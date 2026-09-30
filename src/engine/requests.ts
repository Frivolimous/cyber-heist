// Client Requests: customers write to their personal banker asking for payments or changes to their
// own accounts. Requests are written in words (names, not codes), so acting on one means looking things up.

import { activeCustomers, affordableAmount, MAX_BALANCE_SHARE, MIN_PAYMENT, payingAccount, paymentFor, wealthWeight } from './bank';
import { addLog, balanceOf, gameTime, knownOf, money, nextId, unusedAccountNumber } from './core';
import { notify } from './notify';
import { pick, rand, randInt, weightedPick } from './rng';
import { nextArrival } from './pacing';
import type { ClientRequest, Customer, GameState, Player, RequestKind } from './types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Words = { banker: string; cust: string; payee: string; amt: string; from: string; acct: string; month: string; ref: number };

// Payment requests name who to pay (by name) and which account to pay from (see paymentSource).
const PAYMENT_TEXTS: ((w: Words) => string)[] = [
  (w) => `Hi ${w.banker}, please send ${w.amt} ${w.from} to ${w.payee} for the ${w.month} invoice. Thanks, ${w.cust}`,
  (w) => `Good morning ${w.banker}. Kindly transfer ${w.amt} to ${w.payee} ${w.from}. Regards, ${w.cust}`,
  (w) => `Please pay ${w.payee} ${w.amt} ${w.from} (order #${w.ref}). ${w.cust}`,
  (w) => `Hello ${w.banker}, could you arrange a payment of ${w.amt} to ${w.payee} ${w.from}? Many thanks, ${w.cust}`,
  (w) => `${w.banker}, our ${w.month} bill from ${w.payee} is due. Please pay them ${w.amt} ${w.from}. - ${w.cust}`,
  (w) => `Payment instruction: ${w.amt} to ${w.payee}, ${w.from}. Reference: invoice ${w.ref}. ${w.cust}`,
  (w) => `Dear ${w.banker}, we owe ${w.payee} ${w.amt} for work done in ${w.month}. Please settle it ${w.from}. Best, ${w.cust}`,
  (w) => `Hi ${w.banker}, quick one: ${w.amt} to ${w.payee} ${w.from}, please. Cheers, ${w.cust}`,
  (w) => `Could you please release ${w.amt} to ${w.payee}? Take it ${w.from}. It covers purchase order ${w.ref}. ${w.cust}`,
  (w) => `${w.banker}, as agreed with ${w.payee}, please transfer ${w.amt} ${w.from} this week. Thank you, ${w.cust}`,
];

// Urgent payment requests (shorter deadline) say so.
const URGENT_TEXTS: ((w: Words) => string)[] = [
  (w) => `${w.banker}, we need ${w.amt} paid to ${w.payee} today, ${w.from}. It's urgent. - ${w.cust}`,
  (w) => `URGENT: please send ${w.amt} to ${w.payee} ${w.from} as soon as possible. ${w.cust}`,
  (w) => `${w.banker}, time-critical: ${w.payee} must receive ${w.amt} ${w.from} within the hour. - ${w.cust}`,
  (w) => `Please treat this as urgent: ${w.amt} to ${w.payee} ${w.from}. They're holding our delivery until it arrives. ${w.cust}`,
  (w) => `${w.banker}, emergency payment needed: ${w.amt} to ${w.payee}, ${w.from}. Please do it right away. ${w.cust}`,
  (w) => `We're about to miss a deadline with ${w.payee}! Send them ${w.amt} ${w.from} immediately, please. - ${w.cust}`,
  (w) => `High priority, ${w.banker}: ${w.amt} to ${w.payee} ${w.from}, before noon if at all possible. ${w.cust}`,
];

