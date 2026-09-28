// One handler per function in the catalog. Key format: SYSTEM.MODULE.FUNCTION.
// Handlers only run after authentication, authorization, online and encryption checks have passed.

import { findModule, findSystem, ROLES } from './catalog';
import {
  addAlert,
  fmtClock,
  keyOf,
  money,
  nameOf,
  nextId,
  normAccount,
  normBen,
  normCred,
  normLog,
  normTx,
  note,
  targetLabel,
} from './core';
import { createCredential } from './credentials';
import { computeRisk, reverseTransaction, settleTransaction } from './bank';
import type { Credential, GameState, LogEntry, Player, SystemId, Transaction } from './types';

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
  addAlert(c.s, 'ENCRYPTION_BYPASS', `Encryption bypassed on ${label}`, entry.id);
  return good(`Stripped ${n} layer${n > 1 ? 's' : ''} from ${label}.`);
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

// ---- Security: Master Log / Employees / Intrusion Detection ----------------
H['SECURITY.MASTER_LOG.VIEW_LOG'] = (c, q) => {
  const limit = clampInt(q.limit, 25, 1, 200);
  let entries = c.s.logs;
  if (str(q, 'humansOnly') === 'yes') entries = entries.filter((e) => e.actor !== 'SYSTEM');
  const rows = entries.slice(-limit).map((e) => `[${fmtClock(c.s.config, e.t)}] ${e.id.padEnd(5)} ${e.message}`);
  return good(`Master Log: ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.`, rows);
};

H['SECURITY.EMPLOYEE_RECORDS.VIEW_EMPLOYEES'] = (c) => {
  const rows = c.s.playerOrder.map((id) => {
    const p = c.s.players[id];
    return `${p.name.padEnd(12)} ${ROLES[p.role].label.padEnd(24)} ${p.ip}`;
  });
  return good('Employee Records:', rows);
};

H['SECURITY.INTRUSION_DETECTION.VIEW_ALERTS'] = (c, q) => {
  const limit = clampInt(q.limit, 20, 1, 100);
  const rows = c.s.alerts
    .slice(-limit)
    .map((a) => `[${fmtClock(c.s.config, a.t)}] ${a.kind}: ${a.message}${a.logId ? ` (log ${a.logId})` : ''}`);
  return good(`Intrusion Detection: ${rows.length} alert${rows.length === 1 ? '' : 's'}.`, rows);
};

H['SECURITY.INTRUSION_DETECTION.TRACE'] = (c, q) => {
  const id = normLog(str(q, 'logId'));
  const e = c.s.logs.find((x) => x.id === id);
  if (!e) return bad(`No such log entry: ${id}.`);
  const wait = c.actor.lastTraceAt + c.s.config.traceCooldownSec - c.t;
  if (wait > 0) return bad(`Trace engine cooling down (${Math.ceil(wait)}s).`);
  if (c.t - e.t > c.s.config.traceMaxAgeSec) return bad('That entry is too old to trace.');
  c.actor.lastTraceAt = c.t;
  if (!e.sourceIp) return good(`Trace ${e.id}: system event, no workstation origin.`, undefined, `ran a trace on ${e.id}`);
  return good(`Trace ${e.id}: origin workstation ${e.sourceIp}`, undefined, `ran a trace on ${e.id}`);
};

// ---- Client Data ------------------------------------------------------------
H['CLIENT_DATA.CUSTOMER_RECORDS.VIEW_CUSTOMERS'] = (c) =>
  good('Customer Records:', c.s.customers.map((x) => `${x.id.padEnd(4)} ${x.name.padEnd(22)} ${x.account}`));

H['CLIENT_DATA.BENEFICIARY_DATABASE.VIEW_BENEFICIARIES'] = (c) => {
  const rows = Object.values(c.s.beneficiaries).map((b) => {
    const edited = b.lastModifiedAt !== null ? `  edited ${fmtClock(c.s.config, b.lastModifiedAt)}` : '';
    return `${b.id.padEnd(4)} ${b.name.padEnd(22)} ${b.account}  verified: ${b.verified ? 'yes' : 'NO'}${edited}`;
  });
  return good('Beneficiary Database:', rows);
};

H['CLIENT_DATA.BENEFICIARY_DATABASE.MODIFY_BENEFICIARY'] = (c, q) => {
  const b = c.s.beneficiaries[normBen(str(q, 'beneficiaryId'))];
  if (!b) return bad('No such beneficiary.');
  const acc = normAccount(str(q, 'newAccount'));
  if (!acc) return bad('Account must be 5 digits.');
  if (acc === b.account) return bad('That is already the beneficiary\'s account.');
  b.history.push({ t: c.t, byOwner: c.owner.id, from: b.account, to: acc });
  b.account = acc;
  b.verified = false;
  b.lastModifiedAt = c.t;
  return good(`${b.name} now pays to ${acc}. The record is unverified.`, undefined, `modified Beneficiary ${b.id} (${b.name})`);
};

