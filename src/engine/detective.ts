// Bot mode (docs/BotMode.md): the bank's bots notice tampering, put it right, report it, and close in on whoever
// did it. Every bot works only from its own pages, screen and memory (see bots.ts).
//
// - Account changes nobody asked for (the primary swap): a Personal Banker notices its own customers' files
//   changing when it next looks at Customer Records; Accounts & Receivables (the Bank Manager if none) judges every
//   change made for no request in Verification. Both put things right or report to security.
// - Security (the IT bot; the Bank Manager bot once no IT bot is left) finds the change in the Master Log, traces it,
//   and looks the address up in Employee Records. A first incident costs the code used (revoked; reissued to its
//   owner when someone else used it). An employee whose suspicion reaches the bot's actAt gets "revoke all access".
// - Its own name on something it did not do (an alert names it: "ITBot took Master Log offline"): its code was
//   used. Handled like any incident, the code being its own.
// - The Firewall: a module taken offline or with its security off is restored; a "revoke all access" on one of the
//   bank's own systems is cancelled (by IT: any it did not start itself); a block it did not place is lifted (IT).
// - A code crack names the credential in every alert: security revokes it and issues its owner a new one.
// - Scam requests (wary bots, Sharp and up): the Bank Manager holds any request that came in with a server alert
//   and asks IT to trace it; a banker holds those, and any request that would make an account primary that is not
//   on file. A trace that shows the request was planted, or no follow-up from the customer by halfway to the
//   deadline (real customers chase what is not done), makes it a scam: archived, and undone if it was already done.
// - At the gentler levels, bots ask a suspect about it first; a bot asked about a change it did not make answers
//   "not me" (and tells security), which clears it.

import { act, addEvidence, botsIn, cancelEvidence, editKey, fresh, isDone, page, screenOf, suspicion, tell } from './botkit';
import type { ChangeWhat, Incident, Task, Turn } from './botkit';
import {
  hear,
  holdText,
  newCodeText,
  notMeText,
  questionText,
  reportLogText,
  reportText,
  revokingText,
  scamText,
  traceAskText,
  traceResultText,
  undoingText,
} from './chatter';
import type { AlertRow, ChangeRow, CustomerRow, PageData, RequestRow } from './perception';
import type { ActionResult, Player, SystemId } from './types';

/** Something decided earlier, done one per turn ahead of the job: an action or a message. */
export type Todo =
  | { key: string; kind: 'ACT'; system: SystemId; module: string; fn: string; params: Record<string, string>; untilOk?: boolean }
  | { key: string; kind: 'TELL'; to: string; text: string };

/** Who handles security: the IT bot, or the Bank Manager bot once no IT bot is left. */
export function enforcer(tn: Turn): Player | undefined {
  return botsIn(tn, 'IT_SPECIALIST')[0] ?? botsIn(tn, 'BANK_MANAGER')[0];
}
const isEnforcer = (tn: Turn): boolean => enforcer(tn)?.id === tn.bot.id;

/** Adds to the bot's list (once per key); `urgent` work goes to the front. */
export function queue(tn: Turn, todo: Todo, urgent = false): void {
  if (isDone(tn, todo.key) || tn.mem.todo.some((x) => x.key === todo.key)) return;
  if (urgent) tn.mem.todo.unshift(todo);
  else tn.mem.todo.push(todo);
}
const tellTodo = (key: string, to: string, text: string): Todo => ({ key, kind: 'TELL', to, text });
const actTodo = (key: string, system: SystemId, module: string, fn: string, params: Record<string, string>, untilOk = false): Todo => ({ key, kind: 'ACT', system, module, fn, params, untilOk });

/** Runs the first thing on the bot's list; false when the list is empty. */
export function runTodo(tn: Turn): boolean {
  const todo = tn.mem.todo.shift();
  if (!todo) return false;
  let r: ActionResult | null;
  if (todo.kind === 'TELL') r = tell(tn, todo.to, todo.text);
  else r = act(tn, todo.system, todo.module, todo.fn, todo.params);
  if (todo.kind === 'ACT' && todo.untilOk && r && !r.ok) tn.mem.todo.push(todo); // e.g. another revocation is counting down
  else tn.mem.done[todo.key] = tn.t;
  return true;
}

const incidentKey = (customerId: string, account: string): string => `${customerId}:${account}`;

