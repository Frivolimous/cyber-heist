// Tutorials: a checklist on a new employee's screen for their first steps in the job.
// - Personal Bankers follow their gentle first request (requests.ts) from arriving to its payment settling. Done
//   when it settles; failed when the request expires first, which is reported to the bank.
// - Accounts & Receivables do each part of their job once, in any order: score a payment, settle one, verify an
//   account change. Each part waits for real work the automation leaves to people, then needs the player
//   themselves to open the page, check, and act. Nothing ticks for automation or for a colleague's work.
// - IT Specialists learn the security tools: the Master Log (auto-update, tracing, tracing the hidden host's
//   "Unknown server activity") and the Firewall. Each step ticks only for its own action, in any order. Opening
//   a second Security Systems window is screen-only: the screen ticks it.
// - Bank Managers watch everything: every customer, every request and every payment (each "all" view once there
//   is something to see), the Master Log, and a trace.

import { HOST_KITS, MODES } from './catalog';
import { addAlert, addLog, gameTime, normLog } from './core';
import { thiefTargetMet } from './ending';
import type { ClientRequest, ExecuteAction, GameState, Player, Transaction } from './types';

// ---- The heist (Thieves only) ----
// A Thief's panel under their cover job's: their personal tasks (their own actions, any order), then the heist,
// shared by the crew and taken from the state of the bank, one step at a time.

/** A Thief's personal tasks: each ticks for their own action (opening the host is also ticked by the screen). */
export interface HeistTasks {
  openedHost: boolean;
  posted: boolean; // said something on Blacknet
  ledger: boolean; // viewed the Target Ledger
  kit: boolean; // used their tool kit's page
}
/** The heist's steps reached so far, for the whole crew; once reached they stay reached. */
export interface HeistProgress {
  onFile: boolean; // a mule account was on a customer's file
  primary: boolean; // a mule account was a customer's primary
  earning: boolean; // stolen money reached the Target Ledger
  goalMet: boolean; // the Target Ledger met the goal (the step stays ticked if it later drops)
}
export interface HeistView {
  tasks: HeistTasks;
  progress: HeistProgress;
  stolen: number; // the Target Ledger's stolen total now
  goal: number;
}

/** One A&R part: each step latches in order (waited, then checked, then done); opened is shown, never required. */
export interface TutorialPart {
  waited: boolean; // something was waiting for a person
  opened: boolean; // used the page (the screen also ticks it on opening the page)
  checked: boolean; // looked it up where the step says, after waiting
  done: boolean; // did it, after checking
}
export type ArPart = 'RISK' | 'SETTLE' | 'VERIFY';

export type TutorialState =
  | { kind: 'BANKER'; requestId: string | null; viewed: boolean; openedQueue: boolean; retry: boolean; result: 'DONE' | 'FAILED' | null }
  | { kind: 'AR'; parts: Record<ArPart, TutorialPart>; result: 'DONE' | null }
  | { kind: 'IT'; steps: ItSteps; result: 'DONE' | null }
  | { kind: 'MANAGER'; steps: ManagerSteps; result: 'DONE' | null };

/** The Bank Manager's steps the engine sees ("all" views by when, so the screen can tell they came after the step appeared). */
export interface ManagerSteps {
  customersAll: boolean; // viewed all customers
  requestsAllAt: number | null; // game seconds of the latest "all requests" view
  paymentsAllAt: number | null; // game seconds of the latest "all payments" view
  openedLog: boolean; // used the Master Log (the screen also ticks it on opening the page)
  traced: boolean;
}

/**
 * The IT Specialist's steps the engine sees. The screen shows them in stages (the hunt and the second window once
 * a trace is done, the Firewall once the second window is open), ticks the second window itself, and decides
 * when it is all done: the engine never sees windows.
 */
export interface ItSteps {
  openedLog: boolean; // used the Master Log (the screen also ticks it on opening the page)
  autoUpdate: boolean; // the Master Log refreshed itself (its auto-update box)
  traced: boolean; // traced any entry
  viewedEverything: boolean; // viewed "Everything" in the Master Log after the first trace (where the hunt is)
  tracedHidden: boolean; // traced an "Unknown server activity" entry
  firstTraceHidden: boolean; // the very first trace already was one: the hunt step is never shown
  firewallAt: number | null; // game seconds of the latest Firewall status view (it counts only after the second window)
}

