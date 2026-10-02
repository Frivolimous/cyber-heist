// Bot mode: the bank's employees as bots (docs/BotMode.md): their jobs and their turns. What every bot has is in
// botkit.ts; noticing and answering tampering is detective.ts.
//
// A bot works only from what its seat could see: pages it opens with its own codes (senses.ts: logged like
// anyone's read), its own screen (bells, messages), and memory of what it did itself. It never reads GameState
// for a decision (bots.test.ts checks this file for it).
//
// Time is spent in turns, at the bot's action rate: each turn is one thing, either opening a page, acting on
// what it last saw there, or sending a message. Bells bring a page forward after the bot's reaction time;
// otherwise it checks each of its pages every so often (vigilance). Some turns it does nothing (slack). Numbers
// it types can be wrong (accuracy): a mistyped payment does not answer its request, the customer chases it, and
// the bot tries again. All its randomness comes from its own stream (BotsState.rngState).

import { CHANNELS } from './bank';
import { act, BOT_LEVELS, botsIn, digitsOf, firstSeen, fresh, isDone, openPage, page, PAGES, screenOf, typed } from './botkit';
import type { BotLevel, BotMemory, BotsState, Send, Task, Turn } from './botkit';
import { gameTime } from './core';
import { bankerSawCustomers, heldVerdict, holdRequest, sawNotice, settleOldHolds, judgeChanges, managerTasks, readMessages, runTodo, sawAlerts, sawFirewall, securityTasks, tracesWaiting } from './detective';
import type { CustomerRow, PageData, PaymentRow, RequestRow } from './perception';
import { readRequest } from './reading';
import { pick, rand } from './rng';
import { codeFor } from './senses';
import type { Execute } from './senses';
import type { ActionResult, GameState, Player, PlayerId, RoleId } from './types';

export { BOT_LEVELS } from './botkit';
export type { BotLevel, BotMemory, BotsState, BotStats } from './botkit';

/** Shown on a bot's profile one day; for now in Download state. */
const ARCHETYPES = ['By the book', 'Coasting', 'Eager', 'Methodical', 'Distracted', 'Steady'];

/** A bell's module -> the page it brings forward. */
const BELL_PAGE: Record<string, string> = {
  CLIENT_REQUESTS: 'REQUESTS',
  CUSTOMER_RECORDS: 'CUSTOMERS',
  VERIFICATION: 'VERIFY',
  RISK_CHECK: 'RISK',
  AUTHORIZATION: 'AUTH',
  SETTLEMENT: 'SETTLE',
  MASTER_LOG: 'ALERTS',
  EMPLOYEE_RECORDS: 'EMPLOYEES',
  FIREWALL: 'FIREWALL',
};
/** The pages each job keeps an eye on, and how many times its usual interval it waits between unprompted looks. */
const WATCHES: Record<RoleId, [string, number][]> = {
  PERSONAL_BANKER: [
    ['REQUESTS', 1],
    ['AUTH', 1],
    ['CUSTOMERS', 4],
  ],
  ACCOUNTS_RECEIVABLES: [
    ['RISK', 1],
    ['SETTLE', 1],
    ['VERIFY', 1],
  ],
  IT_SPECIALIST: [
    ['ALERTS', 1],
    ['LOG', 1],
    ['EMPLOYEES', 1],
    ['FIREWALL', 2],
  ],
  BANK_MANAGER: [
    ['VERIFY', 1],
    ['SETTLE', 1],
    ['ALERTS', 1],
    ['FIREWALL', 3],
  ],
};
/** Pages where tampering shows rather than work: checked (and their bells answered) securityLag times slower. */
const SECURITY_PAGES = ['ALERTS', 'LOG', 'EMPLOYEES', 'FIREWALL', 'CUSTOMERS'];
const lagOf = (tn: Turn, key: string): number => (SECURITY_PAGES.includes(key) ? tn.mem.stats.securityLag : 1);
/** The Bank Manager backs the team up: work nobody has touched for this long. */
const MANAGER_BACKUP_SEC = 40;