type NewIncident = Pick<Incident, 'key' | 'what' | 'by' | 'stolen'> & Partial<Pick<Incident, 'customerId' | 'account' | 'system' | 'module' | 'logId' | 'entryT'>>;

function openIncident(tn: Turn, x: NewIncident): Incident {
  const old = tn.mem.incidents[x.key];
  // A second report of the same thing, or a recent one, adds to it rather than opening another.
  if (old && (!old.closed || tn.t - old.t < 600)) {
    old.by ??= x.by;
    old.stolen ||= x.stolen;
    return old;
  }
  return (tn.mem.incidents[x.key] = { customerId: '', account: '', system: 'CLIENT_DATA', module: 'CUSTOMER_RECORDS', ...x, t: tn.t });
}

/** The module whose code an action used, from how the Master Log words it. */
export function moduleOfLog(message: string): [SystemId, string] {
  if (/offline|online|security (off|on|back on)|blocked|unblocked|revoke all access|revocation|\bR\d+\b/i.test(message)) return ['SECURITY', 'FIREWALL'];
  if (/credential/i.test(message)) return ['SECURITY', 'PERMISSIONS'];
  if (/trace|lockout/i.test(message)) return ['SECURITY', /lockout/i.test(message) ? 'EMPLOYEE_RECORDS' : 'MASTER_LOG'];
  if (/account|primary/i.test(message)) return ['CLIENT_DATA', 'CUSTOMER_RECORDS'];
  if (/archived/i.test(message)) return ['CLIENT_DATA', 'CLIENT_REQUESTS'];
  if (/verified/i.test(message)) return ['CLIENT_DATA', 'VERIFICATION'];
  if (/approved|held|rejected/i.test(message)) return ['TRANSACTIONS', 'AUTHORIZATION'];
  if (/settled|reversed/i.test(message)) return ['TRANSACTIONS', 'SETTLEMENT'];
  if (/risk/i.test(message)) return ['TRANSACTIONS', 'RISK_CHECK'];
  return ['TRANSACTIONS', 'PAYMENT_QUEUE'];
}

// ---- Messages ----

/** Reads new private messages (free: they are on the bot's screen). */
export function readMessages(tn: Turn): void {
  const msgs = screenOf(tn).me.messages;
  for (const m of msgs.slice(tn.mem.readMessages)) {
    if (!m.incoming) continue;
    const heard = hear(m.text);
    if (!heard) continue;
    const sec = enforcer(tn);
    switch (heard.kind) {
      case 'QUESTION': {
        // It knows what it did: if it did not make this change, its code was used.
        if (tn.mem.myEdits[editKey(heard.customerId, heard.account, heard.what)] !== undefined) break;
        queue(tn, tellTodo(`notme:${heard.customerId}:${heard.account}:${m.fromName}`, m.fromName, notMeText(heard.customerId, heard.account)));
        if (sec && sec.name !== m.fromName && sec.id !== tn.bot.id) {
          queue(tn, tellTodo(`notme-report:${heard.customerId}:${heard.account}`, sec.name, reportText(heard.customerId, heard.account, heard.what, 'ME', false)));
        }
        break;
      }
      case 'HOLD':
        if (tn.bot.role === 'PERSONAL_BANKER') holdRequest(tn, heard.requestId, heard.logId);
        break;
      case 'TRACE_RESULT':
        if (tn.bot.role === 'PERSONAL_BANKER' && /planted a scam client request/.test(heard.clue)) scam(tn, heard.requestId, 'a trace shows it was planted from an unregistered server');
        break;
      case 'UNDOING':
        tn.mem.undoNotes.push({ customerId: heard.customerId, account: heard.account, until: tn.t + 180 });
        break;
      case 'TRACE_ASK':
        if (isEnforcer(tn)) tn.mem.traceAsks[heard.logId] ??= { request: heard.requestId, tell: [m.fromName, heard.banker] };
        break;
      case 'REPORT_LOG':
        if (isEnforcer(tn)) {
          const [system, module] = moduleOfLog(heard.message);
          openIncident(tn, { key: `log:${heard.logId}`, what: 'action', by: m.fromName, stolen: true, system, module, logId: heard.logId });
        }
        break;
      case 'REPORT':
      case 'NOT_ME': {
        if (!isEnforcer(tn)) break;
        const inc =
          heard.kind === 'REPORT'
            ? openIncident(tn, { key: incidentKey(heard.customerId, heard.account), customerId: heard.customerId, account: heard.account, what: heard.what, by: heard.stolen ? m.fromName : heard.by, stolen: heard.stolen })
            : openIncident(tn, { key: incidentKey(heard.customerId, heard.account), customerId: heard.customerId, account: heard.account, what: 'made primary', by: m.fromName, stolen: true });
        if (inc.stolen && inc.by) cancelEvidence(tn, `emp:${inc.by}`, inc.key);
        // Learning only now that the code was stolen: its owner gets a new one (step 4 again).
        if (inc.stolen && inc.closed && inc.revoked?.length) inc.closed = false;
        break;
      }
    }
  }
  tn.mem.readMessages = msgs.length;
}