H['CLIENT_DATA.BENEFICIARY_DATABASE.INVESTIGATE_CHANGES'] = (c, q) => {
  const b = c.s.beneficiaries[normBen(str(q, 'beneficiaryId'))];
  if (!b) return bad('No such beneficiary.');
  if (b.history.length === 0) return good(`${b.id} ${b.name}: no changes on record.`, undefined, `investigated changes to Beneficiary ${b.id}`);
  const rows = b.history.map((h) => `[${fmtClock(c.s.config, h.t)}] ${h.from} -> ${h.to} by ${nameOf(c.s, h.byOwner)}`);
  return good(`${b.id} ${b.name}: ${b.history.length} change${b.history.length > 1 ? 's' : ''}.`, rows, `investigated changes to Beneficiary ${b.id}`);
};

H['CLIENT_DATA.PERMISSIONS.VIEW_PERMISSIONS'] = (c) => {
  const rows = Object.values(c.s.credentials)
    // Credentials for the hidden host that were issued at game start are not in the bank's registry.
    .filter((cr) => !(cr.system === 'BLACKHAT_DB' && cr.issuedBy === null))
    .map((cr) => {
      const by = cr.issuedBy === null ? 'start of shift' : nameOf(c.s, cr.issuedBy);
      return `${cr.id.padEnd(4)} ${nameOf(c.s, cr.owner).padEnd(12)} ${scopeText(cr).padEnd(44)} ${cr.status.padEnd(8)} issued: ${by}`;
    });
  return good('Permissions registry (codes hidden):', rows);
};

H['CLIENT_DATA.PERMISSIONS.CREATE_CREDENTIAL'] = (c, q) => {
  const owner = c.s.players[str(q, 'owner')];
  if (!owner) return bad('Choose an employee to issue to.');
  const [sys, mod] = str(q, 'scope').split('.');
  const sysDef = findSystem(sys);
  if (!sysDef || !c.actor.knownSystems.includes(sysDef.id)) return bad('Unknown system.');
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
  return good(`Credential ${cred.id} issued to ${owner.name}. Code: ${cred.code}`, undefined, `issued credential ${cred.id} to ${owner.name} (${scopeText(cred)})`);
};

H['CLIENT_DATA.PERMISSIONS.REVOKE_CREDENTIAL'] = (c, q) => {
  const cr = c.s.credentials[normCred(str(q, 'credentialId'))];
  if (!cr) return bad('No such credential.');
  if (cr.status === 'REVOKED') return bad('Already revoked.');
  cr.status = 'REVOKED';
  const owner = c.s.players[cr.owner];
  if (owner.id !== c.actor.id) note(owner, c.t, `Your credential ${cr.id} (${scopeText(cr)}) was revoked.`);
  return good(`Credential ${cr.id} revoked.`, undefined, `revoked credential ${cr.id} (${owner.name})`);
};

H['CLIENT_DATA.VERIFICATION.VERIFY_BENEFICIARY'] = (c, q) => {
  const b = c.s.beneficiaries[normBen(str(q, 'beneficiaryId'))];
  if (!b) return bad('No such beneficiary.');
  if (b.verified) return bad('Already verified.');
  b.verified = true;
  return good(`${b.name} marked verified.`, undefined, `verified Beneficiary ${b.id} (${b.name})`);
};

// ---- Transaction Processing --------------------------------------------------
const ACTIVE = ['QUEUED', 'RISK_CHECKED', 'AUTHORIZED', 'HELD'];
function txLine(c: Ctx, tx: Transaction): string {
  const b = c.s.beneficiaries[tx.beneficiaryId];
  const risk = tx.riskResult ? ` risk ${tx.riskResult}${tx.riskFlags.length ? ' (' + tx.riskFlags.join(', ') + ')' : ''}` : '';
  return `${tx.id}  ${money(tx.amount).padStart(11)}  to ${b.name} ${b.account}  [${tx.status}${risk}]  ${tx.origin === 'NPC' ? 'batch' : 'manual'}`;
}

H['TRANSACTIONS.PAYMENT_QUEUE.VIEW_QUEUE'] = (c, q) => {
  const all = str(q, 'show') === 'ALL';
  const rows = c.s.transactions.filter((tx) => all || ACTIVE.includes(tx.status)).slice(-40).map((tx) => txLine(c, tx));
  return good(`Payment Queue: ${rows.length} payment${rows.length === 1 ? '' : 's'}.`, rows);
};

H['TRANSACTIONS.PAYMENT_QUEUE.CREATE_TRANSACTION'] = (c, q) => {
  const b = c.s.beneficiaries[normBen(str(q, 'beneficiaryId'))];
  if (!b) return bad('No such beneficiary.');
  const amount = Math.round(Number(str(q, 'amount')));
  if (!Number.isFinite(amount) || amount <= 0) return bad('Enter a positive amount.');
  if (amount > c.s.config.maxManualAmount) return bad(`Manual payments are capped at ${money(c.s.config.maxManualAmount)}.`);
  const tx: Transaction = {
    id: nextId(c.s, 'tx', 'TX-', 4),
    amount,
    customerId: c.s.customers[0].id,
    beneficiaryId: b.id,
    origin: 'PLAYER',
    createdBy: c.owner.id,
    status: 'QUEUED',
    createdAt: c.t,
    riskResult: null,
    riskFlags: [],
    authorizedBy: null,
    settledAt: null,
    settledTo: null,
    fraud: false,
  };
  c.s.transactions.push(tx);
  return good(`Queued ${tx.id}.`, undefined, `created payment ${tx.id} (${money(amount)}) to ${b.name}`);
};