/** Sets up bots for these seats at this level (a side stream of the seed, so the game's own sequence is unchanged). */
export function createBots(s: GameState, ids: PlayerId[], level: BotLevel): BotsState {
  const st: BotsState = { level, rngState: (s.seed ^ 0x5bd1e995) | 0, bots: {} };
  const base = BOT_LEVELS[level].stats;
  const vary = (x: number): number => x * (0.8 + 0.4 * rand(st));
  for (const id of ids) {
    const mem: BotMemory = {
      archetype: pick(st, ARCHETYPES),
      stats: {
        actionsPerMin: vary(base.actionsPerMin),
        reactionSec: vary(base.reactionSec),
        accuracy: 1 - vary(1 - base.accuracy), // personality varies the error rate
        thoroughness: Math.min(1, vary(base.thoroughness)),
        slack: vary(base.slack),
        lookEverySec: vary(base.lookEverySec),
        traceAll: base.traceAll,
        paranoia: vary(base.paranoia),
        actAt: vary(base.actAt),
        memorySec: vary(base.memorySec),
        warns: base.warns,
        wary: base.wary,
        tuneAt: base.tuneAt,
        securityLag: base.securityLag,
      },
      nextTurnAt: 0,
      pages: {},
      due: {},
      lastNotice: 0,
      readMessages: 0,
      done: {},
      seen: {},
      answered: {},
      mine: [],
      myEdits: {},
      files: {},
      judged: {},
      incidents: {},
      suspects: [],
      todo: [],
      held: {},
      seenAlerts: [],
      pendingCracks: [],
      pendingHostAlerts: [],
      undoNotes: [],
      traceAsks: {},
      myFirewall: [],
      evidence: [],
      traced: [],
      lastTraceAt: -Infinity,
    };
    st.bots[id] = mem;
    // A thorough banker keeps the Customer Records bell on, so it hears who changes its customers' files.
    const p = s.players[id];
    const bell = (page: string): void => void (p.watching.includes(page) || p.watching.push(page));
    if (p.role === 'PERSONAL_BANKER' && mem.stats.thoroughness >= 0.6) bell('CLIENT_DATA.CUSTOMER_RECORDS');
    // Security keeps an ear on the Firewall and the alerts (a bell only rings for a module it can write).
    if (p.role === 'IT_SPECIALIST' || p.role === 'BANK_MANAGER') {
      bell('SECURITY.FIREWALL');
      bell('SECURITY.MASTER_LOG');
    }
  }
  return st;
}

// ---- Personal Banker -----------------------------------------------------------------------------

/** The account to pay from, as Customer Records shows the sender's file now. */
function payingAccount(rows: CustomerRow[], customerId: string, from: NonNullable<ReturnType<typeof readRequest>['from']>, amount: number): string | null {
  if (from.form === 'NUMBER') return from.account;
  const c = rows.find((x) => x.id === customerId);
  if (!c) return null;
  if (from.form === 'MAIN') return c.primary.account;
  const able = [...c.others].sort((a, b) => b.balance - a.balance);
  return (able.find((a) => a.balance >= amount) ?? able[0])?.account ?? null;
}

