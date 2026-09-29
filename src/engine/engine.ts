// The rules engine. Pure with respect to its inputs: applyAction(state, action, now) returns a NEW state.
// No Firebase, no DOM. Later this exact module runs inside a Cloud Function.

import { findFn, findSystem, SYSTEMS } from './catalog';
import { autoProcess, spawnNpc } from './bank';
import { spawnRequest } from './requests';
import {
  activeBlock,
  activeReroute,
  addAlert,
  addHostLog,
  addLog,
  ANONYMOUS,
  blockText,
  effectiveIp,
  fail,
  gameTime,
  keyOf,
  nameOf,
  nextId,
  note,
  ok,
  targetLabel,
} from './core';
import { findCredentialByCode } from './credentials';
import { advanceCracks, credScopeText, HANDLERS } from './handlers';
import { nextArrival } from './pacing';
import type { Ctx } from './handlers';
import type {
  Action,
  ActionResult,
  Credential,
  ExecuteAction,
  GameState,
  LogEntry,
  Player,
} from './types';

// ---- Time ---------------------------------------------------------------------

/** Mutating: brings the state up to `now` (NPC traffic, auto-processing, win/timeout checks). */
export function advanceState(s: GameState, now: number): void {
  if (s.status !== 'RUNNING') return;
  const endT = s.config.durationSec;
  const targetT = Math.min(Math.max(0, (now - s.startedAt) / 1000), endT);

  // Scheduled arrivals (NPC payments, client requests), handled in time order. Their rate follows the time
  // of day (pacing.ts): slow mornings, a lunch rush, a busy end of day, nothing new at close of business.
  while (s.status === 'RUNNING') {
    const nextNpc = nextArrival(endT, s.lastNpcAt, s.config.npcIntervalSec);
    const nextReq = nextArrival(endT, s.lastRequestAt, s.config.requestIntervalSec);
    const next = Math.min(nextNpc, nextReq);
    if (next > targetT) break;
    s.now = Math.max(s.now, s.startedAt + next * 1000);
    if (next === nextNpc) {
      s.lastNpcAt = nextNpc;
      spawnNpc(s);
      if (s.config.autoProcess) autoProcess(s);
      checkWin(s);
    } else {
      s.lastRequestAt = nextReq;
      spawnRequest(s);
    }
  }
  if (s.status !== 'RUNNING') return;

  s.now = Math.max(s.now, s.startedAt + targetT * 1000);
  runDueRevocations(s);
  advanceCracks(s);
  if (s.config.autoProcess) autoProcess(s);
  checkWin(s);
  if (s.status === 'RUNNING' && targetT >= endT) {
    s.status = 'ENDED';
    s.winner = s.config.timeoutWinner;
    s.endReason = 'Time ran out before either objective was met.';
  }
}

/** Pure wrapper around advanceState. */
export function tick(state: GameState, now: number): GameState {
  const s = structuredClone(state);
  advanceState(s, now);
  return s;
}

export function checkWin(s: GameState): void {
  if (s.status !== 'RUNNING') return;
  if (s.totals.stolen >= s.config.blackTarget) {
    s.status = 'ENDED';
    s.winner = 'BLACK';
    s.endReason = 'The Black Hats diverted enough money.';
  } else if (s.totals.processed >= s.config.whiteTarget) {
    s.status = 'ENDED';
    s.winner = 'WHITE';
    s.endReason = 'The bank processed its quota of legitimate payments.';
  }
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
  }
}

/**
 * Record that a player's workstation was active. With an IP reroute in force the activity follows the fake
 * IP: if it belongs to another workstation, that one shows active instead; an invented IP floats and the
 * real workstation stays idle. So Employee Records tells the same spoofed story as the Master Log.
 */
