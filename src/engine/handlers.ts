// One handler per function in the catalog. Key format: SYSTEM.MODULE.FUNCTION.
// Handlers only run after authentication, authorization, online and encryption checks have passed.

import { ENCRYPTION_ENABLED, findModule, findSystem, ROLES, SYSTEMS } from './catalog';
import {
  accountExists,
  balanceOf,
  unusedAccountNumber,
  unusedAlias,
  addAlert,
  addLog,
  fmtClock,
  gameTime,
  keyOf,
  money,
  nameOf,
  nextId,
  normAccount,
  findCustomer,
  normCust,
  normChange,
  accountOwner,
  accountVerified,
  addHostLog,
  activeBlock,
  blockText,
  effectiveHost,
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
import { automationText, computeRisk, paymentFor, recordTx, reverseTransaction, settleTransaction } from './bank';
import type { TxActor } from './bank';
import { accountRequestText, paymentRequestText, requestReceived, requestTimes } from './requests';
import { notify } from './notify';
import { thiefTargetMet } from './ending';
import { parseTrace } from './perception';
import type { AutomationFact, ChangeRow, CustomerRow, PageData, PaymentRow, RequestRow } from './perception';
import type { AccountChange, ClientRequest, CodeCrack, Credential, Customer, Message, RequestKind, Revocation, GameState, LogEntry, Player, RoleId, SystemId, Transaction, TxEvent, TxStatus, WorkstationUnlock, Proxy } from './types';

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
  /** Bank views: what the lines show, as data (perception.ts). */
  data?: PageData;
}
type Params = Record<string, string>;
export type Handler = (c: Ctx, q: Params) => HandlerResult;

const good = (message: string, lines?: string[], logDetail?: string): HandlerResult => ({ ok: true, message, lines, logDetail });
const bad = (message: string): HandlerResult => ({ ok: false, message });
/** A view's result with its data. */
const page = (message: string, lines: string[] | undefined, data: PageData, logDetail?: string): HandlerResult => ({ ok: true, message, lines, data, logDetail });
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

const scopeText = (cr: Credential): string =>
  cr.system === 'WORKSTATION' ? 'Workstation login' : `${cr.system}.${cr.module ?? '*'}${cr.fn ? '.' + cr.fn : ''} ${cr.permission}`;
export const credScopeText = scopeText;

const H: Record<string, Handler> = {};

/**
 * Logs a security change and raises a Master Log alert for it, naming the credential owner like the log does.
 * SUSPICIOUS (tier 2) can be muted by Alert mute; FATAL (tier 3) always gets through.
 */
function securityAlert(c: Ctx, detail: string, level: 'SUSPICIOUS' | 'FATAL'): void {
  const entry = c.log(detail);
  const what = level === 'FATAL' ? 'Fatal security activity' : 'Suspicious security activity';
  addAlert(c.s, `SECURITY_${level}`, `${what}: ${c.owner.name} ${detail}`, entry.id, level === 'FATAL' ? 3 : 2, c.owner.id);
}

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
  const known = SYSTEMS.filter((sys) => !sys.hidden && c.actor.knownSystems.includes(sys.id));
  const modules = known.flatMap((sys) =>
    sys.modules.map((m) => {
      const st = c.s.modules[keyOf(sys.id, m.id)];
      return { system: sys.id, module: m.id, online: st.status !== 'OFFLINE', securityOn: !st.open };
    }),
  );
  const rows = known.flatMap((sys) =>
    sys.modules.map((m) => {
      const st = c.s.modules[keyOf(sys.id, m.id)];
      const layers = ENCRYPTION_ENABLED && st.encryption.length ? `  ${st.encryption.length} encryption layer${st.encryption.length > 1 ? 's' : ''}` : '';
      return `${`${sys.label} / ${m.label}`.padEnd(46)} ${st.status.padEnd(8)}${st.open ? 'SECURITY OFF' : 'security on'}${layers}`;
    }),
  );
  const activeBlocks = c.s.blocks.filter((b) => activeBlock(c.s, b.address) === b);
  const blocks = activeBlocks.map((b) => `BLOCKED  ${b.address.padEnd(12)} ${blockText(c.s, b)}  by ${nameOf(c.s, b.byOwner)}`);
  const pendingRevs = c.s.revocations.filter((r) => r.status === 'PENDING');
  const pending = pendingRevs.map(
    (r) => `PENDING  ${r.id}  revoke all access for ${r.address} in ${Math.ceil(r.executeAt - c.t)}s  (started by ${nameOf(c.s, r.byOwner)}; cancel from the Firewall)`,
  );
  const data: PageData = {
    page: 'FIREWALL',
    modules,
    revocations: pendingRevs.map((r) => ({ id: r.id, address: r.address, inSec: Math.ceil(r.executeAt - c.t), startedBy: nameOf(c.s, r.byOwner) })),
    blocks: activeBlocks.map((b) => ({ address: b.address, sec: b.until === null ? -1 : Math.ceil(b.until - c.t), by: nameOf(c.s, b.byOwner) })),
  };
  const offline = rows.filter((r) => r.includes('OFFLINE')).length;
  const open = rows.filter((r) => r.includes('SECURITY OFF')).length;
  const summary = [offline ? `${offline} offline` : 'everything online', open ? `${open} with security off` : '', blocks.length ? `${blocks.length} blocked` : '', pending.length ? `${pending.length} revocation pending` : '']
    .filter(Boolean)
    .join(', ');
  return page(`Firewall: ${summary}.`, [...rows, ...pending, ...blocks], data);
};

/** A network address: a workstation IP or a system address. */
function networkAddress(c: Ctx, q: Params): string | { error: string } {
  const a = str(q, 'address');
  if (!a) return { error: 'Enter an address.' };
  // Workstations, systems and Infiltration proxies are all on the network (a proxy can be blocked or revoked).
  const known = Object.values(c.s.players).some((p) => p.ip === a) || SYSTEMS.some((sys) => sys.address && sys.address === a) || a === c.s.hiddenHost || c.s.proxies.some((x) => x.ip === a);
  return known ? a : { error: 'No such address on the network.' };
}

H['SECURITY.FIREWALL.SET_SECURITY'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  if (tgt.system === 'SECURITY' && tgt.module === 'FIREWALL') return bad('The Firewall\'s own security cannot be switched off.');
  if (tgt.system === 'HIDDEN_HOST') return bad('No control over that host.');
  const on = str(q, 'security').toUpperCase() === 'ON';
  const m = c.s.modules[keyOf(tgt.system, tgt.module)];
  if (m.open === !on) return bad(`Security is already ${on ? 'on' : 'off'} for that module.`);
  m.open = !on;
  const label = targetLabel(tgt.system, tgt.module);
  if (on) return good(`Security is back on for ${label}. Codes are required again.`, undefined, `switched security back on for ${label}`);
  securityAlert(c, `switched security OFF for ${label} (open access)`, 'SUSPICIOUS');
  return good(`Security is off for ${label}: anyone can use it without a code, and it is logged as Anonymous.`);
};

H['SECURITY.FIREWALL.BLOCK_ADDRESS'] = (c, q) => {
  const a = networkAddress(c, q);
  if (typeof a !== 'string') return bad(a.error);
  const current = activeBlock(c.s, a);
  if (current) return bad(`${a} is already blocked ${blockText(c.s, current)}.`);
  c.s.blocks = c.s.blocks.filter((b) => b.address !== a);
  c.s.blocks.push({ address: a, until: c.t + c.s.config.blockSec, byOwner: c.owner.id, actualPlayerId: c.actor.id });
  securityAlert(c, `blocked ${a} for ${c.s.config.blockSec}s`, 'SUSPICIOUS');
  return good(`${a} is blocked for ${c.s.config.blockSec}s.`);
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
  // Only one "revoke all access" counts down at a time, bank-wide.
  const pending = c.s.revocations.find((r) => r.status === 'PENDING');
  if (pending) {
    return bad(pending.address === a ? `A revocation of ${a} is already counting down.` : `${pending.id} (${pending.address}) is already counting down. Only one revocation can run at a time.`);
  }
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
  securityAlert(c, `started ${r.id}: revoke all access for ${a} in ${c.s.config.revokeCountdownSec}s`, 'FATAL');
  return good(`${r.id}: all access for ${a} will be revoked in ${c.s.config.revokeCountdownSec}s. It can be cancelled from the Firewall until then.`);
};