// ---- Personal Banker: its own customers' files ----

/** Who the Customer Records bell said made a change: a name, "ME" (bell on, but silent: its own name), or null. */
function whoChanged(tn: Turn, customerId: string, account: string): string | 'ME' | null {
  const view = screenOf(tn);
  const bell = [...view.notifications].reverse().find((n) => n.module === 'CUSTOMER_RECORDS' && n.text.includes(account) && new RegExp(`\\b${customerId} \\(`).test(n.text));
  if (bell) return /^(.+?) (added account|made|removed account) /.exec(bell.text)?.[1] ?? null;
  return view.watching.includes('CLIENT_DATA.CUSTOMER_RECORDS') ? 'ME' : null;
}

/** Called when a Personal Banker opens Customer Records: compares its customers with how it last saw them. */
export function bankerSawCustomers(tn: Turn, rows: CustomerRow[]): void {

  const sec = enforcer(tn);
  for (const c of rows.filter((x) => x.banker === tn.bot.name)) {
    const now = { primary: c.primary.account, accounts: [c.primary.account, ...c.others.map((a) => a.account)], t: tn.t };
    const before = tn.mem.files[c.id];
    tn.mem.files[c.id] = now;
    if (!before) continue;
    // Its own changes since it last looked are not news.
    const recent = (customerId: string, account: string, what: ChangeWhat): boolean => (tn.mem.myEdits[editKey(customerId, account, what)] ?? -Infinity) >= before.t - 1;
    const added = now.accounts.filter((a) => !before.accounts.includes(a) && !recent(c.id, a, 'added'));
    const removed = before.accounts.filter((a) => !now.accounts.includes(a) && !recent(c.id, a, 'removed'));
    const swapped = now.primary !== before.primary && !recent(c.id, now.primary, 'made primary') ? now.primary : null;
    const changes: [string, ChangeWhat][] = [
      ...(swapped ? ([[swapped, 'made primary']] as [string, ChangeWhat][]) : []),
      ...added.filter((a) => a !== swapped).map((a): [string, ChangeWhat] => [a, 'added']),
      ...removed.map((a): [string, ChangeWhat] => [a, 'removed']),
    ];
    for (const [account, what] of changes) {
      const by = whoChanged(tn, c.id, account);
      const key = incidentKey(c.id, account);
      // Put it back: the old primary, then take the stranger's account off (or put a removed one back).
      if (what === 'made primary' && now.accounts.includes(before.primary)) {
        queue(tn, actTodo(`fix:${key}:primary`, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'SET_PRIMARY', { customerId: c.id, account: before.primary.slice(4) }));
      }
      if ((what === 'made primary' && !before.accounts.includes(account)) || what === 'added') {
        queue(tn, actTodo(`fix:${key}:remove`, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'REMOVE_ACCOUNT', { customerId: c.id, account: account.slice(4) }));
      }
      if (what === 'removed') {
        queue(tn, actTodo(`fix:${key}:add`, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: c.id, account: account.slice(4), makePrimary: 'NO' }));
      }
      if (sec) queue(tn, tellTodo(`report:${key}`, sec.name, reportText(c.id, account, what, by, true)));
      if (tn.mem.stats.warns && by && by !== 'ME' && by !== tn.bot.name) queue(tn, tellTodo(`ask:${key}`, by, questionText(c.id, account, what)));
    }
  }
}

// ---- Personal Banker: scam requests (wary bots) ----

/**
 * Holds a request as a possible scam. If the bot already acted on it, it undoes what it did (rejects the payment, puts
 * the file back), so that a real customer, seeing it not done, follows up: the test that tells real from scam.
 */
