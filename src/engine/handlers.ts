// One handler per function in the catalog. Key format: SYSTEM.MODULE.FUNCTION.
// Handlers only run after authentication, authorization, online and encryption checks have passed.

import { ENCRYPTION_ENABLED, findModule, findSystem, ROLES, SYSTEMS } from './catalog';
import {
  addAlert,
  addLog,
  fmtClock,
  gameTime,
  keyOf,
  money,
  nameOf,
  nextId,
  normAccount,
  normCust,
  normChange,
  accountOwner,
  accountVerified,
  addHostLog,
  activeBlock,
  blockText,
  effectiveIp,
  normCred,
  normLog,
  normReq,
  normTx,
  note,
  targetLabel,
} from './core';
import { createCredential } from './credentials';
import { pick, rand, randInt } from './rng';
import { computeRisk, recordTx, reverseTransaction, settleTransaction } from './bank';
import type { TxActor } from './bank';
import type { AccountChange, ClientRequest, CodeCrack, Credential, Customer, Message, RequestKind, Revocation, GameState, LogEntry, Player, RoleId, SystemId, Transaction, TxEvent, TxStatus } from './types';

export interface Ctx {
  s: GameState;
  actor: Player; // the person actually at the keyboard
  owner: Player; // the credential owner the system believes is acting
  cred: Credential;
  t: number;
  system: SystemId;
  module: string;
  /** Write the Master Log entry now (otherwise the engine writes it after the handler succeeds). */
  log(detail?: string): LogEntry;
  /** Count a failed guess toward workstation lockout and raise an alert. */
  strike(reason: string): void;
}

export interface HandlerResult {
  ok: boolean;
  message: string;
  lines?: string[];
  logDetail?: string;
}
type Params = Record<string, string>;
export type Handler = (c: Ctx, q: Params) => HandlerResult;

const good = (message: string, lines?: string[], logDetail?: string): HandlerResult => ({ ok: true, message, lines, logDetail });
const bad = (message: string): HandlerResult => ({ ok: false, message });
const str = (q: Params, k: string): string => (q[k] ?? '').trim();
const clampInt = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};

function moduleTarget(c: Ctx, q: Params): { system: SystemId; module: string } | string {
  const [sys, mod] = str(q, 'target').split('.');
  if (!sys || !mod || !findModule(sys, mod)) return 'Unknown module.';
  if (!c.actor.knownSystems.includes(sys as SystemId)) return 'Unknown module.';
  return { system: sys as SystemId, module: mod };
}

function getTx(c: Ctx, q: Params): Transaction | string {
  const id = normTx(str(q, 'txId'));
  return c.s.transactions.find((t) => t.id === id) ?? `No such payment: ${id}.`;
}

const scopeText = (cr: Credential): string => `${cr.system}.${cr.module ?? '*'}${cr.fn ? '.' + cr.fn : ''} ${cr.permission}`;
export const credScopeText = scopeText;

const H: Record<string, Handler> = {};

// ---- Security: Firewall ---------------------------------------------------
H['SECURITY.FIREWALL.ADD_ENCRYPTION'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  if (tgt.system === 'SECURITY' && tgt.module === 'FIREWALL') return bad('The Firewall cannot be encrypted.');
  const code = str(q, 'code');
  if (!/^\d{4}$/.test(code)) return bad('Layer code must be 4 digits.');
  const m = c.s.modules[keyOf(tgt.system, tgt.module)];
  if (m.encryption.includes(code)) return bad('That layer code is already used on this module.');
  m.encryption.push(code);
  const label = targetLabel(tgt.system, tgt.module);
  return good(`Encryption layer added to ${label} (${m.encryption.length} layer${m.encryption.length > 1 ? 's' : ''}).`, undefined, `added an encryption layer to ${label}`);
};

H['SECURITY.FIREWALL.REMOVE_ENCRYPTION'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  const m = c.s.modules[keyOf(tgt.system, tgt.module)];
  const idx = m.encryption.indexOf(str(q, 'code'));
  if (idx < 0) {
    c.strike('wrong layer code');
    return bad('Wrong layer code.');
  }
  m.encryption.splice(idx, 1);
  const label = targetLabel(tgt.system, tgt.module);
  return good(`Layer removed from ${label} (${m.encryption.length} left).`, undefined, `removed an encryption layer from ${label}`);
};

H['SECURITY.FIREWALL.BYPASS_ENCRYPTION'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  const m = c.s.modules[keyOf(tgt.system, tgt.module)];
  if (m.encryption.length === 0) return bad('That module is not encrypted.');
  const label = targetLabel(tgt.system, tgt.module);
  const n = m.encryption.length;
  m.encryption = [];
  const entry = c.log(`bypassed ${n} encryption layer${n > 1 ? 's' : ''} on ${label}`);
  addAlert(c.s, 'ENCRYPTION_BYPASS', `Encryption bypassed on ${label}`, entry.id, 3); // loud, deliberate: never muted
  return good(`Stripped ${n} layer${n > 1 ? 's' : ''} from ${label}.`);
};

/** Every bank module (online or offline, security on or off), active blocks, and pending revocations. */
H['SECURITY.FIREWALL.VIEW_STATUS'] = (c) => {
  const rows = SYSTEMS.filter((sys) => !sys.hidden && c.actor.knownSystems.includes(sys.id)).flatMap((sys) =>
    sys.modules.map((m) => {
      const st = c.s.modules[keyOf(sys.id, m.id)];
      const layers = ENCRYPTION_ENABLED && st.encryption.length ? `  ${st.encryption.length} encryption layer${st.encryption.length > 1 ? 's' : ''}` : '';
      return `${`${sys.label} / ${m.label}`.padEnd(46)} ${st.status.padEnd(8)}${st.open ? 'SECURITY OFF' : 'security on'}${layers}`;
    }),
  );
  const blocks = c.s.blocks
    .filter((b) => activeBlock(c.s, b.address) === b)
    .map((b) => `BLOCKED  ${b.address.padEnd(12)} ${blockText(c.s, b)}  by ${nameOf(c.s, b.byOwner)}`);
  const pending = c.s.revocations
    .filter((r) => r.status === 'PENDING')
    .map((r) => `PENDING  ${r.id}  revoke all access for ${r.address} in ${Math.ceil(r.executeAt - c.t)}s  (started by ${nameOf(c.s, r.byOwner)}; cancel from the Firewall)`);
  const offline = rows.filter((r) => r.includes('OFFLINE')).length;
  const open = rows.filter((r) => r.includes('SECURITY OFF')).length;
  const summary = [offline ? `${offline} offline` : 'everything online', open ? `${open} with security off` : '', blocks.length ? `${blocks.length} blocked` : '', pending.length ? `${pending.length} revocation pending` : '']
    .filter(Boolean)
    .join(', ');
  return good(`Firewall: ${summary}.`, [...pending, ...blocks, ...rows]);
};

/** A network address: a workstation IP or a system address. */
function networkAddress(c: Ctx, q: Params): string | { error: string } {
  const a = str(q, 'address');
  if (!a) return { error: 'Enter an address.' };
  const known = Object.values(c.s.players).some((p) => p.ip === a) || SYSTEMS.some((sys) => sys.address === a);
  return known ? a : { error: 'No such address on the network.' };
}

H['SECURITY.FIREWALL.SET_SECURITY'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  if (tgt.system === 'SECURITY' && tgt.module === 'FIREWALL') return bad('The Firewall\'s own security cannot be switched off.');
  if (tgt.system === 'BLACKHAT_DB') return bad('No control over that host.');
  const on = str(q, 'security').toUpperCase() === 'ON';
  const m = c.s.modules[keyOf(tgt.system, tgt.module)];
  if (m.open === !on) return bad(`Security is already ${on ? 'on' : 'off'} for that module.`);
  m.open = !on;
  const label = targetLabel(tgt.system, tgt.module);
  return on
    ? good(`Security is back on for ${label}. Codes are required again.`, undefined, `switched security back on for ${label}`)
    : good(`Security is off for ${label}: anyone can use it without a code, and it is logged as Anonymous.`, undefined, `switched security OFF for ${label} (open access)`);
};