const ACCOUNT_TEXTS: Record<Exclude<RequestKind, 'PAYMENT'>, ((w: Words) => string)[]> = {
  ADD_ACCOUNT: [
    (w) => `Hi ${w.banker}, we've opened another account, ${w.acct}. Please add it to our records. - ${w.cust}`,
    (w) => `Please add account ${w.acct} to our file. It is ours and we'll use it for some payments. ${w.cust}`,
    (w) => `${w.banker}, could you register our account ${w.acct} with you? We'd like to pay from it too. Thanks, ${w.cust}`,
    (w) => `Hello, we have a new account (${w.acct}) for our ${w.month} expenses. Please link it to our profile. ${w.cust}`,
    (w) => `Dear ${w.banker}, please add ${w.acct} to our accounts on file. Nothing else changes. Regards, ${w.cust}`,
    (w) => `Quick admin request: account ${w.acct} belongs to us, please add it to our records. - ${w.cust}`,
  ],
  ADD_AND_PRIMARY: [
    (w) => `${w.banker}, please add our new account ${w.acct} and make it our main account for incoming payments. ${w.cust}`,
    (w) => `We've moved banks. Please add account ${w.acct} and pay everything to it from now on. - ${w.cust}`,
    (w) => `Hi ${w.banker}, our finance team has set up account ${w.acct}. Please add it and send all our incoming money there. ${w.cust}`,
    (w) => `Please note our new banking details: account ${w.acct}. Add it and make it our primary, effective today. ${w.cust}`,
    (w) => `Dear ${w.banker}, we are consolidating into a new account, ${w.acct}. Please add it as our main account. Regards, ${w.cust}`,
    (w) => `${w.banker}, from today, payments to us should go to our new account ${w.acct}. Please set that up. Thanks, ${w.cust}`,
  ],
  SET_PRIMARY: [
    (w) => `Please make account ${w.acct} our primary account from now on. Thanks, ${w.cust}`,
    (w) => `Hi ${w.banker}, payments to us should go to account ${w.acct} starting today. - ${w.cust}`,
    (w) => `${w.banker}, we'd like incoming payments paid into ${w.acct} instead of our current main account. ${w.cust}`,
    (w) => `Could you switch our main account to ${w.acct}? It's already on our file. Many thanks, ${w.cust}`,
    (w) => `Dear ${w.banker}, please use account ${w.acct} as our primary account from ${w.month} onwards. ${w.cust}`,
    (w) => `Change of details: our main account is now ${w.acct}. Please update your records. - ${w.cust}`,
  ],
  REMOVE_ACCOUNT: [
    (w) => `Hi ${w.banker}, we've closed account ${w.acct}. Please remove it from our file. - ${w.cust}`,
    (w) => `Account ${w.acct} is no longer ours. Please take it off our records. ${w.cust}`,
    (w) => `${w.banker}, we don't use account ${w.acct} any more. Please remove it. Thanks, ${w.cust}`,
    (w) => `Please delete ${w.acct} from our accounts on file; it was closed at the end of ${w.month}. ${w.cust}`,
    (w) => `Dear ${w.banker}, kindly remove account ${w.acct} from our profile. Regards, ${w.cust}`,
    (w) => `Housekeeping request: account ${w.acct} should no longer be linked to us. Please remove it. - ${w.cust}`,
  ],
};

/**
 * An account request in the customer's words, from the same forms real requests use. Social / Scam request
 * writes its fake request with this, so it reads like any other.
 */
export function accountRequestText(s: GameState, cust: Customer, kind: Exclude<RequestKind, 'PAYMENT'>, account: string): string {
  const words: Words = {
    banker: cust.bankerId ? s.players[cust.bankerId].name : 'team',
    cust: cust.name,
    payee: '',
    amt: '',
    from: '',
    acct: account.slice(4),
    month: pick(s, MONTHS),
    ref: randInt(s, 1000, 9999),
  };
  return pick(s, ACCOUNT_TEXTS[kind])(words);
}

/** A payment request in the customer's words (paid from their main account), from the same forms real requests use. */
export function paymentRequestText(s: GameState, cust: Customer, payee: Customer, amount: number, urgent: boolean): string {
  const words: Words = {
    banker: cust.bankerId ? s.players[cust.bankerId].name : 'team',
    cust: cust.name,
    payee: payee.name,
    amt: money(amount),
    from: 'from our main account',
    acct: '',
    month: pick(s, MONTHS),
    ref: randInt(s, 1000, 9999),
  };
  return pick(s, urgent ? URGENT_TEXTS : PAYMENT_TEXTS)(words);
}

/** Hands each customer to a personal banker (round-robin); with no personal bankers, to anyone. */
export function assignBankers(s: GameState): void {
  const players = s.playerOrder.map((id) => s.players[id]);
  const bankers = players.filter((p) => p.role === 'PERSONAL_BANKER');
  const pool = bankers.length ? bankers : players;
  s.customers.forEach((c, i) => (c.bankerId = pool.length ? pool[i % pool.length].id : null));
}