export function holdRequest(tn: Turn, requestId: string, logId: string | null): void {
  if (tn.mem.held[requestId]) return;
  tn.mem.held[requestId] = { t: tn.t, logId };
  const did = tn.mem.answered[requestId];
  if (did?.txId) queue(tn, actTodo(`reject:${did.txId}`, 'TRANSACTIONS', 'AUTHORIZATION', 'REJECT', { txId: did.txId, reason: 'Possible scam: rejected until the customer confirms' }), true);
  if (did?.customerId && did.account) undoChange(tn, requestId);
}

function undoChange(tn: Turn, requestId: string): void {
  const did = tn.mem.answered[requestId];
  if (!did?.customerId || !did.account || isDone(tn, `undo:${requestId}`)) return;
  tn.mem.done[`undo:${requestId}`] = tn.t;
  const people = [botsIn(tn, 'ACCOUNTS_RECEIVABLES')[0], botsIn(tn, 'BANK_MANAGER')[0]].filter(Boolean) as Player[];
  for (const p of people) queue(tn, tellTodo(`undoing:${requestId}:${p.id}`, p.name, undoingText(did.customerId, did.account, requestId)), true);
  if (did.madePrimary && did.prevPrimary) {
    queue(tn, actTodo(`undo:${requestId}:primary`, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'SET_PRIMARY', { customerId: did.customerId, account: did.prevPrimary.slice(4) }));
  }
  queue(tn, actTodo(`undo:${requestId}:remove`, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'REMOVE_ACCOUNT', { customerId: did.customerId, account: did.account.slice(4) }));
}

/** A request the bot now takes for a scam: archived (if still open), and undone if it was done. */
function scam(tn: Turn, requestId: string, why: string): void {
  if (isDone(tn, `scam:${requestId}`)) return;
  tn.mem.done[`scam:${requestId}`] = tn.t;
  tn.mem.held[requestId] ??= { t: tn.t, logId: null };
  queue(tn, actTodo(`archive:${requestId}`, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId, reason: `Scam: ${why}` }), true);
  const did = tn.mem.answered[requestId];
  if (did?.txId) queue(tn, actTodo(`reject:${did.txId}`, 'TRANSACTIONS', 'AUTHORIZATION', 'REJECT', { txId: did.txId, reason: 'Scam request' }), true);
  if (did?.customerId) undoChange(tn, requestId);
  const sec = enforcer(tn);
  if (sec) queue(tn, tellTodo(`scam-note:${requestId}`, sec.name, scamText(requestId, why)));
}

/**
 * A held request, each time the banker looks at it: a follow-up means a real customer is waiting (released: it
 * acts on it); none by halfway to the deadline (and a little more) means nobody real is (a scam). Null: keep waiting.
 */
/**
 * Held requests no longer open (done before the hold came, then undone): a real customer chases what is not done, and
 * the request reopens with their follow-up; if nobody comes, it was a scam.
 */
export function settleOldHolds(tn: Turn, openIds: string[]): void {
  for (const [id, h] of Object.entries(tn.mem.held)) {
    if (openIds.includes(id) || isDone(tn, `scam:${id}`)) continue;
    noFollowUp(tn, id, h.t + 90);
  }
}

export function heldVerdict(tn: Turn, r: RequestRow): 'RELEASE' | 'WAIT' | 'SCAM' {
  if (r.followUps.length) {
    delete tn.mem.held[r.id];
    return 'RELEASE';
  }
  const window = r.urgent ? tn.s.config.urgentDeadlineSec : tn.s.config.requestDeadlineSec;
  return noFollowUp(tn, r.id, r.t + window / 2 + 5) ? 'SCAM' : 'WAIT';
}

/**
 * After `checkAt` a real customer would have chased: the bot decides only from a Client Requests page it opened after
 * that (an older one cannot show the follow-up), and looks again when the time comes.
 */
function noFollowUp(tn: Turn, requestId: string, checkAt: number): boolean {
  if (tn.t < checkAt) return false;
  if ((tn.mem.pages.REQUESTS?.t ?? -Infinity) < checkAt) {
    tn.mem.due.REQUESTS = Math.min(tn.mem.due.REQUESTS ?? Infinity, tn.t);
    return false;
  }
  scam(tn, requestId, 'no customer followed it up');
  return true;
}

// ---- Accounts & Receivables and the Bank Manager: changes made for no request ----