H['SECURITY.FIREWALL.SET_MODULE_STATUS'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  if (tgt.system === 'SECURITY' && tgt.module === 'FIREWALL') return bad('The Firewall cannot be taken offline.');
  if (tgt.system === 'HIDDEN_HOST') return bad('No control over that host.');
  const status = str(q, 'status');
  if (status !== 'ONLINE' && status !== 'OFFLINE') return bad('Status must be ONLINE or OFFLINE.');
  const m = c.s.modules[keyOf(tgt.system, tgt.module)];
  if (m.status === status) return bad(`Module is already ${status.toLowerCase()}.`);
  const label = targetLabel(tgt.system, tgt.module);
  if (status === 'OFFLINE') {
    securityAlert(c, `took ${label} offline`, 'SUSPICIOUS'); // written first: if this is the Master Log, nothing after it is recorded
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
    const alerts = c.s.alerts.slice(-limit);
    const rows = alerts.map((a) => `[${fmtClock(a.t)}] ${a.id.padEnd(5)} ${a.kind}: ${a.message}${a.logId ? ` (log ${a.logId})` : ''}`);
    const data: PageData = { page: 'ALERTS', rows: alerts.map((a) => ({ id: a.id, t: a.t, kind: a.kind, message: a.message, logId: a.logId })) };
    return page(`Master Log alerts: ${rows.length}.`, rows.length ? rows : ['No alerts.'], data);
  }
  // Wiped entries (Cleanup / Log wiper) drop out here, leaving a visible gap in the ids; a Trace can still reach them.
  const entries = (show === 'ALL' ? c.s.logs : c.s.logs.filter((e) => e.actor !== 'SYSTEM')).filter((e) => !e.deleted).slice(-limit);
  const rows = entries.map((e) => `[${fmtClock(e.t)}] ${e.id.padEnd(5)} ${e.message}`);
  const by = (actor: string): string | null => (actor === 'SYSTEM' || actor === 'UNKNOWN' ? null : nameOf(c.s, actor));
  const data: PageData = { page: 'LOG', rows: entries.map((e) => ({ id: e.id, t: e.t, message: e.message, by: by(e.actor) })) };
  return page(`Master Log: ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.`, rows, data);
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
/** Sorts addresses numerically, octet by octet (10.1.0.9 before 10.1.0.12). */
const ipKey = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

H['SECURITY.EMPLOYEE_RECORDS.VIEW_EMPLOYEES'] = (c) => {
  // In address order, so a planted user sits wherever their address falls rather than at the end.
  const order = [...c.s.playerOrder].sort((a, b) => ipKey(c.s.players[a].ip) - ipKey(c.s.players[b].ip));
  const data: PageData = {
    page: 'EMPLOYEES',
    rows: order.map((id) => {
      const p = c.s.players[id];
      const b = activeBlock(c.s, p.ip);
      return {
        name: p.name,
        role: ROLES[p.role].label,
        ip: p.ip,
        terminated: p.terminated ? { t: p.terminated.t, resigned: p.terminated.reason === 'RESIGNED' } : null,
        lockedSec: p.lockedUntil > c.t ? Math.ceil(p.lockedUntil - c.t) : 0,
        blockedSec: b ? (b.until === null ? -1 : Math.ceil(b.until - c.t)) : 0,
        lastActive: p.lastActiveAt,
        failedAttempts: p.failTotal,
      };
    }),
  };
  const rows = order.flatMap((id) => {
    const p = c.s.players[id];
    const active = p.lastActiveAt === null ? 'never' : `${fmtClock(p.lastActiveAt)} (${ago(c, p.lastActiveAt)})`;
    const flags = [
      p.lockedUntil > c.t ? `LOCKED OUT ${Math.ceil(p.lockedUntil - c.t)}s` : '',
      activeBlock(c.s, p.ip) ? `BLOCKED ${blockText(c.s, activeBlock(c.s, p.ip)!)}` : '',
    ].filter(Boolean);
    if (p.terminated) flags.unshift(`${p.terminated.reason === 'RESIGNED' ? 'RESIGNED' : 'TERMINATED'} ${fmtClock(p.terminated.t)}`);
    return [
      `${p.name.padEnd(10)} ${ROLES[p.role].label.padEnd(24)} ${p.ip}${flags.length ? '  ' + flags.map((x) => `[${x}]`).join(' ') : ''}`,
      `           last activity: ${active}   failed attempts: ${p.failTotal}`,
    ];
  });
  return page('Employee Records:', rows, data);
};

/**
 * One true but partial clue about hidden host activity:
 * a range of addresses holding four real workstations, one number of the server's address, or what was done;
 * from a noisy tool (tier 2) also possibly a pair (real + decoy). Everyday use (tier 1) never gives the pair:
 * it raised no alert, and one of two workstations is nearly a name.
 */
function relayClue(s: GameState, ip: string, server: string, tier: number, activity?: string): string {
  const ips = s.playerOrder.map((id) => s.players[id].ip);
  const last = (x: string): number => Number(x.split('.').pop());
  const kinds = ['RANGE', ...(tier >= 2 ? ['PAIR'] : []), 'SERVER', ...(activity ? ['ACTIVITY'] : [])];
  let kind = pick(s, kinds);
  if (kind === 'RANGE') {
    // Addresses are random, so the range is as wide as it takes to hold the origin and four real
    // workstations (the origin counts as one of them unless it is a proxy).
    const prefix = ip.split('.').slice(0, 3).join('.');
    const real = s.playerOrder.map((id) => s.players[id]).filter((p) => !p.fake && p.ip.startsWith(prefix + '.')).map((p) => last(p.ip));
    const points = [...new Set([...real, last(ip)])].sort((a, b) => a - b);
    const at = points.indexOf(last(ip));
    const windows: [number, number][] = [];
    for (let a = 0; a <= at; a++) {
      let count = 0;
      for (let b = a; b < points.length; b++) {
        if (real.includes(points[b])) count++;
        if (count === 4) {
          if (b >= at) windows.push([points[a], points[b]]);
          break;
        }
      }
    }
    if (windows.length) {
      const [lo, hi] = pick(s, windows);
      return `The origin workstation is within ${prefix}.${lo}-${hi}.`;
    }
    kind = tier >= 2 ? 'PAIR' : 'SERVER'; // no range holds it (a proxy off the workstation subnet)
  }
  if (kind === 'SERVER') {
    const parts = server.split('.');
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
 * 1-2 (vague): one partial clue (the pair only at 2); 3 (loud): one exact fact, the operative's IP or the server's address;
 * 4 (reckless): the operative's IP and a working host credential code (their own).
 * Every tier uses the addresses as recorded: a rerouted workstation or host shows its proxy, even here.
 */
function exposureClue(s: GameState, e: LogEntry): string {
  const tier = e.exposure ?? 1;
  const real = e.actualPlayerId ? s.players[e.actualPlayerId] : undefined;
  const ip = e.sourceIp!;
  const server = e.server ?? s.hiddenHost;
  if (tier <= 2) return relayClue(s, ip, server, tier, e.activity);
  if (tier === 3) {
    return rand(s) < 0.5 ? `The relay leaked the origin workstation: ${ip}.` : `The relay leaked the server's address: ${server}.`;
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
  const traced = (message: string): HandlerResult => page(message, undefined, { page: 'TRACE', logId: e.id, clue: parseTrace(message) }, `ran a trace on ${e.id}`);
  if (!e.sourceIp) return traced(`Trace ${e.id}: system event, no workstation origin.`);
  // Hidden host traffic is relayed. What a trace returns escalates with the action's exposure tier.
  if (e.kind === 'HIDDEN_ACCESS') {
    e.clue ??= exposureClue(c.s, e); // tracing it again gives the same clue
    const clue = e.clue + (e.leak ? ` ${e.leak}` : '');
    // The host notices: operatives see who traced it and what the bank learned.
    addHostLog(c.s, `Relay entry ${e.id} was traced by ${c.owner.name}. The bank learned: ${clue}`, true);
    return traced(`Trace ${e.id}: routed through a relay. ${clue}`);
  }
  return traced(`Trace ${e.id}: origin workstation ${e.sourceIp}`);
};

// ---- Client Data ------------------------------------------------------------
// ---- Client Requests -----------------------------------------------------------------------------
// A Personal Banker sees requests addressed to the credential's OWNER (so a borrowed code shows its owner's
// inbox). Any other role (e.g. the Bank Manager), or a whole-system Client Data credential, sees everyone's.

/** Personal Bankers work only their own customers; everyone else (and any whole-system credential) sees all. */
const ownCustomersOnly = (c: Ctx): boolean => c.owner.role === 'PERSONAL_BANKER' && !(c.cred.system === 'CLIENT_DATA' && c.cred.module === null);
const seesAllRequests = (c: Ctx): boolean => !ownCustomersOnly(c);
const canSeeRequest = (c: Ctx, r: ClientRequest): boolean => seesAllRequests(c) || r.bankerId === c.owner.id;

function requestStatusText(c: Ctx, r: ClientRequest): string {
  if (r.status === 'OPEN') return '[OPEN]';
  const by = r.closedBy ? ` by ${nameOf(c.s, r.closedBy)}` : '';
  if (r.status === 'DONE') return `[DONE${r.txId ? `: ${r.txId}` : ''}${by}]`;
  if (r.status === 'EXPIRED') return '[EXPIRED]';
  return `[ARCHIVED${by}${r.archiveReason ? `: "${r.archiveReason}"` : ''}]`;
}

/** A request in the view: header (status, urgency, time left, REMINDER), the customer's words, then follow-ups. */
function requestLines(c: Ctx, r: ClientRequest): string[] {
  const cust = c.s.customers.find((x) => x.id === r.customerId);
  const to = r.bankerId ? nameOf(c.s, r.bankerId) : 'nobody';
  const tags: string[] = [];
  if (r.urgent) tags.push('URGENT');
  if (r.outcome === null && !r.phish) tags.push(`due in ${Math.max(0, Math.ceil(r.dueAt - c.t))}s`);
  if (r.reminders.length && r.status === 'OPEN') tags.push('REMINDER');
  const lines = [
    `${r.id.padEnd(7)} ${fmtClock(r.t)}  ${r.sender ?? cust?.name ?? '?'} -> ${to}  ${requestStatusText(c, r)}${tags.length ? '  ' + tags.join('  ') : ''}`,
    `        "${r.text}"`,
  ];
  for (const m of r.reminders) lines.push(`        ${fmtClock(m.t)} follow-up: "${m.text}"`);
  if (r.status === 'OPEN' && r.archiveReason) {
    lines.push(`        (archived earlier${r.closedBy ? ` by ${nameOf(c.s, r.closedBy)}` : ''}: "${r.archiveReason}"; reopened by the follow-up)`);
  }
  return lines;
}

/** The same request as data: only what requestLines shows. */
function requestRow(c: Ctx, r: ClientRequest): RequestRow {
  const cust = c.s.customers.find((x) => x.id === r.customerId);
  return {
    id: r.id,
    t: r.t,
    from: r.sender ?? cust?.name ?? '?',
    to: r.bankerId ? nameOf(c.s, r.bankerId) : 'nobody',
    status: r.status,
    closedBy: r.status !== 'OPEN' && r.status !== 'EXPIRED' && r.closedBy ? nameOf(c.s, r.closedBy) : null,
    txId: r.status === 'DONE' ? r.txId : null,
    archiveReason: r.status === 'ARCHIVED' || (r.status === 'OPEN' && r.archiveReason) ? r.archiveReason : null,
    urgent: r.urgent,
    dueInSec: r.outcome === null && !r.phish ? Math.max(0, Math.ceil(r.dueAt - c.t)) : null,
    reminder: r.reminders.length > 0 && r.status === 'OPEN',
    reopened: r.status === 'OPEN' && !!r.archiveReason,
    text: r.text,
    followUps: r.reminders.map((m) => ({ t: m.t, text: m.text })),
  };
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
  if (!kinds.includes(r.kind)) return `${r.id} asks for ${KIND_TEXT[r.kind]}, not this.`;
  // Open and archived requests can be acted on (archiving is not final); a done one only if its payment fell through.
  if (r.outcome === 'MISSED') return `${r.id} has expired.`;
  if (r.status === 'DONE' && (r.kind !== 'PAYMENT' || paymentFor(c.s, r))) return `${r.id} is already done.`;
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
  let rows = c.s.requests.filter((r) => canSeeRequest(c, r) && (all || r.status === 'OPEN')).slice(-30);
  // Open view: requests the customer has already chased come first.
  if (!all) rows = [...rows.filter((r) => r.reminders.length), ...rows.filter((r) => !r.reminders.length)];
  const whose = seesAllRequests(c) ? 'All client requests' : `Client requests for ${c.owner.name}`;
  const lines = rows.flatMap((r) => requestLines(c, r));
  const n = rows.length;
  const data: PageData = { page: 'REQUESTS', all, rows: rows.map((r) => requestRow(c, r)) };
  return page(`${whose} (${all ? 'all' : 'open'}): ${n} request${n === 1 ? '' : 's'}.`, n ? lines : ['Nothing here.'], data);
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
  if (cr.system === 'WORKSTATION') return 'Workstation login';
  const access = cr.permission === 'WRITE' ? 'Read & write' : 'Read only';
  const where = cr.fn
    ? (findModule(cr.system, cr.module ?? '')?.fns.find((x) => x.id === cr.fn)?.label ?? cr.fn)
    : cr.module
      ? (findModule(cr.system, cr.module)?.label ?? cr.module)
      : `all of ${findSystem(cr.system)?.label ?? cr.system}`;
  return `${access} · ${where}`;
}

/** Write access to the Firewall or to Permissions (directly or through all of Security): revoking one waits. */
export const isSecurityWrite = (cr: Credential): boolean =>
  cr.system === 'SECURITY' && cr.permission === 'WRITE' && (cr.module === null || cr.module === 'FIREWALL' || cr.module === 'PERMISSIONS');

H['SECURITY.PERMISSIONS.VIEW_PERMISSIONS'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  const creds = Object.values(c.s.credentials)
    // The unregistered host is not part of the bank: its credentials never appear here. Nor do workstation
    // logins: an unlocked one shows only as a gap in the C ids (and can still be revoked by id).
    .filter((cr) => cr.system !== 'HIDDEN_HOST' && cr.system !== 'WORKSTATION')
    .filter((cr) => all || cr.status === 'ACTIVE');
  const rows = creds.map((cr) => {
    const by = cr.issuedBy === null ? 'start of shift' : nameOf(c.s, cr.issuedBy);
    return `${cr.id.padEnd(4)} ${nameOf(c.s, cr.owner).padEnd(10)} ${scopeLabel(cr).padEnd(44)} ${cr.status.padEnd(8)} issued: ${by}`;
  });
  const pendingCreds = Object.values(c.s.credentials).filter((cr) => cr.pendingRevoke && cr.status === 'ACTIVE');
  const pending = pendingCreds.map(
    (cr) => `PENDING  revoke ${cr.id} (${nameOf(c.s, cr.owner)}, ${scopeLabel(cr)}) in ${Math.ceil(cr.pendingRevoke!.at - c.t)}s  (started by ${nameOf(c.s, cr.pendingRevoke!.byOwner)}; cancel from Permissions)`,
  );
  const data: PageData = {
    page: 'CREDENTIALS',
    pending: pendingCreds.map((cr) => ({
      credentialId: cr.id,
      owner: nameOf(c.s, cr.owner),
      inSec: Math.ceil(cr.pendingRevoke!.at - c.t),
      startedBy: nameOf(c.s, cr.pendingRevoke!.byOwner),
    })),
    rows: creds.map((cr) => ({
      id: cr.id,
      owner: nameOf(c.s, cr.owner),
      system: cr.system,
      module: cr.module,
      fn: cr.fn,
      permission: cr.permission,
      status: cr.status,
      issuedBy: cr.issuedBy === null ? null : nameOf(c.s, cr.issuedBy),
    })),
  };
  return page(`Permissions registry (${all ? 'all' : 'active'}, codes hidden): ${rows.length}${pending.length ? `, ${pending.length} revocation pending` : ''}.`, [...pending, ...rows], data);
};

H['SECURITY.PERMISSIONS.CREATE_CREDENTIAL'] = (c, q) => {
  const owner = c.s.players[str(q, 'owner')];
  if (!owner) return bad('Choose an employee to issue to.');
  if (owner.terminated) return bad(`${owner.name} was terminated and cannot be issued credentials.`);
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
  securityAlert(c, `issued credential ${cred.id} to ${owner.name} (${scopeText(cred)})`, isSecurityWrite(cred) ? 'FATAL' : 'SUSPICIOUS');
  return good(`Credential ${cred.id} (${scopeLabel(cred)}) issued to ${owner.name}. Code: ${cred.code}`);
};

H['SECURITY.PERMISSIONS.REVOKE_CREDENTIAL'] = (c, q) => {
  const cr = c.s.credentials[normCred(str(q, 'credentialId'))];
  if (!cr) return bad('No such credential.');
  if (cr.fixed) return bad(`${cr.id} is a workstation's own login. It cannot be revoked.`);
  if (cr.status === 'REVOKED') return bad('Already revoked.');
  if (cr.pendingRevoke) return bad(`${cr.id} is already being revoked.`);
  const owner = c.s.players[cr.owner];
  if (isSecurityWrite(cr)) {
    // Control of the Firewall or of Permissions: a takeover move, so it waits and can be cancelled.
    const sec = c.s.config.revokeCountdownSec;
    cr.pendingRevoke = { at: c.t + sec, byOwner: c.owner.id, actualPlayerId: c.actor.id };
    note(owner, c.t, `Your credential ${cr.id} (${scopeText(cr)}) will be revoked in ${sec}s. Anyone with Permissions write can cancel it.`);
    securityAlert(c, `started revoking credential ${cr.id} (${owner.name}, ${scopeLabel(cr)}) in ${sec}s`, 'FATAL');
    return good(`Credential ${cr.id} will be revoked in ${sec}s. It can be cancelled from Permissions until then.`);
  }
  cr.status = 'REVOKED';
  if (owner.id !== c.actor.id) note(owner, c.t, `Your credential ${cr.id} (${scopeText(cr)}) was revoked.`);
  securityAlert(c, `revoked credential ${cr.id} (${owner.name})`, 'SUSPICIOUS');
  return good(`Credential ${cr.id} revoked.`);
};

H['SECURITY.PERMISSIONS.CANCEL_REVOKE'] = (c, q) => {
  const cr = c.s.credentials[normCred(str(q, 'credentialId'))];
  if (!cr?.pendingRevoke || cr.status !== 'ACTIVE') return bad('That credential is not being revoked.');
  cr.pendingRevoke = null;
  const owner = c.s.players[cr.owner];
  if (owner.id !== c.actor.id) note(owner, c.t, `The revocation of your credential ${cr.id} was cancelled.`);
  return good(`Revocation of ${cr.id} cancelled. ${owner.name} keeps it.`, undefined, `cancelled the revocation of credential ${cr.id} (${owner.name})`);
};

// ---- Client Data: Customer Records ------------------------------------------------------------------
// Payments to a customer land in their PRIMARY account at settlement. Accounts can be added (any existing
// account on no customer: a "floating" one), made primary, or removed (never the primary; it floats away with
// its money). Every change gets an id and waits in the Verification queue.

const customerParam = (c: Ctx, q: Params): Customer | undefined => findCustomer(c.s, str(q, 'customerId'));

/** Customer for a change command: a Personal Banker's credential only reaches that banker's own customers. */
function ownCustomer(c: Ctx, q: Params): Customer | string {
  const x = customerParam(c, q);
  if (!x) return 'No such customer.';
  if (!seesAllCustomers(c) && x.bankerId !== c.owner.id) return `${x.id} is not one of ${c.owner.name}'s customers.`;
  return x;
}

/** Like Client Requests: Personal Bankers see their own customers (by credential owner); every other role sees all. */
const seesAllCustomers = (c: Ctx): boolean => !ownCustomersOnly(c);

const accountText = (c: Ctx, x: Customer, a: string): string => `${a} ${money(balanceOf(c.s, a))}${accountVerified(x, a) ? '' : ' (unverified)'}`;

function customerRow(c: Ctx, x: Customer): CustomerRow {
  const fact = (a: string) => ({ account: a, balance: balanceOf(c.s, a), verified: accountVerified(x, a) });
  return {
    id: x.id,
    name: x.name,
    banker: x.bankerId ? nameOf(c.s, x.bankerId) : null,
    suspended: x.suspended,
    primary: fact(x.primary),
    others: x.accounts.filter((a) => a !== x.primary).map(fact),
  };
}

function customerLines(c: Ctx, x: Customer): string[] {
  const others = x.accounts.filter((a) => a !== x.primary);
  return [
    `${x.id.padEnd(5)} ${x.name.padEnd(22)} primary ${accountText(c, x, x.primary)}  banker: ${x.bankerId ? nameOf(c.s, x.bankerId) : '-'}${x.suspended ? '  SUSPENDED: no business today' : ''}`,
    `      other accounts: ${others.length ? others.map((a) => accountText(c, x, a)).join(', ') : 'none'}`,
  ];
}

function recordAccountChange(c: Ctx, x: Customer, action: AccountChange['action'], account: string, previousPrimary: string, req: ClientRequest | null = null): AccountChange {
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
    requestId: req?.id ?? null,
  };
  x.history.push(change);
  x.lastModifiedAt = c.t;
  const what = { ADD_ACCOUNT: `added account ${account} to`, SET_PRIMARY: `made ${account} the primary of`, REMOVE_ACCOUNT: `removed account ${account} from` }[action];
  const text = `${c.owner.name} ${what} ${x.id} (${change.id})`;
  notify(c.s, 'CLIENT_DATA', 'CUSTOMER_RECORDS', text, { owner: c.owner.id, bankerId: x.bankerId });
  notify(c.s, 'CLIENT_DATA', 'VERIFICATION', `${change.id} waiting: ${text}`, { owner: c.owner.id });
  // Operatives watching the Target Ledger hear about any change to a mule account's place (not the one who did it).
  const mule = (a: string): boolean => c.s.targets.some((tg) => tg.account === a);
  const scope = { owner: c.actor.id };
  if (mule(account)) notify(c.s, 'HIDDEN_HOST', 'TARGET_LEDGER', `${account} ${{ ADD_ACCOUNT: 'added to', SET_PRIMARY: 'made the primary of', REMOVE_ACCOUNT: 'removed from' }[action]} ${x.id} ${x.name} (by ${c.owner.name})`, scope);
  if (action === 'SET_PRIMARY' && previousPrimary !== account && mule(previousPrimary)) {
    notify(c.s, 'HIDDEN_HOST', 'TARGET_LEDGER', `${previousPrimary} is no longer the primary of ${x.id} ${x.name} (by ${c.owner.name})`, scope);
  }
  return change;
}

/** Switching the primary redirects every future payment to this customer. */
function makePrimary(c: Ctx, x: Customer, account: string, req: ClientRequest | null = null): AccountChange {
  const previous = x.primary;
  x.primary = account;
  return recordAccountChange(c, x, 'SET_PRIMARY', account, previous, req);
}

H['CLIENT_DATA.CUSTOMER_RECORDS.VIEW_CUSTOMERS'] = (c, q) => {
  // Anyone can view every customer (changes stay scoped: see ownCustomer). "My customers" means the credential
  // owner's; with no show picked, a Personal Banker sees their own and everyone else sees all.
  const show = str(q, 'show').toUpperCase();
  const all = show === 'ALL' || (show !== 'MINE' && c.owner.role !== 'PERSONAL_BANKER');
  const rows = c.s.customers.filter((x) => all || x.bankerId === c.owner.id);
  const data: PageData = { page: 'CUSTOMERS', rows: rows.map((x) => customerRow(c, x)) };
  if (!all && !rows.length) return page('You have no customers assigned to you.', undefined, data);
  const title = all ? 'Customer Records (all customers)' : `Customer Records: customers of ${c.owner.name}`;
  return page(`${title}: ${rows.length}.`, rows.length ? rows.flatMap((x) => customerLines(c, x)) : ['Nothing here.'], data);
};

H['CLIENT_DATA.CUSTOMER_RECORDS.ADD_ACCOUNT'] = (c, q) => {
  const x = ownCustomer(c, q);
  if (typeof x === 'string') return bad(x);
  const acc = normAccount(str(q, 'account'));
  if (!acc) return bad('Account must be 5 digits.');
  if (!accountExists(c.s, acc)) return bad(`There is no account ${acc}.`);
  if (x.accounts.includes(acc)) return bad(`${acc} is already on ${x.id}.`);
  if (accountOwner(c.s, acc)) return bad(`${acc} belongs to another customer.`);
  const primary = str(q, 'makePrimary').toUpperCase() === 'YES';
  // Adding as primary also answers "make this account primary" when it is not on file (it has to be added first).
  const req = linkedRequest(c, q, primary ? ['ADD_ACCOUNT', 'ADD_AND_PRIMARY', 'SET_PRIMARY'] : ['ADD_ACCOUNT', 'ADD_AND_PRIMARY']);
  if (typeof req === 'string') return bad(req);
  x.accounts.push(acc);
  const ids = [recordAccountChange(c, x, 'ADD_ACCOUNT', acc, x.primary, req).id];
  if (primary) ids.push(makePrimary(c, x, acc, req).id);
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
  const change = makePrimary(c, x, acc, req);
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
  const change = recordAccountChange(c, x, 'REMOVE_ACCOUNT', acc, x.primary, req);
  if (req) closeRequest(c, req, 'DONE');
  return good(
    `${acc} removed from ${x.id} ${x.name}. Waiting for verification: ${change.id}.${req ? ` ${req.id} is done.` : ''}`,
    undefined,
    `removed account ${acc} from ${x.id}${req ? ` for ${req.id}` : ''}`,
  );
};

// ---- Client Data: Verification ---------------------------------------------------------------------

export const allChanges = (s: GameState): AccountChange[] => s.customers.flatMap((x) => x.history).sort((a, b) => a.t - b.t || Number(a.id.slice(3)) - Number(b.id.slice(3)));

function changeRow(c: Ctx, h: AccountChange): ChangeRow {
  const x = c.s.customers.find((y) => y.id === h.customerId);
  return {
    id: h.id,
    t: h.t,
    customerId: h.customerId,
    customerName: x?.name ?? '?',
    action: h.action,
    account: h.account,
    previousPrimary: h.action === 'SET_PRIMARY' ? h.previousPrimary : null,
    by: nameOf(c.s, h.byOwner),
    requestId: h.requestId ?? null,
    verified: h.verified,
    verifiedBy: h.verified && h.verifiedBy ? nameOf(c.s, h.verifiedBy) : null,
  };
}

function changeLine(c: Ctx, h: AccountChange): string {
  const x = c.s.customers.find((y) => y.id === h.customerId);
  const what =
    h.action === 'ADD_ACCOUNT' ? `added ${h.account}` : h.action === 'REMOVE_ACCOUNT' ? `removed ${h.account}` : `primary ${h.previousPrimary} -> ${h.account}`;
  const status = h.verified ? `[VERIFIED by ${h.verifiedBy ? nameOf(c.s, h.verifiedBy) : '?'}]` : '[UNVERIFIED]';
  const forReq = h.requestId ? `  for ${h.requestId}` : ''; // the request it was linked to when it was made
  return `${h.id.padEnd(6)} ${fmtClock(h.t)}  ${h.customerId.padEnd(4)} ${(x?.name ?? '?').padEnd(22)} ${what}  by ${nameOf(c.s, h.byOwner)}${forReq}  ${status}`;
}

/** PENDING: account changes nobody has verified yet. ALL: the most recent changes. */
H['CLIENT_DATA.VERIFICATION.VIEW_VERIFICATION'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  const changes = allChanges(c.s)
    .filter((h) => all || !h.verified)
    .slice(-40);
  const rows = changes.map((h) => changeLine(c, h));
  const n = rows.length;
  const data: PageData = { page: 'CHANGES', rows: changes.map((h) => changeRow(c, h)) };
  return page(`Verification queue (${all ? 'all' : 'pending'}): ${n} change${n === 1 ? '' : 's'}.`, n ? rows : ['Nothing here.'], data);
};

/** "CU3" -> that customer's changes; "12345" / "ACC-12345" -> that account's changes across every customer. */
H['CLIENT_DATA.VERIFICATION.INVESTIGATE_CHANGES'] = (c, q) => {
  const raw = str(q, 'target');
  const acc = normAccount(raw);
  if (acc) {
    if (!accountExists(c.s, acc)) return bad(`There is no account ${acc}.`);
    const rows = allChanges(c.s).filter((h) => h.account === acc || (h.action === 'SET_PRIMARY' && h.previousPrimary === acc));
    const owner = accountOwner(c.s, acc);
    const now = owner ? `on ${owner.id} ${owner.name}${owner.primary === acc ? ' (primary)' : ''}` : 'floating (no customer)';
    const data: PageData = {
      page: 'INVESTIGATE',
      rows: rows.map((h) => changeRow(c, h)),
      account: { account: acc, customerId: owner?.id ?? null, primary: owner?.primary === acc, balance: balanceOf(c.s, acc) },
    };
    return page(`${acc}: now ${now}, balance ${money(balanceOf(c.s, acc))}. ${rows.length} change${rows.length === 1 ? '' : 's'}.`, rows.map((h) => changeLine(c, h)), data, `investigated changes to account ${acc}`);
  }
  const x = findCustomer(c.s, raw);
  if (!x) return bad('Enter a customer (their name, or tag: CU3) or a 5-digit account.');
  const n = x.history.length;
  const data: PageData = {
    page: 'INVESTIGATE',
    rows: x.history.map((h) => changeRow(c, h)),
    customer: { id: x.id, originalPrimary: x.originalPrimary, primary: x.primary },
  };
  return page(
    `${x.id} ${x.name}: ${n} change${n === 1 ? '' : 's'}. Opened with primary ${x.originalPrimary}; primary now ${x.primary}.`,
    x.history.map((h) => changeLine(c, h)),
    data,
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
  const cust = c.s.customers.find((x) => x.id === h.customerId);
  notify(c.s, 'CLIENT_DATA', 'CUSTOMER_RECORDS', `${c.owner.name} verified ${h.id} on ${h.customerId}`, { owner: c.owner.id, bankerId: cust?.bankerId ?? null });
  return good(`${h.id} verified.`, undefined, `verified account change ${h.id} on ${h.customerId}`);
};

// ---- Transaction Processing --------------------------------------------------
/** For payment history: the records name the credential owner; the truth is who typed it. */
const who = (c: Ctx): TxActor => ({ by: c.owner.id, actualPlayerId: c.actor.id });
/** A typed reason: trimmed, capped, or null if empty. */
const reasonOf = (q: Params): string | null => str(q, 'reason').trim().slice(0, 200) || null;

const ACTIVE = ['QUEUED', 'RISK_CHECKED', 'AUTHORIZED', 'HELD'];
/**
 * "CU5 ACC-13845 -> CU2 ACC-79039": originator and the account used, then the payee and their CURRENT primary.
 * A payment from a floating account shows its originator as UNKNOWN.
 */
function payLine(c: Ctx, tx: Transaction): string {
  const payee = c.s.customers.find((x) => x.id === tx.beneficiaryId);
  return `${tx.customerId ?? 'UNKNOWN'} ${tx.originAccount} -> ${tx.beneficiaryId} ${payee?.primary ?? '?'}`;
}

function txLine(c: Ctx, tx: Transaction): string {
  const risk = tx.riskResult ? ` risk ${tx.riskResult}` : '';
  return `${tx.id}  ${money(tx.amount).padStart(11)}  ${payLine(c, tx)}  [${tx.status}${risk}]${tx.requestId ? `  for ${tx.requestId}` : ''}`;
}

/** A payment as the Payment Queue line shows it. */
function txRow(c: Ctx, tx: Transaction): PaymentRow {
  const payee = c.s.customers.find((x) => x.id === tx.beneficiaryId);
  return {
    id: tx.id,
    amount: tx.amount,
    originCustomer: tx.customerId,
    originAccount: tx.originAccount,
    beneficiaryId: tx.beneficiaryId,
    beneficiaryPrimary: payee?.primary ?? null,
    status: tx.status,
    risk: tx.riskResult,
    requestId: tx.requestId,
  };
}

H['TRANSACTIONS.PAYMENT_QUEUE.VIEW_QUEUE'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  const txs = c.s.transactions.filter((tx) => all || ACTIVE.includes(tx.status)).slice(-40);
  const rows = txs.map((tx) => txLine(c, tx));
  const data: PageData = { page: 'PAYMENTS', stage: 'QUEUE', automation: null, rows: txs.map((tx) => txRow(c, tx)) };
  return page(`Payment Queue: ${rows.length} payment${rows.length === 1 ? '' : 's'}.`, rows, data);
};

H['TRANSACTIONS.PAYMENT_QUEUE.CREATE_TRANSACTION'] = (c, q) => {
  // Any existing account can pay, including a floating one (the payment then shows it as UNKNOWN).
  const acc = normAccount(str(q, 'originAccount'));
  if (!acc || !accountExists(c.s, acc)) return bad('There is no account with that number.');
  const origin = accountOwner(c.s, acc);
  const typed = str(q, 'beneficiaryId').trim();
  const b = findCustomer(c.s, typed);
  if (!b) return bad(typed ? `No customer "${typed}" to pay. Type the name exactly as in Customer Records, or their tag (CU7).` : 'Enter who to pay: their name, or tag (CU7).');
  const amount = Math.round(Number(str(q, 'amount')));
  if (!Number.isFinite(amount) || amount <= 0) return bad('Enter a positive amount.');
  if (amount > c.s.config.maxManualAmount) return bad(`Manual payments are capped at ${money(c.s.config.maxManualAmount)}.`);
  const req = linkedRequest(c, q, ['PAYMENT']);
  if (typeof req === 'string') return bad(req);
  const tx: Transaction = {
    id: nextId(c.s, 'tx', 'TX-', 4),
    amount,
    customerId: origin?.id ?? null,
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
  return good(`Queued ${tx.id}.${req ? ` ${req.id} is done.` : ''}`, undefined, `created payment ${tx.id} (${money(amount)}) from ${origin?.name ?? acc} to ${b.name}${forReq}`);
};

H['TRANSACTIONS.RISK_CHECK.RUN_RISK_CHECK'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'QUEUED' && tx.status !== 'RISK_CHECKED') return bad(`${tx.id} is ${tx.status}; it cannot be risk checked.`);
  const score = str(q, 'score').toUpperCase();
  if (score !== 'LOW' && score !== 'MEDIUM' && score !== 'HIGH') return bad('Pick a risk score: LOW, MEDIUM or HIGH.');
  const why = reasonOf(q); // optional
  tx.riskResult = score;
  tx.riskReason = why || null;
  tx.riskFlags = computeRisk(c.s, tx).flags; // hidden ground truth: what the system would have flagged
  tx.status = 'RISK_CHECKED';
  recordTx(c.s, tx, 'RISK_CHECKED', who(c), `risk ${score}${why ? `: ${why}` : ''}`);
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
  if (!r.ok) return good(`${tx.id} FAILED: insufficient funds in ${tx.originAccount}.`, undefined, `tried to settle ${tx.id}: failed, insufficient funds`);
  return good(`${tx.id} settled: ${money(tx.amount)} paid to ${r.account} (${tx.beneficiaryId}'s primary).`, undefined, `settled ${tx.id}`);
};

H['TRANSACTIONS.SETTLEMENT.REVERSE'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'SETTLED' || tx.settledAt === null) return bad(`${tx.id} is ${tx.status}; only settled payments can be reversed.`);
  if (c.t - tx.settledAt > c.s.config.reversalWindowSec) return bad('The reversal window has closed.');
  if (!reverseTransaction(c.s, tx, who(c))) return bad(`Reversal failed: ${tx.settledTo} no longer holds ${money(tx.amount)}.`);
  return good(`${tx.id} reversed.`, undefined, `reversed ${tx.id}`);
};

// ---- Stage inboxes: "what's waiting for me?" (PENDING) and "what did I just do?" (ALL) ----------
// Two lines per payment: what it is, then who handled it and when. Names are credential owners (what the
// records say), never who really typed. Automatic risk flags are never shown: judging risk is the player's job.

const lastEvent = (tx: Transaction, action: TxEvent['action']): TxEvent | undefined =>
  [...tx.history].reverse().find((e) => e.action === action);

/** Who a history step is attributed to: a player, the payment's channel, or the stage's automation. */
function eventBy(c: Ctx, tx: Transaction, e: TxEvent): string {
  if (e.by !== 'SYSTEM') return nameOf(c.s, e.by);
  return e.action === 'CREATED' ? (tx.channel ?? 'SYSTEM') : 'Automation';
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
  FAILED: 'failed',
  REVERSED: 'reversed',
};

type Stage = 'RISK' | 'AUTH' | 'SETTLE';

function stageLines(c: Ctx, tx: Transaction, stage: Stage): { lines: string[]; row: PaymentRow } {
  const row: PaymentRow = { ...txRow(c, tx), risk: null };
  let head = `${tx.id}  ${money(tx.amount).padStart(11)}  ${payLine(c, tx)}  [${tx.status}]`;
  // The risk queue warns about accounts with account changes nobody has verified yet.
  if (stage === 'RISK') {
    const payee = c.s.customers.find((x) => x.id === tx.beneficiaryId);
    const payer = c.s.customers.find((x) => x.id === tx.customerId);
    const warn: string[] = [];
    if (payee && !accountVerified(payee, payee.primary)) warn.push("payee's primary");
    if (payer && !accountVerified(payer, tx.originAccount)) warn.push('originator account');
    if (warn.length) head += `  !! UNVERIFIED: ${warn.join(', ')}`;
    row.unverified = warn;
  }

  // Each shown step remembers its event, so "how long ago" can be attached to the latest one instead of repeated.
  const parts: { text: string; e?: TxEvent }[] = [];
  if (tx.requestId) parts.push({ text: `for ${tx.requestId}` });
  const created = lastEvent(tx, 'CREATED');
  if (stage === 'RISK' && created) {
    parts.push({ text: `created ${fmtClock(created.t)} by ${eventBy(c, tx, created)}`, e: created });
    row.created = { t: created.t, by: eventBy(c, tx, created) };
  }
  const checked = lastEvent(tx, 'RISK_CHECKED');
  if (checked && tx.riskResult) {
    parts.push({ text: `risk ${tx.riskResult} by ${eventBy(c, tx, checked)}${quoted(tx.riskReason)}`, e: checked });
    row.risk = tx.riskResult;
    row.checked = { by: eventBy(c, tx, checked), reason: tx.riskReason };
  }
  const approved = lastEvent(tx, 'APPROVED');
  if (stage === 'SETTLE' && approved) {
    parts.push({ text: `approved by ${eventBy(c, tx, approved)}${quoted(approved.detail)}`, e: approved });
    row.approved = { by: eventBy(c, tx, approved), reason: approved.detail };
  }
  const last = tx.history.at(-1);
  const shown = last && parts.find((p) => p.e === last);
  if (last) row.last = { action: PAST[last.action], by: eventBy(c, tx, last), agoSec: Math.max(0, Math.floor(c.t - last.t)) };
  if (shown) shown.text += ` (${ago(c, last.t)})`;
  else if (last) {
    const why = last.action === 'APPROVED' || last.action === 'HELD' || last.action === 'REJECTED' ? quoted(last.detail) : '';
    parts.push({ text: `${PAST[last.action]} by ${eventBy(c, tx, last)}${why} (${ago(c, last.t)})` });
  }
  if (tx.status === 'SETTLED' && tx.settledAt !== null) {
    const left = c.s.config.reversalWindowSec - (c.t - tx.settledAt);
    if (left > 0) {
      parts.push({ text: `reversible for ${Math.ceil(left)}s` });
      row.reversibleSec = Math.ceil(left);
    }
  }

  return { lines: [head, `         ${parts.map((p) => p.text).join('   ')}`], row };
}

function stageView(c: Ctx, q: Record<string, string>, stage: Stage, title: string, pending: TxStatus[], all: (tx: Transaction) => boolean): HandlerResult {
  const showAll = str(q, 'show') === 'ALL';
  const rows = c.s.transactions
    .filter((tx) => (showAll ? all(tx) : pending.includes(tx.status)))
    .slice(-40);
  const n = rows.length;
  const shown = rows.map((tx) => stageLines(c, tx, stage));
  const a = c.s.automation;
  // Only the settings the stage's first line states.
  const automation: AutomationFact =
    stage === 'RISK'
      ? { scoreMax: a.scoreMax, scoreSource: a.scoreSource, scoreOrigin: a.scoreOrigin, scorePayee: a.scorePayee }
      : stage === 'AUTH'
        ? { approveUpTo: a.approveUpTo }
        : { settleMax: a.settleMax };
  const data: PageData = { page: 'PAYMENTS', stage, automation, rows: shown.map((x) => x.row) };
  return page(
    `${title} (${showAll ? 'all' : 'pending'}): ${n} payment${n === 1 ? '' : 's'}.`,
    [automationText(c.s, stage), ...(n ? shown.flatMap((x) => x.lines) : ['Nothing here.'])],
    data,
  );
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
  stageView(c, q, 'SETTLE', 'Settlement queue', ['AUTHORIZED'], (tx) => ['AUTHORIZED', 'SETTLED', 'FAILED', 'REVERSED'].includes(tx.status));

// ---- Automation settings: anyone with WRITE on the stage changes them, logged under the credential owner ----

/** A typed amount for an automation threshold: "1000000", "$1,000,000"; 0 switches the stage off. */
function thresholdOf(q: Record<string, string>): number | null {
  const n = Math.round(Number(str(q, 'maxAmount').replace(/[$,\s]/g, '')));
  return str(q, 'maxAmount') !== '' && Number.isFinite(n) && n >= 0 ? n : null;
}

H['TRANSACTIONS.RISK_CHECK.SET_AUTO_SCORE'] = (c, q) => {
  const max = thresholdOf(q);
  if (max === null) return bad('Enter a max amount (0 switches automatic scoring off).');
  const source = str(q, 'source');
  const origin = str(q, 'origin');
  const payee = str(q, 'payee');
  if ((source !== 'AUTOMATIC' && source !== 'ALL') || (origin !== 'CUSTOMER' && origin !== 'ANY') || (payee !== 'VERIFIED' && payee !== 'ANY')) {
    return bad('Pick which payments, paid from where, to which primaries.');
  }
  Object.assign(c.s.automation, { scoreMax: max, scoreSource: source, scoreOrigin: origin, scorePayee: payee });
  const text = automationText(c.s, 'RISK');
  return good(text, undefined, `changed automatic scoring (${text.replace(/^Automatic scoring: /, '').replace(/\.$/, '')})`);
};

H['TRANSACTIONS.AUTHORIZATION.SET_AUTO_APPROVE'] = (c, q) => {
  const level = str(q, 'level').toUpperCase();
  if (level !== 'NONE' && level !== 'LOW' && level !== 'MEDIUM' && level !== 'HIGH') return bad('Pick NONE, LOW, MEDIUM or HIGH.');
  c.s.automation.approveUpTo = level;
  const detail = `set automatic approval to ${level}`;
  if (level === 'HIGH') securityAlert(c, detail, 'SUSPICIOUS'); // every payment would go through unchecked
  return good(automationText(c.s, 'AUTH'), undefined, detail);
};

H['TRANSACTIONS.SETTLEMENT.SET_AUTO_SETTLE'] = (c, q) => {
  const max = thresholdOf(q);
  if (max === null) return bad('Enter a max amount (0 switches automatic settlement off).');
  c.s.automation.settleMax = max;
  return good(automationText(c.s, 'SETTLE'), undefined, max ? `set automatic settlement to payments up to ${money(max)}` : 'switched automatic settlement off');
};

// ---- Hidden host: tool kits & exposure ----------------------------------------
// Thief tools have no cooldowns or charges; they are balanced by exposure. Each tool tags its "Unknown
// server activity" entry with a tier: tier 2+ raises an alert pointing at the entry (never naming anyone),
// and a trace of the entry reveals more the higher the tier, using the addresses as recorded (a reroute shows its proxy).
type ExposureTier = 1 | 2 | 3 | 4;

/** An active host credential code the operative owns, if any (the strongest exposure hands over a working one). */
function ownHostCode(s: GameState, actor: Player): string | null {
  const cr = Object.values(s.credentials).find((x) => x.owner === actor.id && x.system === 'HIDDEN_HOST' && x.status === 'ACTIVE');
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
 * The cost of a Thief tool. Its "Unknown server activity" entry is tagged with the tier, so a trace of it
 * reveals more the louder the tool; tier 2+ also raises an alert pointing at that entry.
 */
function raiseExposure(c: Ctx, tier: ExposureTier): void {
  exposeEntry(c.s, c.log(), tier);
}

/** A hidden host entry for background work (no Ctx), e.g. a running Code crack. */
function hiddenEntry(s: GameState, actor: Player, activity: string): LogEntry {
  const t = gameTime(s);
  return addLog(s, { actor: 'SYSTEM', kind: 'HIDDEN_ACCESS', message: 'Unknown server activity', sourceIp: effectiveIp(s, actor, t), actualPlayerId: actor.id, activity, server: effectiveHost(s, t) });
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
    alias: unusedAlias(s),
    objective: '',
    motivation: '',
    ip,
    bankAccount: unusedAccountNumber(s), // a made-up number: it does not exist, so it cannot hold or move money
    heldCredentialIds: [],
    knownSystems: ['SECURITY', 'CLIENT_DATA', 'TRANSACTIONS'],
    activity: [],
    messages: [],
    failStreak: 0,
    lockedUntil: 0,
    lastTraceAt: -9999,
    failTotal: 0,
    lastActiveAt: null,
    monitoring: [],
    remoteAccess: [],
    watching: [],
    notifications: [],
    terminated: null,
    fake: true,
  };
  s.players[p.id] = p;
  s.playerOrder.push(p.id);
  return p;
}

// ---- Proxies -------------------------------------------------------------------
/** Is this address already on the network: a workstation (real or planted), a system, the host, or a proxy? */
function addressInUse(s: GameState, ip: string): boolean {
  return (
    Object.values(s.players).some((p) => p.ip === ip) ||
    SYSTEMS.some((sys) => sys.address && sys.address === ip) ||
    ip === s.hiddenHost ||
    s.proxies.some((x) => x.ip === ip)
  );
}

/** Why a proxy cannot be used right now, if it cannot. A reroute of `exceptRerouteFrom` (being renewed) does not count. */
export function proxyUnavailable(s: GameState, ip: string, t: number, exceptRerouteFrom?: string): string | null {
  if (s.proxies.some((x) => x.ip === ip && !x.ready)) return 'still being set up';
  if (activeBlock(s, ip)) return 'blocked by the firewall';
  if (Object.values(s.players).some((p) => p.ip === ip)) return 'used by a planted user';
  if (s.reroutes.some((r) => r.toIp === ip && r.until > t && r.fromIp !== exceptRerouteFrom)) return 'carrying a reroute';
  return null;
}

/** The proxy a Reroute or Create user asked for, or why it cannot be used. */
function pickProxy(c: Ctx, q: Params, renewing?: string): string | { error: string } {
  if (!c.s.proxies.length) return { error: 'No proxies yet. Create a proxy first.' };
  const ip = str(q, 'proxy');
  if (!c.s.proxies.some((x) => x.ip === ip)) return { error: 'Choose one of the proxies.' };
  const why = proxyUnavailable(c.s, ip, c.t, renewing);
  return why ? { error: `Proxy ${ip} is unavailable: ${why}.` } : ip;
}

H['HIDDEN_HOST.INFILTRATION.CREATE_PROXY'] = (c, q) => {
  const ip = str(q, 'ip');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split('.').some((n) => Number(n) > 255)) return bad('Enter an IP address, e.g. 10.1.0.77.');
  if (addressInUse(c.s, ip)) return bad(`${ip} is already in use on the network. A proxy needs an unused address.`);
  // One proxy set up at a time, like a code crack.
  const pending = c.s.proxies.find((x) => !x.ready);
  if (pending) return bad(`Proxy ${pending.ip} is still being set up. Only one can be set up at a time.`);
  const sec = c.s.config.proxySetupSec;
  const px: Proxy = { ip, t: c.t, readyAt: c.t + sec, ready: false, createdBy: c.actor.id };
  c.s.proxies.push(px);
  raiseExposure(c, 3);
  if (sec <= 0) {
    px.ready = true;
    return good(proxyReadyText(ip));
  }
  return good(`Proxy ${ip} is being set up: ready in ${sec}s. Watch its progress here.`);
};

const proxyReadyText = (ip: string): string => `Proxy ${ip} is set up. Reroute IP and Create user can use it now.`;

/** Mutating: proxies whose setup time has run out become usable, and their operative is told. */
export function advanceProxies(s: GameState): void {
  const t = gameTime(s);
  for (const px of s.proxies) {
    if (px.ready || px.readyAt > t) continue;
    px.ready = true;
    px.result = proxyReadyText(px.ip);
    const actor = s.players[px.createdBy];
    if (!actor) continue;
    note(actor, px.readyAt, px.result);
    notify(s, 'HIDDEN_HOST', 'INFILTRATION', px.result, { to: actor.id });
  }
}

H['HIDDEN_HOST.INFILTRATION.CREATE_USER'] = (c, q) => {
  const name = str(q, 'name').slice(0, 24);
  if (!name) return bad('Enter a name for the user.');
  const role = str(q, 'role').toUpperCase() as RoleId;
  if (!ROLES[role]) return bad('Pick a role from the list.');
  const ip = pickProxy(c, q);
  if (typeof ip !== 'string') return bad(ip.error);
  const p = plantUser(c.s, name, role, ip);
  raiseExposure(c, 2);
  return good(`${p.name} (${ROLES[role].label}) planted at ${ip}. They now appear in Employee Records; issue them credentials from Permissions.`);
};

// ---- Access -------------------------------------------------------------------
/** A partly-recovered code: revealed digits shown, the rest as underscores ("3 7 _ _"). */
export const maskedCode = (code: string, revealed: number): string => code.split('').map((d, i) => (i < revealed ? d : '_')).join(' ');

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
    const block = actor && activeBlock(s, actor.ip);
    // A revoked IP (permanent block) cuts the bank off, not the host, so only a timed block stops a crack.
    if (!cred || cred.status !== 'ACTIVE' || !actor || (block && block.until !== null)) {
      k.done = true; // aborted: credential revoked, or the source was blocked
      if (!actor) continue;
      k.result = `Code crack ${k.id} on ${k.credentialId} stopped: ${block ? 'your workstation was blocked' : 'the credential was revoked'}.`;
      note(actor, t, k.result);
      notify(s, 'HIDDEN_HOST', 'ACCESS', k.result, { to: actor.id });
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
        const done = (k.result = `Code crack ${k.id} complete: ${cred.id} code is ${cred.code}.`);
        note(actor, revealAt, done);
        notify(s, 'HIDDEN_HOST', 'ACCESS', done, { to: actor.id });
      }
    }
  }
}