/** The customer's new account (opened elsewhere): it exists from now on, floating, with some money in it. */
function newCustomerAccount(s: GameState): string {
  const a = unusedAccountNumber(s);
  s.balances[a] = randInt(s, 50, 1000) * 1000; // $50k-$1M
  return a;
}

/** Deadline fields for a new request: due in requestDeadlineSec (urgentDeadlineSec if urgent), chased halfway. */
export function requestTimes(s: GameState, t: number, urgent: boolean): Pick<ClientRequest, 'urgent' | 'dueAt' | 'remindAt' | 'reminders' | 'outcome'> {
  const window = urgent ? s.config.urgentDeadlineSec : s.config.requestDeadlineSec;
  return { urgent, dueAt: t + window, remindAt: t + window / 2, reminders: [], outcome: null };
}

/**
 * What a customer asks to pay from `account`: an affordable amount in the request range, scaled up by
 * requestAmountFactor (requests are the bank's big payments), but never more than the account holds or a
 * banker may pay by hand. Null when the account cannot afford a payment at all.
 */
function requestAmount(s: GameState, account: string): number | null {
  const base = affordableAmount(s, account, s.config.requestMinAmount, s.config.requestMaxAmount);
  if (base === null) return null;
  const scaled = Math.round((base * s.config.requestAmountFactor) / 1000) * 1000;
  return Math.min(scaled, Math.floor(balanceOf(s, account) / 1000) * 1000, s.config.maxManualAmount);
}

/**
 * Where a payment request says to pay from, picked at random from three forms:
 * - MAIN: "from our main account" (the primary);
 * - NUMBER: "from our account 12345" (any of their accounts, the richer the likelier);
 * - OTHER: "from our other account" / "from whichever of our other accounts has the funds" (a non-primary
 *   account; the banker has to look up which one can pay). Only when a non-primary account can afford it.
 * A form the customer cannot pay from falls back to NUMBER. Null when no account can pay at all.
 */
function paymentSource(s: GameState, cust: Customer): { origin: string; amount: number; from: string } | null {
  const known = knownOf(cust); // the customer goes by the accounts they believe they have
  const others = known.accounts.filter((a) => a !== known.primary);
  const form = pick(s, ['MAIN', 'NUMBER', 'OTHER'] as const);
  if (form === 'MAIN') {
    const amount = requestAmount(s, known.primary);
    if (amount !== null) return { origin: known.primary, amount, from: 'from our main account' };
  }
  if (form === 'OTHER') {
    const able = others.filter((a) => balanceOf(s, a) * MAX_BALANCE_SHARE >= MIN_PAYMENT);
    if (able.length) {
      const origin = weightedPick(s, able, (a) => balanceOf(s, a) + 1);
      const amount = requestAmount(s, origin);
      const from = others.length === 1 ? 'from our other account (not the main one)' : 'from whichever of our other accounts has the funds (not the main one)';
      if (amount !== null) return { origin, amount, from };
    }
  }
  const origin = payingAccount(s, cust);
  const amount = requestAmount(s, origin);
  return amount === null ? null : { origin, amount, from: `from our account ${origin.slice(4)}` };
}

/** Each gap between client requests is the average gap times 1 ± this (at random), so arrivals are uneven. */
export const REQUEST_JITTER = 0.5;
/** The first request after the start (two are waiting already) comes after this share of a normal gap. */
export const FIRST_REQUEST_SHARE = 0.5;

/**
 * Schedules the next client request after one at `after`: a jittered gap around requestIntervalSec, then bent
 * by the time of day (nextArrival). The jitter averages out, so the game-wide total stays about the same.
 */
export function scheduleRequest(s: GameState, after: number, first = false): void {
  const gap = s.config.requestIntervalSec * (1 + (rand(s) * 2 - 1) * REQUEST_JITTER) * (first ? FIRST_REQUEST_SHARE : 1);
  s.nextRequestAt = nextArrival(s.config.durationSec, after, gap);
}