const WHAT_OF: Record<ChangeRow['action'], ChangeWhat> = { ADD_ACCOUNT: 'added', SET_PRIMARY: 'made primary', REMOVE_ACCOUNT: 'removed' };

/** Is this change undoing one the bot already found suspect, or one a colleague said it is undoing? */
function undoes(tn: Turn, ch: ChangeRow, suspects: ChangeRow[]): boolean {
  if (tn.mem.undoNotes.some((n) => n.customerId === ch.customerId && n.until >= tn.t && (ch.account === n.account || ch.action === 'SET_PRIMARY'))) return true;
  return suspects.some(
    (x) =>
      x.customerId === ch.customerId &&
      ((ch.action === 'SET_PRIMARY' && x.action === 'SET_PRIMARY' && x.previousPrimary === ch.account) ||
        (ch.action === 'REMOVE_ACCOUNT' && x.action === 'ADD_ACCOUNT' && x.account === ch.account) ||
        (ch.action === 'ADD_ACCOUNT' && x.action === 'REMOVE_ACCOUNT' && x.account === ch.account)),
  );
}

/** Called when a bot opens Verification: judges each change made for no request, oldest first. */
export function judgeChanges(tn: Turn, rows: ChangeRow[]): void {
  const sec = enforcer(tn);
  const suspects = tn.mem.suspects;
  for (const ch of [...rows].sort((a, b) => a.t - b.t)) {
    if (ch.verified || ch.requestId || tn.mem.judged[ch.id]) continue;
    if (undoes(tn, ch, suspects)) {
      tn.mem.judged[ch.id] = 'UNDO';
      queue(tn, actTodo(`verify:${ch.id}`, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: ch.id }));
      continue;
    }
    tn.mem.judged[ch.id] = 'SUSPECT';
    suspects.push(ch);
    const key = incidentKey(ch.customerId, ch.account);
    const what = WHAT_OF[ch.action];
    if (sec && sec.id !== tn.bot.id) queue(tn, tellTodo(`report:${key}`, sec.name, reportText(ch.customerId, ch.account, what, ch.by === tn.bot.name ? 'ME' : ch.by, false)));
    if (sec?.id === tn.bot.id) openIncident(tn, { key, customerId: ch.customerId, account: ch.account, what, by: ch.by, stolen: false });
    if (tn.mem.stats.warns && ch.by !== tn.bot.name) queue(tn, tellTodo(`ask:${key}`, ch.by, questionText(ch.customerId, ch.account, what)));
  }
}

// ---- Alerts and the Firewall (security, and the Bank Manager) ----

/** Called when IT or the Bank Manager opens the Master Log's alerts: each new alert, once. */
export function sawAlerts(tn: Turn, rows: AlertRow[]): void {
  const sec = enforcer(tn);
  for (const a of rows) {
    if (tn.mem.seenAlerts.includes(a.id)) continue;
    tn.mem.seenAlerts.push(a.id);
    if (a.logId && tn.mem.mine.includes(a.logId)) continue; // its own doing
    // Its own name on a security action it did not take: its code was used.
    const who = /security activity: (\S+) (.*)$/.exec(a.message);
    if (who && who[1] === tn.bot.name && a.logId) {
      if (isEnforcer(tn)) {
        const [system, module] = moduleOfLog(who[2]);
        openIncident(tn, { key: `log:${a.logId}`, what: 'action', by: tn.bot.name, stolen: true, system, module, logId: a.logId, entryT: a.t });
      } else if (sec) queue(tn, tellTodo(`reportlog:${a.logId}`, sec.name, reportLogText(a.logId, `${who[1]} ${who[2]}`)), true);
    }
    // Anything done to security sends it to the Firewall to check; a revocation starting is stopped at once.
    if (a.kind.startsWith('SECURITY_')) tn.mem.due.FIREWALL = Math.min(tn.mem.due.FIREWALL ?? Infinity, tn.t);
    const rev = /started (R\d+): revoke all access for (\S+) in/.exec(a.message);
    if (rev && mustCancel(tn, rev[2])) queue(tn, actTodo(`cancel:${rev[1]}`, 'SECURITY', 'FIREWALL', 'CANCEL_REVOCATION', { revocationId: rev[1] }), true);
    const crack = /^Brute-force on (C\d+)/.exec(a.message);
    if (crack && isEnforcer(tn) && !tn.mem.pendingCracks.includes(crack[1]) && !isDone(tn, `crack:${crack[1]}`)) tn.mem.pendingCracks.push(crack[1]);
    if (a.kind === 'UNAUTHORIZED_ACTION' && a.logId && tn.bot.role === 'BANK_MANAGER' && tn.mem.stats.wary) tn.mem.pendingHostAlerts.push({ logId: a.logId, t: a.t });
  }
  if (tn.mem.seenAlerts.length > 400) tn.mem.seenAlerts.splice(0, tn.mem.seenAlerts.length - 400);
}