H['SECURITY.FIREWALL.BLOCK_ADDRESS'] = (c, q) => {
  const a = networkAddress(c, q);
  if (typeof a !== 'string') return bad(a.error);
  const current = activeBlock(c.s, a);
  if (current) return bad(`${a} is already blocked ${blockText(c.s, current)}.`);
  c.s.blocks = c.s.blocks.filter((b) => b.address !== a);
  c.s.blocks.push({ address: a, until: c.t + c.s.config.blockSec, byOwner: c.owner.id, actualPlayerId: c.actor.id });
  return good(`${a} is blocked for ${c.s.config.blockSec}s.`, undefined, `blocked ${a} for ${c.s.config.blockSec}s`);
};

H['SECURITY.FIREWALL.UNBLOCK_ADDRESS'] = (c, q) => {
  const a = networkAddress(c, q);
  if (typeof a !== 'string') return bad(a.error);
  const current = activeBlock(c.s, a);
  if (!current) return bad(`${a} is not blocked.`);
  if (current.until === null) return bad(`All access for ${a} was revoked. That cannot be undone.`);
  c.s.blocks = c.s.blocks.filter((b) => b !== current);
  return good(`${a} is unblocked.`, undefined, `unblocked ${a}`);
};

H['SECURITY.FIREWALL.CANCEL_REVOCATION'] = (c, q) => {
  const id = str(q, 'revocationId').toUpperCase().replace(/^(\d)/, 'R$1');
  const r = c.s.revocations.find((x) => x.id === id);
  if (!r || r.status !== 'PENDING') return bad('No pending revocation with that id.');
  r.status = 'CANCELLED';
  r.cancelledBy = c.owner.id;
  return good(`${r.id} cancelled. ${r.address} keeps its access.`, undefined, `cancelled ${r.id} (revoke all access for ${r.address})`);
};

H['SECURITY.FIREWALL.REVOKE_ALL_ACCESS'] = (c, q) => {
  const a = networkAddress(c, q);
  if (typeof a !== 'string') return bad(a.error);
  if (activeBlock(c.s, a)?.until === null) return bad(`All access for ${a} is already revoked.`);
  if (c.s.revocations.some((r) => r.address === a && r.status === 'PENDING')) return bad(`A revocation of ${a} is already counting down.`);
  const r: Revocation = {
    id: nextId(c.s, 'revoke', 'R'),
    address: a,
    startedAt: c.t,
    executeAt: c.t + c.s.config.revokeCountdownSec,
    byOwner: c.owner.id,
    actualPlayerId: c.actor.id,
    status: 'PENDING',
    cancelledBy: null,
  };
  c.s.revocations.push(r);
  return good(
    `${r.id}: all access for ${a} will be revoked in ${c.s.config.revokeCountdownSec}s. It can be cancelled from the Firewall until then.`,
    undefined,
    `started ${r.id}: revoke all access for ${a} in ${c.s.config.revokeCountdownSec}s`,
  );
};

H['SECURITY.FIREWALL.SET_MODULE_STATUS'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  if (tgt.system === 'SECURITY' && tgt.module === 'FIREWALL') return bad('The Firewall cannot be taken offline.');
  if (tgt.system === 'BLACKHAT_DB') return bad('No control over that host.');
  const status = str(q, 'status');
  if (status !== 'ONLINE' && status !== 'OFFLINE') return bad('Status must be ONLINE or OFFLINE.');
  const m = c.s.modules[keyOf(tgt.system, tgt.module)];
  if (m.status === status) return bad(`Module is already ${status.toLowerCase()}.`);
  const label = targetLabel(tgt.system, tgt.module);
  if (status === 'OFFLINE') {
    c.log(`took ${label} offline`); // written first: if this is the Master Log, nothing after it is recorded
    m.status = 'OFFLINE';
    return good(`${label} is now offline.`);
  }
  m.status = 'ONLINE';
  return good(`${label} is back online.`, undefined, `brought ${label} back online`);
};

// ---- Security: Master Log / Employees ----------------------------------------
/** PLAYERS: player activity; ALL: everything incl. system noise; ALERTS: security alerts (failed codes, hidden host traffic...). */
H['SECURITY.MASTER_LOG.VIEW_LOG'] = (c, q) => {
  const limit = clampInt(q.limit, 25, 1, 200);
  const show = str(q, 'show') || 'PLAYERS';
  if (show === 'ALERTS') {
    const rows = c.s.alerts
      .slice(-limit)
      .map((a) => `[${fmtClock(c.s.config, a.t)}] ${a.id.padEnd(5)} ${a.kind}: ${a.message}${a.logId ? ` (log ${a.logId})` : ''}`);
    return good(`Master Log alerts: ${rows.length}.`, rows.length ? rows : ['No alerts.']);
  }
  // Wiped entries (Cleanup / Log wiper) drop out here, leaving a visible gap in the ids; a Trace can still reach them.
  const entries = (show === 'ALL' ? c.s.logs : c.s.logs.filter((e) => e.actor !== 'SYSTEM')).filter((e) => !e.deleted);
  const rows = entries.slice(-limit).map((e) => `[${fmtClock(c.s.config, e.t)}] ${e.id.padEnd(5)} ${e.message}`);
  return good(`Master Log: ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.`, rows);
};

H['SECURITY.EMPLOYEE_RECORDS.RESET_LOCKOUT'] = (c, q) => {
  const ip = str(q, 'address');
  const p = Object.values(c.s.players).find((x) => x.ip === ip);
  if (!p) return bad('No workstation with that address.');
  if (p.lockedUntil <= c.t) return bad(`${ip} is not locked out.`);
  p.lockedUntil = 0;
  p.failStreak = 0;
  return good(`${ip} (${p.name}) is unlocked.`, undefined, `reset the lockout on ${ip} (${p.name})`);
};

/** Per workstation: last activity (from the machine, not the credential), failed attempts, lockout and firewall block. */
H['SECURITY.EMPLOYEE_RECORDS.VIEW_EMPLOYEES'] = (c) => {
  const rows = c.s.playerOrder.flatMap((id) => {
    const p = c.s.players[id];
    const active = p.lastActiveAt === null ? 'never' : `${fmtClock(c.s.config, p.lastActiveAt)} (${ago(c, p.lastActiveAt)})`;
    const flags = [
      p.lockedUntil > c.t ? `LOCKED OUT ${Math.ceil(p.lockedUntil - c.t)}s` : '',
      activeBlock(c.s, p.ip) ? `BLOCKED ${blockText(c.s, activeBlock(c.s, p.ip)!)}` : '',
    ].filter(Boolean);
    return [
      `${p.name.padEnd(10)} ${ROLES[p.role].label.padEnd(24)} ${p.ip}${flags.length ? '  ' + flags.map((x) => `[${x}]`).join(' ') : ''}`,
      `           last activity: ${active}   failed attempts: ${p.failTotal}`,
    ];
  });
  return good('Employee Records:', rows);
};

/**
 * One true but partial clue about hidden host activity:
 * a range of four workstations, a pair (real + decoy), one number of the server's address, or what was done.
 */
function relayClue(s: GameState, ip: string, activity?: string): string {
  const ips = s.playerOrder.map((id) => s.players[id].ip);
  const last = (x: string): number => Number(x.split('.').pop());
  const kinds = ['RANGE', 'PAIR', 'SERVER', ...(activity ? ['ACTIVITY'] : [])];
  const kind = pick(s, kinds);
  if (kind === 'RANGE' && ips.length > 4) {
    const nums = ips.map(last).sort((a, b) => a - b);
    const lo = nums[0];
    const hi = nums[nums.length - 1];
    const start = Math.min(Math.max(last(ip) - randInt(s, 0, 3), lo), hi - 3);
    const prefix = ip.split('.').slice(0, 3).join('.');
    return `The origin workstation is within ${prefix}.${start}-${start + 3}.`;
  }
  if (kind === 'SERVER') {
    const parts = s.hiddenHost.split('.');
    const keep = randInt(s, 0, parts.length - 1);
    return `The server's IP address is ${parts.map((p, i) => (i === keep ? p : 'x')).join('.')}.`;
  }
  if (kind === 'ACTIVITY') return `Activity performed: ${activity}.`;
  const others = ips.filter((x) => x !== ip);
  const decoy = others.length ? pick(s, others) : ip;
  const pair = rand(s) < 0.5 ? [ip, decoy] : [decoy, ip];
  return `The origin is one of two workstations: ${pair[0]} or ${pair[1]}.`;
}

