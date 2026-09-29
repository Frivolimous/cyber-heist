// The bank's payment pipeline: NPC traffic, risk scoring, settlement and reversal.

import { pick, rand, weightedPick } from './rng';
import { accountVerified, addLog, balanceOf, gameTime, money, moveMoney, nameOf, nextId } from './core';
import { notify } from './notify';
import type { ClientRequest, Customer, GameState, PlayerId, RiskResult, Transaction, TxEvent, TxStatus } from './types';

/** Who did something to a payment: the credential owner the records will show, and who really did it. */
export interface TxActor {
  by: PlayerId | 'SYSTEM';
  actualPlayerId: PlayerId | null;
}
export const SYSTEM_ACTOR: TxActor = { by: 'SYSTEM', actualPlayerId: null };

export function recordTx(s: GameState, tx: Transaction, action: TxEvent['action'], who: TxActor, detail: string | null = null): void {
  tx.history.push({ t: gameTime(s), action, by: who.by, actualPlayerId: who.actualPlayerId, detail });
  notifyStage(s, tx, action, who);
}

/** Payment pipeline bells: each stage tells the next one there is work, unless that stage's automation will take it. */
function notifyStage(s: GameState, tx: Transaction, action: TxEvent['action'], who: TxActor): void {
  const scope = { owner: who.by === 'SYSTEM' ? null : who.by };
  const pay = `${tx.id} (${money(tx.amount)} to ${tx.beneficiaryId})`;
  if (action === 'CREATED') {
    const by = who.by === 'SYSTEM' ? (tx.channel ?? 'automatic') : nameOf(s, who.by);
    notify(s, 'TRANSACTIONS', 'PAYMENT_QUEUE', `New payment ${pay} from ${by}`, scope);
    if (!autoScores(s, tx)) notify(s, 'TRANSACTIONS', 'RISK_CHECK', `${pay} is waiting for a risk score`, scope);
  } else if (action === 'RISK_CHECKED' && !autoApproves(s, tx)) {
    notify(s, 'TRANSACTIONS', 'AUTHORIZATION', `${pay} is waiting for approval (${tx.riskResult} risk)`, scope);
  } else if (action === 'APPROVED' && !autoSettles(s, tx)) {
    notify(s, 'TRANSACTIONS', 'SETTLEMENT', `${pay} is ready to settle`, scope);
  }
}

export const riskDetail = (tx: Transaction): string =>
  `risk ${tx.riskResult}${tx.riskFlags.length ? ' (' + tx.riskFlags.join(', ') + ')' : ''}`;

export function computeRisk(s: GameState, tx: Transaction): { result: RiskResult; flags: string[] } {
  const flags: string[] = [];
  const payee = s.customers.find((c) => c.id === tx.beneficiaryId);
  const t = gameTime(s);
  if (payee && !accountVerified(payee, payee.primary)) flags.push('UNVERIFIED_PRIMARY');
  if (payee && payee.lastModifiedAt !== null && t - payee.lastModifiedAt < s.config.recentModifySec) {
    flags.push('RECENTLY_CHANGED_PRIMARY');
  }
  if (tx.amount > s.config.largeAmount) flags.push('LARGE_AMOUNT');
  if (tx.origin === 'PLAYER') flags.push('MANUAL_ENTRY');
  const result: RiskResult = flags.length === 0 ? 'LOW' : flags.length === 1 ? 'MEDIUM' : 'HIGH';
  return { result, flags };
}

/** Customers still doing business with the bank today (not suspended after missed requests). */
export const activeCustomers = (s: GameState): Customer[] => s.customers.filter((c) => !c.suspended);

/** Payments that went nowhere: they answer no request. */
const DEAD: TxStatus[] = ['REJECTED', 'FAILED', 'REVERSED'];

/** A manual payment made exactly as a request asked: from one of the customer's accounts, to the payee, for the amount. */
const madeAsAsked = (tx: Transaction, r: ClientRequest): boolean =>
  tx.origin === 'PLAYER' && tx.customerId === r.customerId && tx.beneficiaryId === r.payeeId && tx.amount === r.amount && tx.createdAt >= r.t;

