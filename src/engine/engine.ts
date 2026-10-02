// The rules engine. Pure with respect to its inputs: applyAction(state, action, now) returns a NEW state.
// No Firebase, no DOM. Later this exact module runs inside a Cloud Function.

import { CREDENTIAL_SHARING_ENABLED, findFn, findSystem, SYSTEMS } from './catalog';
import { runAutomation, spawnNpc } from './bank';
import { runBots } from './bots';
import { advanceRequests, scheduleRequest, spawnFirstRequest, spawnRequest } from './requests';
import { advanceTutorials, finishBankerTutorials, trackTutorial } from './tutorial';
import {
  activeBlock,
  systemAddress,
  activeReroute,
  effectiveHost,
  addAlert,
  addHostLog,
  addLog,
  ANONYMOUS,
  blockText,
  effectiveIp,
  fail,
  gameTime,
  keyOf,
  money,
  nameOf,
  nextId,
  normCred,
  note,
  ok,
  targetLabel,
} from './core';
import { findCredentialByCode } from './credentials';
import { advanceCracks, advanceProxies, advanceTraces, advanceUnlocks, credScopeText, HANDLERS, isSecurityWrite } from './handlers';
import { canWriteModule, notify, WATCHABLE } from './notify';
import { bankShutDown, checkEnd, closeOfBusiness, hostShutDown, resign, TERMINATED_TEXT } from './ending';
import { nextArrival } from './pacing';
import type { Ctx } from './handlers';
import type {
  Action,
  ActionResult,
  Credential,
  ExecuteAction,
  GameState,
  LogEntry,
  PendingAction,
  Player,
} from './types';

// ---- Time ---------------------------------------------------------------------

/** Mutating: brings the state up to `now` (NPC traffic, payment automation, win/timeout checks). */
export function advanceState(s: GameState, now: number): void {
  if (s.status !== 'RUNNING') return;
  const endT = s.config.durationSec;
  const targetT = Math.min(Math.max(0, (now - s.startedAt) / 1000), endT);

  // Scheduled arrivals (NPC payments, bankers' first requests, client requests), handled in time order. Their rate
  // follows the time of day (pacing.ts): slow mornings, a lunch rush, a busy end of day, nothing new at close of business.
  const firsts = (s.firstRequests ??= []); // older saves have none
  while (s.status === 'RUNNING') {
    const nextNpc = Number.isFinite(s.nextNpcAt) ? s.nextNpcAt : nextArrival(endT, s.lastNpcAt, s.config.npcIntervalSec); // older saves have none
    const nextReq = Number.isFinite(s.nextRequestAt) ? s.nextRequestAt : Infinity; // JSON turns Infinity into null
    const nextFirst = firsts.length ? firsts[0].at : Infinity;
    const next = Math.min(nextNpc, nextReq, nextFirst);
    if (next > targetT) break;
    s.now = Math.max(s.now, s.startedAt + next * 1000);
    if (next === nextFirst) spawnFirstRequest(s, firsts.shift()!.bankerId);
    else if (next === nextNpc) {
      s.lastNpcAt = nextNpc;
      s.nextNpcAt = nextArrival(endT, nextNpc, s.config.npcIntervalSec);
      spawnNpc(s);
      runAutomation(s);
      checkWin(s);
    } else {
      scheduleRequest(s, nextReq);
      spawnRequest(s);
    }
  }
  if (s.status !== 'RUNNING') return;

  s.now = Math.max(s.now, s.startedAt + targetT * 1000);
  runDueRevocations(s);
  advanceCracks(s);
  advanceUnlocks(s);
  advanceProxies(s);
  advanceTraces(s);
  advancePendingActions(s);
  advanceRequests(s);
  runAutomation(s);
  advanceTutorials(s); // after automation: what is left waiting is left for people
  runBots(s, execute, sendMessage);
  checkWin(s);
  if (s.status === 'RUNNING' && targetT >= endT) closeOfBusiness(s);
}

/** Pure wrapper around advanceState. */
export function tick(state: GameState, now: number): GameState {
  const s = structuredClone(state);
  advanceState(s, now);
  return s;
}

/** Terminations and the instant end conditions (see ending.ts). The bank's own target is only checked at close of business. */
export function checkWin(s: GameState): void {
  checkEnd(s);
}

// ---- Actions ------------------------------------------------------------------

export function applyAction(state: GameState, action: Action, now: number): { state: GameState; result: ActionResult } {
  const s = structuredClone(state);
  advanceState(s, now);
  if (s.status !== 'RUNNING') return { state: s, result: fail('The game is over.') };
  const p = s.players[action.playerId];
  if (!p) return { state: s, result: fail('Unknown player.') };

  let result: ActionResult;
  switch (action.type) {
    case 'EXECUTE':
      result = execute(s, p, action);
      trackTutorial(s, p, action, result.ok);
      finishBankerTutorials(s); // a settlement by hand finishes a banker's at once
      break;
    case 'SHARE_CREDENTIAL':
      result = shareCredential(s, p, action.credentialId, action.toPlayerId);
      break;
    case 'SEND_MESSAGE':
      result = sendMessage(s, p, action.toPlayerId, action.text);
      break;
    case 'CONNECT':
      result = connect(s, p, action.address);
      break;
    case 'ACCESS_WORKSTATION':
      result = accessWorkstation(s, p, action.targetId, action.code);
      break;
    case 'SET_WATCH':
      result = setWatch(s, p, action.system, action.module, action.on);
      break;
    case 'QUIT':
      if (p.terminated) result = fail('You no longer work here.');
      else {
        resign(s, p);
        result = ok('You quit. The bank\'s systems no longer accept you.');
      }
      break;
    default:
      result = fail('Unknown action.');
  }
  checkWin(s);
  return { state: s, result };
}