/**
 * What a trace of a hidden host entry reveals, by the action's exposure tier:
 * 1-2 (vague): one partial clue; 3 (loud): one exact fact, the operative's IP or the server's address;
 * 4 (reckless): the operative's IP and a working host credential code (their own).
 * Tier 1 follows the recorded (possibly rerouted) source; tier 2+ is always about the real operative.
 */
function exposureClue(s: GameState, e: LogEntry): string {
  const tier = e.exposure ?? 1;
  const real = e.actualPlayerId ? s.players[e.actualPlayerId] : undefined;
  const ip = tier >= 2 && real ? real.ip : e.sourceIp!;
  if (tier <= 2) return relayClue(s, ip, e.activity);
  if (tier === 3) {
    return rand(s) < 0.5 ? `The relay leaked the origin workstation: ${ip}.` : `The relay leaked the server's address: ${s.hiddenHost}.`;
  }
  const code = real ? ownHostCode(s, real) : null;
  return `The relay leaked the origin workstation: ${ip}.${code ? ` Captured host access code: ${code}.` : ''}`;
}

H['SECURITY.MASTER_LOG.TRACE'] = (c, q) => {
  const id = normLog(str(q, 'logId'));
  const e = c.s.logs.find((x) => x.id === id);
  if (!e) return bad(`No such log entry: ${id}.`);
  const wait = c.actor.lastTraceAt + c.s.config.traceCooldownSec - c.t;
  if (wait > 0) return bad(`Trace engine cooling down (${Math.ceil(wait)}s).`);
  if (c.t - e.t > c.s.config.traceMaxAgeSec) return bad('That entry is too old to trace.');
  c.actor.lastTraceAt = c.t;
  if (!e.sourceIp) return good(`Trace ${e.id}: system event, no workstation origin.`, undefined, `ran a trace on ${e.id}`);
  // Hidden host traffic is relayed. What a trace returns escalates with the action's exposure tier.
  if (e.kind === 'HIDDEN_ACCESS') {
    const clue = exposureClue(c.s, e);
    // The host notices: operatives see who traced it and what the bank learned.
    addHostLog(c.s, `Relay entry ${e.id} was traced by ${c.owner.name}. The bank learned: ${clue}`, true);
    return good(`Trace ${e.id}: routed through a relay. ${clue}`, undefined, `ran a trace on ${e.id}`);
  }
  return good(`Trace ${e.id}: origin workstation ${e.sourceIp}`, undefined, `ran a trace on ${e.id}`);
};

// ---- Client Data ------------------------------------------------------------
// ---- Client Requests -----------------------------------------------------------------------------
// A banker sees requests addressed to the credential's OWNER (so a borrowed code shows its owner's
// inbox). A whole-system Client Data credential is a supervisor and sees everyone's.

const seesAllRequests = (c: Ctx): boolean => c.cred.system === 'CLIENT_DATA' && c.cred.module === null;
const canSeeRequest = (c: Ctx, r: ClientRequest): boolean => seesAllRequests(c) || r.bankerId === c.owner.id;

function requestStatusText(c: Ctx, r: ClientRequest): string {
  if (r.status === 'OPEN') return '[OPEN]';
  const by = r.closedBy ? ` by ${nameOf(c.s, r.closedBy)}` : '';
  if (r.status === 'DONE') return `[DONE${r.txId ? `: ${r.txId}` : ''}${by}]`;
  return `[ARCHIVED${by}${r.archiveReason ? `: "${r.archiveReason}"` : ''}]`;
}

/** Optional request id to link to an action: null if blank, the open request of the right kind, or an error. */
const KIND_TEXT: Record<RequestKind, string> = {
  PAYMENT: 'a payment',
  ADD_ACCOUNT: 'a new account',
  ADD_AND_PRIMARY: 'a new primary account',
  SET_PRIMARY: 'a primary account change',
  REMOVE_ACCOUNT: 'an account removal',
};

function linkedRequest(c: Ctx, q: Params, kinds: RequestKind[]): ClientRequest | null | string {
  const raw = str(q, 'requestId');
  if (!raw) return null;
  const r = c.s.requests.find((x) => x.id === normReq(raw));
  if (!r) return 'No such client request.';
  if (r.status !== 'OPEN') return `${r.id} is already ${r.status === 'DONE' ? 'done' : 'archived'}.`;
  if (!kinds.includes(r.kind)) return `${r.id} asks for ${KIND_TEXT[r.kind]}, not this.`;
  return r;
}

function closeRequest(c: Ctx, r: ClientRequest, status: 'DONE' | 'ARCHIVED', extra: { txId?: string; reason?: string } = {}): void {
  r.status = status;
  r.closedAt = c.t;
  r.closedBy = c.owner.id;
  r.closedByActual = c.actor.id;
  r.txId = extra.txId ?? null;
  r.archiveReason = extra.reason ?? null;
}

H['CLIENT_DATA.CLIENT_REQUESTS.VIEW_REQUESTS'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  const rows = c.s.requests.filter((r) => canSeeRequest(c, r) && (all || r.status === 'OPEN')).slice(-30);
  const whose = seesAllRequests(c) ? 'All client requests' : `Client requests for ${c.owner.name}`;
  const lines = rows.flatMap((r) => {
    const cust = c.s.customers.find((x) => x.id === r.customerId);
    const to = r.bankerId ? nameOf(c.s, r.bankerId) : 'nobody';
    return [`${r.id.padEnd(7)} ${fmtClock(c.s.config, r.t)}  ${cust?.name ?? '?'} -> ${to}  ${requestStatusText(c, r)}`, `        "${r.text}"`];
  });
  const n = rows.length;
  return good(`${whose} (${all ? 'all' : 'open'}): ${n} request${n === 1 ? '' : 's'}.`, n ? lines : ['Nothing here.']);
};

H['CLIENT_DATA.CLIENT_REQUESTS.ARCHIVE_REQUEST'] = (c, q) => {
  const r = c.s.requests.find((x) => x.id === normReq(str(q, 'requestId')));
  if (!r || !canSeeRequest(c, r)) return bad('No such client request.');
  if (r.status !== 'OPEN') return bad(`${r.id} is already ${r.status === 'DONE' ? 'done' : 'archived'}.`);
  const why = reasonOf(q);
  if (!why) return bad('Type a reason for archiving it.');
  closeRequest(c, r, 'ARCHIVED', { reason: why });
  return good(`${r.id} archived.`, undefined, `archived client request ${r.id}`);
};

/** "Read & write · Settlement" / "Read only · all of Client Data": how players see a credential's reach. */
function scopeLabel(cr: Credential): string {
  const access = cr.permission === 'WRITE' ? 'Read & write' : 'Read only';
  const where = cr.fn
    ? (findModule(cr.system, cr.module ?? '')?.fns.find((x) => x.id === cr.fn)?.label ?? cr.fn)
    : cr.module
      ? (findModule(cr.system, cr.module)?.label ?? cr.module)
      : `all of ${findSystem(cr.system)?.label ?? cr.system}`;
  return `${access} · ${where}`;
}

H['SECURITY.PERMISSIONS.VIEW_PERMISSIONS'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  const rows = Object.values(c.s.credentials)
    // The unregistered host is not part of the bank: its credentials never appear here.
    .filter((cr) => cr.system !== 'BLACKHAT_DB')
    .filter((cr) => all || cr.status === 'ACTIVE')
    .map((cr) => {
      const by = cr.issuedBy === null ? 'start of shift' : nameOf(c.s, cr.issuedBy);
      return `${cr.id.padEnd(4)} ${nameOf(c.s, cr.owner).padEnd(10)} ${scopeLabel(cr).padEnd(44)} ${cr.status.padEnd(8)} issued: ${by}`;
    });
  return good(`Permissions registry (${all ? 'all' : 'active'}, codes hidden): ${rows.length}.`, rows);
};