H['HIDDEN_HOST.ACCESS.CRACK_CODE'] = (c, q) => {
  const tgt = moduleTarget(c, q);
  if (typeof tgt === 'string') return bad(tgt);
  if (tgt.system === 'HIDDEN_HOST') return bad('No codes to crack on that host.');
  // One code crack at a time, across the whole team.
  const running = c.s.cracks.find((k) => !k.done);
  if (running) return bad(`Code crack ${running.id} is still running (${running.revealed} of 4 digits). Only one can run at a time.`);
  const creds = Object.values(c.s.credentials).filter(
    (cr) => cr.status === 'ACTIVE' && cr.owner !== c.actor.id && cr.system === tgt.system && (cr.module === null || cr.module === tgt.module),
  );
  if (!creds.length) return bad(`No active credential reaches ${targetLabel(tgt.system, tgt.module)}.`);
  const cred = pick(c.s, creds);
  const crack: CodeCrack = { id: nextId(c.s, 'crack', 'K'), actorId: c.actor.id, credentialId: cred.id, revealed: 0, nextRevealAt: c.t + c.s.config.crackRevealSec, done: false };
  c.s.cracks.push(crack);
  return good(`Code crack ${crack.id} started on ${cred.id} (${scopeLabel(cred)}). A digit about every ${c.s.config.crackRevealSec}s — watch its progress here.`);
};