function requestTask(tn: Turn, r: RequestRow): Task | null {
  const key = `req:${r.id}:${r.followUps.length}`;
  if (isDone(tn, key)) return null;
  const freshFor = 20 + (1 - tn.mem.stats.thoroughness) * 60;
  if (!fresh(tn, 'CUSTOMERS', freshFor)) return { needs: 'CUSTOMERS' };
  const customers = page(tn, 'CUSTOMERS', 'CUSTOMERS')?.rows ?? [];
  const ask = readRequest(r, customers);
  // A request held as a possible scam waits for a follow-up (real) or its absence (a scam).
  if (tn.mem.held[r.id]) {
    const verdict = heldVerdict(tn, r);
    if (verdict !== 'RELEASE') return null;
  }
  const skip = (): null => ((tn.mem.done[key] = tn.t), null);
  const run = (fn: () => ActionResult | null): Task => ({ key, run: fn });
  if (ask.kind === 'PHISH') return run(() => act(tn, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: r.id, reason: 'Phishing' }));
  if (ask.kind === 'UNREADABLE' || !ask.customerId) return skip();
  const sender = customers.find((c) => c.id === ask.customerId)!;
  if (ask.kind === 'PAYMENT') {
    const origin = payingAccount(customers, ask.customerId, ask.from!, ask.amount!);
    if (!origin) return skip();
    return run(() => {
      const res = act(tn, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', {
        requestId: r.id,
        originAccount: typed(tn, digitsOf(origin)),
        beneficiaryId: ask.payeeId!,
        amount: typed(tn, String(ask.amount)),
      });
      tn.mem.answered[r.id] = { amount: ask.amount, payeeId: ask.payeeId, txId: /Queued (TX-\d+)/.exec(res?.message ?? '')?.[1] };
      return res;
    });
  }
  const acc = ask.account!;
  const onFile = sender.primary.account === acc || sender.others.some((a) => a.account === acc);
  // Wary: a request that would make an account primary that is not on file is the shape of a scam: wait for a follow-up.
  const newPrimary = (ask.kind === 'ADD_AND_PRIMARY' || ask.kind === 'SET_PRIMARY') && !onFile;
  if (tn.mem.stats.wary && newPrimary && !r.followUps.length && !tn.mem.held[r.id]) {
    holdRequest(tn, r.id, null);
    return null;
  }
  const change = (fn: string, makePrimary?: 'YES' | 'NO'): Task =>
    run(() => {
      const res = act(tn, 'CLIENT_DATA', 'CUSTOMER_RECORDS', fn, {
        requestId: r.id,
        customerId: sender.id,
        account: typed(tn, digitsOf(acc)),
        ...(makePrimary ? { makePrimary } : {}),
      });
      if (res?.ok) tn.mem.answered[r.id] = { amount: null, payeeId: null, customerId: sender.id, account: acc, prevPrimary: sender.primary.account, madePrimary: fn === 'SET_PRIMARY' || makePrimary === 'YES' };
      return res;
    });
  switch (ask.kind) {
    case 'ADD_ACCOUNT':
      return onFile ? skip() : change('ADD_ACCOUNT', 'NO');
    case 'ADD_AND_PRIMARY':
      return onFile ? (sender.primary.account === acc ? skip() : change('SET_PRIMARY')) : change('ADD_ACCOUNT', 'YES');
    case 'SET_PRIMARY':
      return sender.primary.account === acc ? skip() : onFile ? change('SET_PRIMARY') : change('ADD_ACCOUNT', 'YES');
    case 'REMOVE_ACCOUNT':
      return onFile && sender.primary.account !== acc ? change('REMOVE_ACCOUNT') : skip();
  }
  return skip();
}

/** Approve, hold or reject a risk-checked payment. The first banker bot takes the ones made for nobody's request. */
function authTask(tn: Turn, tx: PaymentRow, bankers: Player[]): Task | null {
  const mine = tx.requestId ? tn.mem.answered[tx.requestId] : undefined;
  const held = !!tx.requestId && !!tn.mem.held[tx.requestId];
  // Its own payment held as a possible scam, now released (the customer chased it): approve it.
  if (tx.status === 'HELD' && mine && !held && !isDone(tn, `release:${tx.id}`) && !isDone(tn, `scam:${tx.requestId}`)) {
    return { key: `release:${tx.id}`, run: () => act(tn, 'TRANSACTIONS', 'AUTHORIZATION', 'APPROVE', { txId: tx.id }) };
  }
  if (tx.status !== 'RISK_CHECKED') return null;
  const key = `auth:${tx.id}`;
  if (isDone(tn, key)) return null;
  if (held) return { key, run: () => act(tn, 'TRANSACTIONS', 'AUTHORIZATION', 'HOLD', { txId: tx.id, reason: 'Possible scam: held while it is checked' }) };
  if (!mine && bankers[0]?.id !== tn.bot.id) return null;
  const decide = (fn: 'APPROVE' | 'HOLD' | 'REJECT', reason?: string): Task => ({
    key,
    run: () => act(tn, 'TRANSACTIONS', 'AUTHORIZATION', fn, { txId: tx.id, ...(reason ? { reason } : {}) }),
  });
  // One it made: approve it if it is what the customer asked for (whatever the score), else reject it.
  if (mine) return tx.amount === mine.amount && tx.beneficiaryId === mine.payeeId ? decide('APPROVE') : decide('REJECT', 'Does not match the request');
  return tx.risk === 'HIGH' ? decide('HOLD', 'High risk') : decide('APPROVE');
}