H['SECURITY.PERMISSIONS.CREATE_CREDENTIAL'] = (c, q) => {
  const owner = c.s.players[str(q, 'owner')];
  if (!owner) return bad('Choose an employee to issue to.');
  const [sys, mod] = str(q, 'scope').split('.');
  const sysDef = findSystem(sys);
  if (!sysDef || sysDef.hidden || !c.actor.knownSystems.includes(sysDef.id)) return bad('Unknown system.');
  if (mod !== '*' && !findModule(sys, mod)) return bad('Unknown module.');
  const permission = str(q, 'permission');
  if (permission !== 'READ' && permission !== 'WRITE') return bad('Permission must be READ or WRITE.');
  const cred = createCredential(c.s, {
    owner: owner.id,
    system: sysDef.id,
    module: mod === '*' ? null : mod,
    permission,
    issuedBy: c.owner.id,
  });
  for (const p of [owner, c.actor]) if (!p.heldCredentialIds.includes(cred.id)) p.heldCredentialIds.push(cred.id);
  if (owner.id !== c.actor.id) note(owner, c.t, `A new credential ${cred.id} (${scopeText(cred)}) was issued to you. Code ${cred.code}.`);
  return good(`Credential ${cred.id} (${scopeLabel(cred)}) issued to ${owner.name}. Code: ${cred.code}`, undefined, `issued credential ${cred.id} to ${owner.name} (${scopeText(cred)})`);
};

H['SECURITY.PERMISSIONS.REVOKE_CREDENTIAL'] = (c, q) => {
  const cr = c.s.credentials[normCred(str(q, 'credentialId'))];
  if (!cr) return bad('No such credential.');
  if (cr.status === 'REVOKED') return bad('Already revoked.');
  cr.status = 'REVOKED';
  const owner = c.s.players[cr.owner];
  if (owner.id !== c.actor.id) note(owner, c.t, `Your credential ${cr.id} (${scopeText(cr)}) was revoked.`);
  return good(`Credential ${cr.id} revoked.`, undefined, `revoked credential ${cr.id} (${owner.name})`);
};

// ---- Client Data: Customer Records ------------------------------------------------------------------
// Payments to a customer land in their PRIMARY account at settlement. Accounts can be added (any number
// nobody else owns, including "floating" ones), made primary, or removed (never the primary). Every change
// gets an id and waits in the Verification queue.

const findCustomer = (c: Ctx, q: Params): Customer | undefined => c.s.customers.find((x) => x.id === normCust(str(q, 'customerId')));

/** Customer for a change command: must be one of the credential owner's customers, unless the credential covers all of Client Data. */
function ownCustomer(c: Ctx, q: Params): Customer | string {
  const x = findCustomer(c, q);
  if (!x) return 'No such customer.';
  if (!seesAllCustomers(c) && x.bankerId !== c.owner.id) return `${x.id} is not one of ${c.owner.name}'s customers.`;
  return x;
}

/** Like Client Requests: bankers see their own customers (by credential owner); a whole-system Client Data credential sees all. */
const seesAllCustomers = (c: Ctx): boolean => c.cred.system === 'CLIENT_DATA' && c.cred.module === null;

const accountText = (x: Customer, a: string): string => `${a}${accountVerified(x, a) ? '' : ' (unverified)'}`;

function customerLines(c: Ctx, x: Customer): string[] {
  const others = x.accounts.filter((a) => a !== x.primary);
  return [
    `${x.id.padEnd(5)} ${x.name.padEnd(22)} primary ${accountText(x, x.primary)}  banker: ${x.bankerId ? nameOf(c.s, x.bankerId) : '-'}`,
    `      other accounts: ${others.length ? others.map((a) => accountText(x, a)).join(', ') : 'none'}`,
  ];
}

function recordAccountChange(c: Ctx, x: Customer, action: AccountChange['action'], account: string, previousPrimary: string): AccountChange {
  const change: AccountChange = {
    id: nextId(c.s, 'change', 'CH-'),
    customerId: x.id,
    t: c.t,
    action,
    account,
    previousPrimary,
    byOwner: c.owner.id,
    actualPlayerId: c.actor.id,
    verified: false,
    verifiedBy: null,
    verifiedAt: null,
  };
  x.history.push(change);
  x.lastModifiedAt = c.t;
  return change;
}

/** Switching the primary redirects every future payment to this customer. */
function makePrimary(c: Ctx, x: Customer, account: string): AccountChange {
  const previous = x.primary;
  x.primary = account;
  return recordAccountChange(c, x, 'SET_PRIMARY', account, previous);
}

H['CLIENT_DATA.CUSTOMER_RECORDS.VIEW_CUSTOMERS'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  if (all && !seesAllCustomers(c)) return bad('Viewing all customers needs a credential for all of Client Data.');
  const rows = c.s.customers.filter((x) => all || x.bankerId === c.owner.id);
  const title = all ? 'Customer Records (all customers)' : `Customer Records: customers of ${c.owner.name}`;
  return good(`${title}: ${rows.length}.`, rows.length ? rows.flatMap((x) => customerLines(c, x)) : ['Nothing here.']);
};

H['CLIENT_DATA.CUSTOMER_RECORDS.ADD_ACCOUNT'] = (c, q) => {
  const x = ownCustomer(c, q);
  if (typeof x === 'string') return bad(x);
  const acc = normAccount(str(q, 'account'));
  if (!acc) return bad('Account must be 5 digits.');
  if (x.accounts.includes(acc)) return bad(`${acc} is already on ${x.id}.`);
  if (accountOwner(c.s, acc)) return bad(`${acc} belongs to another customer.`);
  const primary = str(q, 'makePrimary').toUpperCase() === 'YES';
  const req = linkedRequest(c, q, ['ADD_ACCOUNT', 'ADD_AND_PRIMARY']);
  if (typeof req === 'string') return bad(req);
  x.accounts.push(acc);
  const ids = [recordAccountChange(c, x, 'ADD_ACCOUNT', acc, x.primary).id];
  if (primary) ids.push(makePrimary(c, x, acc).id);
  if (req) closeRequest(c, req, 'DONE');
  return good(
    `${acc} added to ${x.id} ${x.name}${primary ? ' as their primary account' : ''}. Waiting for verification: ${ids.join(', ')}.${req ? ` ${req.id} is done.` : ''}`,
    undefined,
    `added account ${acc} to ${x.id}${primary ? ' as primary' : ''}${req ? ` for ${req.id}` : ''}`,
  );
};

H['CLIENT_DATA.CUSTOMER_RECORDS.SET_PRIMARY'] = (c, q) => {
  const x = ownCustomer(c, q);
  if (typeof x === 'string') return bad(x);
  const acc = normAccount(str(q, 'account'));
  if (!acc) return bad('Account must be 5 digits.');
  if (!x.accounts.includes(acc)) return bad(`${acc} is not one of ${x.id}'s accounts. Add it first.`);
  if (x.primary === acc) return bad(`${acc} is already ${x.id}'s primary account.`);
  const req = linkedRequest(c, q, ['SET_PRIMARY', 'ADD_AND_PRIMARY']);
  if (typeof req === 'string') return bad(req);
  const change = makePrimary(c, x, acc);
  if (req) closeRequest(c, req, 'DONE');
  return good(
    `${x.id} ${x.name} is now paid into ${acc}. Waiting for verification: ${change.id}.${req ? ` ${req.id} is done.` : ''}`,
    undefined,
    `set ${x.id}'s primary account to ${acc}${req ? ` for ${req.id}` : ''}`,
  );
};

H['CLIENT_DATA.CUSTOMER_RECORDS.REMOVE_ACCOUNT'] = (c, q) => {
  const x = ownCustomer(c, q);
  if (typeof x === 'string') return bad(x);
  const acc = normAccount(str(q, 'account'));
  if (!acc) return bad('Account must be 5 digits.');
  if (!x.accounts.includes(acc)) return bad(`${acc} is not one of ${x.id}'s accounts.`);
  if (x.primary === acc) return bad(`${acc} is ${x.id}'s primary account. Make another account primary first.`);
  const req = linkedRequest(c, q, ['REMOVE_ACCOUNT']);
  if (typeof req === 'string') return bad(req);
  x.accounts = x.accounts.filter((a) => a !== acc);
  const change = recordAccountChange(c, x, 'REMOVE_ACCOUNT', acc, x.primary);
  if (req) closeRequest(c, req, 'DONE');
  return good(
    `${acc} removed from ${x.id} ${x.name}. Waiting for verification: ${change.id}.${req ? ` ${req.id} is done.` : ''}`,
    undefined,
    `removed account ${acc} from ${x.id}${req ? ` for ${req.id}` : ''}`,
  );
};

// ---- Client Data: Verification ---------------------------------------------------------------------

const allChanges = (s: GameState): AccountChange[] => s.customers.flatMap((x) => x.history).sort((a, b) => a.t - b.t || Number(a.id.slice(3)) - Number(b.id.slice(3)));