/** Spawns a request from a customer still doing business with the bank (null if there is none). */
export function spawnRequest(s: GameState): ClientRequest | null {
  const active = activeCustomers(s);
  if (active.length < 2) return null;
  const cust = pick(s, active);
  const known = knownOf(cust);
  const others = known.accounts.filter((a) => a !== known.primary); // accounts they could make primary or remove
  let kind: RequestKind = 'PAYMENT';
  if (rand(s) < s.config.requestChangeShare) {
    kind = pick(s, others.length ? (['ADD_ACCOUNT', 'ADD_AND_PRIMARY', 'SET_PRIMARY', 'REMOVE_ACCOUNT'] as const) : (['ADD_ACCOUNT', 'ADD_AND_PRIMARY'] as const));
  }
  // A customer asks to pay what the account can afford; one too poor to pay anything asks to add an account instead.
  let originAccount: string | null = null;
  let amount: number | null = null;
  let from = '';
  if (kind === 'PAYMENT') {
    const src = paymentSource(s, cust);
    if (src) ({ origin: originAccount, amount, from } = src);
    else kind = 'ADD_ACCOUNT';
  }
  const payee = kind === 'PAYMENT' ? weightedPick(s, active.filter((c) => c.id !== cust.id), (c) => wealthWeight(s, c)) : null;
  const urgent = kind === 'PAYMENT' && rand(s) < s.config.urgentShare;
  const account = kind === 'ADD_ACCOUNT' || kind === 'ADD_AND_PRIMARY' ? newCustomerAccount(s) : kind === 'PAYMENT' ? null : pick(s, others);
  const words: Words = {
    banker: cust.bankerId ? s.players[cust.bankerId].name : 'team',
    cust: cust.name,
    payee: payee?.name ?? '',
    amt: amount === null ? '' : money(amount),
    from,
    acct: account ? account.slice(4) : '',
    month: pick(s, MONTHS),
    ref: randInt(s, 1000, 9999),
  };
  const t = gameTime(s);
  const req: ClientRequest = {
    id: nextId(s, 'req', 'REQ-'),
    t,
    customerId: cust.id,
    bankerId: cust.bankerId,
    kind,
    text: pick(s, kind === 'PAYMENT' ? (urgent ? URGENT_TEXTS : PAYMENT_TEXTS) : ACCOUNT_TEXTS[kind])(words),
    payeeId: payee?.id ?? null,
    amount,
    originAccount,
    account,
    ...requestTimes(s, t, urgent),
    status: 'OPEN',
    closedAt: null,
    closedBy: null,
    closedByActual: null,
    txId: null,
    archiveReason: null,
  };
  s.requests.push(req);
  learnRequest(cust, req);
  requestReceived(s, req);
  return req;
}

/**
 * The customer now believes the change they asked for is in place, whether or not the bank ever makes it.
 * (Scam and phishing requests never come here: no real customer asked.)
 */
function learnRequest(cust: Customer, r: ClientRequest): void {
  if (r.kind === 'PAYMENT' || !r.account) return;
  const known = (cust.known = { ...knownOf(cust), accounts: [...knownOf(cust).accounts] });
  if ((r.kind === 'ADD_ACCOUNT' || r.kind === 'ADD_AND_PRIMARY') && !known.accounts.includes(r.account)) known.accounts.push(r.account);
  if (r.kind === 'ADD_AND_PRIMARY' || r.kind === 'SET_PRIMARY') known.primary = r.account;
  if (r.kind === 'REMOVE_ACCOUNT') known.accounts = known.accounts.filter((a) => a !== r.account);
}

/** Logs a new request and notifies its banker. Real, scam and phishing requests all arrive the same way. */
export function requestReceived(s: GameState, req: ClientRequest): void {
  addLog(s, { actor: 'SYSTEM', kind: 'CLIENT_REQUEST', message: `Client request ${req.id} received`, sourceIp: null, actualPlayerId: null });
  notify(s, 'CLIENT_DATA', 'CLIENT_REQUESTS', `New request ${req.id} from ${requestSender(s, req)}`, { bankerId: req.bankerId });
}

const requestSender = (s: GameState, req: ClientRequest): string => req.sender ?? s.customers.find((x) => x.id === req.customerId)?.name ?? req.customerId;

// ---- Deadlines, reminders and complaints ----------------------------------------------------------
// Every request has a deadline. Halfway there, if what was asked has not happened, the customer chases it
// (on the request itself and in the banker's personal messages). At the deadline an unmet request expires
// and the customer complains to the Bank Manager; after strikesToSuspend expiries the customer stops doing
// business with the bank for the day. Scam requests have no real customer behind them: they expire quietly.

