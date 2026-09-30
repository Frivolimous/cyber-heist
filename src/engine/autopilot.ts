// SOLO test scenario: the scripted White Hat seats (see ScenarioKind in types.ts). Dev tooling, not gameplay.
//
// The bots play through the same actions as people, with their own codes, so every log, alert and bell is
// real. They are diligent but not detectives:
// - Banker bots act on their customers' requests a few seconds after they arrive: they archive obvious
//   phishing and believe everything else (a Social scam works on them). The first banker bot also decides
//   risk-checked payments: approves LOW and MEDIUM, and HIGH only when it was made for a request; holds the rest.
// - The A&R bot scores what automation leaves (with the bank's own risk assessment), verifies account changes
//   a customer asked for (never the others), and settles approved payments.
// - The IT bot traces, whenever its cooldown allows, the newest untraced entry an alert points at, else the
//   newest "Unknown server activity" entry. It has the normal cooldown and age limit, but never misses one.
//   It never acts on what it learns: the scenario only records when a trace exposes the human's workstation
//   IP or the hidden host's address (ScenarioState).
// - The Manager bot does nothing.

import { computeRisk } from './bank';
import { gameTime, normAccount } from './core';
import type { ActionResult, ExecuteAction, GameState, Player, RoleId, SystemId } from './types';

type Execute = (s: GameState, p: Player, a: ExecuteAction) => ActionResult;

/** Seconds a bot waits before acting on new work (so the human gets a window, as with people). */
export const BOT_DELAY_SEC = 8;

const bots = (s: GameState, role: RoleId): Player[] =>
  s.playerOrder.map((id) => s.players[id]).filter((p) => p.bot && p.role === role && !p.terminated);

/** The bot's own code for a module (a whole-system credential covers it too). */
function codeFor(s: GameState, p: Player, system: SystemId, module: string): string | null {
  const cr = Object.values(s.credentials).find(
    (c) => c.owner === p.id && c.status === 'ACTIVE' && c.system === system && (c.module === null || c.module === module) && c.permission === 'WRITE',
  );
  return cr?.code ?? null;
}

/** Does the text name this exact address (10.1.0.1 is not in 10.1.0.12)? A partial clue (10.1.x.12) does not. */
const names = (text: string, ip: string): boolean => new RegExp(`(^|[^\\d.])${ip.replace(/\./g, '\\.')}(?![\\d])`).test(text);