/** What the checklist shows (PlayerView.tutorial). */
export type TutorialView =
  | {
      kind: 'BANKER';
      requestId: string | null; // null until the first request arrives
      viewed: boolean; // looked at Client Requests since it arrived
      openedQueue: boolean; // used the Payment Queue since it arrived (the screen also ticks it on opening the page)
      created: boolean; // a live payment answers the request
      retry: boolean; // an attempt failed (or paid something else) and no payment answers the request yet
      riskChecked: boolean;
      approval: 'MANUAL' | 'AUTO' | null; // who approved it: a person, or Authorization's automation
      settled: boolean;
      result: 'DONE' | 'FAILED' | null;
    }
  | { kind: 'AR'; parts: Record<ArPart, TutorialPart>; result: 'DONE' | null }
  | { kind: 'IT'; steps: ItSteps; result: 'DONE' | null }
  | {
      kind: 'MANAGER';
      steps: ManagerSteps;
      requestsFrom: number | null; // when "View all client requests" appears: the second request arrived
      paymentsFrom: number | null; // when "View all payments" appears: the third request arrived
      result: 'DONE' | null;
    };

/** Where each A&R part happens, what counts as checking it, and what counts as doing it. */
const AR_PARTS: Record<ArPart, { module: string; check: string[]; act: string }> = {
  RISK: { module: 'TRANSACTIONS.RISK_CHECK', check: ['CLIENT_DATA.VERIFICATION.INVESTIGATE_CHANGES', 'CLIENT_DATA.CUSTOMER_RECORDS.VIEW_CUSTOMERS'], act: 'TRANSACTIONS.RISK_CHECK.RUN_RISK_CHECK' },
  SETTLE: { module: 'TRANSACTIONS.SETTLEMENT', check: ['CLIENT_DATA.CUSTOMER_RECORDS.VIEW_CUSTOMERS', 'CLIENT_DATA.VERIFICATION.INVESTIGATE_CHANGES'], act: 'TRANSACTIONS.SETTLEMENT.SETTLE' },
  VERIFY: { module: 'CLIENT_DATA.VERIFICATION', check: ['CLIENT_DATA.VERIFICATION.INVESTIGATE_CHANGES'], act: 'CLIENT_DATA.VERIFICATION.VERIFY_CHANGE' },
};
const AR_ORDER: ArPart[] = ['RISK', 'SETTLE', 'VERIFY'];
const newPart = (): TutorialPart => ({ waited: false, opened: false, checked: false, done: false });

/** At setup: every Personal Banker and every Accounts & Receivables gets their checklist. */
export function startTutorials(s: GameState): void {
  if (!MODES[s.config.mode ?? 'NORMAL'].tutorials) return; // Expert: no checklists at all
  s.heistProgress = { onFile: false, primary: false, earning: false, goalMet: false };
  for (const id of s.playerOrder) {
    const p = s.players[id];
    if (p.bot) continue; // checklists are for people
    if (p.allegiance === 'BLACK') p.heistTasks = { openedHost: false, posted: false, ledger: false, kit: false };
    if (p.role === 'PERSONAL_BANKER') p.tutorial = { kind: 'BANKER', requestId: null, viewed: false, openedQueue: false, retry: false, result: null };
    if (p.role === 'ACCOUNTS_RECEIVABLES') p.tutorial = { kind: 'AR', parts: { RISK: newPart(), SETTLE: newPart(), VERIFY: newPart() }, result: null };
    if (p.role === 'BANK_MANAGER') {
      p.tutorial = { kind: 'MANAGER', steps: { customersAll: false, requestsAllAt: null, paymentsAllAt: null, openedLog: false, traced: false }, result: null };
    }
    if (p.role === 'IT_SPECIALIST') {
      p.tutorial = {
        kind: 'IT',
        steps: { openedLog: false, autoUpdate: false, traced: false, viewedEverything: false, tracedHidden: false, firstTraceHidden: false, firewallAt: null },
        result: null,
      };
    }
  }
}

const DEAD = ['REJECTED', 'FAILED', 'REVERSED'];

/**
 * The live payment answering the request, if any, without linking anything (unlike bank.ts paymentFor): the one
 * linked to it, or an unlinked manual payment made exactly as asked.
 */