/**
 * Advances every running Unlock workstation (called from the engine's time loop). A block on either end, the
 * operative's workstation (real or as recorded) or the target's, stops it; otherwise, when time is up, the
 * target gets a new workstation credential that only the operative knows about.
 */
export function advanceUnlocks(s: GameState): void {
  const t = gameTime(s);
  for (const u of s.unlocks) {
    if (u.done) continue;
    const actor = s.players[u.actorId];
    const target = s.players[u.targetId];
    const blocked = [actor.ip, u.fromIp, target.ip].find((ip) => activeBlock(s, ip));
    if (blocked) {
      u.done = true;
      const stopped = (u.result = `Unlock ${u.id} on ${target.name}'s workstation stopped: ${blocked} was blocked.`);
      note(actor, t, stopped);
      notify(s, 'HIDDEN_HOST', 'ACCESS', stopped, { to: actor.id });
      continue;
    }
    if (u.doneAt > t) continue;
    u.done = true;
    const cred = createCredential(s, { owner: target.id, system: 'WORKSTATION', module: null, permission: 'WRITE', issuedBy: null });
    actor.heldCredentialIds.push(cred.id);
    const done = (u.result = `Unlock ${u.id} complete: ${target.name}'s workstation (${target.ip}) opens with ${cred.id}, code ${cred.code}.`);
    note(actor, u.doneAt, done);
    notify(s, 'HIDDEN_HOST', 'ACCESS', done, { to: actor.id });
  }
}