/** Links a payment to the request it answers and marks the request done (credited to whoever created the payment). */
function linkPayment(s: GameState, r: ClientRequest, tx: Transaction): void {
  tx.requestId = r.id;
  r.txId = tx.id;
  r.status = 'DONE';
  r.closedAt = gameTime(s);
  r.closedBy = tx.createdBy;
  r.closedByActual = tx.history.find((e) => e.action === 'CREATED')?.actualPlayerId ?? null;
}

/**
 * The live payment answering a payment request, if any: the one linked to it, or else an unlinked payment made
 * exactly as asked, which gets linked now. So paying as requested counts even if the request was archived
 * instead of linked. Expired requests are answered by nothing.
 */
export function paymentFor(s: GameState, r: ClientRequest): Transaction | null {
  if (r.kind !== 'PAYMENT' || r.outcome === 'MISSED') return null; // past its deadline with nothing done
  const linked = r.txId ? s.transactions.find((tx) => tx.id === r.txId) : undefined;
  if (linked && !DEAD.includes(linked.status)) return linked;
  const tx = s.transactions.find((x) => !x.requestId && !DEAD.includes(x.status) && madeAsAsked(x, r));
  if (!tx) return null;
  linkPayment(s, r, tx);
  return tx;
}

/** At settlement: an unlinked manual payment made exactly as an undecided request asked answers that request. */
function matchRequest(s: GameState, tx: Transaction): void {
  const r = s.requests.find((x) => x.kind === 'PAYMENT' && x.outcome === null && x.status !== 'EXPIRED' && madeAsAsked(tx, x) && paymentFor(s, x) === null);
  if (r && !tx.requestId) linkPayment(s, r, tx);
}

/**
 * Does this payment count toward the bank's target? Automatic payments always do. A manual payment counts
 * only when it fulfils a customer's payment request: linked to it, to the payee and for the amount asked.
 * (Otherwise players could invent payments to hit the target.) A request can be linked only once. A scam or
 * phishing request has no real customer behind it: paying it never counts.
 */
export function countsForBank(s: GameState, tx: Transaction): boolean {
  if (tx.origin === 'NPC') return true;
  const req = tx.requestId ? s.requests.find((r) => r.id === tx.requestId) : undefined;
  return !!req && !req.scam && !req.phish && req.kind === 'PAYMENT' && req.payeeId === tx.beneficiaryId && req.amount === tx.amount;
}

/** An employee's own account: money settled there is embezzled, and counts toward no goal. */
export const isEmployeeAccount = (s: GameState, account: string | null): boolean =>
  account !== null && Object.values(s.players).some((p) => p.bankAccount === account);

/** A settled payment's contribution to the bank's target: never when it went to a mule or an employee. */
const creditsBank = (s: GameState, tx: Transaction): boolean => !tx.fraud && !isEmployeeAccount(s, tx.settledTo) && countsForBank(s, tx);

/**
 * Moves the money at once: out of the originator account, into whatever account is the beneficiary's primary
 * RIGHT NOW. If the originator account holds too little at that moment, the payment FAILS instead.
 */
export function settleTransaction(s: GameState, tx: Transaction, who: TxActor): { ok: boolean; account: string; fraud: boolean } {
  const account = s.customers.find((c) => c.id === tx.beneficiaryId)!.primary;
  const from = tx.originAccount;
  if (balanceOf(s, from) < tx.amount) {
    tx.status = 'FAILED';
    recordTx(s, tx, 'FAILED', who, `insufficient funds in ${from}`);
    return { ok: false, account, fraud: false };
  }
  const fraud = s.targets.some((tg) => tg.account === account);
  tx.status = 'SETTLED';
  tx.settledAt = gameTime(s);
  tx.settledTo = account;
  tx.debitedFrom = from;
  tx.fraud = fraud;
  moveMoney(s, from, account, tx.amount); // the stolen total follows the Target Ledger balances
  recordTx(s, tx, 'SETTLED', who, `${money(tx.amount)} from ${from} to ${account}`);
  if (!tx.requestId) matchRequest(s, tx);
  if (creditsBank(s, tx)) s.totals.processed += tx.amount;
  return { ok: true, account, fraud };
}