function markActive(s: GameState, p: Player, t: number): void {
  const rr = activeReroute(s, p.id, t);
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

/** Why this workstation cannot reach the network right now, if it cannot. */
function workstationBlocked(s: GameState, p: Player): string | null {
  const b = activeBlock(s, p.ip);
  return b ? `Your workstation is blocked by the firewall ${blockText(s, b)}.` : null;
}

function execute(s: GameState, p: Player, a: ExecuteAction): ActionResult {
  const t = gameTime(s);
  const blocked = workstationBlocked(s, p);
  if (blocked) return fail(blocked);
  if (p.lockedUntil > t) {
    return fail(`Workstation locked for ${Math.ceil(p.lockedUntil - t)}s after repeated failed attempts.`);
  }
  const def = findFn(a.system, a.module, a.fn);
  const handler = HANDLERS[`${a.system}.${a.module}.${a.fn}`];
  if (!def || !handler) return fail('Unknown system, module or function.');
  const address = findSystem(a.system)?.address ?? '';
  if (activeBlock(s, address)) return fail('No route to host (blocked by the firewall).');
  if (!a.quiet) markActive(s, p, t);
  const code = (a.code ?? '').trim();
  const label = targetLabel(a.system, a.module);
  const where = `${a.system}.${a.module}.${a.fn}`;
  const mod = s.modules[keyOf(a.system, a.module)];

  // Security switched off: no code needed, and the records say "Anonymous".
  if (mod.open && code === '') return run(s, p, a, def, handler, label, openCredential(s, a), anonymous(p), true);
  if (!/^\d{4}$/.test(code)) return fail('Enter a 4-digit code.');
  const cred = findCredentialByCode(s, code);

  // One deliberately uninformative reply for: unknown code / revoked code / code without the right scope.
  const deny = (actor: string, kind: string, message: string, reason: string): ActionResult => {
    // On the hidden host even a failure only shows up as nameless "Unknown server activity".
    if (a.system === 'BLACKHAT_DB') hiddenActivity(s, p, 'failed login attempt', 'Failed login attempt');
    else {
      const entry = addLog(s, { actor, kind, message, sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id });
      addAlert(s, kind, message, entry.id);
    }
    note(p, t, `FAILED (${reason}): code ${code} on ${where}`);
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

  // The code worked, so this player now knows (holds) that credential.
  if (!p.heldCredentialIds.includes(cred.id)) {
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
  if (mod.status === 'OFFLINE') return fail(`${label} is offline.`);

  const given = a.encCodes ?? [];
  const missing = mod.encryption.filter((layer) => !given.includes(layer));
  if (missing.length > 0) {
    const message = `${owner.name} failed to decrypt ${label}`;
    const entry = addLog(s, { actor: owner.id, kind: 'DECRYPT_FAIL', message, sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id });
    addAlert(s, 'DECRYPT_FAIL', message, entry.id);
    note(p, t, `FAILED (missing layer codes): ${where}`);
    registerFailure(s, p);
    const n = mod.encryption.length;
    return fail(`Module is encrypted (${n} layer${n > 1 ? 's' : ''}). Supply every layer code.`);
  }

  p.failStreak = 0;

  const st: { logged: LogEntry | null } = { logged: null };
  const hidden = a.system === 'BLACKHAT_DB';
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
    strike: (reason) => {
      const message = `${owner.name} failed a decryption attempt on ${label}`;
      const entry = addLog(s, { actor: owner.id, kind: 'DECRYPT_FAIL', message, sourceIp: effectiveIp(s, p, t), actualPlayerId: p.id });
      addAlert(s, 'DECRYPT_FAIL', message, entry.id);
      note(p, t, `FAILED (${reason}): ${where}`);
      registerFailure(s, p);
    },
  };

  // A live monitor may refresh quietly, but only a view this player already opened with a logged read.
  const monitorKey = `${a.system}.${a.module}.${a.fn}`;
  const quiet = a.quiet && def.permission === 'READ' && p.monitoring.includes(monitorKey);
  const res = handler(ctx, a.params ?? {});
  if (quiet && res.ok) return { ok: true, message: res.message, lines: res.lines };
  if (res.ok && def.permission === 'READ' && !p.monitoring.includes(monitorKey)) p.monitoring.push(monitorKey);
  if (res.ok && !st.logged) st.logged = writeAccessLog(res.logDetail);

  const via = open ? 'open access (no code)' : owner.id === p.id ? `your credential ${cred.id}` : `${owner.name}'s credential ${cred.id}`;
  note(p, t, `${res.ok ? 'OK' : 'FAILED'}: ${def.label} on ${label} using ${via}${res.ok ? '' : ' - ' + res.message}`);
  return { ok: res.ok, message: res.message, lines: res.lines };
}

function shareCredential(s: GameState, p: Player, credentialId: string, toId: string): ActionResult {
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
  const blocked = workstationBlocked(s, p);
  if (blocked) return fail(blocked);
  if (activeBlock(s, (address ?? '').trim())) return fail('No route to host.');
  markActive(s, p, t);
  if (p.lockedUntil > t) return fail(`Workstation locked for ${Math.ceil(p.lockedUntil - t)}s.`);
  const addr = (address ?? '').trim();
  const station = Object.values(s.players).find((x) => x.ip === addr);
  if (station) return { ok: true, message: `Workstation ${addr} found.`, workstation: station.id };
  if (addr !== s.hiddenHost) return fail('No route to host.');
  const first = !p.knownSystems.includes('BLACKHAT_DB');
  if (first) p.knownSystems.push('BLACKHAT_DB');
  hiddenActivity(s, p, 'connected to the server', 'Unknown workstation connected to the server');
  note(p, t, `Connected to ${s.hiddenHost}.`);
  return ok(`Connected to ${s.hiddenHost}. It now appears in your terminal, but every module needs a credential.`);
}

/**
 * Log in to another player's workstation with one of THAT player's credential codes (any scope).
 * Success is logged under the credential owner's name, so the Master Log reads as if they logged in
 * themselves; the owner's personal log records the source IP.
 */
function accessWorkstation(s: GameState, p: Player, targetId: string, code: string): ActionResult {
  const t = gameTime(s);
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
  if (!cred || cred.owner !== target.id || cred.status !== 'ACTIVE') {
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
  if (!p.heldCredentialIds.includes(cred.id)) p.heldCredentialIds.push(cred.id);
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

/** Mutating: carries out every pending "revoke all access" whose countdown has run out. */
function runDueRevocations(s: GameState): void {
  const t = gameTime(s);
  for (const r of s.revocations) {
    if (r.status !== 'PENDING' || r.executeAt > t) continue;
    r.status = 'DONE';
    s.blocks = s.blocks.filter((b) => b.address !== r.address);
    s.blocks.push({ address: r.address, until: null, byOwner: r.byOwner, actualPlayerId: r.actualPlayerId });
    const victim = Object.values(s.players).find((p) => p.ip === r.address);
    if (victim) {
      for (const cr of Object.values(s.credentials)) if (cr.owner === victim.id) cr.status = 'REVOKED';
      note(victim, t, 'The firewall revoked all access for your workstation. Your credentials no longer work.');
    }
    addLog(s, { actor: 'SYSTEM', kind: 'REVOKED_ALL', message: `Firewall: all access revoked for ${r.address} (${r.id})`, sourceIp: null, actualPlayerId: null });
    // The nuclear option: cutting off one of the bank's own systems shuts the bank down, and everybody loses.
    const bankSystem = SYSTEMS.find((sys) => !sys.hidden && sys.address === r.address);
    if (bankSystem && s.status === 'RUNNING') {
      s.status = 'ENDED';
      s.winner = null;
      s.endReason = `All access to ${bankSystem.label} was revoked and the bank shut down. Nobody wins.`;
    }
  }
}

/** Any contact with the hidden host: a nameless system entry (exposure tier 1: no alert, a trace gives a vague clue). */
function hiddenActivity(s: GameState, p: Player, activity: string, hostMessage: string): LogEntry {
  const entry = addLog(s, { actor: 'SYSTEM', kind: 'HIDDEN_ACCESS', message: 'Unknown server activity', sourceIp: effectiveIp(s, p, gameTime(s)), actualPlayerId: p.id, activity });
  // The host keeps its own record, named after the host credential's owner.
  addHostLog(s, hostMessage);
  return entry;
}

/** How a trace describes what was done on the hidden host. */
const HIDDEN_ACTIVITY: Record<string, string> = {
  READ_MESSAGES: 'read the Blacknet board',
  POST_MESSAGE: 'posted on Blacknet',
  VIEW_TARGETS: 'viewed the target ledger',
  SET_TARGET_STATUS: 'changed a target\'s status',
  VIEW_CACHE: 'viewed the credential cache',
  VIEW_HOST_LOG: 'viewed the host log',
  REROUTE_IP: 'rerouted their IP',
  CREATE_USER: 'planted a user in the records',
  SPOOFED_MESSAGE: 'sent a spoofed message',
  SCAM_REQUEST: 'planted a scam client request',
  LOG_WIPER: 'wiped a log entry',
  ALERT_MUTE: 'muted the alerts',
  CRACK_CODE: 'started cracking a code',
  LOCKOUT_BOMB: 'forced a lockout',
};