/** First names customers' staff write under (companies only; private people sign their own name). */
const CONTACT_NAMES = [
  'Cody', 'Maria', 'Dev', 'Helen', 'Tom', 'Aisha', 'Greg', 'Lena', 'Sam', 'Nora', 'Victor', 'Jess',
  'Ravi', 'Paula', 'Ben', 'Ingrid', 'Marco', 'Tasha', 'Owen', 'Fiona', 'Kenji', 'Rita', 'Luis', 'Beth',
];

/** Gives every company customer a made-up contact; a private person writes as themselves. */
export function assignContacts(s: GameState, persons: ReadonlySet<string>): void {
  for (const c of s.customers) {
    c.person = persons.has(c.name);
    c.contact = c.person ? c.name : pick(s, CONTACT_NAMES);
  }
}

/** How a customer shows up as a message sender: "Cody (Cobalt Payroll)" or "Marisol Ortega". */
export const senderName = (c: Customer): string => (c.person ? c.name : `${c.contact} (${c.name})`);

type Voice = { intro: string; who: string; sign: string; banker: string; what: string };

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function voiceOf(s: GameState, c: Customer, r: ClientRequest): Voice {
  const acct = r.account ? r.account.slice(4) : '';
  const payee = s.customers.find((x) => x.id === r.payeeId)?.name ?? 'our supplier';
  const what: Record<RequestKind, string> = {
    PAYMENT: `the ${r.amount === null ? '' : money(r.amount) + ' '}payment to ${payee}`,
    ADD_ACCOUNT: `adding our account ${acct}`,
    ADD_AND_PRIMARY: `making our new account ${acct} our main account`,
    SET_PRIMARY: `switching our main account to ${acct}`,
    REMOVE_ACCOUNT: `taking account ${acct} off our file`,
  };
  return {
    intro: c.person ? `This is ${c.name}.` : `This is ${c.contact} from ${c.name}.`,
    who: c.person ? c.name : `${c.contact} from ${c.name}`,
    sign: c.person ? c.name : `${c.contact}, ${c.name}`,
    banker: r.bankerId ? s.players[r.bankerId].name : 'your team',
    what: what[r.kind],
  };
}

// Form messages: the customer's voice varies, the facts (what was asked, who was asked) do not.
const REMINDER_TEXTS: ((v: Voice) => string)[] = [
  (v) => `Hi ${v.banker}, ${v.who} here. Just following up on ${v.what}: has it gone through yet?`,
  (v) => `Regarding ${v.what}: we haven't seen anything happen yet. Could you check? - ${v.sign}`,
  (v) => `${v.intro} Still waiting on ${v.what}. Can you give me an update?`,
  (v) => `${v.banker}, ${v.who} again. Any news on ${v.what}?`,
  (v) => `${v.intro} I sent a request earlier about ${v.what}. Is anyone looking at it?`,
  (v) => `Just checking in on ${v.what}, ${v.banker}. We'd like to close this off today. - ${v.sign}`,
  (v) => `Hello ${v.banker}, gentle reminder about ${v.what}. Please confirm when it's done. ${v.sign}`,
  (v) => `${v.intro} Our accounts team is asking about ${v.what}. Where are we with it?`,
  (v) => `Regarding ${v.what}: could you let me know the status? Thanks, ${v.sign}`,
];
const URGENT_REMINDER_TEXTS: ((v: Voice) => string)[] = [
  (v) => `${v.intro} ${cap(v.what)} was urgent and it still isn't done. Please sort it out now.`,
  (v) => `Regarding ${v.what}: this is urgent and we're running out of time! - ${v.sign}`,
  (v) => `${v.banker}, ${v.who} here. We flagged ${v.what} as urgent. Why hasn't it happened yet?`,
  (v) => `${v.intro} I need ${v.what} done in the next few minutes or we're in real trouble.`,
  (v) => `URGENT follow-up on ${v.what}. Please call me back or just get it done. - ${v.sign}`,
  (v) => `${v.banker}, please, ${v.what} cannot wait any longer. ${v.sign}`,
];
const COMPLAINT_TEXTS: ((v: Voice) => string)[] = [
  (v) => `${v.intro} I asked ${v.banker} to handle ${v.what} and nothing happened. This is not acceptable.`,
  (v) => `Regarding ${v.what}: we chased ${v.banker} and heard nothing back. I'd like to make a formal complaint. - ${v.sign}`,
  (v) => `To the manager: ${v.who} here. ${v.banker} let ${v.what} slip past our deadline. Please look into it.`,
  (v) => `${v.intro} I'm writing to complain. ${cap(v.what)} was left with ${v.banker} and simply never done.`,
  (v) => `Dear manager, ${v.banker} ignored our request about ${v.what}, even after a reminder. We expect better. ${v.sign}`,
  (v) => `${v.intro} ${v.banker} has cost us money today: ${v.what} never happened. What is going on over there?`,
  (v) => `Complaint regarding ${v.what}: our banker, ${v.banker}, did not act in time. Please make sure it doesn't happen again. - ${v.sign}`,
  (v) => `I'd like to speak to someone about ${v.banker}. ${cap(v.what)} was missed despite our follow-up. ${v.sign}`,
];
const WALKOUT_TEXTS: ((v: Voice) => string)[] = [
  (v) => `${v.intro} ${cap(v.what)} was missed, and that's twice now. We're taking our business elsewhere for the rest of today.`,
  (v) => `Regarding ${v.what}: this is the second time a request of ours was ignored. We are stopping all business with your bank today. - ${v.sign}`,
  (v) => `${v.intro} Enough. After ${v.what} went nowhere as well, we're suspending everything with you for today.`,
  (v) => `Two missed requests in one day, the latest being ${v.what}. We won't be sending you anything else today. ${v.sign}`,
  (v) => `Dear manager, ${v.banker} has now let us down twice. We're moving our business elsewhere for the day. - ${v.sign}`,
  (v) => `${v.intro} We can't rely on you today. Consider all our business on hold until tomorrow.`,
];