/** Claws the money back from the account it was paid into. Fails (false) if that account no longer holds it all. */
export function reverseTransaction(s: GameState, tx: Transaction, who: TxActor): boolean {
  if (balanceOf(s, tx.settledTo!) < tx.amount) return false;
  moveMoney(s, tx.settledTo!, tx.debitedFrom!, tx.amount);
  if (creditsBank(s, tx)) s.totals.processed -= tx.amount;
  tx.status = 'REVERSED';
  recordTx(s, tx, 'REVERSED', who, `${money(tx.amount)} returned from ${tx.settledTo} to ${tx.debitedFrom}`);
  return true;
}

/** Where automatic payments come in from. Shown as "created by" so players see a source, not a fake person. */
export const CHANNELS = ['Online banking', 'Mobile app', 'Standing order', 'Branch transfer'];

const NOISE = [
  'Nightly backup checkpoint written',
  'Customer portal session opened',
  'Customer portal session closed',
  'Scheduled certificate check passed',
  'Batch processor heartbeat',
  'Statement generation job finished',
  'ATM network sync completed',
  'Session cleanup removed idle connections',
];

// ---- Who pays whom, and how much ------------------------------------------------
/** The smallest payment customers make (automatic payments and payment requests). */
export const MIN_PAYMENT = 10_000;
/** Automatic payments and payment requests take at most this share of the paying account's balance. */
export const MAX_BALANCE_SHARE = 0.4;

export const customerMoney = (s: GameState, c: Customer): number => c.accounts.reduce((sum, a) => sum + balanceOf(s, a), 0);
/** Customers pay and get paid roughly in proportion to their wealth, so money does not just drain from rich to poor. */
export const wealthWeight = (s: GameState, c: Customer): number => customerMoney(s, c) + 250_000;
/** The account a customer pays from: the richer the account, the likelier. */
export const payingAccount = (s: GameState, c: Customer): string => weightedPick(s, c.accounts, (a) => balanceOf(s, a) + 1);

/**
 * An amount between min and max (rounded to $1,000) that the account can afford right now, or null if it cannot
 * afford even MIN_PAYMENT. A small account pays between a quarter of its cap and its cap, not always the cap.
 */
export function affordableAmount(s: GameState, account: string, min: number, max: number): number | null {
  const cap = Math.floor((balanceOf(s, account) * MAX_BALANCE_SHARE) / 1000) * 1000;
  if (cap < MIN_PAYMENT) return null;
  const hi = Math.min(max, cap);
  const lo = Math.max(MIN_PAYMENT, Math.min(min, hi / 4));
  return Math.round((lo + rand(s) * (hi - lo)) / 1000) * 1000;
}

/** An automatic payment between two customers. Skipped when the chosen account cannot afford one. */
export function spawnNpc(s: GameState): void {
  const active = activeCustomers(s); // suspended customers neither pay nor get paid
  if (active.length < 2) return;
  const c = weightedPick(s, active, (x) => wealthWeight(s, x));
  const payee = weightedPick(s, active.filter((x) => x.id !== c.id), (x) => wealthWeight(s, x));
  const from = payingAccount(s, c);
  const amount = affordableAmount(s, from, s.config.npcMinAmount, s.config.npcMaxAmount);
  if (amount === null) return;
  const tx: Transaction = {
    id: nextId(s, 'tx', 'TX-', 4),
    amount,
    customerId: c.id,
    originAccount: from,
    beneficiaryId: payee.id,
    origin: 'NPC',
    createdBy: null,
    channel: pick(s, CHANNELS),
    status: 'QUEUED',
    createdAt: gameTime(s),
    riskResult: null,
    riskFlags: [],
    riskReason: null,
    authorizedBy: null,
    settledAt: null,
    settledTo: null,
    debitedFrom: null,
    fraud: false,
    history: [],
    requestId: null,
  };
  s.transactions.push(tx);
  recordTx(s, tx, 'CREATED', SYSTEM_ACTOR, `${tx.channel}: ${money(amount)} from ${from} to ${payee.id}`);
  addLog(s, {
    actor: 'SYSTEM',
    kind: 'NPC_TX',
    message: `Batch processor queued ${tx.id} (${money(amount)})`,
    sourceIp: null,
    actualPlayerId: null,
  });
  if (rand(s) < 0.6) {
    addLog(s, { actor: 'SYSTEM', kind: 'NOISE', message: pick(s, NOISE), sourceIp: null, actualPlayerId: null });
  }
}