H['HIDDEN_HOST.ACCESS.UNLOCK_WORKSTATION'] = (c, q) => {
  const ip = str(q, 'target');
  const target = Object.values(c.s.players).find((p) => p.ip === ip);
  if (!target) return bad('No workstation with that address.');
  if (target.id === c.actor.id) return bad('That is your own workstation.');
  if (activeBlock(c.s, ip)) return bad(`No route to ${ip}.`);
  // One unlock at a time, like a code crack.
  const running = c.s.unlocks.find((u) => !u.done);
  if (running) return bad(`Unlock ${running.id} (${nameOf(c.s, running.targetId)}'s workstation) is still running. Only one can run at a time.`);
  const sec = c.s.config.unlockSec;
  const u: WorkstationUnlock = { id: nextId(c.s, 'unlock', 'U'), actorId: c.actor.id, targetId: target.id, fromIp: effectiveIp(c.s, c.actor, c.t), doneAt: c.t + sec, done: false };
  c.s.unlocks.push(u);
  exposeEntry(c.s, c.log(), 3, 'WORKSTATION_UNLOCK', `Workstation unlock in progress on ${ip} (${target.name}): a new login completes in ${sec}s`);
  return good(`Unlock ${u.id} started on ${target.name}'s workstation. The new code arrives in ${sec}s, unless either end is blocked first — watch its progress here.`);
};