function changeLine(c: Ctx, h: AccountChange): string {
  const x = c.s.customers.find((y) => y.id === h.customerId);
  const what =
    h.action === 'ADD_ACCOUNT' ? `added ${h.account}` : h.action === 'REMOVE_ACCOUNT' ? `removed ${h.account}` : `primary ${h.previousPrimary} -> ${h.account}`;
  const status = h.verified ? `[VERIFIED by ${h.verifiedBy ? nameOf(c.s, h.verifiedBy) : '?'}]` : '[UNVERIFIED]';
  return `${h.id.padEnd(6)} ${fmtClock(c.s.config, h.t)}  ${h.customerId.padEnd(4)} ${(x?.name ?? '?').padEnd(22)} ${what}  by ${nameOf(c.s, h.byOwner)}  ${status}`;
}

/** PENDING: account changes nobody has verified yet. ALL: the most recent changes. */
H['CLIENT_DATA.VERIFICATION.VIEW_VERIFICATION'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  const rows = allChanges(c.s)
    .filter((h) => all || !h.verified)
    .slice(-40)
    .map((h) => changeLine(c, h));
  const n = rows.length;
  return good(`Verification queue (${all ? 'all' : 'pending'}): ${n} change${n === 1 ? '' : 's'}.`, n ? rows : ['Nothing here.']);
};

/** "CU3" -> that customer's changes; "12345" / "ACC-12345" -> that account's changes across every customer. */
H['CLIENT_DATA.VERIFICATION.INVESTIGATE_CHANGES'] = (c, q) => {
  const raw = str(q, 'target');
  const acc = normAccount(raw);
  if (acc) {
    const rows = allChanges(c.s).filter((h) => h.account === acc || (h.action === 'SET_PRIMARY' && h.previousPrimary === acc));
    const owner = accountOwner(c.s, acc);
    const now = owner ? `on ${owner.id} ${owner.name}${owner.primary === acc ? ' (primary)' : ''}` : 'floating (no customer)';
    return good(`${acc}: now ${now}. ${rows.length} change${rows.length === 1 ? '' : 's'}.`, rows.map((h) => changeLine(c, h)), `investigated changes to account ${acc}`);
  }
  const x = c.s.customers.find((y) => y.id === normCust(raw));
  if (!x) return bad('Enter a customer (CU3) or a 5-digit account.');
  const n = x.history.length;
  return good(
    `${x.id} ${x.name}: ${n} change${n === 1 ? '' : 's'}. Opened with primary ${x.originalPrimary}; primary now ${x.primary}.`,
    x.history.map((h) => changeLine(c, h)),
    `investigated account changes for ${x.id}`,
  );
};

H['CLIENT_DATA.VERIFICATION.VERIFY_CHANGE'] = (c, q) => {
  const id = normChange(str(q, 'changeId'));
  const h = allChanges(c.s).find((x) => x.id === id);
  if (!h) return bad('No such change.');
  if (h.verified) return bad(`${h.id} is already verified.`);
  h.verified = true;
  h.verifiedBy = c.owner.id;
  h.verifiedAt = c.t;
  return good(`${h.id} verified.`, undefined, `verified account change ${h.id} on ${h.customerId}`);
};

// ---- Transaction Processing --------------------------------------------------
/** For payment history: the records name the credential owner; the truth is who typed it. */
const who = (c: Ctx): TxActor => ({ by: c.owner.id, actualPlayerId: c.actor.id });
/** A typed reason: trimmed, capped, or null if empty. */
const reasonOf = (q: Params): string | null => str(q, 'reason').trim().slice(0, 200) || null;

const ACTIVE = ['QUEUED', 'RISK_CHECKED', 'AUTHORIZED', 'HELD'];
/** "CU5 ACC-13845 -> CU2 ACC-79039": originator and the account used, then the payee and their CURRENT primary. */
function payLine(c: Ctx, tx: Transaction): string {
  const payee = c.s.customers.find((x) => x.id === tx.beneficiaryId);
  return `${tx.customerId} ${tx.originAccount} -> ${tx.beneficiaryId} ${payee?.primary ?? '?'}`;
}

function txLine(c: Ctx, tx: Transaction): string {
  const risk = tx.riskResult ? ` risk ${tx.riskResult}` : '';
  return `${tx.id}  ${money(tx.amount).padStart(11)}  ${payLine(c, tx)}  [${tx.status}${risk}]${tx.requestId ? `  for ${tx.requestId}` : ''}`;
}

H['TRANSACTIONS.PAYMENT_QUEUE.VIEW_QUEUE'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  const rows = c.s.transactions.filter((tx) => all || ACTIVE.includes(tx.status)).slice(-40).map((tx) => txLine(c, tx));
  return good(`Payment Queue: ${rows.length} payment${rows.length === 1 ? '' : 's'}.`, rows);
};

H['TRANSACTIONS.PAYMENT_QUEUE.CREATE_TRANSACTION'] = (c, q) => {
  const acc = normAccount(str(q, 'originAccount'));
  const origin = acc ? accountOwner(c.s, acc) : undefined;
  if (!acc || !origin) return bad('No customer account with that number.');
  const b = c.s.customers.find((x) => x.id === normCust(str(q, 'beneficiaryId')));
  if (!b) return bad('No such customer to pay.');
  const amount = Math.round(Number(str(q, 'amount')));
  if (!Number.isFinite(amount) || amount <= 0) return bad('Enter a positive amount.');
  if (amount > c.s.config.maxManualAmount) return bad(`Manual payments are capped at ${money(c.s.config.maxManualAmount)}.`);
  const req = linkedRequest(c, q, ['PAYMENT']);
  if (typeof req === 'string') return bad(req);
  const tx: Transaction = {
    id: nextId(c.s, 'tx', 'TX-', 4),
    amount,
    customerId: origin.id,
    originAccount: acc,
    beneficiaryId: b.id,
    origin: 'PLAYER',
    createdBy: c.owner.id,
    channel: null,
    status: 'QUEUED',
    createdAt: c.t,
    riskResult: null,
    riskFlags: [],
    riskReason: null,
    authorizedBy: null,
    settledAt: null,
    settledTo: null,
    debitedFrom: null,
    fraud: false,
    history: [],
    requestId: req ? req.id : null,
  };
  c.s.transactions.push(tx);
  const forReq = req ? ` for ${req.id}` : '';
  recordTx(c.s, tx, 'CREATED', who(c), `manual: ${money(amount)} from ${acc} to ${b.id}${forReq}`);
  if (req) closeRequest(c, req, 'DONE', { txId: tx.id });
  return good(`Queued ${tx.id}.${req ? ` ${req.id} is done.` : ''}`, undefined, `created payment ${tx.id} (${money(amount)}) from ${origin.name} to ${b.name}${forReq}`);
};

H['TRANSACTIONS.RISK_CHECK.RUN_RISK_CHECK'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'QUEUED' && tx.status !== 'RISK_CHECKED') return bad(`${tx.id} is ${tx.status}; it cannot be risk checked.`);
  const score = str(q, 'score').toUpperCase();
  if (score !== 'LOW' && score !== 'MEDIUM' && score !== 'HIGH') return bad('Pick a risk score: LOW, MEDIUM or HIGH.');
  const why = reasonOf(q);
  if (!why) return bad('Type a reason for the score.');
  tx.riskResult = score;
  tx.riskReason = why;
  tx.riskFlags = computeRisk(c.s, tx).flags; // hidden ground truth: what the system would have flagged
  tx.status = 'RISK_CHECKED';
  recordTx(c.s, tx, 'RISK_CHECKED', who(c), `risk ${score}: ${why}`);
  return good(`${tx.id}: scored ${score} risk.`, undefined, `scored ${tx.id} as ${score} risk`);
};

H['TRANSACTIONS.AUTHORIZATION.APPROVE'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'RISK_CHECKED' && tx.status !== 'HELD') return bad(`${tx.id} is ${tx.status}; it cannot be approved.`);
  if (!tx.riskResult) return bad('Run a risk check first.');
  tx.status = 'AUTHORIZED';
  tx.authorizedBy = c.owner.id;
  recordTx(c.s, tx, 'APPROVED', who(c), reasonOf(q));
  return good(`${tx.id} approved.`, undefined, `approved ${tx.id}`);
};