H['TRANSACTIONS.RISK_CHECK.RUN_RISK_CHECK'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'QUEUED' && tx.status !== 'RISK_CHECKED') return bad(`${tx.id} is ${tx.status}; it cannot be risk checked.`);
  const r = computeRisk(c.s, tx);
  tx.riskResult = r.result;
  tx.riskFlags = r.flags;
  tx.status = 'RISK_CHECKED';
  return good(`${tx.id}: risk ${r.result}${r.flags.length ? ' - ' + r.flags.join(', ') : ''}`, undefined, `ran risk check on ${tx.id}`);
};

H['TRANSACTIONS.AUTHORIZATION.APPROVE'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'RISK_CHECKED' && tx.status !== 'HELD') return bad(`${tx.id} is ${tx.status}; it cannot be approved.`);
  if (!tx.riskResult) return bad('Run a risk check first.');
  tx.status = 'AUTHORIZED';
  tx.authorizedBy = c.owner.id;
  return good(`${tx.id} approved.`, undefined, `approved ${tx.id}`);
};

H['TRANSACTIONS.AUTHORIZATION.REJECT'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (!ACTIVE.includes(tx.status)) return bad(`${tx.id} is ${tx.status}; it cannot be rejected.`);
  tx.status = 'REJECTED';
  return good(`${tx.id} rejected.`, undefined, `rejected ${tx.id}`);
};

H['TRANSACTIONS.AUTHORIZATION.HOLD'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'QUEUED' && tx.status !== 'RISK_CHECKED' && tx.status !== 'AUTHORIZED') return bad(`${tx.id} is ${tx.status}; it cannot be held.`);
  tx.status = 'HELD';
  return good(`${tx.id} held.`, undefined, `held ${tx.id}`);
};

H['TRANSACTIONS.SETTLEMENT.SETTLE'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'AUTHORIZED') return bad(`${tx.id} is ${tx.status}; only approved payments can be settled.`);
  const r = settleTransaction(c.s, tx);
  const b = c.s.beneficiaries[tx.beneficiaryId];
  return good(`${tx.id} settled: ${money(tx.amount)} paid to ${r.account} (${b.name}).`, undefined, `settled ${tx.id}`);
};

H['TRANSACTIONS.SETTLEMENT.REVERSE'] = (c, q) => {
  const tx = getTx(c, q);
  if (typeof tx === 'string') return bad(tx);
  if (tx.status !== 'SETTLED' || tx.settledAt === null) return bad(`${tx.id} is ${tx.status}; only settled payments can be reversed.`);
  if (c.t - tx.settledAt > c.s.config.reversalWindowSec) return bad('The reversal window has closed.');
  reverseTransaction(c.s, tx);
  return good(`${tx.id} reversed.`, undefined, `reversed ${tx.id}`);
};

H['TRANSACTIONS.SETTLEMENT.VIEW_SETTLED'] = (c, q) => {
  const limit = clampInt(q.limit, 20, 1, 100);
  const rows = c.s.transactions
    .filter((tx) => tx.status === 'SETTLED' || tx.status === 'REVERSED')
    .slice(-limit)
    .map((tx) => {
      const left = tx.settledAt === null ? 0 : Math.max(0, c.s.config.reversalWindowSec - (c.t - tx.settledAt));
      const rev = tx.status === 'SETTLED' && left > 0 ? `  reversible for ${Math.ceil(left)}s` : '';
      return `${tx.id}  ${money(tx.amount).padStart(11)}  paid to ${tx.settledTo}  [${tx.status}]${rev}`;
    });
  return good(`Settlement ledger: ${rows.length} payment${rows.length === 1 ? '' : 's'}.`, rows);
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

H['BLACKHAT_DB.CREDENTIAL_CACHE.VIEW_CACHE'] = (c) => {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const bp of Object.values(c.s.players)) {
    if (bp.allegiance !== 'BLACK') continue;
    for (const id of bp.heldCredentialIds) {
      const cr = c.s.credentials[id];
      if (!cr || seen.has(id) || c.s.players[cr.owner].allegiance !== 'WHITE') continue;
      seen.add(id);
      rows.push(`${cr.id.padEnd(4)} ${nameOf(c.s, cr.owner).padEnd(12)} ${scopeText(cr).padEnd(44)} code ${cr.code}  ${cr.status}`);
    }
  }
  return good(`Credential Cache: ${rows.length} compromised credential${rows.length === 1 ? '' : 's'}.`, rows);
};

export const HANDLERS = H;