H['HIDDEN_HOST.ACCESS.LOCKOUT_BOMB'] = (c, q) => {
  const ip = str(q, 'target');
  const target = Object.values(c.s.players).find((p) => p.ip === ip);
  if (!target) return bad('No workstation with that address.');
  if (target.id === c.actor.id) return bad('That is your own workstation.');
  if (target.lockedUntil > c.t) return bad(`${ip} is already locked out.`);
  const fails = c.s.config.lockoutAfterFails;
  // Failed logins spoofed to come FROM the target, so their own anti-brute-force lockout trips.
  for (let i = 0; i < fails; i++) {
    const from = effectiveIp(c.s, target, c.t);
    const entry = addLog(c.s, { actor: 'UNKNOWN', kind: 'AUTH_FAIL', message: `Failed authentication attempt from ${from}`, sourceIp: from, actualPlayerId: c.actor.id });
    addAlert(c.s, 'AUTH_FAIL', `Failed authentication attempt from ${from}`, entry.id, 2);
  }
  target.failTotal += fails;
  target.failStreak = 0;
  target.lockedUntil = c.t + c.s.config.lockoutSec;
  raiseExposure(c, 2);
  return good(`${ip} (${target.name}) locked out for ${c.s.config.lockoutSec}s.`);
};

// ---- Cleanup ------------------------------------------------------------------
H['HIDDEN_HOST.CLEANUP.LOG_WIPER'] = (c, q) => {
  const id = normLog(str(q, 'logId'));
  const e = c.s.logs.find((x) => x.id === id);
  if (!e) return bad(`No such log entry: ${id}.`);
  if (e.deleted) return bad(`${id} is already wiped.`);
  e.deleted = true; // hidden from the log view; still in s.logs, so a Trace works until it ages out
  raiseExposure(c, 2);
  return good(`Wiped ${id} from the Master Log. The gap in the ids stays, and it can still be traced for now.`);
};