H['TRANSACTIONS.AUTHORIZATION.REJECT'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (!ACTIVE.includes(tx.status)) return bad(`${tx.id} is ${tx.status}; it cannot be rejected.`);
  const why = reasonOf(q);
  if (!why) return bad('Type a reason for rejecting it.');
  tx.status = 'REJECTED';
  recordTx(c.s, tx, 'REJECTED', who(c), why);
  return good(`${tx.id} rejected.`, undefined, `rejected ${tx.id}`);
};

H['TRANSACTIONS.AUTHORIZATION.HOLD'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'QUEUED' && tx.status !== 'RISK_CHECKED' && tx.status !== 'AUTHORIZED') return bad(`${tx.id} is ${tx.status}; it cannot be held.`);
  const why = reasonOf(q);
  if (!why) return bad('Type a reason for holding it.');
  tx.status = 'HELD';
  recordTx(c.s, tx, 'HELD', who(c), why);
  return good(`${tx.id} held.`, undefined, `held ${tx.id}`);
};

H['TRANSACTIONS.SETTLEMENT.SETTLE'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'AUTHORIZED') return bad(`${tx.id} is ${tx.status}; only approved payments can be settled.`);
  const r = settleTransaction(c.s, tx, who(c));
  return good(`${tx.id} settled: ${money(tx.amount)} paid to ${r.account} (${tx.beneficiaryId}'s primary).`, undefined, `settled ${tx.id}`);
};

H['TRANSACTIONS.SETTLEMENT.REVERSE'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'SETTLED' || tx.settledAt === null) return bad(`${tx.id} is ${tx.status}; only settled payments can be reversed.`);
  if (c.t - tx.settledAt > c.s.config.reversalWindowSec) return bad('The reversal window has closed.');
  reverseTransaction(c.s, tx, who(c));
  return good(`${tx.id} reversed.`, undefined, `reversed ${tx.id}`);
};

// ---- Stage inboxes: "what's waiting for me?" (PENDING) and "what did I just do?" (ALL) ----------
// Two lines per payment: what it is, then who handled it and when. Names are credential owners (what the
// records say), never who really typed. Automatic risk flags are never shown: judging risk is the player's job.

const lastEvent = (tx: Transaction, action: TxEvent['action']): TxEvent | undefined =>
  [...tx.history].reverse().find((e) => e.action === action);

/** Who a history step is attributed to: a player, the payment's channel, or the (debug) auto-processor. */
function eventBy(c: Ctx, tx: Transaction, e: TxEvent): string {
  if (e.by !== 'SYSTEM') return nameOf(c.s, e.by);
  return e.action === 'CREATED' ? (tx.channel ?? 'SYSTEM') : 'Auto-processor';
}

const quoted = (text: string | null): string => (text ? `: "${text}"` : '');