export function runAutopilot(s: GameState, execute: Execute): void {
  const sc = s.scenario;
  if (sc?.kind !== 'SOLO' || s.status !== 'RUNNING') return;
  const t = gameTime(s);
  const handled = new Set(sc.handled);
  const act = (p: Player, key: string, system: SystemId, module: string, fn: string, params: Record<string, string>): ActionResult | null => {
    if (handled.has(key)) return null;
    handled.add(key);
    sc.handled.push(key);
    const code = codeFor(s, p, system, module);
    return code ? execute(s, p, { type: 'EXECUTE', playerId: p.id, code, system, module, fn, params }) : null;
  };
  const ripe = (at: number): boolean => t - at >= BOT_DELAY_SEC;
  const digits = (account: string | null): string => (account ?? '').slice(4);

  // Personal Bankers: their own customers' requests.
  const bankers = bots(s, 'PERSONAL_BANKER');
  for (const b of bankers) {
    for (const r of s.requests) {
      if (r.bankerId !== b.id || r.status !== 'OPEN' || r.outcome !== null || !ripe(r.t)) continue;
      const key = `req:${r.id}:${r.reminders.length}`;
      if (r.phish) {
        act(b, key, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: r.id, reason: 'Phishing' });
      } else if (r.kind === 'PAYMENT') {
        act(b, key, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', {
          originAccount: digits(r.originAccount),
          beneficiaryId: r.payeeId ?? '',
          amount: String(r.amount ?? 0),
          requestId: r.id,
        });
      } else {
        const fn = r.kind === 'ADD_AND_PRIMARY' ? 'ADD_ACCOUNT' : r.kind;
        const params: Record<string, string> = { customerId: r.customerId, account: digits(r.account), requestId: r.id };
        if (fn === 'ADD_ACCOUNT') params.makePrimary = r.kind === 'ADD_AND_PRIMARY' ? 'YES' : 'NO';
        act(b, key, 'CLIENT_DATA', 'CUSTOMER_RECORDS', fn, params);
      }
    }
  }
  // Authorization: the first banker bot approves LOW and MEDIUM (and HIGH made for a request), holds other HIGH.
  const approver = bankers[0];
  if (approver) {
    for (const tx of s.transactions) {
      if (tx.status !== 'RISK_CHECKED' || !ripe(tx.history.at(-1)!.t)) continue;
      if (tx.riskResult === 'HIGH' && !tx.requestId) act(approver, `hold:${tx.id}`, 'TRANSACTIONS', 'AUTHORIZATION', 'HOLD', { txId: tx.id, reason: 'High risk' });
      else act(approver, `approve:${tx.id}`, 'TRANSACTIONS', 'AUTHORIZATION', 'APPROVE', { txId: tx.id });
    }
  }

  // Accounts & Receivables: score, verify requested changes, settle.
  const ar = bots(s, 'ACCOUNTS_RECEIVABLES')[0];
  if (ar) {
    for (const tx of s.transactions) {
      if (tx.status === 'QUEUED' && ripe(tx.createdAt)) {
        const risk = computeRisk(s, tx);
        act(ar, `score:${tx.id}`, 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id, score: risk.result, reason: risk.flags.join(', ') || 'Routine' });
      } else if (tx.status === 'AUTHORIZED' && ripe(tx.history.at(-1)!.t)) {
        act(ar, `settle:${tx.id}`, 'TRANSACTIONS', 'SETTLEMENT', 'SETTLE', { txId: tx.id });
      }
    }
    for (const c of s.customers) {
      for (const h of c.history) {
        if (h.verified || !ripe(h.t)) continue;
        const asked = s.requests.some(
          (r) => !r.phish && r.customerId === c.id && r.account !== null && normAccount(r.account) === h.account && (h.action === 'REMOVE_ACCOUNT') === (r.kind === 'REMOVE_ACCOUNT'),
        );
        if (asked) act(ar, `verify:${h.id}`, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: h.id });
      }
    }
  }

  // IT: trace what an alert points at, else hidden host activity, whenever the cooldown allows.
  const it = bots(s, 'IT_SPECIALIST')[0];
  if (it && t - it.lastTraceAt >= s.config.traceCooldownSec) {
    const traced = new Set(sc.traced);
    const fresh = (id: string | null): boolean => {
      const e = id ? s.logs.find((x) => x.id === id) : undefined;
      return !!e && !traced.has(e.id) && t - e.t <= s.config.traceMaxAgeSec;
    };
    const alerted = [...s.alerts].reverse().find((a) => fresh(a.logId))?.logId;
    const hidden = [...s.logs].reverse().find((e) => e.kind === 'HIDDEN_ACCESS' && fresh(e.id))?.id;
    const logId = alerted ?? hidden;
    const code = codeFor(s, it, 'SECURITY', 'MASTER_LOG');
    if (logId && code) {
      sc.traced.push(logId);
      const r = execute(s, it, { type: 'EXECUTE', playerId: it.id, code, system: 'SECURITY', module: 'MASTER_LOG', fn: 'TRACE', params: { logId } });
      const human = s.playerOrder.map((id) => s.players[id]).find((p) => !p.bot);
      const exposes: ('IP' | 'HOST')[] = [];
      if (human && names(r.message, human.ip)) exposes.push('IP');
      if (names(r.message, s.hiddenHost)) exposes.push('HOST');
      sc.traceLog.push({ t, logId, text: r.message, exposes });
      if (exposes.includes('IP')) sc.exposedIpAt ??= t;
      if (exposes.includes('HOST')) sc.exposedHostAt ??= t;
    }
  }
}