export const ALERT_MUTE_SEC = 10;
H['HIDDEN_HOST.CLEANUP.ALERT_MUTE'] = (c) => {
  c.s.alertMuteUntil = Math.max(c.s.alertMuteUntil, c.t + ALERT_MUTE_SEC);
  raiseExposure(c, 3); // tier 3: this alert (and any tier 3-4) is never muted, so the mute cannot hide the loud stuff
  return good(`Alerts muted for ${ALERT_MUTE_SEC}s. Only weak alerts are hidden; strong exposures still get through.`);
};

// ---- Social -------------------------------------------------------------------
const findPlayerByName = (s: GameState, name: string): Player | undefined => {
  const n = name.trim().toLowerCase();
  return n ? s.playerOrder.map((id) => s.players[id]).find((p) => p.name.toLowerCase() === n) : undefined;
};

H['HIDDEN_HOST.SOCIAL.SPOOFED_MESSAGE'] = (c, q) => {
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

H['HIDDEN_HOST.SOCIAL.SCAM_REQUEST'] = (c, q) => {
  const cust = findCustomer(c.s, str(q, 'customer'));
  if (!cust) return bad('No customer by that name or id.');
  const kind = str(q, 'kind').toUpperCase() as RequestKind;
  if (!(['PAYMENT', 'SET_PRIMARY', 'ADD_AND_PRIMARY', 'ADD_ACCOUNT', 'REMOVE_ACCOUNT'] as RequestKind[]).includes(kind)) return bad('Pick what the request asks for.');
  // A payment: who to pay and how much (from the customer's main account). Anything else: one account.
  let payee: Customer | undefined;
  let amount: number | null = null;
  let account: string | null = null;
  let urgent = false;
  if (kind === 'PAYMENT') {
    payee = findCustomer(c.s, str(q, 'payee'));
    if (!payee) return bad('No payee by that name or id.');
    if (payee.id === cust.id) return bad('A customer cannot ask to pay themselves.');
    amount = Math.round(Number(str(q, 'amount').replace(/[$,]/g, '')));
    if (!Number.isFinite(amount) || amount <= 0) return bad('Enter a positive amount.');
    if (amount > c.s.config.maxManualAmount) return bad(`Bankers cannot pay more than ${money(c.s.config.maxManualAmount)} by hand.`);
    urgent = str(q, 'urgent').toUpperCase() === 'YES';
  } else {
    account = normAccount(str(q, 'account'));
    if (!account) return bad('Enter a 5-digit account number.');
  }
  // Worded from the same forms as real requests.
  const id = nextId(c.s, 'req', 'REQ-');
  const text = payee && amount !== null ? paymentRequestText(c.s, cust, payee, amount, urgent, id) : accountRequestText(c.s, cust, kind as Exclude<RequestKind, 'PAYMENT'>, account!);
  const req: ClientRequest = {
    id,
    t: c.t,
    customerId: cust.id,
    bankerId: cust.bankerId,
    kind,
    text,
    payeeId: payee?.id ?? null,
    amount,
    originAccount: payee ? cust.primary : null,
    account,
    ...requestTimes(c.s, c.t, urgent), // shows a deadline like any request, but no customer will chase it
    scam: true,
    status: 'OPEN',
    closedAt: null,
    closedBy: null,
    closedByActual: null,
    txId: null,
    archiveReason: null,
  };
  c.s.requests.push(req);
  // Logged and notified exactly like a real incoming request, so nothing sets it apart.
  requestReceived(c.s, req);
  note(c.actor, c.t, `Planted scam account request ${req.id} from ${cust.name} (${payee ? `pay ${money(amount!)} to ${payee.name}${urgent ? ', urgent' : ''}` : `${kind} ${account}`}).`);
  raiseExposure(c, 2);
  const to = cust.bankerId ? nameOf(c.s, cust.bankerId) : 'their banker';
  return good(`Scam account request ${req.id} planted, from ${cust.name} to ${to}.`, [`"${text}"`]);
};

H['HIDDEN_HOST.INFILTRATION.REROUTE_IP'] = (c, q) => {
  // What to reroute: your own workstation (blank), any other workstation, or the unregistered host itself.
  const fromIp = str(q, 'source') || c.actor.ip;
  const host = fromIp === c.s.hiddenHost;
  const station = Object.values(c.s.players).find((p) => p.ip === fromIp);
  if (!host && !station) return bad('Reroute a workstation\'s IP or the server\'s address.');
  const toIp = pickProxy(c, q, fromIp);
  if (typeof toIp !== 'string') return bad(toIp.error);
  const seconds = Number(str(q, 'seconds') || '10');
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) return bad('Seconds must be a whole number from 1 to 60.');
  // One reroute per address: a new one replaces any that is still running. Written before the log entry, so
  // rerouting the host already hides its address in this very action's record.
  c.s.reroutes = c.s.reroutes.filter((r) => r.fromIp !== fromIp);
  c.s.reroutes.push({ fromIp, toIp, until: c.t + seconds, seconds, byPlayerId: c.actor.id });
  raiseExposure(c, 2);
  const what = host ? 'the server\'s address' : station!.id === c.actor.id ? 'your activity' : `activity from ${fromIp}`;
  return good(`For ${seconds}s ${what} appears as proxy ${toIp}.`);
};