function bankerTasks(tn: Turn): Task[] {
  const out: Task[] = [];
  const reqs = page(tn, 'REQUESTS', 'REQUESTS');
  // Chased requests first, then urgent, then oldest.
  const open = (reqs?.rows ?? []).filter((r) => r.status === 'OPEN').sort((a, b) => Number(b.reminder) - Number(a.reminder) || Number(b.urgent) - Number(a.urgent) || a.t - b.t);
  for (const r of open) {
    const task = requestTask(tn, r);
    if (task) out.push(task);
  }
  if (reqs) settleOldHolds(tn, open.map((r) => r.id));
  const bankers = botsIn(tn, 'PERSONAL_BANKER');
  for (const tx of page(tn, 'AUTH', 'PAYMENTS')?.rows ?? []) {
    const task = authTask(tn, tx, bankers);
    if (task) out.push(task);
  }
  return out;
}

// ---- Accounts & Receivables, and the Bank Manager's backup ---------------------------------------

/** A risk score from what the risk queue shows: unverified or floating money is HIGH, large or unrequested manual MEDIUM. */
function judge(tn: Turn, tx: PaymentRow): { score: string; reason: string } {
  const high: string[] = [];
  const medium: string[] = [];
  if (tx.unverified?.length) high.push(`unverified ${tx.unverified.join(' and ')}`);
  if (tx.originCustomer === null) high.push('paid from an account on no customer');
  const manual = tx.created && !CHANNELS.includes(tx.created.by);
  if (manual && !tx.requestId) medium.push('manual, for no request');
  if (tx.amount > tn.s.config.largeAmount) medium.push('large');
  const score = high.length ? 'HIGH' : medium.length ? 'MEDIUM' : 'LOW';
  return { score, reason: [...high, ...medium].join(', ') || 'Routine' };
}

/**
 * When a stage's queue backs up, the back office lets its automation take more: Settlement settles approved payments
 * up to the manual cap; Risk Check scores manual payments too, up to the large-payment line, but still only money
 * from a customer's account to a verified primary (an unverified one, the swap's tell, stays with people).
 */
function tuneTasks(tn: Turn): Task[] {
  const at = tn.mem.stats.tuneAt;
  if (!at) return [];
  const out: Task[] = [];
  const c = tn.s.config;
  const settle = page(tn, 'SETTLE', 'PAYMENTS');
  const waiting = (p: typeof settle, status: string): number => p?.rows.filter((x) => x.status === status).length ?? 0;
  // Once changed, only again after seeing the page since (the old view still shows the old setting).
  const since = (key: string, pageKey: string): boolean => !isDone(tn, key) || (tn.mem.pages[pageKey]?.t ?? 0) > tn.mem.done[key];
  if (settle && since('tune:settle', 'SETTLE') && waiting(settle, 'AUTHORIZED') >= at && (settle.automation?.settleMax ?? 0) < c.maxManualAmount) {
    out.push({ key: 'tune:settle', run: () => act(tn, 'TRANSACTIONS', 'SETTLEMENT', 'SET_AUTO_SETTLE', { maxAmount: String(c.maxManualAmount) }) });
  }
  const risk = page(tn, 'RISK', 'PAYMENTS');
  const a = risk?.automation;
  if (risk && since('tune:risk', 'RISK') && waiting(risk, 'QUEUED') >= at && a && ((a.scoreMax ?? 0) < c.largeAmount || a.scoreSource !== 'ALL')) {
    out.push({
      key: 'tune:risk',
      run: () => act(tn, 'TRANSACTIONS', 'RISK_CHECK', 'SET_AUTO_SCORE', { maxAmount: String(Math.max(a.scoreMax ?? 0, c.largeAmount)), source: 'ALL', origin: 'CUSTOMER', payee: 'VERIFIED' }),
    });
  }
  return out;
}