function registerFailure(s: GameState, p: Player): void {
  p.failTotal += 1;
  p.failStreak += 1;
  if (p.failStreak >= s.config.lockoutAfterFails) {
    p.failStreak = 0;
    p.lockedUntil = gameTime(s) + s.config.lockoutSec;
    notify(s, 'SECURITY', 'EMPLOYEE_RECORDS', `${p.name}'s workstation (${p.ip}) is locked out for ${s.config.lockoutSec}s`, { owner: p.id });
  }
}

/**
 * Record that a player's workstation was active. With an IP reroute in force the activity follows the fake
 * IP: if it belongs to another workstation, that one shows active instead; an invented IP floats and the
 * real workstation stays idle. So Employee Records tells the same spoofed story as the Master Log.
 */
function markActive(s: GameState, p: Player, t: number): void {
  const rr = activeReroute(s, p.ip, t);
  if (!rr) {
    p.lastActiveAt = t;
    return;
  }
  const framed = Object.values(s.players).find((x) => x.ip === rr.toIp);
  if (framed) framed.lastActiveAt = t;
}

function credCovers(cr: Credential, system: string, module: string, fnId: string, perm: 'READ' | 'WRITE'): boolean {
  return (
    cr.system === system &&
    (cr.module === null || cr.module === module) &&
    (cr.fn === null || cr.fn === fnId) &&
    (cr.permission === 'WRITE' || perm === 'READ')
  );
}

/**
 * Why this workstation cannot reach the network right now, if it cannot. A revoked IP (a permanent block) cuts
 * it off from the bank only: the unregistered host is outside the bank's firewall.
 */
function workstationBlocked(s: GameState, p: Player, toHiddenHost = false): string | null {
  const b = activeBlock(s, p.ip);
  if (!b || (toHiddenHost && b.until === null)) return null;
  return `Your workstation is blocked by the firewall ${blockText(s, b)}.`;
}

/** What the player typed into an action, the code included, for the dev-only `typed` on a failure's activity entry. */
function typedOf(a: ExecuteAction): Record<string, string> {
  return { ...a.params, code: a.code ?? '' };
}

function execute(s: GameState, p: Player, a: ExecuteAction): ActionResult {
  const t = gameTime(s);
  const def = findFn(a.system, a.module, a.fn);
  // A failure before access is settled still goes in the activity log (a monitor's quiet refresh aside).
  const failed = (message: string): ActionResult => {
    if (!a.quiet) note(p, t, `FAILED: ${def?.label ?? a.fn} on ${targetLabel(a.system, a.module)} - ${message}`, typedOf(a));
    return fail(message);
  };
  // A terminated employee keeps nothing but the unregistered host.
  if (p.terminated && a.system !== 'HIDDEN_HOST') return failed(TERMINATED_TEXT);
  const blocked = workstationBlocked(s, p, a.system === 'HIDDEN_HOST');
  if (blocked) return failed(blocked);
  if (p.lockedUntil > t) {
    return failed(`Workstation locked for ${Math.ceil(p.lockedUntil - t)}s after repeated failed attempts.`);
  }
  const handler = HANDLERS[`${a.system}.${a.module}.${a.fn}`];
  if (!def || !handler) return failed('Unknown system, module or function.');
  const address = systemAddress(s, a.system);
  if (activeBlock(s, address)) return failed('No route to host (blocked by the firewall).');
  if (!a.quiet) markActive(s, p, t);
  const code = (a.code ?? '').trim();
  const label = targetLabel(a.system, a.module);
  const where = `${a.system}.${a.module}.${a.fn}`;
  const mod = s.modules[keyOf(a.system, a.module)];

  // Security switched off: no code needed, and the records say "Anonymous".
  if (mod.open && code === '') return run(s, p, a, def, handler, label, openCredential(s, a), anonymous(p), true);
  if (!/^\d{4}$/.test(code)) return failed('Enter a 4-digit code.');
  const cred = findCredentialByCode(s, code);

  // One deliberately uninformative reply for: unknown code / revoked code / code without the right scope.
  const deny = (actor: string, kind: string, message: string, reason: string): ActionResult => {
    // On the hidden host even a failure only shows up as nameless "Unknown server activity".
    if (a.system === 'HIDDEN_HOST') hiddenActivity(s, p, 'failed login attempt', 'Failed login attempt');
    else {
      const entry = addLog(s, { actor, kind, message, sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id });
      addAlert(s, kind, message, entry.id);
    }
    note(p, t, `FAILED (${reason}): code ${code} on ${where}`, typedOf(a));
    registerFailure(s, p);
    return fail('Access denied.');
  };

  if (!cred) return deny('UNKNOWN', 'AUTH_FAIL', `Failed authentication attempt on ${label}`, 'no such code');
  const owner = s.players[cred.owner];
  if (cred.status === 'REVOKED') {
    return deny(owner.id, 'AUTH_REVOKED', `Attempt with revoked credential ${cred.id} (${owner.name}) on ${label}`, `revoked credential ${cred.id}`);
  }
  if (!credCovers(cred, a.system, a.module, a.fn, def.permission)) {
    return deny(owner.id, 'AUTH_DENIED', `${owner.name}'s credential was denied on ${label}`, `credential ${cred.id} lacks scope`);
  }

  // The code worked, so this player now knows (holds) that credential (while credential sharing is on).
  if (CREDENTIAL_SHARING_ENABLED && !p.heldCredentialIds.includes(cred.id)) {
    p.heldCredentialIds.push(cred.id);
    note(p, t, `Learned credential ${cred.id} (${owner.name}'s, ${credScopeText(cred)}) by entering its code.`);
  }

  return run(s, p, a, def, handler, label, cred, owner, false);
}