// ---- Hidden host: the Thieves' own server ------------------------------------------
H['HIDDEN_HOST.BLACKNET.READ_MESSAGES'] = (c, q) => {
  const limit = clampInt(q.limit, 30, 1, 100);
  const rows = c.s.blacknet.slice(-limit).map((m) => `[${fmtClock(m.t)}] ${m.alias}: ${m.text}`);
  return good(`Blacknet: ${rows.length} message${rows.length === 1 ? '' : 's'}.`, rows);
};

H['HIDDEN_HOST.BLACKNET.POST_MESSAGE'] = (c, q) => {
  const text = str(q, 'text');
  if (!text) return bad('Write a message first.');
  c.s.blacknet.push({
    id: nextId(c.s, 'msg', 'N'),
    t: c.t,
    alias: c.owner.alias, // the credential owner's fixed alias: a borrowed code posts as its owner
    text: text.slice(0, 300),
    ownerId: c.owner.id,
  });
  notify(c.s, 'HIDDEN_HOST', 'BLACKNET', `${c.owner.alias}: ${text.length > 80 ? text.slice(0, 80) + '...' : text}`, { owner: c.actor.id });
  return good('Posted.');
};

/** Each mule account: the customer it is on (and whether it is their primary) or floating, and its balance. */
H['HIDDEN_HOST.TARGET_LEDGER.VIEW_TARGETS'] = (c) =>
  good(
    `Target accounts: ${money(c.s.totals.stolen)} of ${money(c.s.config.blackTarget)} diverted.${thiefTargetMet(c.s) ? ' Heist secured: Hold funds until close of business, or quit to escape with your prize.' : ''}`,
    c.s.targets.map((tg) => {
      const owner = accountOwner(c.s, tg.account);
      const where = owner ? `${owner.id}${owner.primary === tg.account ? ' (primary)' : ''}` : 'floating';
      const balance = balanceOf(c.s, tg.account);
      return `${tg.account}  ${where.padEnd(14)} ${money(balance)}  (stolen ${money(balance - tg.opening)})`;
    }),
  );

/** ALL: everything on the host's own log; ALERTS: only the moments an operative was exposed. */
H['HIDDEN_HOST.HOST_LOG.VIEW_HOST_LOG'] = (c, q) => {
  const alertsOnly = str(q, 'show') === 'ALERTS';
  const rows = c.s.hostLog
    .filter((h) => !alertsOnly || h.alert)
    .slice(-30)
    .map((h) => `[${fmtClock(h.t)}] ${h.id.padEnd(4)} ${h.alert ? '!! ' : ''}${h.message}`);
  return good(`Host log (${alertsOnly ? 'alerts' : 'all'}): ${rows.length}.`, rows.length ? rows : ['Nothing here.']);
};

H['HIDDEN_HOST.CREDENTIAL_CACHE.VIEW_CACHE'] = (c) => {
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