/** A personal message from a customer: it lands only in the recipient's inbox. */
function customerMessage(s: GameState, c: Customer, to: Player, text: string): void {
  to.messages.push({ id: nextId(s, 'msg', 'M'), t: gameTime(s), from: senderName(c), to: to.id, text });
}

const bankManagers = (s: GameState): Player[] => s.playerOrder.map((id) => s.players[id]).filter((p) => p.role === 'BANK_MANAGER' && !p.fake);

/**
 * Has what the request asks for happened? Account requests look at the customer's accounts as they are now;
 * a payment request needs a live payment for it (paymentFor also links an unlinked payment made exactly as
 * asked, so paying as requested counts even when the request was archived instead of linked).
 */
export function requestMet(s: GameState, r: ClientRequest): boolean {
  const c = s.customers.find((x) => x.id === r.customerId)!;
  switch (r.kind) {
    case 'PAYMENT':
      return paymentFor(s, r) !== null;
    case 'ADD_ACCOUNT':
      return c.accounts.includes(r.account!);
    case 'ADD_AND_PRIMARY':
    case 'SET_PRIMARY':
      return c.primary === r.account;
    case 'REMOVE_ACCOUNT':
      return !c.accounts.includes(r.account!);
  }
}

/** Called from the engine's time loop: sends reminders halfway and decides each request at its deadline. */
export function advanceRequests(s: GameState): void {
  const t = gameTime(s);
  while (s.phishSchedule.length && s.phishSchedule[0].at <= t) spawnPhish(s, s.phishSchedule.shift()!.bankerId);
  for (const r of s.requests) {
    if (r.outcome !== null) continue;
    if (r.phish) continue; // no deadline: it sits in the queue until someone archives it
    const c = s.customers.find((x) => x.id === r.customerId)!;
    if (t >= r.dueAt) expire(s, r, c);
    else if (t >= r.remindAt && !r.reminders.length && !r.scam && !c.suspended && !requestMet(s, r)) remind(s, r, c);
  }
}

/** The customer chases the request. An archived request comes back: the customer is still waiting for it. */
function remind(s: GameState, r: ClientRequest, c: Customer): void {
  const text = pick(s, r.urgent ? URGENT_REMINDER_TEXTS : REMINDER_TEXTS)(voiceOf(s, c, r));
  r.reminders.push({ t: gameTime(s), text });
  if (r.status !== 'OPEN') {
    r.status = 'OPEN'; // archived, or done by a payment that has since been rejected or failed
    r.closedAt = null;
  }
  if (r.bankerId) customerMessage(s, c, s.players[r.bankerId], text);
  addLog(s, { actor: 'SYSTEM', kind: 'CLIENT_REMINDER', message: `Client follow-up received on ${r.id}`, sourceIp: null, actualPlayerId: null });
  notify(s, 'CLIENT_DATA', 'CLIENT_REQUESTS', `Follow-up on ${r.id} from ${requestSender(s, r)}`, { bankerId: r.bankerId });
}