/** A stand-in credential for open-access use: the whole system, read and write. */
function openCredential(s: GameState, a: ExecuteAction): Credential {
  return { id: 'OPEN', owner: ANONYMOUS, code: '', system: a.system, module: null, fn: null, permission: 'WRITE', status: 'ACTIVE', issuedBy: null, createdAt: gameTime(s) };
}
/** The "owner" recorded for open-access use. Only its id and name are ever read. */
const anonymous = (p: Player): Player => ({ ...p, id: ANONYMOUS, name: 'Anonymous' });

/** Runs a function once access is settled (a real credential, or open access). */
/** Pages whose bell notifies about every logged use (see notify.ts). */
const ANY_ACTIVITY = ['SECURITY.FIREWALL', 'SECURITY.PERMISSIONS'];

function run(
  s: GameState,
  p: Player,
  a: ExecuteAction,
  def: NonNullable<ReturnType<typeof findFn>>,
  handler: (typeof HANDLERS)[string],
  label: string,
  cred: Credential,
  owner: Player,
  open: boolean,
): ActionResult {
  const t = gameTime(s);
  const where = `${a.system}.${a.module}.${a.fn}`;
  const mod = s.modules[keyOf(a.system, a.module)];
  if (mod.status === 'OFFLINE') {
    if (!a.quiet) note(p, t, `FAILED: ${def.label} on ${label} - ${label} is offline.`, typedOf(a));
    return fail(`${label} is offline.`);
  }

  const given = a.encCodes ?? [];
  const missing = mod.encryption.filter((layer) => !given.includes(layer));
  if (missing.length > 0) {
    const message = `${owner.name} failed to decrypt ${label}`;
    const entry = addLog(s, { actor: owner.id, kind: 'DECRYPT_FAIL', message, sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id });
    addAlert(s, 'DECRYPT_FAIL', message, entry.id);
    note(p, t, `FAILED (missing layer codes): ${where}`, typedOf(a));
    registerFailure(s, p);
    const n = mod.encryption.length;
    return fail(`Module is encrypted (${n} layer${n > 1 ? 's' : ''}). Supply every layer code.`);
  }

  p.failStreak = 0;

  // A timed Security write: checked and logged now, carried out when its time is up (bots act at once, for now).
  const delay = p.bot ? 0 : (SECURITY_DELAY[`${a.system}.${a.module}.${a.fn}`]?.(s, a.params ?? {}) ?? 0) * s.config.securityDelayScale;
  if (delay > 0) return startTimed(s, p, a, def, handler, label, cred, owner, open, delay);
  return perform(s, p, a, def, handler, label, cred, owner, open);
}

/** Runs the function itself and records it (the Master Log entry, notifications, the activity note). */
function perform(
  s: GameState,
  p: Player,
  a: ExecuteAction,
  def: NonNullable<ReturnType<typeof findFn>>,
  handler: (typeof HANDLERS)[string],
  label: string,
  cred: Credential,
  owner: Player,
  open: boolean,
  finishing = false, // a timed action finishing: its alerts and notification went out when it started
): ActionResult {
  const t = gameTime(s);
  const where = `${a.system}.${a.module}.${a.fn}`;
  const st: { logged: LogEntry | null } = { logged: null };
  const hidden = a.system === 'HIDDEN_HOST';
  const writeAccessLog = (detail?: string): LogEntry => {
    // The hidden host leaves only a cryptic system entry (shown under "Everything"); tracing it gives a partial answer.
    if (hidden) {
      const activity = HIDDEN_ACTIVITY[a.fn] ?? def.label.toLowerCase();
      return hiddenActivity(s, p, activity, `${owner.name}: ${activity}`);
    }
    const message = `${owner.name} ${detail ?? 'accessed ' + label}${open ? ' (open access)' : ''}`;
    return addLog(s, { actor: owner.id, kind: 'ACCESS', message, sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id });
  };
  const ctx: Ctx = {
    s,
    actor: p,
    owner,
    cred,
    t,
    system: a.system,
    module: a.module,
    log: (detail) => (st.logged ??= writeAccessLog(detail)),
    quietAlerts: finishing,
    strike: (reason) => {
      const message = `${owner.name} failed a decryption attempt on ${label}`;
      const entry = addLog(s, { actor: owner.id, kind: 'DECRYPT_FAIL', message, sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id });
      addAlert(s, 'DECRYPT_FAIL', message, entry.id);
      note(p, t, `FAILED (${reason}): ${where}`, typedOf(a));
      registerFailure(s, p);
    },
  };

  // A live monitor may refresh quietly, but only a view this player already opened with a logged read.
  const monitorKey = `${a.system}.${a.module}.${a.fn}`;
  const quiet = a.quiet && def.permission === 'READ' && p.monitoring.includes(monitorKey);
  const res = handler(ctx, a.params ?? {});
  if (quiet && res.ok) return { ok: true, message: res.message, lines: res.lines, data: res.data };
  if (res.ok && def.permission === 'READ' && !p.monitoring.includes(monitorKey)) p.monitoring.push(monitorKey);
  if (res.ok && !st.logged) st.logged = writeAccessLog(res.logDetail);
  if (res.ok && hidden && st.logged) st.logged.leak ??= blacknetLeak(s, a.fn);
  // "Any activity" pages notify with the Master Log line (it names the credential owner, not who typed).
  if (res.ok && st.logged && !hidden && !finishing && ANY_ACTIVITY.includes(keyOf(a.system, a.module))) {
    notify(s, a.system, a.module, st.logged.message, { owner: owner.id });
  }

  const via = open ? 'open access (no code)' : owner.id === p.id ? `your credential ${cred.id}` : `${owner.name}'s credential ${cred.id}`;
  note(p, t, `${res.ok ? 'OK' : 'FAILED'}: ${def.label} on ${label} using ${via}${res.ok ? '' : ' - ' + res.message}`, res.ok ? undefined : typedOf(a));
  return { ok: res.ok, message: res.message, lines: res.lines, data: res.data };
}