/** Should this revocation be stopped? The bank's own systems never; security also stops any it did not start itself. */
function mustCancel(tn: Turn, address: string): boolean {
  const systems = new Set(screenOf(tn).systems.map((x) => x.address));
  return systems.has(address) || (isEnforcer(tn) && !tn.mem.myFirewall.includes(address));
}

/**
 * A pop-up, read as it arrives (a person reads the pop-up too): a "revoke all access" starting is cancelled
 * straight from it, without opening the Firewall first. Countdowns are short.
 */
export function sawNotice(tn: Turn, text: string): void {
  const m = /started (R\d+): revoke all access for (\S+) in/.exec(text);
  if (m && mustCancel(tn, m[2])) {
    queue(tn, actTodo(`cancel:${m[1]}`, 'SECURITY', 'FIREWALL', 'CANCEL_REVOCATION', { revocationId: m[1] }), true);
  }
}

/** Called when a bot with Firewall access opens its status: puts back what someone switched off. */
export function sawFirewall(tn: Turn, data: Extract<PageData, { page: 'FIREWALL' }>): void {
  const bucket = Math.floor(tn.t / 20);
  for (const m of data.modules) {
    const target = `${m.system}.${m.module}`;
    if (!m.online) queue(tn, actTodo(`online:${target}:${bucket}`, 'SECURITY', 'FIREWALL', 'SET_MODULE_STATUS', { target, status: 'ONLINE' }), true);
    if (!m.securityOn) queue(tn, actTodo(`secure:${target}:${bucket}`, 'SECURITY', 'FIREWALL', 'SET_SECURITY', { target, security: 'ON' }), true);
  }
  for (const r of data.revocations) {
    if (mustCancel(tn, r.address)) {
      queue(tn, actTodo(`cancel:${r.id}`, 'SECURITY', 'FIREWALL', 'CANCEL_REVOCATION', { revocationId: r.id }), true);
    }
  }
  if (isEnforcer(tn)) {
    for (const b of data.blocks) {
      if (!tn.mem.myFirewall.includes(b.address)) queue(tn, actTodo(`unblock:${b.address}:${bucket}`, 'SECURITY', 'FIREWALL', 'UNBLOCK_ADDRESS', { address: b.address }), true);
    }
  }
}

/** The Bank Manager (wary): requests that arrived with a server alert are held, and IT is asked to trace it. */
export function managerTasks(tn: Turn): Task[] {
  if (!tn.mem.pendingHostAlerts.length) return [];
  const oldest = Math.min(...tn.mem.pendingHostAlerts.map((x) => x.t));
  if (!tn.mem.pages.ALL_REQUESTS || tn.mem.pages.ALL_REQUESTS.t < oldest + 1) return [{ needs: 'ALL_REQUESTS' }];
  const rows = page(tn, 'ALL_REQUESTS', 'REQUESTS')?.rows ?? [];
  const sec = enforcer(tn);
  for (const al of tn.mem.pendingHostAlerts) {
    for (const r of rows.filter((x) => Math.abs(x.t - al.t) <= 2 && x.status !== 'EXPIRED' && x.to !== 'nobody')) {
      queue(tn, tellTodo(`holdmsg:${r.id}`, r.to, holdText(r.id, al.logId)), true);
      if (sec && sec.id !== tn.bot.id) queue(tn, tellTodo(`traceask:${al.logId}`, sec.name, traceAskText(al.logId, r.id, r.to)), true);
      if (sec?.id === tn.bot.id) tn.mem.traceAsks[al.logId] ??= { request: r.id, tell: [r.to] };
    }
  }
  tn.mem.pendingHostAlerts = [];
  return [];
}

// ---- Security: trace, look up, act ----

const custPattern = (customerId: string): RegExp => new RegExp(`\\b${customerId}\\b`);

