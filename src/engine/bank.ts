// The bank's payment pipeline: NPC traffic, risk scoring, settlement and reversal.

import { pick, rand } from './rng';
import { addLog, gameTime, money, nextId } from './core';
import type { GameState, RiskResult, Transaction } from './types';

export function computeRisk(s: GameState, tx: Transaction): { result: RiskResult; flags: string[] } {
  const flags: string[] = [];
  const b = s.beneficiaries[tx.beneficiaryId];
  const t = gameTime(s);
  if (b && !b.verified) flags.push('UNVERIFIED_BENEFICIARY');
  if (b && b.lastModifiedAt !== null && t - b.lastModifiedAt < s.config.recentModifySec) {
    flags.push('RECENTLY_MODIFIED_BENEFICIARY');
  }
  if (tx.amount > s.config.largeAmount) flags.push('LARGE_AMOUNT');
  if (tx.origin === 'PLAYER') flags.push('MANUAL_ENTRY');
  const result: RiskResult = flags.length === 0 ? 'LOW' : flags.length === 1 ? 'MEDIUM' : 'HIGH';
  return { result, flags };
}

/** Pays the transaction to whatever account the beneficiary has RIGHT NOW. */
export function settleTransaction(s: GameState, tx: Transaction): { account: string; fraud: boolean } {
  const b = s.beneficiaries[tx.beneficiaryId];
  const account = b.account;
  const fraud = s.targets.some((tg) => tg.account === account);
  tx.status = 'SETTLED';
  tx.settledAt = gameTime(s);
  tx.settledTo = account;
  tx.fraud = fraud;
  if (fraud) s.totals.stolen += tx.amount;
  else if (tx.origin === 'NPC') s.totals.processedNpc += tx.amount;
  return { account, fraud };
}

export function reverseTransaction(s: GameState, tx: Transaction): void {
  if (tx.fraud) s.totals.stolen -= tx.amount;
  else if (tx.origin === 'NPC') s.totals.processedNpc -= tx.amount;
  tx.status = 'REVERSED';
}

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
  const bens = Object.values(s.beneficiaries);
  const b = pick(s, bens);
  const c = pick(s, s.customers);
  const raw = s.config.npcMinAmount + rand(s) * (s.config.npcMaxAmount - s.config.npcMinAmount);
  const amount = Math.round(raw / 1000) * 1000;
  const tx: Transaction = {
    id: nextId(s, 'tx', 'TX-', 4),
    amount,
    customerId: c.id,
    beneficiaryId: b.id,
    origin: 'NPC',
    createdBy: null,
    status: 'QUEUED',
    createdAt: gameTime(s),
    riskResult: null,
    riskFlags: [],
    authorizedBy: null,
    settledAt: null,
    settledTo: null,
    fraud: false,
  };
  s.transactions.push(tx);
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
    if (r.result !== 'LOW') continue; // leave for humans
    tx.status = 'AUTHORIZED';
    settleTransaction(s, tx);
    addLog(s, {
      actor: 'SYSTEM',
      kind: 'AUTO_SETTLE',
      message: `Auto-processor settled ${tx.id}`,
      sourceIp: null,
      actualPlayerId: null,
    });
  }
}