/** At the deadline: done if what was asked happened, otherwise expired, a strike, and a complaint (or a walkout). */
/**
 * A request past its deadline with nothing done: it can no longer be acted on. An archived one stays archived
 * (for real and scam requests alike, so the status never gives away which were real); the rest expire.
 */
function closeUnanswered(s: GameState, r: ClientRequest): void {
  r.outcome = 'MISSED';
  if (r.status === 'ARCHIVED') return;
  r.status = 'EXPIRED';
  r.closedAt = gameTime(s);
}

function expire(s: GameState, r: ClientRequest, c: Customer): void {
  if (requestMet(s, r)) {
    r.outcome = 'MET';
    if (r.status !== 'DONE') {
      r.status = 'DONE';
      r.closedAt = gameTime(s);
    }
    return;
  }
  closeUnanswered(s, r);
  if (r.scam || c.suspended) return; // nobody real is waiting, or they already left
  c.strikes += 1;
  const walkout = c.strikes >= s.config.strikesToSuspend;
  const text = pick(s, walkout ? WALKOUT_TEXTS : COMPLAINT_TEXTS)(voiceOf(s, c, r));
  const managers = bankManagers(s);
  for (const m of managers) customerMessage(s, c, m, text);
  addLog(s, { actor: 'SYSTEM', kind: 'CLIENT_COMPLAINT', message: `Customer complaint: ${r.id} expired`, sourceIp: null, actualPlayerId: null });
  if (!walkout) return;
  c.suspended = true;
  if (r.bankerId && !managers.some((m) => m.id === r.bankerId)) customerMessage(s, c, s.players[r.bankerId], text);
  addLog(s, { actor: 'SYSTEM', kind: 'CUSTOMER_SUSPENDED', message: `${c.id} suspended business with the bank for today`, sourceIp: null, actualPlayerId: null });
}

// ---- Phishing --------------------------------------------------------------------------------------
// Obvious scam messages that land in the Client Requests like any other: a customer tag that does not exist,
// a destination account that does not exist, and no account of their own to pay from. They are noise to
// recognise and archive. They have no deadline: nobody chases them, and they stay open until archived.

type Bait = { banker: string; cu: string; acct: string; amt: string; fee: string };

