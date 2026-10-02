// Bot mode: what every bot has (docs/BotMode.md). Its stats, its memory, the pages it opens, and the few things
// it does with its hands: open a page, act, type a number, write a message. bots.ts runs their jobs and turns;
// detective.ts notices and answers tampering. A bot decides only from pages it opens with its own codes, its own
// screen, and memory of what it did itself.

import { codeFor, glance, look } from './senses';
import type { PlayerView } from './views';
import type { Execute } from './senses';
import type { ChangeRow, PageData } from './perception';
import type { Todo } from './detective';
import { pick, rand } from './rng';
import type { ActionResult, GameState, Player, PlayerId, RoleId, SystemId } from './types';

export type BotLevel = 'ROOKIE' | 'STANDARD' | 'SHARP' | 'RUTHLESS';

export interface BotStats {
  actionsPerMin: number;
  /** Seconds from a bell to opening its page. */
  reactionSec: number;
  /** Chance each number it types is right. */
  accuracy: number;
  /** Share of optional checks it makes: how fresh Customer Records must be before it pays from them, and how often it reads back a number it typed and catches a typo. */
  thoroughness: number;
  /** Share of turns it does nothing. */
  slack: number;
  /** Seconds between checks of each of its pages when no bell rings. */
  lookEverySec: number;
  /** IT: also traces host activity nobody raised an alert about. */
  traceAll: boolean;
  /** Weight it gives evidence (noticing). */
  paranoia: number;
  /** Suspicion at which it acts against an employee (decisiveness: lower acts sooner). */
  actAt: number;
  /** Seconds for evidence to lose half its weight (memory). */
  memorySec: number;
  /** Asks a suspect about what it saw before acting (telegraphing). */
  warns: boolean;
  /** Suspects scam requests: holds one that came in with a server alert, or would make a new account primary, until
   * a trace or the customer's follow-up settles it (no follow-up by halfway: nobody real is waiting). */
  wary: boolean;
  /** Raises a stage's automation once this many payments wait in its queue (0: never). */
  tuneAt: number;
  /** How many times slower than its job pages it checks the pages where tampering shows (alerts, the Firewall, the
   * Master Log, Employee Records, its customers' files), and answers their bells. The day job is the same skill at
   * every level; dealing with Thieves is not. */
  securityLag: number;
}

/** The difficulty levels: the stats every bot's personality is drawn around (each varies by up to 20%). */
export const BOT_LEVELS: Record<BotLevel, { label: string; stats: BotStats }> = {
  ROOKIE: {
    label: 'Rookie',
    stats: { actionsPerMin: 7, reactionSec: 12, accuracy: 0.99, thoroughness: 0.45, slack: 0.15, lookEverySec: 25, traceAll: false, paranoia: 0.7, actAt: 2.5, memorySec: 120, warns: true, wary: false, tuneAt: 4, securityLag: 3 },
  },
  STANDARD: {
    label: 'Standard',
    stats: { actionsPerMin: 7, reactionSec: 12, accuracy: 0.99, thoroughness: 0.45, slack: 0.15, lookEverySec: 25, traceAll: true, paranoia: 1, actAt: 1.5, memorySec: 300, warns: true, wary: false, tuneAt: 4, securityLag: 1 },
  },
  SHARP: {
    label: 'Sharp',
    stats: { actionsPerMin: 9, reactionSec: 6, accuracy: 0.997, thoroughness: 0.7, slack: 0.08, lookEverySec: 15, traceAll: true, paranoia: 1.2, actAt: 1, memorySec: 600, warns: false, wary: true, tuneAt: 3, securityLag: 1 },
  },
  RUTHLESS: {
    label: 'Ruthless',
    stats: { actionsPerMin: 12, reactionSec: 3, accuracy: 0.999, thoroughness: 0.9, slack: 0.03, lookEverySec: 10, traceAll: true, paranoia: 1.5, actAt: 0.8, memorySec: 1200, warns: false, wary: true, tuneAt: 3, securityLag: 1 },
  },
};