function ago(c: Ctx, t: number): string {
  const s = Math.max(0, Math.floor(c.t - t));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

const PAST: Record<TxEvent['action'], string> = {
  CREATED: 'created',
  RISK_CHECKED: 'checked',
  APPROVED: 'approved',
  HELD: 'held',
  REJECTED: 'rejected',
  SETTLED: 'settled',
  REVERSED: 'reversed',
};

type Stage = 'RISK' | 'AUTH' | 'SETTLE';

function stageLines(c: Ctx, tx: Transaction, stage: Stage): string[] {
  let head = `${tx.id}  ${money(tx.amount).padStart(11)}  ${payLine(c, tx)}  [${tx.status}]`;
  // The risk queue warns about accounts with account changes nobody has verified yet.
  if (stage === 'RISK') {
    const payee = c.s.customers.find((x) => x.id === tx.beneficiaryId);
    const payer = c.s.customers.find((x) => x.id === tx.customerId);
    const warn: string[] = [];
    if (payee && !accountVerified(payee, payee.primary)) warn.push("payee's primary");
    if (payer && !accountVerified(payer, tx.originAccount)) warn.push('originator account');
    if (warn.length) head += `  !! UNVERIFIED: ${warn.join(', ')}`;
  }

  // Each shown step remembers its event, so "how long ago" can be attached to the latest one instead of repeated.
  const parts: { text: string; e?: TxEvent }[] = [];
  if (tx.requestId) parts.push({ text: `for ${tx.requestId}` });
  const created = lastEvent(tx, 'CREATED');
  if (stage === 'RISK' && created) parts.push({ text: `created ${fmtClock(c.s.config, created.t)} by ${eventBy(c, tx, created)}`, e: created });
  const checked = lastEvent(tx, 'RISK_CHECKED');
  if (checked && tx.riskResult) parts.push({ text: `risk ${tx.riskResult} by ${eventBy(c, tx, checked)}${quoted(tx.riskReason)}`, e: checked });
  const approved = lastEvent(tx, 'APPROVED');
  if (stage === 'SETTLE' && approved) parts.push({ text: `approved by ${eventBy(c, tx, approved)}${quoted(approved.detail)}`, e: approved });
  const last = tx.history.at(-1);
  const shown = last && parts.find((p) => p.e === last);
  if (shown) shown.text += ` (${ago(c, last.t)})`;
  else if (last) {
    const why = last.action === 'APPROVED' || last.action === 'HELD' || last.action === 'REJECTED' ? quoted(last.detail) : '';
    parts.push({ text: `${PAST[last.action]} by ${eventBy(c, tx, last)}${why} (${ago(c, last.t)})` });
  }
  if (tx.status === 'SETTLED' && tx.settledAt !== null) {
    const left = c.s.config.reversalWindowSec - (c.t - tx.settledAt);
    if (left > 0) parts.push({ text: `reversible for ${Math.ceil(left)}s` });
  }

  return [head, `         ${parts.map((p) => p.text).join('   ')}`];
}

function stageView(c: Ctx, q: Record<string, string>, stage: Stage, title: string, pending: TxStatus[], all: (tx: Transaction) => boolean): HandlerResult {
  const showAll = str(q, 'show') === 'ALL';
  const rows = c.s.transactions
    .filter((tx) => (showAll ? all(tx) : pending.includes(tx.status)))
    .slice(-40);
  const n = rows.length;
  return good(`${title} (${showAll ? 'all' : 'pending'}): ${n} payment${n === 1 ? '' : 's'}.`, n ? rows.flatMap((tx) => stageLines(c, tx, stage)) : ['Nothing here.']);
}

H['TRANSACTIONS.RISK_CHECK.VIEW_RISK_QUEUE'] = (c, q) =>
  stageView(c, q, 'RISK', 'Risk queue', ['QUEUED'], (tx) =>
    tx.status === 'QUEUED' || tx.status === 'RISK_CHECKED' || (tx.status === 'HELD' && tx.riskResult !== null),
  );

H['TRANSACTIONS.AUTHORIZATION.VIEW_AUTH_QUEUE'] = (c, q) =>
  stageView(c, q, 'AUTH', 'Authorization queue', ['RISK_CHECKED', 'HELD'], (tx) =>
    tx.riskResult !== null && ['RISK_CHECKED', 'HELD', 'AUTHORIZED', 'REJECTED'].includes(tx.status),
  );

H['TRANSACTIONS.SETTLEMENT.VIEW_SETTLEMENT'] = (c, q) =>
  stageView(c, q, 'SETTLE', 'Settlement queue', ['AUTHORIZED'], (tx) => ['AUTHORIZED', 'SETTLED', 'REVERSED'].includes(tx.status));

// ---- Hidden host: tool kits & exposure ----------------------------------------
// Black Hat tools have no cooldowns or charges; they are balanced by exposure. Each tool tags its "Unknown
// server activity" entry with a tier: tier 2+ raises an alert pointing at the entry (never naming anyone),
// and a trace of the entry reveals more the higher the tier, always about the REAL operative (tier 2+).
type ExposureTier = 1 | 2 | 3 | 4;

/** An active host credential code the operative owns, if any (the strongest exposure hands over a working one). */
function ownHostCode(s: GameState, actor: Player): string | null {
  const cr = Object.values(s.credentials).find((x) => x.owner === actor.id && x.system === 'BLACKHAT_DB' && x.status === 'ACTIVE');
  return cr?.code ?? null;
}

/** Alert text per tier. It never says who or where; it only points at the log entry to trace. */
const EXPOSURE_ALERT: Record<number, string> = {
  2: 'Suspicious server activity',
  3: 'Intrusion alert: unauthorized server activity',
  4: 'Critical breach: unauthorized server activity',
};
/** What the operatives are told a trace would give away. */
const EXPOSURE_LEAK: Record<number, string> = {
  2: 'a vague clue',
  3: 'the operative\'s exact IP or the server\'s address',
  4: 'the operative\'s exact IP and their host access code',
};

/** Raises the exposure alert for a hidden host entry (tier 2+) and warns the operatives in the Host Log. */
function exposeEntry(s: GameState, entry: LogEntry, tier: ExposureTier, kind = 'UNAUTHORIZED_ACTION', message = EXPOSURE_ALERT[tier]): void {
  entry.exposure = tier;
  if (tier === 1) return; // tier 1: no alert, just the cryptic entry
  if (!addAlert(s, kind, message, entry.id, tier)) return; // muted: the bank never saw it, so no warning either
  addHostLog(s, `An operative's action raised an alert on log ${entry.id}. A trace of it gives the bank ${EXPOSURE_LEAK[tier]}.`, true);
}

/**
 * The cost of a Black Hat tool. Its "Unknown server activity" entry is tagged with the tier, so a trace of it
 * reveals more the louder the tool; tier 2+ also raises an alert pointing at that entry.
 */
function raiseExposure(c: Ctx, tier: ExposureTier): void {
  exposeEntry(c.s, c.log(), tier);
}

/** A hidden host entry for background work (no Ctx), e.g. a running Code crack. */
function hiddenEntry(s: GameState, actor: Player, activity: string): LogEntry {
  return addLog(s, { actor: 'SYSTEM', kind: 'HIDDEN_ACCESS', message: 'Unknown server activity', sourceIp: effectiveIp(s, actor, gameTime(s)), actualPlayerId: actor.id, activity });
}

// ---- Infiltration -------------------------------------------------------------
/** Insert a fabricated employee into the bank's records: a real player row (so it can own credentials and
 *  show in Employee Records), flagged `fake` and kept out of the sandbox seat picker. Poses as White staff. */
function plantUser(s: GameState, name: string, role: RoleId, ip: string): Player {
  const p: Player = {
    id: nextId(s, 'player', 'FAKE'),
    name,
    role,
    allegiance: 'WHITE',
    objective: '',
    motivation: '',
    ip,
    bankAccount: '',
    heldCredentialIds: [],
    knownSystems: ['SECURITY', 'CLIENT_DATA', 'TRANSACTIONS'],
    packets: [],
    activity: [],
    messages: [],
    failStreak: 0,
    lockedUntil: 0,
    lastTraceAt: -9999,
    failTotal: 0,
    lastActiveAt: null,
    monitoring: [],
    remoteAccess: [],
    fake: true,
  };
  s.players[p.id] = p;
  s.playerOrder.push(p.id);
  return p;
}

H['BLACKHAT_DB.INFILTRATION.CREATE_USER'] = (c, q) => {
  const name = str(q, 'name').slice(0, 24);
  if (!name) return bad('Enter a name for the user.');
  const role = str(q, 'role').toUpperCase() as RoleId;
  if (!ROLES[role]) return bad('Pick a role from the list.');
  const ip = str(q, 'ip');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return bad('Enter an IP address, e.g. 10.1.0.30.');
  const p = plantUser(c.s, name, role, ip);
  raiseExposure(c, 2);
  return good(`${p.name} (${ROLES[role].label}) planted at ${ip}. They now appear in Employee Records; issue them credentials from Permissions.`);
};

// ---- Access -------------------------------------------------------------------
/** A partly-recovered code: revealed digits shown, the rest as underscores ("3 7 _ _"). */
const maskedCode = (code: string, revealed: number): string => code.split('').map((d, i) => (i < revealed ? d : '_')).join(' ');

/**
 * Advances every running Code crack (called from the engine's time loop). Each due reveal recovers one more
 * digit (noted privately to the operative) and leaves a tier-2 hidden host entry, with an alert naming the
 * credential and pointing at that entry. Revoking the credential or blocking the operative's workstation aborts the crack.
 */
export function advanceCracks(s: GameState): void {
  const t = gameTime(s);
  for (const k of s.cracks) {
    if (k.done) continue;
    const cred = s.credentials[k.credentialId];
    const actor = s.players[k.actorId];
    if (!cred || cred.status !== 'ACTIVE' || !actor || activeBlock(s, actor.ip)) {
      k.done = true; // aborted: credential revoked, or the source was blocked
      continue;
    }
    while (!k.done && k.nextRevealAt <= t && k.revealed < 4) {
      k.revealed += 1;
      const revealAt = k.nextRevealAt;
      k.nextRevealAt += s.config.crackRevealSec;
      const complete = k.revealed >= 4;
      note(actor, revealAt, `Code crack ${k.id} on ${cred.id}: recovered digit ${k.revealed}. Code so far: ${maskedCode(cred.code, k.revealed)}`);
      exposeEntry(
        s,
        hiddenEntry(s, actor, 'cracked a code digit'),
        2,
        'CODE_CRACK',
        `Brute-force on ${cred.id} (${nameOf(s, cred.owner)}, ${scopeLabel(cred)}): ${k.revealed} of 4 digits recovered${complete ? ' — credential compromised' : ''}`,
      );
      if (complete) {
        k.done = true;
        if (!actor.heldCredentialIds.includes(cred.id)) actor.heldCredentialIds.push(cred.id);
        note(actor, revealAt, `Code crack ${k.id} complete: ${cred.id} code is ${cred.code}.`);
      }
    }
  }
}

H['BLACKHAT_DB.ACCESS.CRACK_CODE'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  if (tgt.system === 'BLACKHAT_DB') return bad('No codes to crack on that host.');
  const creds = Object.values(c.s.credentials).filter(
    (cr) => cr.status === 'ACTIVE' && cr.owner !== c.actor.id && cr.system === tgt.system && (cr.module === null || cr.module === tgt.module),
  );
  if (!creds.length) return bad(`No active credential reaches ${targetLabel(tgt.system, tgt.module)}.`);
  const cred = pick(c.s, creds);
  const crack: CodeCrack = { id: nextId(c.s, 'crack', 'K'), actorId: c.actor.id, credentialId: cred.id, revealed: 0, nextRevealAt: c.t + c.s.config.crackRevealSec, done: false };
  c.s.cracks.push(crack);
  return good(`Code crack ${crack.id} started on ${cred.id} (${scopeLabel(cred)}). A digit about every ${c.s.config.crackRevealSec}s — watch your activity log.`);
};

H['BLACKHAT_DB.ACCESS.LOCKOUT_BOMB'] = (c, q) => {
  const ip = str(q, 'target');
  const target = Object.values(c.s.players).find((p) => p.ip === ip);
  if (!target) return bad('No workstation with that address.');
  if (target.id === c.actor.id) return bad('That is your own workstation.');
  if (target.lockedUntil > c.t) return bad(`${ip} is already locked out.`);
  const fails = c.s.config.lockoutAfterFails;
  // Failed logins spoofed to come FROM the target, so their own anti-brute-force lockout trips.
  for (let i = 0; i < fails; i++) {
    const entry = addLog(c.s, { actor: 'UNKNOWN', kind: 'AUTH_FAIL', message: `Failed authentication attempt from ${ip}`, sourceIp: ip, actualPlayerId: c.actor.id });
    addAlert(c.s, 'AUTH_FAIL', `Failed authentication attempt from ${ip}`, entry.id, 2);
  }
  target.failTotal += fails;
  target.failStreak = 0;
  target.lockedUntil = c.t + c.s.config.lockoutSec;
  raiseExposure(c, 2);
  return good(`${ip} (${target.name}) locked out for ${c.s.config.lockoutSec}s.`);
};

// ---- Cleanup ------------------------------------------------------------------
H['BLACKHAT_DB.CLEANUP.LOG_WIPER'] = (c, q) => {
  const id = normLog(str(q, 'logId'));
  const e = c.s.logs.find((x) => x.id === id);
  if (!e) return bad(`No such log entry: ${id}.`);
  if (e.deleted) return bad(`${id} is already wiped.`);
  e.deleted = true; // hidden from the log view; still in s.logs, so a Trace works until it ages out
  raiseExposure(c, 2);
  return good(`Wiped ${id} from the Master Log. The gap in the ids stays, and it can still be traced for now.`);
};

const ALERT_MUTE_SEC = 10;
H['BLACKHAT_DB.CLEANUP.ALERT_MUTE'] = (c) => {
  c.s.alertMuteUntil = Math.max(c.s.alertMuteUntil, c.t + ALERT_MUTE_SEC);
  raiseExposure(c, 3); // tier 3: this alert (and any tier 3-4) is never muted, so the mute cannot hide the loud stuff
  return good(`Alerts muted for ${ALERT_MUTE_SEC}s. Only weak alerts are hidden; strong exposures still get through.`);
};

// ---- Social -------------------------------------------------------------------
const findPlayerByName = (s: GameState, name: string): Player | undefined => {
  const n = name.trim().toLowerCase();
  return n ? s.playerOrder.map((id) => s.players[id]).find((p) => p.name.toLowerCase() === n) : undefined;
};
const findCustomerByRef = (s: GameState, ref: string): Customer | undefined => {
  const byId = s.customers.find((x) => x.id === normCust(ref));
  if (byId) return byId;
  const n = ref.trim().toLowerCase();
  return n ? s.customers.find((x) => x.name.toLowerCase() === n) : undefined;
};

H['BLACKHAT_DB.SOCIAL.SPOOFED_MESSAGE'] = (c, q) => {
  const recipient = findPlayerByName(c.s, str(q, 'to'));
  if (!recipient) return bad('No employee by that name to send to.');
  const fromName = str(q, 'from').trim().slice(0, 24);
  if (!fromName) return bad('Enter who the message should appear to be from.');
  const text = str(q, 'text').trim().slice(0, 500);
  if (!text) return bad('Write a message first.');
  // A real employee's name spoofs THEM (nameOf resolves the id); any other name shows as typed and is easier to spot.
  const impersonated = findPlayerByName(c.s, fromName);
  const from = impersonated ? impersonated.id : fromName;
  const m: Message = { id: nextId(c.s, 'msg', 'M'), t: c.t, from, to: recipient.id, text };
  recipient.messages.push(m); // ONLY the recipient's inbox: the impersonated sender's history stays clean
  note(c.actor, c.t, `Sent a spoofed message to ${recipient.name} as "${nameOf(c.s, from)}": ${text}`);
  raiseExposure(c, 2);
  return good(`Delivered to ${recipient.name}, appearing to be from ${nameOf(c.s, from)}.`);
};

H['BLACKHAT_DB.SOCIAL.SCAM_REQUEST'] = (c, q) => {
  const cust = findCustomerByRef(c.s, str(q, 'customer'));
  if (!cust) return bad('No customer by that name or id.');
  const kind = str(q, 'kind').toUpperCase() as RequestKind;
  if (!(['SET_PRIMARY', 'ADD_AND_PRIMARY', 'ADD_ACCOUNT', 'REMOVE_ACCOUNT'] as RequestKind[]).includes(kind)) return bad('Pick what the request asks for.');
  const account = normAccount(str(q, 'account'));
  if (!account) return bad('Enter a 5-digit account number.');
  const text = str(q, 'text').trim().slice(0, 300);
  if (!text) return bad('Write the message the customer would send.');
  const req: ClientRequest = {
    id: nextId(c.s, 'req', 'REQ-'),
    t: c.t,
    customerId: cust.id,
    bankerId: cust.bankerId,
    kind,
    text,
    payeeId: null,
    amount: null,
    originAccount: null,
    account,
    status: 'OPEN',
    closedAt: null,
    closedBy: null,
    closedByActual: null,
    txId: null,
    archiveReason: null,
  };
  c.s.requests.push(req);
  // A normal-looking system entry, so in the Master Log it is indistinguishable from a real incoming request.
  addLog(c.s, { actor: 'SYSTEM', kind: 'CLIENT_REQUEST', message: `Client request ${req.id} received`, sourceIp: null, actualPlayerId: null });
  note(c.actor, c.t, `Planted scam request ${req.id} from ${cust.name} (${kind} ${account}).`);
  raiseExposure(c, 2);
  const to = cust.bankerId ? nameOf(c.s, cust.bankerId) : 'their banker';
  return good(`Scam request ${req.id} planted, from ${cust.name} to ${to}.`);
};

H['BLACKHAT_DB.INFILTRATION.REROUTE_IP'] = (c, q) => {
  const toIp = str(q, 'toIp');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(toIp)) return bad('Enter an IP address to appear as, e.g. 10.1.0.14.');
  if (toIp === c.actor.ip) return bad('That is already your workstation.');
  const tierByDuration: Record<string, ExposureTier> = { '10': 2, '30': 3, '60': 4 };
  const duration = str(q, 'duration');
  const tier = tierByDuration[duration];
  if (!tier) return bad('Choose a duration: 10, 30 or 60 seconds.');
  const seconds = Number(duration);
  // One reroute per operative: a new one replaces any that is still running.
  c.s.reroutes = c.s.reroutes.filter((r) => r.playerId !== c.actor.id);
  c.s.reroutes.push({ playerId: c.actor.id, toIp, until: c.t + seconds });
  raiseExposure(c, tier);
  return good(`For ${seconds}s your activity appears to come from ${toIp}. Longer reroutes leak more — check the Host Log.`);
};