// ---- Timed Security writes ------------------------------------------------------
type Params = Record<string, string>;

/**
 * How long each Security write and Thief kit tool takes, in seconds (scaled by config.securityDelayScale;
 * missing = instant). Drastic moves take longer, undoing is quick. Revoke all access and the revocation of a
 * Firewall or Permissions write credential have their own countdowns; Trace (traceDelaySec), Create proxy
 * (proxySetupSec), Code crack and Unlock workstation have their own timers.
 */
const SECURITY_DELAY: Record<string, (s: GameState, q: Params) => number> = {
  'SECURITY.FIREWALL.SET_MODULE_STATUS': (_s, q) => (q.status === 'OFFLINE' ? 5 : 2),
  'SECURITY.FIREWALL.SET_SECURITY': (_s, q) => (q.security === 'OFF' ? 5 : 2),
  'SECURITY.FIREWALL.BLOCK_ADDRESS': () => 2,
  'SECURITY.FIREWALL.UNBLOCK_ADDRESS': () => 2,
  'SECURITY.FIREWALL.CANCEL_REVOCATION': () => 2,
  'SECURITY.EMPLOYEE_RECORDS.RESET_LOCKOUT': () => 2,
  'SECURITY.PERMISSIONS.CREATE_CREDENTIAL': () => 5,
  'SECURITY.PERMISSIONS.REVOKE_CREDENTIAL': (s, q) => {
    const cr = s.credentials[normCred(q.credentialId ?? '')];
    return cr && isSecurityWrite(cr) ? 0 : 2; // those count down 30s anyway
  },
  'SECURITY.PERMISSIONS.CANCEL_REVOKE': () => 2,
  'HIDDEN_HOST.INFILTRATION.REROUTE_IP': () => 2,
  'HIDDEN_HOST.INFILTRATION.CREATE_USER': () => 5,
  'HIDDEN_HOST.SOCIAL.SPOOFED_MESSAGE': () => 2,
  'HIDDEN_HOST.SOCIAL.SCAM_REQUEST': () => 2,
  'HIDDEN_HOST.CLEANUP.LOG_WIPER': () => 5,
  'HIDDEN_HOST.CLEANUP.ALERT_MUTE': () => 2,
  'HIDDEN_HOST.ACCESS.LOCKOUT_BOMB': () => 2,
};

const moduleName = (q: Params): string => {
  const [sys, mod] = (q.target ?? '').split('.');
  return targetLabel(sys, mod);
};