/** Something a bot saw that points at a subject: an employee ("emp:Name") or an address ("ip:10.1.0.7"). */
export interface Evidence {
  t: number;
  subject: string;
  weight: number;
  why: string;
  /** The incident it belongs to, so a later finding can cancel it (a colleague's code was stolen, not used by them). */
  incident: string;
}

/**
 * Something done under someone's name that they may not have done, as security knows it: an account change nobody
 * asked for (customer, account), or any logged action under a bot's own name that it did not make (its log entry).
 */
export interface Incident {
  key: string; // customer:account, or log:L123
  t: number;
  customerId: string; // '' when it is not an account change
  account: string;
  what: ChangeWhat | 'action';
  /** The module whose code was used (its code is revoked): Customer Records for account changes. */
  system: string;
  module: string;
  /** The name the records show; null when the bot does not know yet. */
  by: string | null;
  /** That employee says it was not them: their code was used. */
  stolen: boolean;
  /** The Master Log entry (and when it was written), its trace, and what was done about it (the enforcer's work). */
  logId?: string | null;
  entryT?: number;
  tracedIp?: string | null;
  traceFailed?: boolean;
  /** The credentials of the named employee it revoked (to reissue them if the code turns out stolen). */
  revoked?: { id: string; module: string | null }[];
  /** Its evidence has been counted. */
  weighed?: boolean;
  closed?: boolean;
}
export type ChangeWhat = 'made primary' | 'added' | 'removed';

export interface BotMemory {
  archetype: string;
  stats: BotStats;
  nextTurnAt: number;
  /** The last view of each page it opened, by page key. */
  pages: Record<string, { t: number; data: PageData }>;
  /** Pages a bell asked it to open, and when it gets round to it. */
  due: Record<string, number>;
  /** The newest notification it has dealt with (its number). */
  lastNotice: number;
  /** Messages it has read (they only ever grow). */
  readMessages: number;
  /** Work it has done, by key, and when. */
  done: Record<string, number>;
  /** When it first saw each piece of work (Bank Manager: it leaves fresh work to the job's owner). */
  seen: Record<string, number>;
  /** Requests it answered, with what it read and did: to check the payments made for them, or undo it. */
  answered: Record<string, Answered>;
  /** Log entries of its own actions: it knows what it did. */
  mine: string[];
  /** Account changes it made itself (editKey -> when). */
  myEdits: Record<string, number>;
  /** Personal Banker: its customers' files as it last saw them. */
  files: Record<string, { primary: string; accounts: string[]; t: number }>;
  /** Changes it has judged (Verification): change id -> what it made of it. */
  judged: Record<string, 'OK' | 'SUSPECT' | 'UNDO'>;
  incidents: Record<string, Incident>;
  /** Changes it found suspect in Verification (to recognise a colleague undoing them). */
  suspects: ChangeRow[];
  /** Things it decided to do, one per turn ahead of its job (detective.ts). */
  todo: Todo[];
  /** Personal Banker: requests it is holding as possible scams (until a trace or a follow-up settles it). */
  held: Record<string, { t: number; logId: string | null }>;
  /** Alerts it has dealt with (by id). */
  seenAlerts: string[];
  /** Alerts waiting on a page before it can deal with them: code cracks (credential id), host alerts (scam checks). */
  pendingCracks: string[];
  pendingHostAlerts: { logId: string; t: number }[];
  /** A&R: colleagues' notes that they are undoing a change made for a scam request (customer, account, until). */
  undoNotes: { customerId: string; account: string; until: number }[];
  /** IT: traces colleagues asked for: log id -> who to tell, and about which request. */
  traceAsks: Record<string, { request: string; tell: string[] }>;
  /** What it started on the Firewall itself (revocations and blocks, by address): it knows its own. */
  myFirewall: string[];
  evidence: Evidence[];
  traced: string[];
  lastTraceAt: number;
}