const PHISH: { sender: string; text: (b: Bait) => string }[] = [
  { sender: 'Prince Adebayo Okonkwo', text: (b) => `Dearest ${b.banker}, I am Prince Adebayo Okonkwo, your customer ${b.cu}. My late father the King left ${b.amt} in a frozen account. Kindly send a release fee of ${b.fee} to account ${b.acct} and 30% shall be yours. God bless you.` },
  { sender: 'Chad Worthington III', text: (b) => `yo ${b.banker} its Chad, ${b.cu}. dad froze my cards lol. just wire ${b.fee} to my buddy's account ${b.acct}, he'll pay u back. DONT tell dad` },
  { sender: 'Svetlana', text: (b) => `Hello ${b.banker}, I am Svetlana, very beautiful and very lonely, customer ${b.cu}. I need only ${b.fee} for plane ticket to come meet you. Please send to account ${b.acct}. Many kisses` },
  { sender: 'International Email Lottery Board', text: (b) => `CONGRATULATIONS!!! Customer ${b.cu} has WON ${b.amt} in the International Email Lottery. To claim your prize, transfer the processing fee of ${b.fee} to account ${b.acct} TODAY.` },
  { sender: 'Barrister Samuel Adeyemi, Esq.', text: (b) => `Dear ${b.banker}, I represent the estate of a distant relative of customer ${b.cu}, who passed away leaving ${b.amt} unclaimed. Send ${b.fee} for the legal paperwork to account ${b.acct} and we split it 50/50. Strictly confidential.` },
  { sender: 'CryptoKing', text: (b) => `Hi ${b.banker}!!! Send ${b.fee} to account ${b.acct} and I will send back DOUBLE within the hour. Exclusive offer for customer ${b.cu} only. Don't miss out!!!` },
  { sender: 'Revenue Service Refund Department', text: (b) => `FINAL NOTICE: Customer ${b.cu} is owed a tax refund of ${b.amt}. To release it, pay the ${b.fee} verification charge to account ${b.acct}. Failure to act within 24 hours will cancel the refund.` },
  { sender: 'Your friend Dave', text: (b) => `${b.banker} it's me, Dave (${b.cu})! Stuck in Manila, wallet stolen, phone about to die. Please send ${b.fee} to account ${b.acct} ASAP, I'll explain everything later!!` },
  { sender: 'Sgt. Maj. Harold Stone', text: (b) => `Greetings ${b.banker}. I am a soldier on peacekeeping duty guarding ${b.amt} in gold bars. As customer ${b.cu} I need a trusted banker. Send ${b.fee} for shipping to account ${b.acct} and the gold is yours to share.` },
  { sender: 'Bank Security Team', text: (b) => `SECURITY ALERT ${b.banker}: customer ${b.cu} has been HACKED! Move all their funds (${b.amt}) to our safe holding account ${b.acct} immediately to protect them. Do not verify, there is no time.` },
  { sender: 'Sheikh Rashid Al-Fayed', text: (b) => `My dear friend ${b.banker}, I wish to invest ${b.amt} in your fine bank as customer ${b.cu}. As is customary, a small good-faith deposit of ${b.fee} to account ${b.acct} is required first.` },
  { sender: 'Cousin Vinny', text: (b) => `hey ${b.banker}!! its ur cousin Vinny, remember me? im customer ${b.cu} now. can u spot me ${b.fee}? account ${b.acct}. ill pay u back friday i promise` },
  { sender: 'Dr. Barnabus Goldfield', text: (b) => `Dear Sir/Madam ${b.banker}, I am a scientist who has invented a machine that prints ${b.amt}. Customer ${b.cu}. I need only ${b.fee} for spare parts, sent to account ${b.acct}. You will be rewarded handsomely.` },
  { sender: 'Lady Arabella Pemberton-Smythe', text: (b) => `Darling ${b.banker}, it is Lady Arabella (customer ${b.cu}). My yacht is stuck in Monaco harbour over a silly ${b.fee} mooring fee. Be a dear and send it to account ${b.acct}? Kisses to the staff.` },
  { sender: 'Customer Care', text: (b) => `Dear valued banker ${b.banker}, due to a system upgrade customer ${b.cu} must re-confirm their balance of ${b.amt} by sending ${b.fee} to account ${b.acct}. Thank you for your cooperation. Customer Care` },
];

/** Deals each Personal Banker phishPerBankerMin-Max phishing messages at random times over the working day. */
export function schedulePhishing(s: GameState): void {
  const bankers = s.playerOrder.filter((id) => s.players[id].role === 'PERSONAL_BANKER');
  const latest = s.config.durationSec * 0.85; // nothing new at close of business
  for (const bankerId of bankers) {
    const n = randInt(s, s.config.phishPerBankerMin, s.config.phishPerBankerMax);
    for (let i = 0; i < n; i++) s.phishSchedule.push({ at: randInt(s, 20, latest), bankerId });
  }
  s.phishSchedule.sort((a, b) => a.at - b.at);
}

/** A tag no customer has, e.g. CU57 at a table with 12 customers. */
const fakeCustomerTag = (s: GameState): string => `CU${s.customers.length + randInt(s, 5, 80)}`;

function spawnPhish(s: GameState, bankerId: string): void {
  const form = pick(s, PHISH); // duplicates across bankers (or for one banker) are fine
  const t = gameTime(s);
  const fee = randInt(s, 2, 95) * 1000;
  const bait: Bait = {
    banker: s.players[bankerId].name,
    cu: fakeCustomerTag(s),
    acct: unusedAccountNumber(s).slice(4), // an account that does not exist
    amt: money(randInt(s, 2, 60) * 1_000_000),
    fee: money(fee),
  };
  s.requests.push({
    id: nextId(s, 'req', 'REQ-'),
    t,
    customerId: bait.cu,
    bankerId,
    kind: 'PAYMENT',
    text: form.text(bait),
    payeeId: null,
    amount: fee,
    originAccount: null,
    account: null,
    ...requestTimes(s, t, false),
    phish: true,
    sender: form.sender,
    status: 'OPEN',
    closedAt: null,
    closedBy: null,
    closedByActual: null,
    txId: null,
    archiveReason: null,
  });
  requestReceived(s, s.requests.at(-1)!);
}