/** What a timed Security write is called: `short` on its progress bar, `initiated` in the Master Log when it starts. */
const TIMED_TEXT: Record<string, (s: GameState, q: Params) => { short: string; initiated: string }> = {
  'SECURITY.FIREWALL.SET_MODULE_STATUS': (_s, q) =>
    q.status === 'OFFLINE'
      ? { short: `${moduleName(q)} offline`, initiated: `initiated taking ${moduleName(q)} offline` }
      : { short: `${moduleName(q)} online`, initiated: `initiated bringing ${moduleName(q)} back online` },
  'SECURITY.FIREWALL.SET_SECURITY': (_s, q) =>
    q.security === 'OFF'
      ? { short: `${moduleName(q)} full access`, initiated: `initiated switching security off for ${moduleName(q)}` }
      : { short: `${moduleName(q)} security on`, initiated: `initiated switching security back on for ${moduleName(q)}` },
  'SECURITY.FIREWALL.BLOCK_ADDRESS': (_s, q) => ({ short: `Block ${q.address}`, initiated: `initiated a firewall block on ${q.address}` }),
  'SECURITY.FIREWALL.UNBLOCK_ADDRESS': (_s, q) => ({ short: `Unblock ${q.address}`, initiated: `initiated unblocking ${q.address}` }),
  'SECURITY.FIREWALL.CANCEL_REVOCATION': (_s, q) => ({ short: `Cancel ${q.revocationId}`, initiated: `initiated cancelling revocation ${q.revocationId}` }),
  'SECURITY.EMPLOYEE_RECORDS.RESET_LOCKOUT': (_s, q) => ({ short: `Unlock ${q.address}`, initiated: `initiated a lockout reset on ${q.address}` }),
  'SECURITY.PERMISSIONS.CREATE_CREDENTIAL': (s, q) => ({ short: `Credential for ${nameOf(s, q.owner)}`, initiated: `initiated a new credential for ${nameOf(s, q.owner)}` }),
  'SECURITY.PERMISSIONS.REVOKE_CREDENTIAL': (_s, q) => ({ short: `Revoke ${normCred(q.credentialId ?? '')}`, initiated: `initiated revoking credential ${normCred(q.credentialId ?? '')}` }),
  'SECURITY.PERMISSIONS.CANCEL_REVOKE': (_s, q) => ({ short: `Keep ${normCred(q.credentialId ?? '')}`, initiated: `initiated cancelling the revocation of ${normCred(q.credentialId ?? '')}` }),
  // Kit tools: only `short` is used (the host's own records are written as usual, when they start).
  'HIDDEN_HOST.INFILTRATION.REROUTE_IP': (_s, q) => ({ short: `Reroute ${q.source || 'your IP'} via ${q.proxy}`, initiated: '' }),
  'HIDDEN_HOST.INFILTRATION.CREATE_USER': (_s, q) => ({ short: `Plant ${q.name}`, initiated: '' }),
  'HIDDEN_HOST.SOCIAL.SPOOFED_MESSAGE': (_s, q) => ({ short: `Message to ${q.to}`, initiated: '' }),
  'HIDDEN_HOST.SOCIAL.SCAM_REQUEST': (_s, q) => ({ short: `Scam request from ${q.customer}`, initiated: '' }),
  'HIDDEN_HOST.CLEANUP.LOG_WIPER': (_s, q) => ({ short: `Wipe ${q.logId}`, initiated: '' }),
  'HIDDEN_HOST.CLEANUP.ALERT_MUTE': () => ({ short: 'Alert mute', initiated: '' }),
  'HIDDEN_HOST.ACCESS.LOCKOUT_BOMB': (_s, q) => ({ short: `Lockout bomb on ${q.target}`, initiated: '' }),
};

/**
 * Starts a timed Security write. It is tried on a copy of the game first, so a mistake is refused at once; if it
 * would work, the Master Log gets an "initiated" entry now, with the alerts it would raise, and it is carried
 * out when its time is up (advancePendingActions). One of each per player at a time.
 */
function startTimed(
  s: GameState,
  p: Player,
  a: ExecuteAction,
  def: NonNullable<ReturnType<typeof findFn>>,
  handler: (typeof HANDLERS)[string],
  label: string,
  cred: Credential,
  owner: Player,
  open: boolean,
  delay: number,
): ActionResult {
  const t = gameTime(s);
  const key = `${a.system}.${a.module}.${a.fn}`;
  const pending = (s.pendingActions ??= []);
  const running = pending.find((x) => !x.done && x.actorId === p.id && `${x.system}.${x.module}.${x.fn}` === key);
  if (running) return fail(`${running.label} is still running (${Math.ceil(running.doneAt - t)}s).`);
  const params = a.params ?? {};
  // Dry run on a copy: the same checks and the same answer, and nothing changes for real.
  const copy = structuredClone(s);
  const tried = perform(copy, copy.players[p.id], a, def, handler, label, open ? cred : copy.credentials[cred.id], open ? owner : copy.players[owner.id], open);
  if (!tried.ok) {
    note(p, t, `FAILED: ${def.label} on ${label} - ${tried.message}`, typedOf(a));
    return tried;
  }
  const text = TIMED_TEXT[key]?.(s, params) ?? { short: def.label, initiated: `initiated ${def.label.toLowerCase()}` };
  if (a.system === 'HIDDEN_HOST') copyRecords(s, copy); // the host's usual records, written now
  else startRecords(s, copy, a, p, owner, open, text.initiated);
  const job: PendingAction = {
    id: nextId(s, 'job', 'J'),
    actorId: p.id,
    credentialId: open ? 'OPEN' : cred.id,
    system: a.system,
    module: a.module,
    fn: a.fn,
    params,
    label: text.short,
    startedAt: t,
    doneAt: t + delay,
    done: false,
  };
  pending.push(job);
  const via = open ? 'open access (no code)' : owner.id === p.id ? `your credential ${cred.id}` : `${owner.name}'s credential ${cred.id}`;
  note(p, t, `STARTED: ${def.label} on ${label} using ${via} (${delay}s)`);
  return ok(`${text.short}: started, done in ${delay}s. Watch its progress here.`);
}

/**
 * A Security write starting: an "initiated" Master Log entry, and the alerts its dry run raised worded as
 * started, so whoever watches can react in time (and the page's bell, for Firewall and Permissions).
 */