function backOfficeTasks(tn: Turn, backup: boolean): Task[] {
  const out: Task[] = backup && botsIn(tn, 'ACCOUNTS_RECEIVABLES').length ? [] : tuneTasks(tn);
  const ready = (key: string): boolean => !backup || tn.t - firstSeen(tn, key) >= MANAGER_BACKUP_SEC;
  if (!backup) {
    for (const tx of page(tn, 'RISK', 'PAYMENTS')?.rows ?? []) {
      const key = `score:${tx.id}`;
      if (tx.status !== 'QUEUED' || isDone(tn, key)) continue;
      const { score, reason } = judge(tn, tx);
      out.push({ key, run: () => act(tn, 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id, score, reason }) });
    }
  }
  for (const tx of page(tn, 'SETTLE', 'PAYMENTS')?.rows ?? []) {
    const key = `settle:${tx.id}`;
    if (tx.status !== 'AUTHORIZED' || isDone(tn, key) || !ready(key)) continue;
    out.push({ key, run: () => act(tn, 'TRANSACTIONS', 'SETTLEMENT', 'SETTLE', { txId: tx.id }) });
  }
  // Changes made for a customer's request are verified; the rest are judged when the page is opened (detective.ts).
  for (const ch of page(tn, 'VERIFY', 'CHANGES')?.rows ?? []) {
    const key = `verify:${ch.id}`;
    if (ch.verified || !ch.requestId || isDone(tn, key) || !ready(key)) continue;
    out.push({ key, run: () => act(tn, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: ch.id }) });
  }
  return out;
}

// ---- IT Specialist -------------------------------------------------------------------------------

function itTasks(tn: Turn): Task[] {
  const out: Task[] = [];
  for (const e of page(tn, 'EMPLOYEES', 'EMPLOYEES')?.rows ?? []) {
    const key = `reset:${e.ip}`;
    if (!e.lockedSec || (isDone(tn, key) && tn.t - tn.mem.done[key] < tn.s.config.lockoutSec)) continue;
    out.push({ key, run: () => act(tn, 'SECURITY', 'EMPLOYEE_RECORDS', 'RESET_LOCKOUT', { address: e.ip }) });
  }
  const c = tn.s.config;
  // An incident waiting for its trace has the trace engine first.
  if (!tracesWaiting(tn) && tn.t - tn.mem.lastTraceAt >= c.traceCooldownSec) {
    const traceable = (logId: string | null, at: number): logId is string =>
      !!logId && !tn.mem.mine.includes(logId) && !tn.mem.traced.includes(logId) && tn.t - at <= c.traceMaxAgeSec - 5;
    const alert = [...(page(tn, 'ALERTS', 'ALERTS')?.rows ?? [])].reverse().find((a) => traceable(a.logId, a.t));
    const hidden = tn.mem.stats.traceAll
      ? [...(page(tn, 'LOG', 'LOG')?.rows ?? [])].reverse().find((e) => e.message === 'Unknown server activity' && traceable(e.id, e.t))
      : undefined;
    const logId = alert?.logId ?? hidden?.id;
    if (logId) {
      out.push({
        key: `trace:${logId}`,
        run: () => {
          tn.mem.traced.push(logId);
          tn.mem.lastTraceAt = tn.t;
          return act(tn, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId });
        },
      });
    }
  }
  return out;
}

/** SOLO test strip (dev tooling, not the bot's knowledge): whether a trace exposed the human or the host. */
function recordSoloTrace(s: GameState, logId: string, text: string): void {
  const sc = s.scenario;
  if (sc?.kind !== 'SOLO') return;
  const names = (ip: string): boolean => new RegExp(`(^|[^\\d.])${ip.replace(/\./g, '\\.')}(?![\\d])`).test(text);
  const human = s.playerOrder.map((id) => s.players[id]).find((p) => !p.bot);
  const t = gameTime(s);
  const exposes: ('IP' | 'HOST')[] = [];
  if (human && names(human.ip)) exposes.push('IP');
  if (names(s.hiddenHost)) exposes.push('HOST');
  sc.traceLog.push({ t, logId, text, exposes });
  if (exposes.includes('IP')) sc.exposedIpAt ??= t;
  if (exposes.includes('HOST')) sc.exposedHostAt ??= t;
}

// ---- Turns ---------------------------------------------------------------------------------------

function tasksFor(tn: Turn): Task[] {
  switch (tn.bot.role) {
    case 'PERSONAL_BANKER':
      return bankerTasks(tn);
    case 'ACCOUNTS_RECEIVABLES':
      return backOfficeTasks(tn, false);
    case 'BANK_MANAGER':
      return [...managerTasks(tn), ...securityTasks(tn), ...backOfficeTasks(tn, true)];
    case 'IT_SPECIALIST':
      return [...securityTasks(tn), ...itTasks(tn)];
  }
}