// ---- Hidden host: Black Hat Database ------------------------------------------
H['BLACKHAT_DB.BLACKNET.READ_MESSAGES'] = (c, q) => {
  const limit = clampInt(q.limit, 30, 1, 100);
  const rows = c.s.blacknet.slice(-limit).map((m) => `[${fmtClock(c.s.config, m.t)}] ${m.alias}: ${m.text}`);
  return good(`Blacknet: ${rows.length} message${rows.length === 1 ? '' : 's'}.`, rows);
};

H['BLACKHAT_DB.BLACKNET.POST_MESSAGE'] = (c, q) => {
  const text = str(q, 'text');
  if (!text) return bad('Write a message first.');
  c.s.blacknet.push({
    id: nextId(c.s, 'msg', 'N'),
    t: c.t,
    alias: str(q, 'alias').slice(0, 20) || 'anon',
    text: text.slice(0, 300),
    ownerId: c.owner.id,
  });
  return good('Posted.');
};

H['BLACKHAT_DB.TARGET_LEDGER.VIEW_TARGETS'] = (c) =>
  good('TARGET ACCOUNTS', c.s.targets.map((tg) => `${tg.account}  ${tg.status}`));

H['BLACKHAT_DB.TARGET_LEDGER.SET_TARGET_STATUS'] = (c, q) => {
  const acc = normAccount(str(q, 'account'));
  const tg = c.s.targets.find((x) => x.account === acc);
  if (!tg) return bad('That account is not in the ledger.');
  const status = str(q, 'status');
  if (status !== 'READY' && status !== 'PREPARE' && status !== 'ABORT') return bad('Status must be READY, PREPARE or ABORT.');
  tg.status = status;
  return good(`${tg.account} is now ${status}.`);
};

/** ALL: everything on the host's own log; ALERTS: only the moments an operative was exposed. */
H['BLACKHAT_DB.HOST_LOG.VIEW_HOST_LOG'] = (c, q) => {
  const alertsOnly = str(q, 'show') === 'ALERTS';
  const rows = c.s.hostLog
    .filter((h) => !alertsOnly || h.alert)
    .slice(-30)
    .map((h) => `[${fmtClock(c.s.config, h.t)}] ${h.id.padEnd(4)} ${h.alert ? '!! ' : ''}${h.message}`);
  return good(`Host log (${alertsOnly ? 'alerts' : 'all'}): ${rows.length}.`, rows.length ? rows : ['Nothing here.']);
};

H['BLACKHAT_DB.CREDENTIAL_CACHE.VIEW_CACHE'] = (c) => {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const bp of Object.values(c.s.players)) {
    if (bp.allegiance !== 'BLACK') continue;
    for (const id of bp.heldCredentialIds) {
      const cr = c.s.credentials[id];
      if (!cr || seen.has(id) || c.s.players[cr.owner].allegiance !== 'WHITE') continue;
      seen.add(id);
      rows.push(`${cr.id.padEnd(4)} ${nameOf(c.s, cr.owner).padEnd(10)} ${scopeLabel(cr).padEnd(44)} code ${cr.code}  ${cr.status}`);
    }
  }
  return good(`Credential Cache: ${rows.length} compromised credential${rows.length === 1 ? '' : 's'}.`, rows);
};

export const HANDLERS = H;