function startRecords(s: GameState, copy: GameState, a: ExecuteAction, p: Player, owner: Player, open: boolean, initiated: string): void {
  const entry = addLog(s, { actor: owner.id, kind: 'ACCESS', message: `${owner.name} ${initiated}${open ? ' (open access)' : ''}`, sourceIp: effectiveIp(s, p, gameTime(s)), actualPlayerId: p.id });
  for (const al of copy.alerts.filter((x) => Number(x.id.slice(1)) > s.counters.alert)) {
    addAlert(s, al.kind, `${al.message.split(': ')[0]}: ${owner.name} ${initiated}`, entry.id, al.tier, owner.id);
  }
  if (ANY_ACTIVITY.includes(keyOf(a.system, a.module))) notify(s, a.system, a.module, entry.message, { owner: owner.id });
}

/**
 * A kit tool starting: the records its dry run wrote (the "Unknown server activity" entry, the host's own log,
 * any exposure alert) are taken over as they are, so the bank sees it now and can react in time.
 */
function copyRecords(s: GameState, copy: GameState): void {
  const newer = <T extends { id: string }>(list: T[], since: number): T[] => list.filter((x) => Number(x.id.slice(1)) > since);
  for (const e of newer(copy.logs, s.counters.log)) s.logs.push(e);
  for (const al of newer(copy.alerts, s.counters.alert)) {
    s.alerts.push(al);
    notify(s, 'SECURITY', 'MASTER_LOG', al.message);
  }
  for (const h of newer(copy.hostLog, s.counters.host)) {
    s.hostLog.push(h);
    if (h.alert) notify(s, 'HIDDEN_HOST', 'HOST_LOG', h.message);
  }
  s.counters.log = copy.counters.log;
  s.counters.alert = copy.counters.alert;
  s.counters.host = copy.counters.host;
}

/**
 * Mutating: timed Security writes whose time is up are carried out (their completion is logged; their alerts
 * already went out). One stops instead if its actor is blocked or gone, its page went offline, its code was
 * revoked, or, used with security off, security came back on.
 */
function advancePendingActions(s: GameState): void {
  const t = gameTime(s);
  for (const job of s.pendingActions ?? []) {
    if (job.done) continue;
    const p = s.players[job.actorId];
    const mod = s.modules[keyOf(job.system, job.module)];
    const open = job.credentialId === 'OPEN';
    const cred = open ? null : s.credentials[job.credentialId];
    // A revoked IP (a permanent block) cuts a workstation off from the bank, not from the hidden host.
    const block = p ? activeBlock(s, p.ip) : undefined;
    const hidden = job.system === 'HIDDEN_HOST';
    const why =
      !p || (p.terminated && !hidden) ? 'you were disabled'
      : block && (!hidden || block.until !== null) ? 'your workstation was blocked'
      : activeBlock(s, systemAddress(s, job.system)) ? `${targetLabel(job.system, job.module)} was blocked`
      : mod.status === 'OFFLINE' ? `${targetLabel(job.system, job.module)} went offline`
      : !open && cred?.status !== 'ACTIVE' ? 'the credential was revoked'
      : open && !mod.open ? 'security came back on'
      : null;
    if (!why && job.doneAt > t) continue;
    job.done = true;
    if (!p) continue;
    if (why) {
      job.ok = false;
      job.result = `${job.label} stopped: ${why}.`;
      note(p, t, job.result);
      continue;
    }
    const a: ExecuteAction = { type: 'EXECUTE', playerId: p.id, code: '', system: job.system, module: job.module, fn: job.fn, params: job.params };
    const def = findFn(job.system, job.module, job.fn)!;
    const handler = HANDLERS[`${job.system}.${job.module}.${job.fn}`];
    const owner = open ? anonymous(p) : s.players[cred!.owner];
    if (hidden) s.recordsOff = true; // its records were written when it started
    const res = perform(s, p, a, def, handler, targetLabel(job.system, job.module), open ? openCredential(s, a) : cred!, owner, open, true);
    s.recordsOff = false;
    job.ok = res.ok;
    job.result = res.ok ? res.message : `${job.label} failed: ${res.message}`;
  }
}

function shareCredential(s: GameState, p: Player, credentialId: string, toId: string): ActionResult {
  if (!CREDENTIAL_SHARING_ENABLED) return fail('Credential sharing is switched off.');
  const t = gameTime(s);
  const cred = s.credentials[credentialId];
  if (!cred || !p.heldCredentialIds.includes(cred.id)) return fail('You do not hold that credential.');
  const to = s.players[toId];
  if (!to || to.id === p.id) return fail('Pick another employee.');
  if (to.heldCredentialIds.includes(cred.id)) return fail(`${to.name} already has that credential.`);
  to.heldCredentialIds.push(cred.id);
  note(p, t, `Shared credential ${cred.id} (${credScopeText(cred)}) with ${to.name}.`);
  note(to, t, `${p.name} shared credential ${cred.id} (${nameOf(s, cred.owner)}'s, ${credScopeText(cred)}) with you. Code ${cred.code}.`);
  return ok(`Shared ${cred.id} with ${to.name}.`);
}