/** A request a banker bot answered: what it read, and what it did. */
export interface Answered {
  amount: number | null;
  payeeId: string | null;
  txId?: string;
  customerId?: string;
  account?: string;
  /** Account requests: the primary before the change (to put it back). */
  prevPrimary?: string;
  madePrimary?: boolean;
}

export interface BotsState {
  level: BotLevel;
  rngState: number;
  bots: Record<PlayerId, BotMemory>;
}

/** The pages bots open: page key -> the read that opens it. */
export const PAGES: Record<string, [SystemId, string, string, Record<string, string>]> = {
  REQUESTS: ['CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS', {}],
  CUSTOMERS: ['CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: 'ALL' }],
  VERIFY: ['CLIENT_DATA', 'VERIFICATION', 'VIEW_VERIFICATION', {}],
  RISK: ['TRANSACTIONS', 'RISK_CHECK', 'VIEW_RISK_QUEUE', {}],
  AUTH: ['TRANSACTIONS', 'AUTHORIZATION', 'VIEW_AUTH_QUEUE', {}],
  SETTLE: ['TRANSACTIONS', 'SETTLEMENT', 'VIEW_SETTLEMENT', {}],
  ALERTS: ['SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: 'ALERTS', limit: '30' }],
  LOG: ['SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: 'ALL', limit: '40' }],
  ALL_REQUESTS: ['CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS', { show: 'ALL' }],
  FIREWALL: ['SECURITY', 'FIREWALL', 'VIEW_STATUS', {}],
  ACTIVITY: ['SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: 'PLAYERS', limit: '200' }],
  EMPLOYEES: ['SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES', {}],
  CREDENTIALS: ['SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', {}],
};

/** The engine's private message, as a player sends it. */
export type Send = (s: GameState, p: Player, toId: PlayerId, text: string) => ActionResult;

export interface Turn {
  s: GameState;
  st: BotsState;
  bot: Player;
  mem: BotMemory;
  t: number;
  execute: Execute;
  send: Send;
  /** Its screen, as it was at the start of the turn (built once: it is not cheap). */
  screen?: PlayerView;
}

/** What is on the bot's screen this turn. */
export const screenOf = (tn: Turn): PlayerView => (tn.screen ??= glance(tn.s, tn.bot));

/** One piece of work: what it does, or a page it must (re)open first. */
export type Task = { key: string; run: () => ActionResult | null } | { needs: string };

/** What a bot remembers of its own account changes: customer, account and kind. */
export const editKey = (customerId: string, account: string, what: ChangeWhat): string => `${customerId}:${account}:${what}`;

export const digitsOf = (account: string): string => account.replace(/\D/g, '').slice(-5);

/** A number as the bot types it: now and then one digit is wrong, unless it reads it back and catches it. */
export function typed(tn: Turn, value: string): string {
  if (rand(tn.st) < tn.mem.stats.accuracy || !/\d/.test(value) || rand(tn.st) < tn.mem.stats.thoroughness) return value;
  const at = [...value].map((ch, i) => (/\d/.test(ch) ? i : -1)).filter((i) => i >= 0);
  const i = pick(tn.st, at);
  const d = (Number(value[i]) + 1 + Math.floor(rand(tn.st) * 9)) % 10;
  return value.slice(0, i) + d + value.slice(i + 1);
}

/** Runs one action as the bot with its own code, and remembers the log entries it made. */
export function act(tn: Turn, system: SystemId, module: string, fn: string, params: Record<string, string>): ActionResult | null {
  const code = codeFor(tn.s, tn.bot, system, module, fn);
  if (!code) return null;
  const before = tn.s.counters.log;
  const r = tn.execute(tn.s, tn.bot, { type: 'EXECUTE', playerId: tn.bot.id, code, system, module, fn, params });
  remember(tn, before);
  if (r.ok && system === 'CLIENT_DATA' && module === 'CUSTOMER_RECORDS' && params.customerId && params.account) {
    const whats: ChangeWhat[] = fn === 'SET_PRIMARY' ? ['made primary'] : fn === 'REMOVE_ACCOUNT' ? ['removed'] : params.makePrimary === 'YES' ? ['added', 'made primary'] : ['added'];
    for (const w of whats) tn.mem.myEdits[editKey(params.customerId, `ACC-${digitsOf(params.account)}`, w)] = tn.t;
  }
  return r;
}

/** Sends a private message to a colleague, by name (one action, like anyone's). */
export function tell(tn: Turn, name: string, text: string): ActionResult | null {
  const to = tn.s.playerOrder.find((id) => tn.s.players[id].name === name);
  if (!to || to === tn.bot.id) return null;
  return tn.send(tn.s, tn.bot, to, text);
}

function remember(tn: Turn, logCounterBefore: number): void {
  for (const e of tn.s.logs.slice(-5)) {
    if (Number(e.id.slice(1)) > logCounterBefore && e.actualPlayerId === tn.bot.id) tn.mem.mine.push(e.id);
  }
  if (tn.mem.mine.length > 300) tn.mem.mine.splice(0, tn.mem.mine.length - 300);
}

export function openPage(tn: Turn, key: string, onLook?: (tn: Turn, key: string, before: PageData | null) => void): { ok: boolean; message: string } {
  const [system, module, fn, params] = PAGES[key];
  const before = tn.s.counters.log;
  const prev = tn.mem.pages[key]?.data ?? null;
  const seen = look(tn.s, tn.bot, tn.execute, system, module, fn, params);
  remember(tn, before);
  delete tn.mem.due[key];
  if (seen.ok && seen.data) {
    tn.mem.pages[key] = { t: tn.t, data: seen.data };
    onLook?.(tn, key, prev);
  } else tn.mem.pages[key] = { t: tn.t, data: { page: 'LOG', rows: [] } }; // could not open it: try again later
  return seen;
}

export const page = <K extends PageData['page']>(tn: Turn, key: string, kind: K): Extract<PageData, { page: K }> | null => {
  const p = tn.mem.pages[key]?.data;
  return p && p.page === kind ? (p as Extract<PageData, { page: K }>) : null;
};
/** Seen recently enough: within maxAge, plus a few of the bot's own turns (a slow bot cannot look any quicker). */
export const fresh = (tn: Turn, key: string, maxAge: number): boolean =>
  !!tn.mem.pages[key] && tn.t - tn.mem.pages[key].t <= maxAge + (3 * 60) / tn.mem.stats.actionsPerMin;
export const isDone = (tn: Turn, key: string): boolean => key in tn.mem.done;
export const firstSeen = (tn: Turn, key: string): number => (tn.mem.seen[key] ??= tn.t);
/** Bot colleagues in a role (bots know which seats are bots: they are the bank's own staff). */
export const botsIn = (tn: Turn, role: RoleId): Player[] =>
  Object.keys(tn.st.bots).map((id) => tn.s.players[id]).filter((p) => p.role === role && !p.terminated);

// ---- Evidence ----

export function addEvidence(tn: Turn, subject: string, weight: number, why: string, incident: string): void {
  tn.mem.evidence.push({ t: tn.t, subject, weight, why, incident });
  if (tn.mem.evidence.length > 200) tn.mem.evidence.splice(0, tn.mem.evidence.length - 200);
}
/** Drops what an incident said about a subject (a finding showed it wrong). */
export function cancelEvidence(tn: Turn, subject: string, incident: string): void {
  tn.mem.evidence = tn.mem.evidence.filter((e) => !(e.subject === subject && e.incident === incident));
}
/** How suspicious a subject is now: its evidence, weighed by paranoia and faded by memory. */
export function suspicion(tn: Turn, subject: string): number {
  const { paranoia, memorySec } = tn.mem.stats;
  return tn.mem.evidence.filter((e) => e.subject === subject).reduce((sum, e) => sum + e.weight * paranoia * 0.5 ** ((tn.t - e.t) / memorySec), 0);
}
