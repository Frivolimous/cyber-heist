// Client Requests: customers write to their personal banker asking for payments or changes to their
// own accounts. Requests are written in words (names, not codes), so acting on one means looking things up.

import { addLog, gameTime, money, nextId } from './core';
import { pick, rand, randInt } from './rng';
import type { ClientRequest, GameState, RequestKind } from './types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Words = { banker: string; cust: string; payee: string; amt: string; from: string; acct: string; month: string; ref: number };

// Payment requests name who to pay (by name) and which account to pay from ("our main account" or a number).
const PAYMENT_TEXTS: ((w: Words) => string)[] = [
  (w) => `Hi ${w.banker}, please send ${w.amt} ${w.from} to ${w.payee} for the ${w.month} invoice. Thanks, ${w.cust}`,
  (w) => `${w.banker}, we need ${w.amt} paid to ${w.payee} today, ${w.from}. It's urgent. - ${w.cust}`,
  (w) => `Good morning ${w.banker}. Kindly transfer ${w.amt} to ${w.payee} ${w.from}. Regards, ${w.cust}`,
  (w) => `Please pay ${w.payee} ${w.amt} ${w.from} (order #${w.ref}). ${w.cust}`,
  (w) => `Hello ${w.banker}, could you arrange a payment of ${w.amt} to ${w.payee} ${w.from}? Many thanks, ${w.cust}`,
];

const ACCOUNT_TEXTS: Record<Exclude<RequestKind, 'PAYMENT'>, ((w: Words) => string)[]> = {
  ADD_ACCOUNT: [
    (w) => `Hi ${w.banker}, we've opened another account, ${w.acct}. Please add it to our records. - ${w.cust}`,
    (w) => `Please add account ${w.acct} to our file. It is ours and we'll use it for some payments. ${w.cust}`,
  ],
  ADD_AND_PRIMARY: [
    (w) => `${w.banker}, please add our new account ${w.acct} and make it our main account for incoming payments. ${w.cust}`,
    (w) => `We've moved banks. Please add account ${w.acct} and pay everything to it from now on. - ${w.cust}`,
  ],
  SET_PRIMARY: [
    (w) => `Please make account ${w.acct} our primary account from now on. Thanks, ${w.cust}`,
    (w) => `Hi ${w.banker}, payments to us should go to account ${w.acct} starting today. - ${w.cust}`,
  ],
  REMOVE_ACCOUNT: [
    (w) => `Hi ${w.banker}, we've closed account ${w.acct}. Please remove it from our file. - ${w.cust}`,
    (w) => `Account ${w.acct} is no longer ours. Please take it off our records. ${w.cust}`,
  ],
};

/** Hands each customer to a personal banker (round-robin); with no personal bankers, to anyone. */
export function assignBankers(s: GameState): void {
  const players = s.playerOrder.map((id) => s.players[id]);
  const bankers = players.filter((p) => p.role === 'PERSONAL_BANKER');
  const pool = bankers.length ? bankers : players;
  s.customers.forEach((c, i) => (c.bankerId = pool.length ? pool[i % pool.length].id : null));
}

function newUnusedAccount(s: GameState): string {
  const used = new Set<string>([
    ...s.customers.flatMap((c) => c.accounts),
    ...s.targets.map((t) => t.account),
    ...Object.values(s.players).map((p) => p.bankAccount),
  ]);
  for (;;) {
    const a = `ACC-${randInt(s, 10000, 99999)}`;
    if (!used.has(a)) return a;
  }
}

export function spawnRequest(s: GameState): ClientRequest {
  const cust = pick(s, s.customers);
  const others = cust.accounts.filter((a) => a !== cust.primary); // accounts that can be made primary or removed
  let kind: RequestKind = 'PAYMENT';
  if (rand(s) < s.config.requestChangeShare) {
    kind = pick(s, others.length ? (['ADD_ACCOUNT', 'ADD_AND_PRIMARY', 'SET_PRIMARY', 'REMOVE_ACCOUNT'] as const) : (['ADD_ACCOUNT', 'ADD_AND_PRIMARY'] as const));
  }
  const payee = kind === 'PAYMENT' ? pick(s, s.customers.filter((c) => c.id !== cust.id)) : null;
  const amount = kind === 'PAYMENT' ? Math.round(randInt(s, s.config.npcMinAmount, s.config.maxManualAmount) / 1000) * 1000 : null;
  const originAccount = kind === 'PAYMENT' ? pick(s, cust.accounts) : null;
  const account = kind === 'ADD_ACCOUNT' || kind === 'ADD_AND_PRIMARY' ? newUnusedAccount(s) : kind === 'PAYMENT' ? null : pick(s, others);
  const words: Words = {
    banker: cust.bankerId ? s.players[cust.bankerId].name : 'team',
    cust: cust.name,
    payee: payee?.name ?? '',
    amt: amount === null ? '' : money(amount),
    from: originAccount === null ? '' : originAccount === cust.primary ? 'from our main account' : `from our account ${originAccount.slice(4)}`,
    acct: account ? account.slice(4) : '',
    month: pick(s, MONTHS),
    ref: randInt(s, 1000, 9999),
  };
  const req: ClientRequest = {
    id: nextId(s, 'req', 'REQ-'),
    t: gameTime(s),
    customerId: cust.id,
    bankerId: cust.bankerId,
    kind,
    text: pick(s, kind === 'PAYMENT' ? PAYMENT_TEXTS : ACCOUNT_TEXTS[kind])(words),
    payeeId: payee?.id ?? null,
    amount,
    originAccount,
    account,
    status: 'OPEN',
    closedAt: null,
    closedBy: null,
    closedByActual: null,
    txId: null,
    archiveReason: null,
  };
  s.requests.push(req);
  addLog(s, { actor: 'SYSTEM', kind: 'CLIENT_REQUEST', message: `Client request ${req.id} received`, sourceIp: null, actualPlayerId: null });
  return req;
}