/** The notification bell on a page. It can only be switched on where this workstation holds write access. */
function setWatch(s: GameState, p: Player, system: string, module: string, on: boolean): ActionResult {
  const key = keyOf(system, module);
  const what = WATCHABLE[key];
  if (!what) return fail('This page has no notifications.');
  const label = targetLabel(system, module);
  if (!on) {
    p.watching = p.watching.filter((k) => k !== key);
    return ok(`Alerts for ${label} disabled.`);
  }
  if (!canWriteModule(s, p, system, module)) return fail(`You need write access to ${label} to be notified from it.`);
  if (!p.watching.includes(key)) p.watching.push(key);
  return ok(`Alerts for ${label} enabled. You will receive a notification when ${what}.`);
}

function sendMessage(s: GameState, p: Player, toId: string, text: string): ActionResult {
  const to = s.players[toId];
  const body = (text ?? '').trim().slice(0, 500);
  if (!to || to.id === p.id) return fail('Pick another employee.');
  if (!body) return fail('Write a message first.');
  const m = { id: nextId(s, 'msg', 'M'), t: gameTime(s), from: p.id, to: to.id, text: body };
  p.messages.push(m);
  to.messages.push(m);
  return ok(`Sent to ${to.name}.`);
}

function connect(s: GameState, p: Player, address: string): ActionResult {
  const t = gameTime(s);
  const toHost = (address ?? '').trim() === s.hiddenHost;
  if (p.terminated && !toHost) return fail(TERMINATED_TEXT);
  const blocked = workstationBlocked(s, p, toHost);
  if (blocked) return fail(blocked);
  if (activeBlock(s, (address ?? '').trim())) return fail('No route to host.');
  markActive(s, p, t);
  if (p.lockedUntil > t) return fail(`Workstation locked for ${Math.ceil(p.lockedUntil - t)}s.`);
  const addr = (address ?? '').trim();
  const station = Object.values(s.players).find((x) => x.ip === addr);
  if (station) return { ok: true, message: `Workstation ${addr} found.`, workstation: station.id };
  // A proxy answers as a relay: nothing to log in to, but it shows whether traffic is going through it right now.
  if (s.proxies.some((x) => x.ip === addr)) {
    const relaying = s.reroutes.some((r) => r.toIp === addr && r.until > t);
    return { ok: true, message: `${addr} is a proxy relay.`, proxy: { ip: addr, relaying } };
  }
  if (addr !== s.hiddenHost) return fail('No route to host.');
  const first = !p.knownSystems.includes('HIDDEN_HOST');
  if (first) p.knownSystems.push('HIDDEN_HOST');
  hiddenActivity(s, p, 'connected to the server', 'Unknown workstation connected to the server');
  note(p, t, `Connected to ${s.hiddenHost}.`);
  return ok(`Connected to ${s.hiddenHost}. It now appears in your terminal, but every module needs a credential.`);
}

/**
 * Log in to another player's workstation with one of THAT player's workstation credentials: their own
 * login (W<n>) or one made by Unlock workstation.
 * Success is logged under the credential owner's name, so the Master Log reads as if they logged in
 * themselves; the owner's personal log records the source IP.
 */
function accessWorkstation(s: GameState, p: Player, targetId: string, code: string): ActionResult {
  const t = gameTime(s);
  if (p.terminated) return fail(TERMINATED_TEXT);
  const blocked = workstationBlocked(s, p);
  if (blocked) return fail(blocked);
  if (s.players[targetId] && activeBlock(s, s.players[targetId].ip)) return fail('No route to host.');
  markActive(s, p, t);
  if (p.lockedUntil > t) return fail(`Workstation locked for ${Math.ceil(p.lockedUntil - t)}s after repeated failed attempts.`);
  const target = s.players[targetId];
  if (!target) return fail('No route to host.');
  if (target.id === p.id) return fail('That is your own workstation.');
  const c = (code ?? '').trim();
  if (!/^\d{4}$/.test(c)) return fail('Enter a 4-digit code.');

  const cred = findCredentialByCode(s, c);
  if (!cred || cred.owner !== target.id || cred.system !== 'WORKSTATION' || cred.status !== 'ACTIVE') {
    const actor = cred ? cred.owner : 'UNKNOWN';
    const message = `Failed login to ${target.name}'s workstation`;
    const entry = addLog(s, { actor, kind: 'WORKSTATION_DENIED', message, sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id });
    addAlert(s, 'WORKSTATION_DENIED', message, entry.id);
    note(p, t, `FAILED: code ${c} on ${target.name}'s workstation (${target.ip})`);
    registerFailure(s, p);
    return fail('Access denied.');
  }

  p.failStreak = 0;
  p.remoteAccess = p.remoteAccess.filter((g) => g.playerId !== target.id);
  p.remoteAccess.push({ playerId: target.id, credentialId: cred.id });
  if (CREDENTIAL_SHARING_ENABLED && !p.heldCredentialIds.includes(cred.id)) p.heldCredentialIds.push(cred.id);
  const from = effectiveIp(s, p, t); // an active IP reroute frames the login as coming from the fake IP
  addLog(s, {
    actor: target.id,
    kind: 'WORKSTATION_ACCESS',
    message: `${target.name} logged in to their workstation (${target.ip})`,
    sourceIp: from,
    actualPlayerId: p.id,
  });
  note(target, t, `Your workstation was accessed from ${from}.`);
  note(p, t, `Logged in to ${target.name}'s workstation (${target.ip}) using credential ${cred.id}.`);
  return ok(`Access granted to ${target.name}'s workstation.`);
}

