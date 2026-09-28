// The bank's payment pipeline: NPC traffic, risk scoring, settlement and reversal.

import { pick, rand } from './rng';
import { accountVerified, addLog, gameTime, money, nextId } from './core';
import type { GameState, PlayerId, RiskResult, Transaction, TxEvent } from './types';

/** Who did something to a payment: the credential owner the records will show, and who really did it. */
export interface TxActor {
  by: PlayerId | 'SYSTEM';
  actualPlayerId: PlayerId | null;
}
export const SYSTEM_ACTOR: TxActor = { by: 'SYSTEM', actualPlayerId: null };

export function recordTx(s: GameState, tx: Transaction, action: TxEvent['action'], who: TxActor, detail: string | null = null): void {
  tx.history.push({ t: gameTime(s), action, by: who.by, actualPlayerId: who.actualPlayerId, detail });
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

/** Pays the transaction into whatever account is the beneficiary's primary RIGHT NOW. */
export function settleTransaction(s: GameState, tx: Transaction, who: TxActor): { account: string; fraud: boolean } {
  const account = s.customers.find((c) => c.id === tx.beneficiaryId)!.primary;
  const from = tx.originAccount;
  const fraud = s.targets.some((tg) => tg.account === account);
  tx.status = 'SETTLED';
  tx.settledAt = gameTime(s);
  tx.settledTo = account;
  tx.debitedFrom = from;
  tx.fraud = fraud;
  recordTx(s, tx, 'SETTLED', who, `${money(tx.amount)} from ${from} to ${account}`);
  if (fraud) s.totals.stolen += tx.amount;
  else if (tx.origin === 'NPC') s.totals.processedNpc += tx.amount;
  return { account, fraud };
}

export function reverseTransaction(s: GameState, tx: Transaction, who: TxActor): void {
  if (tx.fraud) s.totals.stolen -= tx.amount;
  else if (tx.origin === 'NPC') s.totals.processedNpc -= tx.amount;
  tx.status = 'REVERSED';
  recordTx(s, tx, 'REVERSED', who, `${money(tx.amount)} returned from ${tx.settledTo} to ${tx.debitedFrom}`);
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

export function spawnNpc(s: GameState): void {
  const c = pick(s, s.customers);
  const payee = pick(s, s.customers.filter((x) => x.id !== c.id));
  const from = pick(s, c.accounts);
  const raw = s.config.npcMinAmount + rand(s) * (s.config.npcMaxAmount - s.config.npcMinAmount);
  const amount = Math.round(raw / 1000) * 1000;
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

/** DEBUG helper: settles NPC payments that come back LOW risk, like a diligent (but not paranoid) team. */
export function autoProcess(s: GameState): void {
  const t = gameTime(s);
  for (const tx of s.transactions) {
    if (tx.origin !== 'NPC' || tx.status !== 'QUEUED') continue;
    if (t - tx.createdAt < s.config.autoProcessDelaySec) continue;
    const r = computeRisk(s, tx);
    tx.riskResult = r.result;
    tx.riskFlags = r.flags;
    tx.status = 'RISK_CHECKED';
    recordTx(s, tx, 'RISK_CHECKED', SYSTEM_ACTOR, riskDetail(tx));
    if (r.result !== 'LOW') continue; // leave for humans
    tx.status = 'AUTHORIZED';
    recordTx(s, tx, 'APPROVED', SYSTEM_ACTOR);
    settleTransaction(s, tx, SYSTEM_ACTOR);
    addLog(s, {
      actor: 'SYSTEM',
      kind: 'AUTO_SETTLE',
      message: `Auto-processor settled ${tx.id}`,
      sourceIp: null,
      actualPlayerId: null,
    });
  }
}