// ---- Automation: each stage can handle routine payments by itself (s.automation) ----------------

const RISK_RANK: Record<RiskResult, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/** Risk Check scores this queued payment LOW by itself: small enough, and from the sources the settings allow. */
export function autoScores(s: GameState, tx: Transaction): boolean {
  const a = s.automation;
  if (tx.amount > a.scoreMax) return false;
  if (a.scoreSource === 'AUTOMATIC' && tx.origin !== 'NPC') return false;
  if (a.scoreOrigin === 'CUSTOMER' && tx.customerId === null) return false;
  const payee = s.customers.find((c) => c.id === tx.beneficiaryId);
  return a.scorePayee === 'ANY' || (!!payee && accountVerified(payee, payee.primary));
}
/** Authorization approves this risk-checked payment by itself. */
export const autoApproves = (s: GameState, tx: Transaction): boolean =>
  s.automation.approveUpTo !== 'NONE' && tx.riskResult !== null && RISK_RANK[tx.riskResult] <= RISK_RANK[s.automation.approveUpTo];
/** Settlement settles this approved payment by itself. */
export const autoSettles = (s: GameState, tx: Transaction): boolean => tx.amount <= s.automation.settleMax;

/** Mutating: moves every payment the automation settings cover through as many stages as they allow. */
export function runAutomation(s: GameState): void {
  for (const tx of s.transactions) {
    if (tx.status === 'QUEUED' && autoScores(s, tx)) {
      tx.riskResult = 'LOW';
      tx.riskReason = 'Automatic scoring';
      tx.riskFlags = computeRisk(s, tx).flags; // hidden ground truth, as for a human score
      tx.status = 'RISK_CHECKED';
      recordTx(s, tx, 'RISK_CHECKED', SYSTEM_ACTOR, 'risk LOW: automatic scoring');
    }
    if (tx.status === 'RISK_CHECKED' && autoApproves(s, tx)) {
      tx.status = 'AUTHORIZED';
      recordTx(s, tx, 'APPROVED', SYSTEM_ACTOR, `automatic approval (${tx.riskResult} risk)`);
    }
    if (tx.status === 'AUTHORIZED' && autoSettles(s, tx)) {
      const settled = settleTransaction(s, tx, SYSTEM_ACTOR);
      addLog(s, {
        actor: 'SYSTEM',
        kind: 'AUTO_SETTLE',
        message: settled.ok ? `Automation settled ${tx.id}` : `Automation: ${tx.id} failed, insufficient funds`,
        sourceIp: null,
        actualPlayerId: null,
      });
    }
  }
}

/** What each stage's automation does right now, in words. */
export function automationText(s: GameState, stage: 'RISK' | 'AUTH' | 'SETTLE'): string {
  const a = s.automation;
  if (stage === 'RISK') {
    if (a.scoreMax <= 0) return 'Automatic scoring: off.';
    const source = a.scoreSource === 'AUTOMATIC' ? 'automatic payments' : 'automatic and manual payments';
    const origin = a.scoreOrigin === 'CUSTOMER' ? 'from customer accounts' : 'from customer or floating accounts';
    const payee = a.scorePayee === 'VERIFIED' ? 'to verified primaries' : 'to any primary';
    return `Automatic scoring: LOW for ${source} up to ${money(a.scoreMax)}, ${origin}, ${payee}.`;
  }
  if (stage === 'AUTH') return a.approveUpTo === 'NONE' ? 'Automatic approval: off.' : `Automatic approval: ${a.approveUpTo === 'LOW' ? 'LOW' : `${a.approveUpTo} risk and below`}.`;
  return a.settleMax <= 0 ? 'Automatic settlement: off.' : `Automatic settlement: payments up to ${money(a.settleMax)}.`;
}