function tutorialPayment(s: GameState, r: ClientRequest): Transaction | null {
  const answers = (tx: Transaction): boolean => !DEAD.includes(tx.status) && tx.beneficiaryId === r.payeeId && tx.amount === r.amount;
  const linked = r.txId ? s.transactions.find((tx) => tx.id === r.txId) : undefined;
  if (linked && answers(linked)) return linked;
  return s.transactions.find((tx) => !tx.requestId && tx.origin === 'PLAYER' && tx.customerId === r.customerId && tx.createdAt >= r.t && answers(tx)) ?? null;
}

const bankerRequest = (s: GameState, requestId: string | null): ClientRequest | null => (requestId && s.requests.find((r) => r.id === requestId)) || null;

/** After every action a player takes: the steps the engine sees them do themselves. */
export function trackTutorial(s: GameState, p: Player, a: ExecuteAction, ok: boolean): void {
  const ht = p.heistTasks;
  if (ht && a.system === 'HIDDEN_HOST') {
    ht.openedHost = true;
    if (ok && a.module === 'BLACKNET' && a.fn === 'POST_MESSAGE') ht.posted = true;
    if (ok && a.module === 'TARGET_LEDGER') ht.ledger = true;
    if (HOST_KITS.includes(a.module)) ht.kit = true;
  }
  const tu = p.tutorial;
  if (!tu || tu.result) return;
  const key = `${a.system}.${a.module}.${a.fn}`;
  if (tu.kind === 'BANKER') {
    const r = bankerRequest(s, tu.requestId);
    if (!r) return;
    if (key === 'CLIENT_DATA.CLIENT_REQUESTS.VIEW_REQUESTS' && ok) tu.viewed = true;
    if (a.system === 'TRANSACTIONS' && a.module === 'PAYMENT_QUEUE') tu.openedQueue = true;
    if (key === 'TRANSACTIONS.PAYMENT_QUEUE.CREATE_TRANSACTION' && !tutorialPayment(s, r)) tu.retry = true;
    return;
  }
  if (tu.kind === 'MANAGER') {
    const st = tu.steps;
    const all = (a.params?.show ?? '').toUpperCase() === 'ALL';
    if (a.system === 'SECURITY' && a.module === 'MASTER_LOG') st.openedLog = true;
    if (!ok) return;
    if (key === 'CLIENT_DATA.CUSTOMER_RECORDS.VIEW_CUSTOMERS' && all) st.customersAll = true;
    if (key === 'CLIENT_DATA.CLIENT_REQUESTS.VIEW_REQUESTS' && all) st.requestsAllAt = gameTime(s);
    if (key === 'TRANSACTIONS.PAYMENT_QUEUE.VIEW_QUEUE' && all) st.paymentsAllAt = gameTime(s);
    if (key === 'SECURITY.MASTER_LOG.TRACE') st.traced = true;
    return;
  }
  if (tu.kind === 'IT') {
    const st = tu.steps;
    if (a.system === 'SECURITY' && a.module === 'MASTER_LOG') st.openedLog = true;
    if (!ok) return;
    if (a.quiet && key === 'SECURITY.MASTER_LOG.VIEW_LOG') st.autoUpdate = true;
    if (key === 'SECURITY.MASTER_LOG.VIEW_LOG' && st.traced && (a.params?.show ?? '').toUpperCase() === 'ALL') st.viewedEverything = true;
    if (key === 'SECURITY.MASTER_LOG.TRACE') {
      const hidden = s.logs.find((e) => e.id === normLog(a.params?.logId ?? ''))?.kind === 'HIDDEN_ACCESS';
      if (!st.traced && hidden) st.firstTraceHidden = true;
      st.traced = true;
      if (hidden) st.tracedHidden = true;
    }
    if (key === 'SECURITY.FIREWALL.VIEW_STATUS') st.firewallAt = gameTime(s);
    return;
  }
  for (const id of AR_ORDER) {
    const part = tu.parts[id];
    const def = AR_PARTS[id];
    if (!part.waited || part.done) continue;
    if (`${a.system}.${a.module}` === def.module) part.opened = true;
    if (!ok) continue;
    if (def.check.includes(key)) part.checked = true;
    else if (key === def.act && part.checked) part.done = true;
  }
  if (AR_ORDER.every((id) => tu.parts[id].done)) tu.result = 'DONE';
}