/** What a bot makes of a page it has just opened, beyond the work on it (detective.ts). */
function onLook(tn: Turn, key: string, data: PageData | null): void {
  if (!data) return;
  if (key === 'CUSTOMERS' && data.page === 'CUSTOMERS' && tn.bot.role === 'PERSONAL_BANKER') bankerSawCustomers(tn, data.rows);
  // The Bank Manager judges changes only when no Accounts & Receivables bot is left to.
  const judges = tn.bot.role === 'ACCOUNTS_RECEIVABLES' || (tn.bot.role === 'BANK_MANAGER' && !botsIn(tn, 'ACCOUNTS_RECEIVABLES').length);
  if (key === 'VERIFY' && data.page === 'CHANGES' && judges) judgeChanges(tn, data.rows);
  if (key === 'ALERTS' && data.page === 'ALERTS') sawAlerts(tn, data.rows);
  if (key === 'FIREWALL' && data.page === 'FIREWALL') sawFirewall(tn, data);
}

/** Opens a page; a page that is offline sends a bot with Firewall access to check the Firewall straight away. */
function look(tn: Turn, key: string): void {
  const r = openPage(tn, key, (t, k) => onLook(t, k, t.mem.pages[k]?.data ?? null));
  if (!r.ok && /offline/.test(r.message) && canOpen(tn, 'FIREWALL')) tn.mem.due.FIREWALL = Math.min(tn.mem.due.FIREWALL ?? Infinity, tn.t);
}

/** Holds a code for the page. */
const canOpen = (tn: Turn, key: string): boolean => !!codeFor(tn.s, tn.bot, PAGES[key][0], PAGES[key][1], PAGES[key][2]);

/** The page most overdue: one a bell asked for, else the stalest of its job's pages. */
function nextLook(tn: Turn): string | null {
  const bell = Object.entries(tn.mem.due).filter(([, at]) => at <= tn.t).sort((a, b) => a[1] - b[1])[0];
  if (bell) return bell[0];
  const age = (key: string): number => (tn.mem.pages[key] ? tn.t - tn.mem.pages[key].t : Infinity);
  const stale = WATCHES[tn.bot.role]
    .filter(([k, f]) => age(k) >= tn.mem.stats.lookEverySec * f * lagOf(tn, k) && canOpen(tn, k))
    .sort((a, b) => age(b[0]) / (b[1] * lagOf(tn, b[0])) - age(a[0]) / (a[1] * lagOf(tn, a[0])));
  return stale[0]?.[0] ?? null;
}

function takeTurn(tn: Turn): void {
  const { mem, t } = tn;
  readMessages(tn);
  // Bells since last time bring their pages forward, after the bot's reaction time.
  for (const n of screenOf(tn).notifications) {
    const num = Number(n.id.slice(1));
    if (num <= mem.lastNotice) continue;
    mem.lastNotice = num;
    sawNotice(tn, n.text);
    const key = BELL_PAGE[n.module];
    if (key && WATCHES[tn.bot.role].some(([k]) => k === key)) mem.due[key] = Math.min(mem.due[key] ?? Infinity, n.t + mem.stats.reactionSec * lagOf(tn, key));
  }
  if (rand(tn.st) < mem.stats.slack) return;
  if (runTodo(tn)) return;
  for (const task of tasksFor(tn)) {
    if ('needs' in task) {
      look(tn, task.needs);
      return;
    }
    mem.done[task.key] = t;
    const r = task.run();
    if (r && task.key.startsWith('trace:')) recordSoloTrace(tn.s, task.key.split(':')[1], r.message);
    if (r !== null) return; // one action per turn; a task with nothing to do costs nothing
  }
  const key = nextLook(tn);
  if (key) look(tn, key);
}

/** Mutating: every bot whose turn has come takes it. Called on every tick, after the bank's automation. */
export function runBots(s: GameState, execute: Execute, send: Send): void {
  const st = s.bots;
  if (!st || s.status !== 'RUNNING') return;
  const t = gameTime(s);
  for (const id of s.playerOrder) {
    const mem = st.bots[id];
    const bot = s.players[id];
    if (!mem || bot.terminated || t < mem.nextTurnAt) continue;
    mem.nextTurnAt = t + (60 / mem.stats.actionsPerMin) * (0.7 + 0.6 * rand(st));
    takeTurn({ s, st, bot, mem, t, execute, send });
    if (s.status !== 'RUNNING') return;
  }
}