// ---- Firewall revocations ------------------------------------------------------

/** Mutating: carries out every pending credential revocation and "revoke all access" whose countdown has run out. */
function runDueRevocations(s: GameState): void {
  const t = gameTime(s);
  // Security credentials whose revocation countdown ran out (Permissions > Revoke credential).
  for (const cr of Object.values(s.credentials)) {
    if (!cr.pendingRevoke || cr.pendingRevoke.at > t) continue;
    const by = cr.pendingRevoke.byOwner;
    cr.pendingRevoke = null;
    if (cr.status !== 'ACTIVE') continue; // revoked meanwhile by a firewall revocation
    cr.status = 'REVOKED';
    const owner = s.players[cr.owner];
    note(owner, t, `Your credential ${cr.id} was revoked.`);
    const message = `Credential ${cr.id} (${owner.name}) revoked, as started by ${nameOf(s, by)}`;
    const entry = addLog(s, { actor: 'SYSTEM', kind: 'CRED_REVOKED', message, sourceIp: null, actualPlayerId: null });
    addAlert(s, 'SECURITY_FATAL', `Fatal security activity: ${message}`, entry.id, 3);
    notify(s, 'SECURITY', 'PERMISSIONS', message);
  }
  for (const r of s.revocations) {
    if (r.status !== 'PENDING' || r.executeAt > t) continue;
    r.status = 'DONE';
    s.blocks = s.blocks.filter((b) => b.address !== r.address);
    s.blocks.push({ address: r.address, until: null, byOwner: r.byOwner, actualPlayerId: r.actualPlayerId });
    const victim = Object.values(s.players).find((p) => p.ip === r.address);
    let revoked = 0;
    if (victim) {
      for (const cr of Object.values(s.credentials)) {
        // The unregistered host is not the bank's: its credentials survive. Workstation logins are not bank credentials either.
        if (cr.owner !== victim.id || cr.status === 'REVOKED' || cr.system === 'HIDDEN_HOST' || cr.system === 'WORKSTATION') continue;
        cr.status = 'REVOKED';
        revoked++;
      }
      note(victim, t, 'The firewall revoked all access for your workstation. Your bank credentials no longer work.');
    }
    const message = `Firewall: all access revoked for ${r.address} (${r.id})${victim ? `, ${revoked} of ${victim.name}'s credential${revoked === 1 ? '' : 's'} revoked` : ''}`;
    const entry = addLog(s, { actor: 'SYSTEM', kind: 'REVOKED_ALL', message, sourceIp: null, actualPlayerId: null });
    addAlert(s, 'SECURITY_FATAL', `Fatal security activity: ${message}`, entry.id, 3);
    notify(s, 'SECURITY', 'FIREWALL', message);
    // The nuclear option: cutting off one of the bank's own systems shuts the bank down (nobody wins, unless the
    // Thieves' goal is met right now). Cutting off the unregistered host ends the heist (the bank wins, same caveat).
    const bankSystem = SYSTEMS.find((sys) => !sys.hidden && sys.address === r.address);
    if (bankSystem) bankShutDown(s);
    else if (r.address === s.hiddenHost) hostShutDown(s);
  }
}

/** Any contact with the hidden host: a nameless system entry (exposure tier 1: no alert, a trace gives a vague clue). */
function hiddenActivity(s: GameState, p: Player, activity: string, hostMessage: string): LogEntry {
  const t = gameTime(s);
  const entry = addLog(s, { actor: 'SYSTEM', kind: 'HIDDEN_ACCESS', message: 'Unknown server activity', sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id, activity, server: effectiveHost(s, t) });
  // The host keeps its own record, named after the host credential's owner.
  addHostLog(s, hostMessage);
  return entry;
}

/**
 * What tracing a Blacknet entry gives away besides its clue: the message just posted, or the newest message on
 * the board when it was read (none on an empty board).
 */
function blacknetLeak(s: GameState, fn: string): string | undefined {
  const last = s.blacknet.at(-1);
  if (!last) return undefined;
  if (fn === 'POST_MESSAGE') return `The message posted by ${last.alias}: "${last.text}"`;
  if (fn === 'READ_MESSAGES') return `The newest message on the board then, by ${last.alias}: "${last.text}"`;
  return undefined;
}

/** How a trace describes what was done on the hidden host. */
const HIDDEN_ACTIVITY: Record<string, string> = {
  UNLOCK_WORKSTATION: 'unlocked a workstation',
  READ_MESSAGES: 'read the Blacknet board',
  POST_MESSAGE: 'posted on Blacknet',
  VIEW_TARGETS: 'viewed the target ledger',
  VIEW_CACHE: 'viewed the credential cache',
  VIEW_HOST_LOG: 'viewed the host log',
  CREATE_PROXY: 'set up a proxy',
  REROUTE_IP: 'rerouted their IP',
  CREATE_USER: 'planted a user in the records',
  SPOOFED_MESSAGE: 'sent a spoofed message',
  SCAM_REQUEST: 'planted a scam client request',
  LOG_WIPER: 'wiped a log entry',
  ALERT_MUTE: 'muted the alerts',
  CRACK_CODE: 'started cracking a code',
  LOCKOUT_BOMB: 'forced a lockout',
};