/** Is something waiting for a person at this stage? (Called after automation has had its turn.) */
function waitingFor(s: GameState, id: ArPart): boolean {
  if (id === 'RISK') return s.transactions.some((tx) => tx.status === 'QUEUED');
  if (id === 'SETTLE') return s.transactions.some((tx) => tx.status === 'AUTHORIZED');
  return s.customers.some((c) => c.history.some((h) => !h.verified));
}

/**
 * From the time loop, after automation: a banker's tutorial is done when the payment settles, failed when the
 * request expires first (with an alert); an A&R part's wait ends when work is left for a person.
 */
export function advanceTutorials(s: GameState): void {
  const hp = s.heistProgress;
  if (hp) {
    const mules = s.targets.map((x) => x.account);
    if (s.customers.some((c) => c.accounts.some((a) => mules.includes(a)))) hp.onFile = true;
    if (s.customers.some((c) => mules.includes(c.primary))) hp.primary = true;
    if (s.totals.stolen > 0) hp.earning = true;
    if (thiefTargetMet(s)) hp.goalMet = true;
  }
  for (const id of s.playerOrder) {
    const p = s.players[id];
    const tu = p.tutorial;
    if (!tu || tu.result) continue;
    if (tu.kind === 'IT' || tu.kind === 'MANAGER') continue;
    if (tu.kind === 'AR') {
      for (const part of AR_ORDER) if (!tu.parts[part].waited && waitingFor(s, part)) tu.parts[part].waited = true;
      continue;
    }
    const r = bankerRequest(s, tu.requestId);
    if (!r) continue;
    if (tutorialPayment(s, r)?.status === 'SETTLED') tu.result = 'DONE';
    else if (r.outcome === 'MISSED') {
      tu.result = 'FAILED';
      const message = `${p.name} failed their Personal Banker tutorial. Consider immediate termination for poor performance.`;
      const entry = addLog(s, { actor: 'SYSTEM', kind: 'TUTORIAL_FAILED', message, sourceIp: null, actualPlayerId: null });
      addAlert(s, 'TUTORIAL_FAILED', message, entry.id);
    }
  }
}

/** A banker's settlement by hand finishes their tutorial at once (no waiting for the next tick). */
export function finishBankerTutorials(s: GameState): void {
  for (const id of s.playerOrder) {
    const tu = s.players[id].tutorial;
    if (tu?.kind !== 'BANKER' || tu.result) continue;
    const r = bankerRequest(s, tu.requestId);
    if (r && tutorialPayment(s, r)?.status === 'SETTLED') tu.result = 'DONE';
  }
}

/** A Thief's heist checklist; null for everyone else. */
export function heistView(s: GameState, p: Player): HeistView | null {
  if (!p.heistTasks) return null;
  return {
    tasks: { ...p.heistTasks },
    progress: { ...(s.heistProgress ?? { onFile: false, primary: false, earning: false, goalMet: false }) },
    stolen: s.totals.stolen,
    goal: s.config.blackTarget,
  };
}

export function tutorialView(s: GameState, p: Player): TutorialView | null {
  const tu = p.tutorial;
  if (!tu) return null;
  if (tu.kind === 'AR') return { kind: 'AR', parts: structuredClone(tu.parts), result: tu.result };
  if (tu.kind === 'IT') return { kind: 'IT', steps: { ...tu.steps }, result: tu.result };
  if (tu.kind === 'MANAGER') return { kind: 'MANAGER', steps: { ...tu.steps }, requestsFrom: s.requests[1]?.t ?? null, paymentsFrom: s.requests[2]?.t ?? null, result: tu.result };
  const r = bankerRequest(s, tu.requestId);
  const tx = r ? tutorialPayment(s, r) : null;
  const approved = tx?.history.find((e) => e.action === 'APPROVED');
  return {
    kind: 'BANKER',
    requestId: r?.id ?? null,
    viewed: tu.viewed,
    openedQueue: tu.openedQueue,
    created: !!tx,
    retry: tu.retry && !tx,
    riskChecked: !!tx?.history.some((e) => e.action === 'RISK_CHECKED'),
    approval: approved ? (approved.by === 'SYSTEM' ? 'AUTO' : 'MANUAL') : null,
    settled: tx?.status === 'SETTLED',
    result: tu.result,
  };
}