/** Security's open traces (incidents, and colleagues' asks) come before routine ones. */
export const tracesWaiting = (tn: Turn): boolean =>
  Object.values(tn.mem.incidents).some((x) => !x.closed && x.logId && x.tracedIp === undefined && !x.traceFailed) ||
  Object.keys(tn.mem.traceAsks).some((id) => !isDone(tn, `asked:${id}`));

export function securityTasks(tn: Turn): Task[] {
  if (!isEnforcer(tn)) return [];
  const out: Task[] = [];
  const c = tn.s.config;
  const canTrace = tn.t - tn.mem.lastTraceAt >= c.traceDelaySec + c.traceCooldownSec; // a bot's trace is instant for now
  // 0. Code cracks: the alert names the credential; revoke it and give its owner a new one.
  if (tn.mem.pendingCracks.length) {
    if (!fresh(tn, 'CREDENTIALS', 20)) return [{ needs: 'CREDENTIALS' }];
    for (const id of tn.mem.pendingCracks) {
      tn.mem.done[`crack:${id}`] = tn.t;
      const cr = page(tn, 'CREDENTIALS', 'CREDENTIALS')!.rows.find((x) => x.id === id && x.status === 'ACTIVE');
      if (!cr) continue;
      queue(tn, actTodo(`revoke:${id}`, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: id }), true);
      reissue(tn, cr.owner, cr.system, cr.module, cr.permission, id);
    }
    tn.mem.pendingCracks = [];
  }
  // 0b. Traces colleagues asked for (a request that came in with a server alert).
  for (const [logId, ask] of Object.entries(tn.mem.traceAsks)) {
    if (isDone(tn, `asked:${logId}`)) continue;
    if (!canTrace) break;
    out.push({
      key: `asked:${logId}`,
      run: () => {
        tn.mem.lastTraceAt = tn.t;
        tn.mem.traced.push(logId);
        const r = act(tn, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId });
        const clue = r?.ok ? r.message.replace(/^Trace L\d+: /, '') : `could not trace it (${r?.message ?? 'no access'})`;
        for (const name of ask.tell) queue(tn, tellTodo(`traceresult:${logId}:${name}`, name, traceResultText(logId, ask.request, clue)), true);
        return r;
      },
    });
    return out;
  }
  for (const inc of Object.values(tn.mem.incidents)) {
    if (inc.closed) continue;
    // 1. Find the change in the Master Log (player activity), opened after the incident came in.
    if (inc.logId === undefined) {
      if (!tn.mem.pages.ACTIVITY || tn.mem.pages.ACTIVITY.t < inc.t) return [{ needs: 'ACTIVITY' }];
      const rows = page(tn, 'ACTIVITY', 'LOG')?.rows ?? [];
      const hit = rows.find(
        (e) =>
          custPattern(inc.customerId).test(e.message) &&
          e.message.includes(inc.account) &&
          !/removed account/.test(e.message) === (inc.what !== 'removed') &&
          !/ for REQ-\d+/.test(e.message) &&
          !tn.mem.mine.includes(e.id) &&
          e.by !== null,
      );
      inc.logId = hit?.id ?? null;
      inc.entryT = hit?.t;
      if (hit) inc.by ??= hit.by;
      if (hit && inc.stolen && inc.by) cancelEvidence(tn, `emp:${inc.by}`, inc.key);
    }
    // 2. Trace it while it is young enough.
    if (inc.logId && inc.tracedIp === undefined && !inc.traceFailed) {
      const at = inc.entryT ?? page(tn, 'ACTIVITY', 'LOG')?.rows.find((e) => e.id === inc.logId)?.t;
      if (at === undefined || tn.t - at > c.traceMaxAgeSec - 3) inc.traceFailed = true;
      else if (canTrace) {
        out.push({ key: `trace:${inc.logId}:${tn.t}`, run: () => traceIncident(tn, inc) });
        continue;
      } else continue; // wait for the trace engine
    }
    // 3. Who sits at the address it traced to (once).
    if (inc.weighed) {
      // already done
    } else if (inc.tracedIp) {
      if (!fresh(tn, 'EMPLOYEES', 60)) return [{ needs: 'EMPLOYEES' }];
      const at = page(tn, 'EMPLOYEES', 'EMPLOYEES')!.rows.find((e) => e.ip === inc.tracedIp);
      const what = inc.customerId ? `${inc.customerId}'s accounts` : `${inc.logId}`;
      if (at && at.name !== tn.bot.name) {
        addEvidence(tn, `emp:${at.name}`, 2, `a trace of ${inc.logId} (${what}) came from their workstation`, inc.key);
        if (inc.by && at.name !== inc.by) {
          inc.stolen = true;
          cancelEvidence(tn, `emp:${inc.by}`, inc.key);
        }
      } else if (!at) {
        addEvidence(tn, `ip:${inc.tracedIp}`, 2, `a trace of ${inc.logId} came from an address on nobody's workstation`, inc.key);
        tn.mem.myFirewall.push(inc.tracedIp);
        queue(tn, actTodo(`block:${inc.tracedIp}`, 'SECURITY', 'FIREWALL', 'BLOCK_ADDRESS', { address: inc.tracedIp }));
      }
    } else if (inc.by && !inc.stolen) {
      // No trace: the name on the records carries it (a strong incident).
      addEvidence(tn, `emp:${inc.by}`, 0.8, `${inc.customerId}'s accounts were changed under their name for no request`, inc.key);
    }
    inc.weighed = true;
    // 4. The code used is spent: revoked, and reissued to its owner once it is known someone else used it.
    if (inc.by) {
      if (!inc.revoked) {
        if (!fresh(tn, 'CREDENTIALS', 30)) return [{ needs: 'CREDENTIALS' }];
        inc.revoked = page(tn, 'CREDENTIALS', 'CREDENTIALS')!
          .rows.filter((cr) => cr.owner === inc.by && cr.status === 'ACTIVE' && cr.system === inc.system && cr.permission === 'WRITE' && (!cr.module || cr.module === inc.module))
          .map((cr) => ({ id: cr.id, module: cr.module }));
        for (const cr of inc.revoked) queue(tn, actTodo(`revoke:${cr.id}`, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: cr.id }), inc.by === tn.bot.name);
      }
      if (inc.stolen) for (const cr of inc.revoked) reissue(tn, inc.by, inc.system, cr.module, 'WRITE', cr.id);
    }
    inc.closed = true;
  }
  // 5. Anyone suspicious enough loses all access.
  for (const e of new Set(tn.mem.evidence.map((x) => x.subject))) {
    if (!e.startsWith('emp:') || isDone(tn, `revokeall:${e}`) || tn.mem.todo.some((x) => x.key === `revokeall:${e}`)) continue;
    const name = e.slice(4);
    if (name === tn.bot.name || suspicion(tn, e) < tn.mem.stats.actAt) continue;
    if (!fresh(tn, 'EMPLOYEES', 60)) return [{ needs: 'EMPLOYEES' }];
    const row = page(tn, 'EMPLOYEES', 'EMPLOYEES')!.rows.find((x) => x.name === name);
    if (!row || row.terminated) continue;
    tn.mem.myFirewall.push(row.ip);
    queue(tn, actTodo(`revokeall:${e}`, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: row.ip }, true));
    const why = tn.mem.evidence.filter((x) => x.subject === e).at(-1)!.why;
    queue(tn, tellTodo(`revoking:${e}`, name, revokingText(row.ip, name, tn.s.config.revokeCountdownSec, why)));
  }
  return out;
}

/** Issues an employee a new credential like one that was revoked, and tells them (unless it is the bot's own). */
function reissue(tn: Turn, ownerName: string, system: string, module: string | null, permission: string, oldId: string): void {
  const owner = tn.s.playerOrder.find((id) => tn.s.players[id].name === ownerName);
  if (!owner) return;
  queue(tn, actTodo(`reissue:${oldId}`, 'SECURITY', 'PERMISSIONS', 'CREATE_CREDENTIAL', { owner, scope: `${system}.${module ?? '*'}`, permission })); // after the revoke
  if (ownerName !== tn.bot.name) queue(tn, tellTodo(`newcode:${oldId}`, ownerName, newCodeText(oldId)));
}

function traceIncident(tn: Turn, inc: Incident): ActionResult | null {
  tn.mem.lastTraceAt = tn.t;
  tn.mem.traced.push(inc.logId!);
  const r = act(tn, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: inc.logId! });
  const data = r?.data as PageData | undefined;
  if (r?.ok && data?.page === 'TRACE') inc.tracedIp = data.clue.ip ?? null;
  else inc.traceFailed = true;
  if (inc.tracedIp === null) inc.traceFailed = true;
  return r;
}
