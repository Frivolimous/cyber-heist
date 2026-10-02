// The game screen. The yellow bar at the top is sandbox tooling; everything below it is the player screen
// exactly as one player sees it. It runs three ways (see mode.ts): the offline sandbox (this tab holds the
// game), the online sandbox host (the same, and other tabs and devices play along through the database),
// and a remote screen (one seat, whose view and actions go through the host).

import './style.css';
import {
  advanceState,
  applyAction,
  BOT_LEVELS,
  createGame,
  CREDENTIAL_SHARING_ENABLED,
  findFn,
  findModule,
  findSystem,
  fmtClock,
  getPlayerView,
  grantMasterAccess,
  HOST_KITS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  money,
  ROLE_ORDER,
  ROLES,
  SYSTEMS,
  TERMINATED_TEXT,
  WATCHABLE,
} from '../engine';
import type { Action, ActionResult, Countdown, EndMember, EndTeam, GameState, Pace, PlayerId, PlayerView, ScenarioKind, StageAutomation, SystemId, TutorialView, WorkstationView } from '../engine';
import type { ArPart } from '../engine/tutorial';
import { downloadState } from './dump';
import { mountConsole } from './console';
import { mountSettings } from './settings';
import { boot } from './mode';
import { HostSession, startTicker } from '../net/host';
import type { HostSnapshot, WatchCopy } from '../net/host';
import { createRoom } from '../net/room';

const NAMES = ['Jeremy', 'Sarah', 'Mike', 'David', 'Lisa', 'Anna', 'Omar', 'Priya', 'Chen', 'Rosa', 'Tariq', 'Mei', 'Hugo', 'Zara', 'Ivan', 'Nina', 'Kofi', 'Elena', 'Raj', 'Sofia'];
/** Sandbox seats p0..p(n-1); past the name list, seats are numbered. */
const rosterOf = (n: number): { id: string; name: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: NAMES[i] ?? `Player ${i + 1}` }));
let playerCount = 10;
/** A dev test scenario for the next New game (?scenario=duo or ?scenario=solo), or null for a normal table. */
const urlScenario = new URLSearchParams(location.search).get('scenario')?.toUpperCase();
let scenario: ScenarioKind | null = urlScenario === 'DUO' || urlScenario === 'SOLO' ? urlScenario : null;
const SCENARIO_LABEL: Record<ScenarioKind, string> = { DUO: '2-player test', SOLO: 'solo Thief test' };
/** Custom settings for New game: kept in one element that renderDev re-attaches, so it survives redraws. */
const settingsEl = document.createElement('span');
const customSettings = mountSettings(settingsEl);
const MASTER_SEAT = 'p0'; // this seat gets whole-system credentials for every system
const TICK_MS = 250;
const TASKBAR_H = 44;
const TERMINAL_LINES = 100;

type Line = { cls: string; text: string };
type Route =
  | { kind: 'system'; system: SystemId }
  | { kind: 'module'; system: SystemId; module: string }
  | { kind: 'workstation'; playerId: PlayerId; address: string }
  | { kind: 'proxy'; address: string; relaying: boolean }
  | { kind: 'noroute'; address: string; message: string };

interface Win {
  id: number;
  kind: 'browser' | 'personal';
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  min: boolean;
  max: boolean;
  history: Route[];
  idx: number;
  addr: string; // address bar text (may be a draft the player is typing)
  sized: boolean; // the player resized it by hand, so stop auto-fitting
  form: Record<string, string>;
  out: Line[]; // terminal: kept while the window stays on one system, last 100 lines
  termSystem: SystemId | null; // the system the terminal is logged in to
  notice: Line[]; // one-off notices on workstation pages
  scrollEnd?: boolean; // a command just ran: the next render scrolls the page and its terminal to the bottom
  liveEnd?: number; // live monitor: w.out length right after its last block (so the next refresh can replace it)
  unsnap?: { w: number; h: number }; // snapped to half the desk: its size before, given back when dragged away
  termH?: number; // module pages: the terminal's height, once dragged by the splitter above it (px)
}

// ---- Sandbox state ----------------------------------------------------------------
const MODE = boot.current;
/** A remote screen: everything comes from the host. */
const client = MODE.kind === 'client' ? MODE.session : null;
/**
 * DEV ONLY (remove before any public release): the watcher link. This tab holds a read-only copy of a real
 * game that its host refreshes every few seconds; it writes nothing, so no player can see that it exists.
 */
const watcher = MODE.kind === 'watch' ? MODE : null;
/** Online sandbox: this tab runs the game for the other tabs and devices too. */
let hostSession: HostSession | null = null;
let lastView: PlayerView | null = null;
let game: GameState; // offline and host only
let vNow = 0; // virtual "now" in ms, advanced by the timer
let speed = 1; // 0 = paused
let selected: PlayerId = MASTER_SEAT;
type Tab = 'profile' | 'codes' | 'activity' | 'messages';
let tab: Tab = 'profile';
let god = false;
let truthOpen = false;
let endHidden = false; // the end screen was put away to look at the desk
let tickCount = 0;
let desks: Record<PlayerId, Win[]> = {}; // each seat keeps its own open windows
const deskShown = new Set<PlayerId>(); // seats whose desk has been on screen this game (it opened their workstation)
let winSeq = 0;
let zSeq = 10;
const seenMessages: Record<PlayerId, number> = {};

const app = document.getElementById('app') as HTMLElement;
app.innerHTML = `
  <div class="shell">
    <section id="dev" class="dev" aria-label="Sandbox controls"></section>
    <section id="scenario" class="dev scenario" aria-label="Test scenario" hidden></section>
    <section class="screen" aria-label="Player screen">
      <header id="status" class="status"></header>
      <div class="screen-body">
        <nav id="rail" aria-label="Employees"></nav>
        <div id="desk" class="desk">
          <div id="icons" class="icons"></div>
          <div id="snap" class="snap-preview" hidden></div>
          <div id="wins"></div>
          <footer id="taskbar" class="taskbar"></footer>
          <div id="tutorial"></div>
          <div id="toasts" class="toasts" aria-live="polite"></div>
          <div id="console" class="console" hidden></div>
          <div id="endscreen" class="endscreen" hidden></div>
        </div>
      </div>
    </section>
    <aside id="truth" class="dev truth" aria-label="Ground truth" hidden></aside>
  </div>`;
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const slug = (id: string): string => id.toLowerCase().replace(/_/g, '-');
const view = (): PlayerView => {
  if (client) return (lastView = client.view ?? lastView)!;
  return getPlayerView(game, selected);
};

/**
 * The button just pressed, if any. A remote screen marks it busy while its action travels to the host and
 * back (~0.2s), so nobody presses twice or wonders whether it worked. Cleared once the click has been handled.
 */
let pressed: HTMLButtonElement | null = null;
function notePressed(b: HTMLButtonElement | null | undefined): void {
  if (!b || !client) return;
  pressed = b;
  setTimeout(() => (pressed = null), 0);
}

/** Plays an action as the selected seat: here, or through the host when this is a remote screen. */
async function act(action: Action): Promise<ActionResult> {
  if (client) {
    const b = pressed;
    pressed = null;
    b?.classList.add('busy');
    if (b) b.disabled = true;
    try {
      return await client.send(action);
    } finally {
      // Usually the window has been redrawn by now and the button is gone; if not, give it back.
      b?.classList.remove('busy');
      if (b) b.disabled = false;
    }
  }
  if (watcher) {
    // Reading is allowed on the local copy, and the result is thrown away; nothing reaches the real game.
    const reads = action.type === 'CONNECT' || (action.type === 'EXECUTE' && findFn(action.system, action.module, action.fn)?.permission === 'READ');
    return reads ? applyAction(game, action, vNow).result : { ok: false, message: 'Watching: read-only.' };
  }
  const r = applyAction(game, action, vNow);
  game = r.state;
  hostSession?.publish();
  return r.result;
}

/** The console (the ` key): every function of every loaded system on one command line. */
const terminal = mountConsole({ host: $('console'), view, seat: () => selected, act, refresh });

const ICONS: Record<SystemId, string> = {
  SECURITY: '<path d="M24 5 8 11v11c0 10 7 17 16 21 9-4 16-11 16-21V11z"/><path d="m17 24 5 5 9-10"/>',
  CLIENT_DATA: '<rect x="6" y="10" width="36" height="28" rx="3"/><circle cx="18" cy="22" r="4"/><path d="M11 32c1-4 4-6 7-6s6 2 7 6M29 19h8M29 25h8M29 31h5"/>',
  TRANSACTIONS: '<path d="M8 17h28l-7-7M40 31H12l7 7"/>',
  WORKSTATION: '<rect x="6" y="9" width="36" height="24" rx="2"/><path d="M18 39h12M24 33v6"/>',
  HIDDEN_HOST: '<path d="M8 30c4-2 10-3 16-3s12 1 16 3M13 28l3-16c1-3 4-3 6-2l2 1 2-1c2-1 5-1 6 2l3 16"/><circle cx="18" cy="36" r="3"/><circle cx="30" cy="36" r="3"/><path d="M21 36h6"/>',
};
const icon = (id: SystemId, size = 48): string =>
  `<svg viewBox="0 0 48 48" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;

// ---- Game lifecycle ----------------------------------------------------------------
function newGame(seed: number): void {
  vNow = Date.now();
  const roster = rosterOf(scenario === 'SOLO' ? 1 : scenario === 'DUO' ? 2 : playerCount);
  // Custom settings with a problem are left out (the panel lists them); the rest apply.
  game = createGame({ seed, players: roster, now: vNow, config: customSettings().config, ...(scenario ? { scenario } : {}) });
  if (!scenario) grantMasterAccess(game, MASTER_SEAT); // the test scenarios are played with real access only
  desks = {};
  deskShown.clear();
  endHidden = false;
  resetTutorials(game.id);
  for (const id of game.playerOrder) {
    seenMessages[id] = 0;
    seenNotices[id] = 0;
  }
  if (!game.players[selected]) selected = MASTER_SEAT;
  tab = 'profile';
  renderAll();
  void hostSession?.reset();
}

/** Online sandbox host after a reload: carry on with the saved game. */
function resumeGame(snap: HostSnapshot): void {
  game = snap.state;
  vNow = snap.vNow;
  speed = snap.speed;
  scenario = game.scenario?.kind ?? null;
  if (!scenario) playerCount = game.playerOrder.filter((id) => !game.players[id].fake).length;
  for (const id of game.playerOrder) seenNotices[id] = Number.MAX_SAFE_INTEGER; // no backlog of pop-ups
  renderAll();
}

/** Offline sandbox -> online sandbox: open a room and serve this game to other tabs and devices. */
async function goOnline(): Promise<void> {
  const { openDb } = await import('../net/config');
  const db = await openDb();
  const code = await createRoom(db, true);
  serve(db, code);
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('host', code);
  if (db.kind === 'local') url.searchParams.set('net', 'local');
  history.replaceState(null, '', url);
  renderDev();
}

function serve(db: import('../net/db').Db, code: string): void {
  hostSession = new HostSession(db, code, { apply: (a) => {
    const r = applyAction(game, a, vNow);
    game = r.state;
    refresh();
    return r.result;
  }, state: () => game }, true);
  hostSession.start(() => {
    renderDev();
    renderRail();
  });
  void hostSession.setPaused(speed === 0);
}

/** The link that opens a tester screen on this online sandbox. */
function testerLink(): string {
  if (!hostSession) return '';
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('test', hostSession.code);
  if (hostSession.db.kind === 'local') url.searchParams.set('net', 'local');
  return url.toString();
}

// ---- Sandbox controls (not part of the game) ----------------------------------------
function renderDev(): void {
  if (client) return renderTesterBar();
  if (watcher) return renderWatchBar();
  const online = hostSession?.remoteSeats() ?? {};
  const btn = (act: string, label: string, on: boolean): string =>
    `<button data-act="${act}" class="${on ? 'on' : ''}">${label}</button>`;
  $('dev').innerHTML = `
    <span class="dev-tag">Sandbox</span>
    <label>Viewing as <select data-f="seat">${game.playerOrder
      .filter((id) => !game.players[id].fake) // planted users are records, not seats you can control
      .map((id) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(game.players[id].name)}${game.players[id].bot ? ' (bot)' : id === MASTER_SEAT && !game.scenario ? ' (master access)' : ''}${online[id] ? ` · ${online[id]} online` : ''}</option>`)
      .join('')}</select></label>
    <span class="grp">${btn('speed:0', 'Pause', speed === 0)}${btn('speed:0.5', '0.5x', speed === 0.5)}${btn('speed:1', '1x', speed === 1)}${btn('speed:5', '5x', speed === 5)}${btn('speed:20', '20x', speed === 20)}<button data-act="skip:30">+30s</button></span>
    <label><input type="checkbox" data-f="god" ${god ? 'checked' : ''}> show allegiances</label>
    <label>table <select data-f="scenario" title="Applies on New game">${[['', 'normal'], ['DUO', SCENARIO_LABEL.DUO], ['SOLO', SCENARIO_LABEL.SOLO]]
      .map(([v, l]) => `<option value="${v}" ${(scenario ?? '') === v ? 'selected' : ''}>${l}</option>`)
      .join('')}</select></label>
    <label>players <input type="number" data-f="count" min="${MIN_PLAYERS}" max="${MAX_PLAYERS}" value="${playerCount}" title="Applies on New game" ${scenario ? 'disabled' : ''}></label>
    <label>seed <input type="number" data-f="seed" value="${game.seed >>> 0}"></label>
    <button data-act="newgame">New game</button>
    <button data-act="truth" class="${truthOpen ? 'on' : ''}">Ground truth</button>
    <button data-act="dump" title="Save the whole game state, config included, as JSON">Download state</button>
    ${hostSession
      ? `<span class="grp online">Online: room <b>${esc(hostSession.code)}</b>${hostSession.db.kind === 'local' ? ' (this browser only)' : ''} <a href="${esc(testerLink())}" target="_blank" rel="noopener">Open a tester screen</a></span>`
      : '<button data-act="online" title="Let other tabs and devices play seats of this game">Go online</button>'}
    <span class="dev-note">Everything below this bar is the game.</span>`;
  $('dev').querySelector('[data-act="newgame"]')!.after(settingsEl);
}

/** DEV ONLY: the watcher's bar. Any seat's screen (read only), allegiances, ground truth, the state file. */
function renderWatchBar(): void {
  $('dev').innerHTML = `
    <span class="dev-tag">Watching</span>
    <label>Viewing as <select data-f="seat">${game.playerOrder
      .filter((id) => !game.players[id].fake)
      .map((id) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(game.players[id].name)}${game.players[id].bot ? ' (bot)' : ''}</option>`)
      .join('')}</select></label>
    <label><input type="checkbox" data-f="god" ${god ? 'checked' : ''}> show allegiances</label>
    <button data-act="truth" class="${truthOpen ? 'on' : ''}">Ground truth</button>
    <button data-act="dump" title="Save the whole game state, config included, as JSON">Download state</button>
    <span>Game <b>${esc(watcher!.code)}</b>: read only, refreshed by the host every few seconds. Players cannot see you.</span>
    <span class="dev-note">Everything below this bar is that seat's screen.</span>`;
}

/** A remote screen's bar: testers pick a seat; real players get no bar at all. */
function renderTesterBar(): void {
  const dev = $('dev');
  if (MODE.kind !== 'client' || !MODE.dev) {
    dev.hidden = true;
    return;
  }
  const v = view();
  dev.innerHTML = `
    <span class="dev-tag">Online sandbox</span>
    <label>Viewing as <select data-f="claim">${v.table
      .map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
      .join('')}</select></label>
    <span>Room <b>${esc(client!.code)}</b>: the host's tab runs the clock${client!.db.kind === 'local' ? ' (this browser only)' : ''}.</span>
    <span class="dev-note">Everything below this bar is the game.</span>`;
}

/**
 * The test scenario strip under the dev bar. SOLO: the bots' level, whether the IT bot's traces have exposed your
 * workstation IP or the hidden host's address yet (red once they have), and its latest traces.
 */
function renderScenario(): void {
  const el = $('scenario');
  const sc = client ? null : game.scenario;
  el.hidden = !sc;
  if (!sc) return;
  if (sc.kind === 'DUO') {
    el.className = 'dev scenario';
    el.innerHTML = `<b>${SCENARIO_LABEL.DUO}</b> <span>One Personal Banker and one Accounts &amp; Receivables, no Thieves. The economy is a 3-player game's.</span>`;
    return;
  }
  const exposed = sc.exposedIpAt !== null || sc.exposedHostAt !== null;
  const flag = (label: string, at: number | null): string =>
    `<span class="sc-flag ${at === null ? 'safe' : 'hit'}">${label}: ${at === null ? 'hidden' : `EXPOSED at ${fmtClock(at)}`}</span>`;
  const recent = sc.traceLog.slice(-3).reverse();
  el.className = `dev scenario ${exposed ? 'exposed' : ''}`;
  el.innerHTML = `<b>${SCENARIO_LABEL.SOLO}</b> ${flag('Your workstation IP', sc.exposedIpAt)} ${flag('Hidden host address', sc.exposedHostAt)}
    <span class="sc-note">Bots: ${esc(BOT_LEVELS[game.bots?.level ?? 'STANDARD'].label)} (they do their jobs and catch tampering; from Sharp up, scams too). ${sc.traceLog.length} traces so far.</span>
    ${recent.length ? `<ul>${recent.map((x) => `<li class="${x.exposes.length ? 'hit' : ''}">[${fmtClock(x.t)}] ${esc(x.logId)}: ${esc(x.text)}</li>`).join('')}</ul>` : ''}`;
}

function renderTruth(): void {
  const el = $('truth');
  el.hidden = !truthOpen || !!client;
  if (el.hidden) return;
  const s = game;
  const t = (x: number): string => fmtClock(x);
  const people = s.playerOrder
    .map((id) => {
      const p = s.players[id];
      return `${p.name.padEnd(8)} ${p.allegiance.padEnd(6)} ${p.role.padEnd(22)} ${p.ip}${p.fake ? '  (planted)' : ''}`;
    })
    .join('\n');
  const logs = s.logs
    .filter((l) => l.actor !== 'SYSTEM')
    .slice(-40)
    .map((l) => `[${t(l.t)}] ${l.id.padEnd(5)} says ${(l.actor === 'UNKNOWN' ? 'UNKNOWN' : (s.players[l.actor]?.name ?? l.actor)).padEnd(8)} truth ${(s.players[l.actualPlayerId ?? '']?.name ?? '-').padEnd(8)} ${l.sourceIp ?? ''}  ${l.message}`)
    .join('\n');
  const txs = s.transactions
    .slice(-25)
    .map((x) => `${x.id} ${money(x.amount).padStart(11)} ${x.status.padEnd(12)} ${x.origin.padEnd(6)} from ${x.customerId ?? 'UNKNOWN'} ${x.originAccount} to ${x.beneficiaryId} ${x.settledTo ?? ''} ${x.fraud ? 'FRAUD' : ''}`)
    .join('\n');
  const who = (id: string | null): string => (id === null || id === 'SYSTEM' ? 'SYSTEM' : (s.players[id]?.name ?? id));
  const beliefs = s.customers
    .filter((c) => c.known && (c.known.primary !== c.primary || [...c.known.accounts].sort().join() !== [...c.accounts].sort().join()))
    .map((c) => `${c.id.padEnd(5)} file: ${c.primary}* ${c.accounts.filter((a) => a !== c.primary).join(' ')}\n      believes: ${c.known.primary}* ${c.known.accounts.filter((a) => a !== c.known.primary).join(' ')}`)
    .join('\n');
  const history = s.transactions
    .slice(-8)
    .map((x) => [`${x.id}`, ...x.history.map((e) => `  [${t(e.t)}] ${e.action.padEnd(12)} records: ${who(e.by).padEnd(8)} truth: ${who(e.actualPlayerId).padEnd(8)} ${e.detail ?? ''}`)].join('\n'))
    .join('\n');
  const bn = s.blacknet.map((m) => `[${t(m.t)}] ${m.alias} (really ${s.players[m.ownerId].name}): ${m.text}`).join('\n');
  const targets = s.targets.map((x) => `${x.account} ${money(s.balances[x.account] ?? 0)}`).join('   ');
  el.innerHTML = `
    <div class="truth-head"><b>Ground truth (spoilers)</b><button data-act="truth" aria-label="Close ground truth">Close</button></div>
    <div class="totals"><span>settled: ${money(s.totals.processed)}</span><span>stolen: ${money(s.totals.stolen)} / ${money(s.config.blackTarget)}</span><span>targets: ${esc(targets)}</span></div>
    <h4>People</h4><pre>${esc(people)}</pre>
    <h4>Player activity: what the log says vs who did it</h4><pre>${esc(logs || 'No player activity yet.')}</pre>
    <h4>Customer files vs what customers believe</h4><pre>${esc(beliefs || 'Every file matches what its customer believes.')}</pre>
    <h4>Payments</h4><pre>${esc(txs)}</pre>
    <h4>Payment history (last 8)</h4><pre>${esc(history)}</pre>
    <h4>Blacknet</h4><pre>${esc(bn || 'No Blacknet posts.')}</pre>`;
}

// ---- Game: status bar -----------------------------------------------------------------
function renderStatus(): void {
  const v = view();
  const ended = v.status === 'ENDED';
  const banner = ended && v.end
    ? `<div class="banner ${v.end.winner === 'WHITE' ? 'white' : v.end.winner === 'BLACK' ? 'black' : 'none'}">${esc(v.end.headline)}. ${esc(v.end.text)}${endHidden ? ' <button data-act="endshow">Show results</button>' : ''}</div>`
    : client?.paused && !ended
      ? '<div class="banner paused">Paused by the host. The clock is stopped and nothing can be done until the game resumes.</div>'
      : '';
  $('status').innerHTML = `
    <div class="who"><b>${esc(v.me.name)}</b><span>${esc(v.me.roleLabel)}</span>
      ${v.me.allegiance === 'BLACK' ? '<span class="chip BLACK">Thief</span>' : ''}
      ${v.me.terminated ? `<span class="chip terminated">${v.me.resigned ? 'Resigned' : 'Terminated'}</span>` : ''}
      <span id="timers" class="timers"></span></div>
    <div class="clock"><span id="phase" class="phase"></span><span id="pace" class="pace"></span><b id="elapsed"></b><span class="ends" title="The game ends at this time">/ ${fmtClock(v.durationSec)}</span></div>
    <div class="throughput"><span id="thr" title="Every payment settled today, however it counts"></span><span id="workload" class="workload" title="What the whole bank has waiting at each step"></span></div>
    ${banner}`;
  renderTimers();
  updateClock();
  renderEnd();
}

// ---- Game: end screen ---------------------------------------------------------------------
/** Both teams, who was on them and what they made, and how the game was won. Embezzlement is an aside. */
/** The end screen already built (seat and ending), so redraws do not replay its reveal. */
let endKey = '';
const REVEAL_START = 0.5; // seconds: the first name appears
const REVEAL_STEP = 0.22; // then one name after another, the Thieves last
const BAR_SEC = 0.9;

/**
 * The end screen is revealed in steps, for everyone watching on the call: the teams' names one at a time
 * (Thieves last), then how far each side got, then who won. A click on the card skips to the end.
 */
function renderEnd(): void {
  const el = $('endscreen');
  const end = view().end;
  el.hidden = !end || endHidden;
  if (!end) {
    endKey = '';
    return;
  }
  const key = `${selected}|${end.clock}|${end.headline}`;
  if (key === endKey) return;
  endKey = key;
  const at = (sec: number): string => `style="--d:${sec.toFixed(2)}s"`;
  // Reveal order: regular employees first, then the Thieves.
  const order = [...end.teams].sort((a, b) => (a.side === 'BLACK' ? 1 : 0) - (b.side === 'BLACK' ? 1 : 0)).flatMap((t) => t.members);
  const barsAt = REVEAL_START + order.length * REVEAL_STEP + 0.1;
  const verdictAt = barsAt + BAR_SEC;
  const made = (t: EndTeam): string =>
    `<div class="end-made"><b>${money(t.made)}</b> of ${money(t.target)} ${t.side === 'WHITE' ? 'settled' : 'diverted'}</div>
     <div class="end-bar"><i class="rv-bar" style="--d:${barsAt.toFixed(2)}s;width:${Math.min(100, (t.made / t.target) * 100)}%"></i></div>`;
  const member = (m: EndMember): string =>
    `<li class="rv" ${at(REVEAL_START + order.indexOf(m) * REVEAL_STEP)}><span class="nm">${esc(m.name)}</span><span class="rl">${esc(m.roleLabel)}</span>
      ${m.terminated ? `<span class="flag term">${m.resigned ? 'Resigned' : 'Terminated'}</span>` : ''}
      ${m.embezzled > 0 ? `<span class="flag emb">Embezzled ${money(m.embezzled)}</span>` : ''}</li>`;
  const anyEmbezzled = end.teams.some((t) => t.members.some((m) => m.embezzled > 0));
  el.innerHTML = `<div class="end-card ${end.winner ?? 'NONE'}" role="dialog" aria-label="Game over" title="Click to skip ahead">
    <p class="end-kicker">Game over at ${esc(end.clock)}</p>
    <h2 class="rv verdict" ${at(verdictAt)}>${esc(end.headline)}</h2>
    <p class="end-text rv" ${at(verdictAt + 0.3)}>${esc(end.text)}</p>
    <div class="end-teams">${end.teams
      .map(
        (t) => `<section class="end-team ${t.side} ${t.won ? 'won' : ''}" ${at(verdictAt)}>
          <header><h3>${esc(t.label)}</h3><span class="result rv" ${at(verdictAt)}>${t.won ? 'Won' : 'Lost'}</span></header>
          ${made(t)}
          <ul>${t.members.map(member).join('')}</ul>
        </section>`,
      )
      .join('')}</div>
    ${anyEmbezzled ? `<p class="end-note rv" ${at(verdictAt + 0.3)}>Embezzled money was paid into an employee's own account. It counts toward no one's goal.</p>` : ''}
    <button class="end-close rv" ${at(verdictAt + 0.3)} data-act="endhide">Back to the desk</button>
  </div>`;
}

// A click on the end card skips the reveal.
$('endscreen').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('button')) return;
  $('endscreen')
    .getAnimations({ subtree: true })
    .forEach((a) => a.finish());
});

const PACE_TEXT: Record<Pace, string> = { SLOW: 'Slow', MEDIUM: 'Medium', BUSY: 'Busy', CLOSED: 'Closed' };

function updateClock(): void {
  const v = view();
  // Time of day, how busy it is, and the game clock counting up to the end.
  $('phase').textContent = v.dayPhase;
  $('desk').dataset.phase = v.dayPhase.toLowerCase().replace(/ /g, '-'); // tints the desktop (style.css)
  const pace = $('pace');
  pace.textContent = PACE_TEXT[v.pace];
  pace.className = `pace ${v.pace}`;
  $('elapsed').textContent = fmtClock(v.t);
  $('thr').textContent = `Settled today: ${money(v.settled)}`;
  // A countdown started, ended or was cancelled: redraw what shows them, then turn every gauge.
  if (timerKey(v) !== shownTimers) {
    renderRail();
    renderTimers();
  }
  updateKitJobs();
  updateModuleLights();
  updateWorkload();
  updateTraceCooldown();
  updateGauges(v.t);
}

/** The bank's workload, for everyone: each step's label stacked over its count, coloured by how many are waiting per person working it. */
function updateWorkload(): void {
  const el = $('workload');
  const html = view()
    .workload.map((x) => `<span class="wl ${x.level ?? ''}"><small>${esc(x.label)}</small><b>${x.count}</b></span>`)
    .join('');
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

/** Master Log: while the trace engine cools down, the Trace button is disabled with a countdown ring beside it. */
function updateTraceCooldown(): void {
  const c = view().traceCooldown;
  const busy = !!c || view().kitJobs.some((j) => j.kind === 'TRACE' && !j.done); // a trace running (its progress bar) or cooling down
  const html = c ? gauge(c) : '';
  for (const slot of document.querySelectorAll<HTMLElement>('.trace-cool')) {
    if (slot.dataset.html !== html) {
      slot.dataset.html = html;
      slot.innerHTML = html;
    }
    slot.closest('.cmd-card')?.querySelectorAll<HTMLButtonElement>('button[data-cmd="trace"]').forEach((b) => (b.disabled = busy));
  }
}

// ---- Countdown gauges ---------------------------------------------------------------------
/**
 * A radial countdown: the ring empties and the number counts down to `c.until` (updateGauges turns it every
 * clock tick). A permanent one (`until` null) is a full ring with no number.
 */
function gauge(c: Countdown): string {
  const live = c.until !== null;
  return `<span class="gauge ${live ? 'live' : 'perm'}"${live ? ` data-until="${c.until}" data-total="${c.total}"` : ''}>` +
    '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="track" cx="18" cy="18" r="15.9"/>' +
    '<circle class="arc" cx="18" cy="18" r="15.9" pathLength="100" stroke-dasharray="100 100" transform="rotate(-90 18 18)"/></svg>' +
    '<b></b></span>';
}

/** A gauge with what it counts down to. `tone`: warn (amber), bad (red) or kit (the hidden host's purple). */
const timer = (c: Countdown, label: string, tone: string): string => `<span class="timer ${tone}">${gauge(c)}<span>${esc(label)}</span></span>`;

function updateGauges(t: number): void {
  for (const bar of document.querySelectorAll<HTMLElement>('.kbar.live')) {
    const left = Math.max(0, Number(bar.dataset.until) - t);
    bar.querySelector('i')!.style.width = `${(100 * (1 - Math.min(1, left / Number(bar.dataset.total)))).toFixed(1)}%`;
    const secs = bar.parentElement?.querySelector('.left');
    if (secs) secs.textContent = `${Math.ceil(left)}s`;
  }
  for (const g of document.querySelectorAll<HTMLElement>('.gauge.live')) {
    const left = Math.max(0, Number(g.dataset.until) - t);
    const frac = Math.min(1, left / Number(g.dataset.total));
    g.querySelector('.arc')!.setAttribute('stroke-dasharray', `${(frac * 100).toFixed(1)} 100`);
    g.querySelector('b')!.textContent = String(Math.ceil(left));
    g.classList.toggle('low', frac <= 0.25);
    g.closest<HTMLElement>('.timer')?.toggleAttribute('hidden', left <= 0);
  }
}

/** Which countdowns are showing, so the clock redraws them only when one starts or stops. */
let shownTimers = '';
const timerKey = (v: PlayerView): string => JSON.stringify([v.table.map((p) => [p.terminated, p.lock, p.block]), v.timers]);

/** The status bar's countdowns: this workstation locked, blocked or rerouted, a revocation this player can stop, an alert mute. */
function renderTimers(): void {
  const v = view();
  const mine = v.table.find((p) => p.id === v.me.id);
  $('timers').innerHTML =
    (mine?.block ? timer(mine.block, 'Workstation blocked', 'bad') : '') +
    (mine?.lock ? timer(mine.lock, 'Workstation locked', 'warn') : '') +
    v.timers.map((x) => timer(x, x.label, { REVOKE: 'bad', MUTE: 'kit', REROUTE: 'warn' }[x.kind])).join('');
  shownTimers = timerKey(v);
  updateGauges(v.t);
}

// ---- Kit jobs: Code crack and Unlock workstation ------------------------------------------------
/**
 * Each job's card holds a progress bar while it runs (a `.kit-progress` slot, filled here every clock tick
 * and only rewritten when the job changes). When one ends, its result goes in every open terminal on its page.
 */
/** The progress bar slot for a card's timed Security writes (SYSTEM.MODULE.FN each): filled by updateKitJobs. */
const timedSlot = (...kinds: string[]): string => `<div class="kit-progress full" data-kit="${kinds.join(' ')}"></div>`;

/** A crack's code so far ("1 2 _ _"), with the digit being cracked now blinking. */
function crackDigits(detail: string): string {
  const next = detail.split(' ').indexOf('_');
  return detail.split(' ').map((d, i) => (i === next ? '<span class="blink">_</span>' : esc(d))).join(' ');
}

const kitSeen: Record<PlayerId, Record<string, boolean>> = {}; // seat > job id > done when last seen
function updateKitJobs(): void {
  const v = view();
  const seen = (kitSeen[selected] ??= {});
  for (const j of v.kitJobs) {
    if (seen[j.id] === false && j.done && j.result) { // seen running, now ended
      terminal.printJob(`[${fmtClock(v.t)}] ${j.result}`, j.ok !== false);
      for (const w of wins()) {
        const r = route(w);
        // The page its result is printed on: a Security write's is its own (SYSTEM.MODULE.FN).
        const page = ({ CRACK: 'HIDDEN_HOST.ACCESS', UNLOCK: 'HIDDEN_HOST.ACCESS', PROXY: 'HIDDEN_HOST.INFILTRATION', TRACE: 'SECURITY.MASTER_LOG' } as Record<string, string>)[j.kind] ?? j.kind.split('.').slice(0, 2).join('.');
        if (r?.kind !== 'module' || `${r.system}.${r.module}` !== page) continue;
        w.out.push({ cls: j.ok === false ? 'bad' : 'ok', text: `[${fmtClock(v.t)}] ${j.result}` });
        if (w.out.length > TERMINAL_LINES) w.out.splice(0, w.out.length - TERMINAL_LINES);
        renderTerminal(w);
      }
    }
    seen[j.id] = j.done;
  }
  for (const slot of document.querySelectorAll<HTMLElement>('.kit-progress[data-kit]')) {
    const kinds = slot.dataset.kit!.split(' '); // a card can run several (Block / Unblock)
    const j = v.kitJobs.find((x) => kinds.includes(x.kind) && !x.done);
    const html = j
      ? `<div class="kbar live" data-until="${j.until}" data-total="${j.total}"><i></i></div>` +
        `<div class="kinfo"><span>${esc(j.label)}</span>${j.detail ? `<code>${crackDigits(j.detail)}</code>` : ''}<b class="left"></b></div>`
      : '';
    if (slot.dataset.html !== html) {
      slot.dataset.html = html;
      slot.innerHTML = html;
    }
    // Only one runs at a time: its start button waits until it ends.
    slot.closest('.cmd-card')?.querySelectorAll<HTMLButtonElement>('button[data-cmd], button[data-act^="mcmd:"]').forEach((b) => (b.disabled = !!j));
  }
}

// ---- Game: employee sidebar ------------------------------------------------------------
function renderRail(): void {
  // The people at the table (planted users are records, not people: only the system views show them).
  $('rail').innerHTML = `<h3>Employees</h3>${view()
    .table.map((p) => {
      const side = god && game ? game.players[p.id].allegiance : null;
      return `<div class="pl ${p.id === selected ? 'me' : ''}">
        <span class="nm">${esc(p.name)}${p.id === selected ? ' <small>(you)</small>' : ''}</span><span class="rl">${esc(p.roleLabel)}${p.terminated ? ` <b class="gone">${p.resigned ? 'Resigned' : 'Terminated'}</b>` : ''}</span>
        ${p.block || p.lock ? `<span class="st">${p.block ? timer(p.block, 'Blocked', 'bad') : ''}${p.lock ? timer(p.lock, 'Locked out', 'warn') : ''}</span>` : ''}
        ${side === 'BLACK' ? `<i class="tag BLACK" title="Sandbox: allegiance">Thief</i>` : ''}
      </div>`;
    })
    .join('')}`;
}

// ---- Game: desktop --------------------------------------------------------------------
function renderIcons(): void {
  $('icons').innerHTML = view()
    .systems.map(
      (sys) => `<button class="sys-icon ${sys.hidden ? 'hidden-host' : ''}" data-act="open:${sys.id}">
        ${icon(sys.id, 56)}<span class="lbl">${esc(sys.label)}</span><small>${esc(sys.address)}</small></button>`,
    )
    .join('');
}

const wins = (): Win[] => (desks[selected] ??= []);
const winById = (id: number): Win | undefined => wins().find((w) => w.id === id);
const winEl = (w: Win): HTMLElement | null => $('wins').querySelector<HTMLElement>(`[data-win="${w.id}"]`);
const route = (w: Win): Route | undefined => (w.kind === 'browser' ? w.history[w.idx] : undefined);
const topWin = (): Win | undefined =>
  wins()
    .filter((w) => !w.min)
    .sort((a, b) => b.z - a.z)[0];

function deskSize(): { w: number; h: number } {
  const d = $('desk');
  return { w: d.clientWidth, h: d.clientHeight - TASKBAR_H };
}

/** A system's address as this player's view gives it (the unregistered host's is random each game). */
const sysAddress = (id: SystemId): string => view().systems.find((s) => s.id === id)?.address ?? findSystem(id)?.address ?? '';

function routeAddress(r: Route): string {
  if (r.kind === 'noroute' || r.kind === 'workstation' || r.kind === 'proxy') return r.address;
  let a = sysAddress(r.system);
  if (r.kind !== 'system') a += '/' + slug(r.module);
  return a;
}

/** Your best access to a module from the active credentials you hold (yours or shared with you). */
function moduleAccess(v: PlayerView, system: string, module: string): 'WRITE' | 'READ' | 'NONE' {
  const covering = v.me.credentials.filter((c) => c.status === 'ACTIVE' && c.system === system && (c.module === null || c.module === module));
  if (covering.some((c) => c.permission === 'WRITE')) return 'WRITE';
  return covering.length ? 'READ' : 'NONE';
}
const ACCESS_TEXT = { WRITE: 'Read & write', READ: 'Read only', NONE: 'No access' } as const;

/** Full access: the module is online with its security off, so no code is needed (offline wins over it). */
const fullAccess = (v: PlayerView, key: string): boolean => v.openModules.includes(key) && !v.offlineModules.includes(key);

/** A bank module's state as the Firewall set it: green online, red offline, blue full access (security off). */
function moduleState(v: PlayerView, key: string): { cls: string; text: string } {
  if (v.offlineModules.includes(key)) return { cls: 'red', text: 'Offline' };
  if (v.openModules.includes(key)) return { cls: 'blue', text: 'Full access' };
  return { cls: 'green', text: 'Online' };
}

/**
 * Firewall / Control a module: puts a module in one of its light's three states, with only the switches it
 * needs (Offline: take it offline; Online: back online, security on; Full access: online, security off).
 */
async function setModuleState(w: Win, target: string, state: string): Promise<void> {
  const v = view();
  const offline = v.offlineModules.includes(target);
  const open = v.openModules.includes(target);
  const fw = (fn: string, params: Record<string, string>): Promise<boolean> => execute(w, 'SECURITY', 'FIREWALL', fn, { target, ...params });
  if (state === 'OFFLINE') {
    await fw('SET_MODULE_STATUS', { status: 'OFFLINE' });
    return;
  }
  if (offline && !(await fw('SET_MODULE_STATUS', { status: 'ONLINE' }))) return;
  if (state === 'ONLINE' && open) await fw('SET_SECURITY', { security: 'ON' });
  else if (state === 'FULL' && !open) await fw('SET_SECURITY', { security: 'OFF' });
  // Already in that state: the switch it would use says so ("already online" / "security is already off").
  else if (!offline) await (state === 'FULL' ? fw('SET_SECURITY', { security: 'OFF' }) : fw('SET_MODULE_STATUS', { status: 'ONLINE' }));
}

/** The light for a bank module's state (its tile, and its page's credential line); filled by updateModuleLights. */
const moduleLight = (key: string): string => `<span class="mod-light" data-light="${key}"><i></i><span></span></span>`;

/**
 * Module states change when someone else acts at the Firewall: keep the open windows' lights current, and
 * redraw a page whose security was switched off or on (its credential choice is disabled while security is off).
 */
function updateModuleLights(): void {
  const v = view();
  // Firewall / Control a module: fill the button for the chosen module's state now.
  for (const card of document.querySelectorAll<HTMLElement>('.cmd-card:has(button[data-cmd^="state:"])')) {
    const target = card.querySelector<HTMLSelectElement>('select[data-f="p:target"]')?.value ?? '';
    const now = { red: 'OFFLINE', green: 'ONLINE', blue: 'FULL' }[moduleState(v, target).cls];
    card.querySelectorAll<HTMLButtonElement>('button[data-cmd^="state:"]').forEach((b) => b.classList.toggle('current', b.dataset.cmd === `state:${now}`));
  }
  for (const sec of document.querySelectorAll<HTMLElement>('.mod-cred[data-open-key]')) {
    const w = winById(Number(sec.dataset.win));
    if (w && sec.dataset.open !== (fullAccess(v, sec.dataset.openKey!) ? '1' : '0')) renderWin(w);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-light]')) {
    const st = moduleState(v, el.dataset.light!);
    el.className = `mod-light ${st.cls}`;
    el.lastElementChild!.textContent = st.text; // shown on a page's credential line; on a tile only as its tooltip
    el.title = st.text;
  }
}

function winTitle(w: Win): string {
  if (w.kind === 'personal') return 'My workstation';
  const r = route(w);
  if (r?.kind === 'workstation') return `${view().players.find((p) => p.id === r.playerId)?.name ?? r.address}'s workstation`;
  if (r?.kind === 'proxy') return 'Proxy relay';
  if (!r || r.kind === 'noroute') return 'Network';
  return findSystem(r.system)?.label ?? r.system;
}

function openWindow(kind: Win['kind'], first?: Route): Win {
  const list = wins();
  const { w: dw, h: dh } = deskSize();
  const w = Math.max(340, Math.min(640, dw - 20));
  const h = Math.max(220, Math.min(560, dh - 20)); // tall enough for a page with one row of tools (e.g. Master Log) to need no scrollbar
  const off = (list.length % 6) * 28;
  const win: Win = {
    id: ++winSeq,
    kind,
    // Cascade even if that pushes the window partly off the edge, so stacked instances stay distinguishable.
    x: clamp(Math.min(40, dw - w) + off, 0, Math.max(0, dw - 200)),
    y: clamp(Math.min(20, dh - h) + off, 0, Math.max(0, dh - 120)),
    w,
    h,
    z: ++zSeq,
    min: false,
    max: false,
    history: first ? [first] : [],
    idx: 0,
    addr: first ? routeAddress(first) : '',
    sized: false,
    form: {},
    out: [],
    termSystem: null,
    notice: [],
  };
  list.push(win);
  if (first) showRoute(win); // renders, fits, and opens the terminal session
  else {
    renderWin(win);
    fitWin(win);
  }
  markFocus();
  renderTaskbar();
  const el = winEl(win);
  if (el) animateWin(el, POP_IN, 170);
  return win;
}

function openPersonal(): void {
  const existing = wins().find((w) => w.kind === 'personal');
  if (existing) focusWin(existing);
  else openWindow('personal');
}

function placeWin(w: Win, el = winEl(w)): void {
  if (!el) return;
  el.style.left = `${w.x}px`;
  el.style.top = `${w.y}px`;
  el.style.width = `${w.w}px`;
  el.style.height = `${w.h}px`;
  el.style.zIndex = String(w.z);
  el.classList.toggle('min', w.min);
  el.classList.toggle('max', w.max);
}

// ---- Window animations: open, close, minimize/restore (to and from the taskbar), maximize/restore ----
// Purely visual: the window's state changes at once and the animation only plays over the top of it.

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const reduceMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Plays keyframes on a window, replacing whatever it was already playing. Null when motion is off. */
function animateWin(el: HTMLElement, frames: Keyframe[], ms: number): Animation | null {
  el.getAnimations().forEach((a) => a.cancel());
  if (reduceMotion() || !el.animate) return null;
  return el.animate(frames, { duration: ms, easing: EASE });
}

/** A transform that shrinks `from` onto `to` (both screen rectangles), about the element's centre. */
function shrinkOnto(from: DOMRect, to: DOMRect): string {
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${Math.max(0.05, to.width / from.width)})`;
}

/**
 * Runs `done` when a window animation ends, or at once without one. A timer backs up the finish event, which
 * a background tab may never deliver; `done` must be safe to run late (it re-applies the window's state).
 */
function afterAnim(a: Animation | null, ms: number, done: () => void): void {
  if (!a) return done();
  let ran = false;
  const once = (): void => {
    if (ran) return;
    ran = true;
    done();
  };
  a.onfinish = once;
  setTimeout(once, ms + 50);
}

const taskRect = (w: Win): DOMRect | undefined =>
  document.querySelector<HTMLElement>(`.taskbar [data-act="task:${w.id}"]`)?.getBoundingClientRect();

const POP_IN: Keyframe[] = [{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }];

function minimizeWin(w: Win): void {
  const el = winEl(w);
  w.min = true;
  markFocus();
  renderTaskbar();
  const to = taskRect(w);
  if (!el || !to) return placeWin(w);
  const a = animateWin(el, [{ opacity: 1, transform: 'none' }, { opacity: 0.2, transform: shrinkOnto(el.getBoundingClientRect(), to) }], 200);
  afterAnim(a, 200, () => placeWin(w, el)); // hide it once it has landed in the taskbar (unless restored meanwhile)
}

/** Maximize or restore, sliding from the old frame to the new one. */
/** Changes a window's frame (`change`, then a redraw) and slides it there from where it was. */
function slideWin(w: Win, change: () => void, redraw: (el: HTMLElement) => void): void {
  const el = winEl(w);
  const before = el?.getBoundingClientRect();
  change();
  if (!el || !before) return;
  redraw(el);
  const after = el.getBoundingClientRect();
  const from = `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})`;
  animateWin(el, [{ transformOrigin: 'top left', transform: from }, { transformOrigin: 'top left', transform: 'none' }], 180);
}

function toggleMax(w: Win): void {
  slideWin(w, () => (w.max = !w.max), () => renderWin(w));
}

function focusWin(w: Win): void {
  const wasMin = w.min;
  w.min = false;
  w.z = ++zSeq;
  placeWin(w);
  markFocus();
  const from = wasMin ? taskRect(w) : undefined;
  renderTaskbar();
  const el = winEl(w);
  if (wasMin && el) {
    // Back up out of its taskbar button.
    const frames = from ? [{ opacity: 0.2, transform: shrinkOnto(el.getBoundingClientRect(), from) }, { opacity: 1, transform: 'none' }] : POP_IN;
    animateWin(el, frames, 200);
  }
}

function markFocus(): void {
  const top = topWin();
  $('wins')
    .querySelectorAll<HTMLElement>('.win')
    .forEach((el) => el.classList.toggle('focused', Number(el.dataset.win) === top?.id));
}

function closeWin(w: Win): void {
  desks[selected] = wins().filter((x) => x !== w);
  const el = winEl(w);
  if (el) {
    // Gone at once as far as the game is concerned; the element just fades out first.
    delete el.dataset.win;
    el.style.pointerEvents = 'none';
    const a = animateWin(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.94)' }], 140);
    afterAnim(a, 140, () => el.remove());
  }
  markFocus();
  renderTaskbar();
}

function navigate(w: Win, r: Route): void {
  w.history = w.history.slice(0, w.idx + 1);
  w.history.push(r);
  w.idx = w.history.length - 1;
  showRoute(w);
}

function showRoute(w: Win): void {
  const r = route(w);
  w.addr = r ? routeAddress(r) : '';
  w.notice = [];
  // The terminal survives moving around one system; entering a different system starts a fresh session.
  if (r && 'system' in r && r.system !== w.termSystem) {
    const sys = findSystem(r.system)!;
    w.termSystem = r.system;
    w.out = [{ cls: 'hs', text: `[${fmtClock(view().t)}] Logged in to ${sys.label} (${sysAddress(sys.id)})` }];
  }
  delete w.form.credSel;
  delete w.form.autoOpen;
  noteTutorialRoute(r);
  renderWin(w);
  fitWin(w);
  renderTaskbar();
}

/**
 * Grow (never shrink) a window so the page fits without scrolling, up to the desktop size.
 * Skipped once the player has resized the window themselves, or while it is maximized.
 */
function fitWin(w: Win): void {
  const el = winEl(w);
  if (!el || w.sized || w.max || w.min) return;
  const { w: dw, h: dh } = deskSize();
  const r = route(w);
  const minW = r?.kind === 'module' && MODULE_PAGES[`${r.system}.${r.module}`] ? 760 : 0;
  w.w = Math.max(w.w, Math.min(minW, dw));
  placeWin(w, el); // apply the width first: it changes how tall the content is
  const body = el.querySelector<HTMLElement>('.wbody');
  const overflow = body ? body.scrollHeight - body.clientHeight : 0;
  // Sub-pixel content can show a scrollbar while overflow still rounds to 0, so also check for the bar itself.
  const bar = body ? body.offsetWidth - body.clientWidth > 1 : false;
  if (overflow > 0 || bar) w.h = Math.min(w.h + Math.max(0, overflow) + 4, dh);
  w.x = clamp(w.x, 0, Math.max(0, dw - w.w));
  w.y = clamp(w.y, 0, Math.max(0, dh - w.h));
  placeWin(w, el);
}

/** Address bar: "10.0.0.30" (a system) or "10.0.0.30/settlement" (one of its modules). */
async function goAddress(w: Win): Promise<void> {
  const raw = w.addr.trim();
  const [host = '', modSlug, extra] = raw.replace(/^[a-z]+:\/\//i, '').split('/').filter(Boolean);
  let sys = view().systems.find((s) => s.address === host);
  if (!sys) {
    // Unknown address: ask the network. This is how the hidden host and other workstations are found.
    const result = await act({ type: 'CONNECT', playerId: selected, address: host });
    refresh();
    if (!result.ok) return navigate(w, { kind: 'noroute', address: raw, message: result.message });
    if (result.workstation) return navigate(w, { kind: 'workstation', playerId: result.workstation, address: host });
    if (result.proxy) return navigate(w, { kind: 'proxy', address: host, relaying: result.proxy.relaying });
    sys = view().systems.find((s) => s.address === host);
    if (!sys) return;
  }
  const mod = modSlug ? sys.modules.find((m) => slug(m.id) === modSlug) : undefined;
  if ((modSlug && !mod) || extra) {
    return navigate(w, { kind: 'noroute', address: raw, message: `${sys.label} has no page at that path.` });
  }
  if (mod) navigate(w, { kind: 'module', system: sys.id, module: mod.id });
  else navigate(w, { kind: 'system', system: sys.id });
}

function renderWins(): void {
  const firstLook = !deskShown.has(selected);  deskShown.add(selected);
  $('wins').innerHTML = '';
  for (const w of wins()) renderWin(w);
  markFocus();
  // A seat's desk starts with its workstation open: role, objective and credentials are the first read.
  if (firstLook) openWindow('personal');
}

function renderWin(w: Win): void {
  let el = winEl(w);
  if (!el) {
    el = document.createElement('div');
    el.className = 'win';
    el.dataset.win = String(w.id);
    el.setAttribute('role', 'dialog');
    $('wins').appendChild(el);
  }
  placeWin(w, el);
  el.setAttribute('aria-label', winTitle(w));
  // The unregistered host gets its own dark look; its tool kits get a purple accent on top.
  const r = route(w);
  const onHost = !!r && 'system' in r && r.system === 'HIDDEN_HOST';
  el.classList.toggle('host', onHost);
  el.classList.toggle('kit', onHost && r.kind === 'module' && HOST_KITS.includes(r.module));
  // Redrawing replaces the page, so keep where it was scrolled to (or jump to the bottom after a command, so the
  // terminal shows; a module page keeps its terminal in view anyway, so its commands stay where they were).
  const scroller = (): HTMLElement | null => el!.querySelector<HTMLElement>('.mod-top') ?? el!.querySelector<HTMLElement>('.wbody');
  const prevScroll = scroller()?.scrollTop ?? 0;
  el.innerHTML = titleBar(w) + (w.kind === 'personal' ? personalHtml(w) : browserHtml(w)) + resizeHandles();
  updateModuleLights(); // fill the new page's module lights at once
  const out = el.querySelector('.out');
  if (out) out.scrollTop = out.scrollHeight;
  const body = scroller();
  if (body) body.scrollTop = w.scrollEnd && !body.classList.contains('mod-top') ? body.scrollHeight : prevScroll;
  w.scrollEnd = false;
}

function titleBar(w: Win): string {
  const r = route(w);
  const glyph = r && 'system' in r ? icon(r.system, 16) : '';
  return `<div class="titlebar" data-drag="${w.id}">
    <span class="wtitle">${glyph}${esc(winTitle(w))}</span>
    <span class="wctl">
      <button data-act="wmin:${w.id}" title="Minimize" aria-label="Minimize"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 9h8" stroke="currentColor" stroke-width="1.6"/></svg></button>
      <button data-act="wmax:${w.id}" title="${w.max ? 'Restore' : 'Full screen'}" aria-label="${w.max ? 'Restore' : 'Full screen'}"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4">${w.max ? '<rect x="2" y="4" width="6" height="6"/><path d="M4 4V2h6v6H8"/>' : '<rect x="2" y="2" width="8" height="8"/>'}</svg></button>
      <button class="x" data-act="wclose:${w.id}" title="Close" aria-label="Close"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.6"/></svg></button>
    </span>
  </div>`;
}

function browserHtml(w: Win): string {
  const r = route(w);
  const nav = `<form class="navbar" data-addr="${w.id}">
    <button type="button" data-act="wback:${w.id}" ${w.idx <= 0 ? 'disabled' : ''} title="Back" aria-label="Back">&#8249;</button>
    <button type="button" data-act="wfwd:${w.id}" ${w.idx >= w.history.length - 1 ? 'disabled' : ''} title="Forward" aria-label="Forward">&#8250;</button>
    <input data-f="addr" value="${esc(w.addr)}" spellcheck="false" autocomplete="off" aria-label="Address">
    <button type="submit">Go</button>
  </form>`;
  if (!r) return nav;
  if (r.kind === 'workstation') return nav + remoteHtml(w, r);
  if (r.kind === 'proxy') {
    return `${nav}<div class="wbody"><div class="noroute proxy"><h2>Proxy relay at ${esc(r.address)}</h2>
      <p>This address is a relay: it forwards other machines' traffic under its own address. There is nothing on it to log in to.</p>
      <p class="relay ${r.relaying ? 'on' : ''}">${r.relaying ? 'Relaying traffic right now.' : 'Idle: no traffic is going through it right now.'}</p>
      <p class="hint">Press Go again to check its status.</p></div></div>`;
  }
  let crumbs = '';
  let body = '';
  if (r.kind === 'noroute') {
    const known = view().systems.map((s) => `${esc(s.label)} <code>${esc(s.address)}</code>`).join('<br>');
    body = `<div class="noroute"><h2>Can't reach ${esc(r.address || 'that address')}</h2><p>${esc(r.message)}</p><p class="hint">Addresses you know:<br>${known}</p></div>`;
  } else if (view().me.terminated && r.system !== 'HIDDEN_HOST') {
    body = `<div class="noroute terminated"><h2>${esc(TERMINATED_TEXT)}</h2><p>This workstation has been terminated. The bank's systems no longer accept it.</p></div>`;
  } else {
    const sys = findSystem(r.system)!;
    const crumb = (label: string, act: string | null): string =>
      act ? `<button data-act="${act}">${esc(label)}</button>` : `<span>${esc(label)}</span>`;
    const parts = [crumb(sys.label, r.kind === 'system' ? null : `wgo:${w.id}:${sys.id}`)];
    if (r.kind !== 'system') {
      const mod = findModule(r.system, r.module)!;
      parts.push(crumb(mod.label, null));
    }
    crumbs = `<div class="crumbs">${parts.join('<i>/</i>')}${r.kind === 'module' ? autoBadgeHtml(w, r) + bellHtml(`${r.system}.${r.module}`) : ''}</div>`;
    if (r.kind === 'system') {
      // On the unregistered host, the tool kits you can use (read & write) come first; the rest keep their order.
      const rank = (id: string): number => (sys.id === 'HIDDEN_HOST' && HOST_KITS.includes(id) ? 1 + ['WRITE', 'READ', 'NONE'].indexOf(moduleAccess(view(), sys.id, id)) : 0);
      const modules = [...sys.modules].sort((a, b) => rank(a.id) - rank(b.id));
      return `${nav}${crumbs}${splitBody(w, '', `<div class="tiles">${modules
        .map((m) => {
          const a = moduleAccess(view(), sys.id, m.id);
          const kit = sys.id === 'HIDDEN_HOST' && HOST_KITS.includes(m.id);
          // Bank modules also show their Firewall state: a light in the corner (the hidden host is not the bank's to control).
          const state = sys.hidden ? '' : moduleLight(`${sys.id}.${m.id}`);
          return `<button class="tile ${kit ? 'kit' : ''} ${a === 'NONE' ? 'locked' : ''}" data-act="wgo:${w.id}:${sys.id}:${m.id}">${state}<b>${esc(m.label)}</b><i class="perm ${a}">${ACCESS_TEXT[a]}</i></button>`;
        })
        .join('')}</div>`)}`;
    } else if (MODULE_PAGES[`${r.system}.${r.module}`]) {
      return `${nav}${crumbs}${modulePageHtml(w, r)}`;
    } else {
      const empty = findModule(r.system, r.module)?.fns.length === 0;
      return `${nav}${crumbs}${splitBody(w, '', `<p class="hint">${empty ? 'No tools in this kit yet.' : 'This module has no page yet.'}</p>`)}`;
    }
  }
  return `${nav}${crumbs}<div class="wbody">${body}</div>`;
}

type Cred = PlayerView['me']['credentials'][number];

/**
 * "Access Level: Read & Write" (this module), "System Access Level: Read Only" (the whole system). The list only
 * offers credentials that reach the page, so it never needs to name it. Credentials in your list are your own
 * except a few (one you issued to someone, a cracked code, an unlocked workstation): those name their owner.
 */
function credLabel(c: Cred): string {
  const whose = c.own ? '' : ` (${c.ownerName}'s)`;
  if (c.system === 'WORKSTATION') return `Workstation login${whose}`;
  const access = c.permission === 'WRITE' ? 'Read & Write' : 'Read Only';
  const only = c.fn ? ` (${findFn(c.system, c.module ?? '', c.fn)?.label ?? c.fn} only)` : '';
  return `${c.module ? 'Access Level' : 'System Access Level'}: ${access}${only}${whose}`;
}

/**
 * Credential dropdown + code box. Lists only active credentials that `applies` accepts, then "Manual code".
 * With no such credentials the first option is "No credentials granted". Only "Manual code" makes the
 * code box editable. Starts on the first credential `prefer` accepts (else the first listed); with none to
 * list, on "Manual code", ready to type. While `openKey`'s security is off, no code is sent: the dropdown and
 * the code box are both blank and disabled.
 */
function credentialFields(w: Win, v: PlayerView, applies: (c: Cred) => boolean, prefer?: (c: Cred) => boolean, openKey?: string): string {
  const list = v.me.credentials.filter((c) => c.status === 'ACTIVE' && applies(c));
  const open = openKey !== undefined && fullAccess(v, openKey);
  const opts: [string, string][] = [
    ...(list.length ? list.map((c): [string, string] => [c.id, credLabel(c)]) : [['none', 'No credentials granted'] as [string, string]]), ['manual', 'Manual code']];
  if (!opts.some(([id]) => id === w.form.credSel)) {
    w.form.credSel = (prefer && list.find(prefer)?.id) || list[0]?.id || 'manual';
  }
  const sel = w.form.credSel;
  const manual = sel === 'manual';
  // Security off: no code is sent (the use is logged as Anonymous), so the choice is disabled and the code hidden.
  w.form.code = open ? '' : manual ? (w.form.manualCode ?? '') : (list.find((c) => c.id === sel)?.code ?? '');
  // A bank module's state (the hidden host's modules are not the Firewall's to switch).
  const light = openKey === undefined || openKey.startsWith('HIDDEN_HOST.') ? '' : moduleLight(openKey);
  return `<div class="cred-row">
      <label class="field grow"><span>Credential</span><select data-f="credSel" aria-label="Credential" class="${sel === 'none' ? 'none' : ''}" ${open ? 'disabled title="Security is off: no code needed"' : ''}>${open
        ? '<option value="" selected></option>' // blank while security is off
        : opts.map(([id, label]) => `<option value="${id}" class="${id === 'none' ? 'none' : ''}" ${id === sel ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
      <label class="field"><span>4-digit code</span><input class="mono code" data-f="code" aria-label="4-digit code" maxlength="4" inputmode="numeric" value="${esc(w.form.code)}" ${open ? 'disabled' : manual ? 'placeholder="0000"' : 'readonly tabindex="-1"'} autocomplete="off"></label>
      ${light}
    </div>`;
}

/** The window's terminal: persists across one system's pages, with a Clear button. */
/** `height`: a height the player dragged it to (module pages); otherwise it takes its share of the window. */
function terminalHtml(w: Win, height?: number): string {
  return `<section class="mod-sec term" ${height ? `style="flex: 0 0 ${height}px"` : ''}><h3>Terminal <button type="button" class="term-clear" data-act="wclear:${w.id}">Clear</button></h3><div class="out" aria-live="polite">${w.out.map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('') || '<div class="dim">Output appears here.</div>'}</div></section>`;
}

/** Runs one function with the window's credential code and prints the result to the window's terminal. */
async function execute(w: Win, system: SystemId, module: string, fn: string, params: Record<string, string>): Promise<boolean> {
  const def = findFn(system, module, fn);
  const action: Action = {
    type: 'EXECUTE',
    playerId: selected,
    code: (w.form.code ?? '').trim(),
    system,
    module,
    fn,
    params,
    encCodes: (w.form.enc ?? '').split(/[\s,]+/).filter(Boolean),
  };
  const result = await act(action);
  w.out.push({ cls: 'cmd', text: `[${findModule(system, module)?.label ?? module}] > ${def?.label ?? fn}` }, { cls: result.ok ? 'ok' : 'bad', text: result.message });
  for (const line of result.lines ?? []) w.out.push({ cls: 'row', text: line });
  if (w.out.length > TERMINAL_LINES) w.out.splice(0, w.out.length - TERMINAL_LINES);
  w.scrollEnd = true;
  renderWin(w);
  refresh();
  return result.ok;
}

/** Redraw just the terminal (not the whole window), keeping the scroll at the bottom if it was there. */
function renderTerminal(w: Win): void {
  const out = winEl(w)?.querySelector<HTMLElement>('.out');
  if (!out) return;
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 8;
  out.innerHTML = w.out.map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('');
  if (atBottom) out.scrollTop = out.scrollHeight;
}

/**
 * Live monitors (Master Log, Blacknet): once a second, re-read quietly (the engine only allows this after a
 * logged read) and replace the previous output block, unless something else was printed after it.
 */
const monitorBusy = new Set<Win>(); // remote screens: a refresh still waiting for the host
function tickMonitors(): void {
  for (const w of wins()) {
    const r = route(w);
    if (w.min || !r || r.kind !== 'module' || w.form['p:monitor'] !== 'YES' || monitorBusy.has(w)) continue;
    const spec = MODULE_PAGES[`${r.system}.${r.module}`]?.monitor?.(w);
    if (!spec) continue;
    monitorBusy.add(w);
    void act({ type: 'EXECUTE', playerId: selected, code: (w.form.code ?? '').trim(), system: r.system, module: r.module, fn: spec.fn, params: spec.params, quiet: true })
      .then((result) => showMonitor(w, r, spec.fn, result))
      .finally(() => monitorBusy.delete(w));
  }
}

/** Shows a live refresh: it replaces the previous live block if that is still the last thing in the terminal. */
function showMonitor(w: Win, r: ModuleRoute, fn: string, result: ActionResult): void {
  if (w.form['p:monitor'] !== 'YES') return; // switched off while waiting
  if (!result.ok) {
    w.form['p:monitor'] = 'NO';
    w.out.push({ cls: 'bad', text: `Auto-update stopped: ${result.message}` });
    renderWin(w);
    return;
  }
  const title = `[${findModule(r.system, r.module)?.label ?? r.module}] > ${findFn(r.system, r.module, fn)?.label ?? fn} (live)`;
  const block: Line[] = [{ cls: 'cmd', text: title }, { cls: 'ok', text: result.message }, ...(result.lines ?? []).map((text) => ({ cls: 'row', text }))];
  const start = w.liveEnd !== undefined && w.liveEnd === w.out.length ? w.out.map((l) => l.cls).lastIndexOf('cmd') : w.out.length;
  w.out.splice(start, w.out.length - start, ...block);
  if (w.out.length > TERMINAL_LINES) w.out.splice(0, w.out.length - TERMINAL_LINES);
  w.liveEnd = w.out.length;
  renderTerminal(w);
}
setInterval(tickMonitors, 1000);

// ---- Module pages: one screen per module (credential, commands, terminal) ------------------------
// Every module has a page here: its credential, its commands (cards), and the window's terminal.

type ModuleRoute = Extract<Route, { kind: 'module' }>;
// Building blocks for command cards. A card with inputs is a <form>: Enter runs its first button.
const card = (title: string, perm: 'READ' | 'WRITE', body: string, form?: string): string => {
  const tag = form ? 'form' : 'div';
  return `<${tag} class="cmd-card" ${form ? `data-mform="${form}"` : ''}>
    <div class="cmd-head"><b>${title}</b><i class="perm ${perm}">${perm === 'WRITE' ? 'Write' : 'Read'}</i></div>
    <div class="cmd-row">${body}</div>
  </${tag}>`;
};
const input = (w: Win, name: string, label: string, placeholder: string, grow = false, full = false): string =>
  `<label class="field ${grow ? 'grow' : ''} ${full ? 'full' : ''}"><span>${label}</span><input data-f="p:${name}" value="${esc(w.form[`p:${name}`] ?? '')}" placeholder="${placeholder}" autocomplete="off" size="8"></label>`;
/** A row of radio buttons (a segmented control), nothing preselected so Enter cannot pick one by accident. */
const segPicker = (w: Win, name: string, label: string, options: string[]): string =>
  `<fieldset class="field full seg"><span>${label}</span><div class="seg-opts">${options
    .map(
      (s) =>
        `<label class="seg-opt ${s}"><input type="radio" name="${name}-${w.id}" data-f="p:${name}" value="${s}" ${w.form[`p:${name}`] === s ? 'checked' : ''}><span>${s[0] + s.slice(1).toLowerCase()}</span></label>`,
    )
    .join('')}</div></fieldset>`;
/** Low / Medium / High. */
const scorePicker = (w: Win): string => segPicker(w, 'score', 'Score', ['LOW', 'MEDIUM', 'HIGH']);
/** A typed automation threshold as the engine wants it ("" when unreadable, so the engine explains). */
const thresholdParam = (w: Win): string => {
  const n = parseAmount(w.form['p:maxAmount'] ?? '');
  return n === null ? '' : String(n);
};
/** A dropdown for command cards. Starts on the first option; the choice sticks for the window. */
/** The Infiltration proxies as dropdown options; an unavailable one says why (the engine refuses it anyway). */
const proxyOptions = (): { value: string; label: string }[] => {
  const list = view().proxies;
  if (!list.length) return [{ value: '', label: 'No proxies yet: create one first' }];
  return list.map((x) => ({ value: x.ip, label: x.unavailable ? `${x.ip} (unavailable: ${x.unavailable})` : x.ip }));
};
const select = (w: Win, name: string, label: string, options: { value: string; label: string }[], full = false): string => {
  const key = `p:${name}`;
  if (!options.some((o) => o.value === w.form[key])) w.form[key] = options[0]?.value ?? '';
  return `<label class="field grow ${full ? 'full' : ''}"><span>${label}</span><select data-f="${key}">${options
    .map((o) => `<option value="${esc(o.value)}" ${o.value === w.form[key] ? 'selected' : ''}>${esc(o.label)}</option>`)
    .join('')}</select></label>`;
};
/** A YES / NO checkbox for command cards. */
const checkbox = (w: Win, name: string, label: string): string =>
  `<label class="check full"><input type="checkbox" data-f="p:${name}" ${w.form[`p:${name}`] === 'YES' ? 'checked' : ''}> ${label}</label>`;
/** Groups buttons onto their own line under a full-width field. */
const btns = (html: string): string => `<div class="cmd-btns">${html}</div>`;
/** A button that runs `cmd`. Inside a form card it submits (so Enter picks the first one). */
const btn = (w: Win, cmd: string, label: string, style = '', submit = false): string =>
  submit
    ? `<button class="cmd-btn ${style}" type="submit" data-cmd="${cmd}">${label}</button>`
    : `<button class="cmd-btn ${style}" type="button" data-act="mcmd:${w.id}:${cmd}">${label}</button>`;

/**
 * Run a command whose typed inputs must be entered fresh each time: on success the `clear` fields are emptied.
 */
async function runFresh(w: Win, system: SystemId, module: string, fn: string, params: Record<string, string>, clear: string[]): Promise<void> {
  if (await execute(w, system, module, fn, params)) {
    for (const k of clear) w.form[`p:${k}`] = '';
    renderWin(w);
  }
}
const txParam = (w: Win): Record<string, string> => ({ txId: w.form['p:txId'] ?? '' });
/** A link to a module page by its address ("10.0.0.30/payment-queue"): brings up a window showing it, or opens one. */
const pageLink = (system: SystemId, module: string): string =>
  `<button type="button" class="page-link" data-act="page:${system}:${module}">${esc(`${sysAddress(system)}/${slug(module)}`)}</button>`;

/** Client Requests: where requests get answered, for the pages this seat can write. */
function requestLinks(): string {
  const v = view();
  const lines: string[] = [];
  if (moduleAccess(v, 'TRANSACTIONS', 'PAYMENT_QUEUE') === 'WRITE') lines.push(`Create a payment at ${pageLink('TRANSACTIONS', 'PAYMENT_QUEUE')}`);
  if (moduleAccess(v, 'CLIENT_DATA', 'CUSTOMER_RECORDS') === 'WRITE') lines.push(`Modify accounts at ${pageLink('CLIENT_DATA', 'CUSTOMER_RECORDS')}`);
  return lines.length ? `<p class="cmd-hint">${lines.join('<br>')}</p>` : '';
}

/** Read card for a stage: "what's waiting for me?" and "what did I just do?". */
const viewCard = (w: Win, title: string, pendingLabel: string): string =>
  card(title, 'READ', btn(w, 'view:PENDING', pendingLabel) + btn(w, 'view:ALL', 'All', 'alt'));

interface ModulePage {
  commands: (w: Win) => string;
  run: (w: Win, cmd: string, arg?: string) => void;
  /** A page with a live monitor: the READ function its "auto-update" checkbox refreshes quietly every second. */
  monitor?: (w: Win) => { fn: string; params: Record<string, string> };
}

const MODULE_PAGES: Record<string, ModulePage> = {
  'HIDDEN_HOST.BLACKNET': {
    commands: (w) =>
      card('Read messages', 'READ', btn(w, 'view', 'Read the board') + checkbox(w, 'monitor', 'Auto-update every second (only opening the board is logged)')) +
      card(
        'Post a message',
        'WRITE',
        `<p class="hint full">${
          view().me.alias
            ? `You post as <b class="mono">${esc(view().me.alias)}</b> (with someone else's code, as theirs).`
            : 'Posts show the alias of the code\'s owner.'
        }</p>` +
          input(w, 'text', 'Message', 'say something', true, true) +
          btns(btn(w, 'post', 'Post', '', true)),
        `${w.id}:post`,
      ),
    run: (w, cmd) => {
      if (cmd === 'view') {
        execute(w, 'HIDDEN_HOST', 'BLACKNET', 'READ_MESSAGES', {});
        w.liveEnd = w.out.length;
      } else runFresh(w, 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: w.form['p:text'] ?? '' }, ['text']);
    },
    monitor: () => ({ fn: 'READ_MESSAGES', params: {} }),
  },
  'HIDDEN_HOST.TARGET_LEDGER': {
    commands: (w) =>
      card('View targets', 'READ', btn(w, 'view', 'All target accounts') + checkbox(w, 'monitor', 'Auto-update every second (only opening the ledger is logged)')),
    run: (w, cmd) => {
      if (cmd !== 'view') return;
      execute(w, 'HIDDEN_HOST', 'TARGET_LEDGER', 'VIEW_TARGETS', {});
      w.liveEnd = w.out.length;
    },
    monitor: () => ({ fn: 'VIEW_TARGETS', params: {} }),
  },
  'HIDDEN_HOST.HOST_LOG': {
    commands: (w) =>
      card(
        'View host log',
        'READ',
        // Like the Master Log: all white, and the last one pressed (the one the auto-update keeps refreshing) is blue.
        ([['ALL', 'Everything'], ['ALERTS', 'Alerts']] as const)
          .map(([show, label]) => btn(w, `view:${show}`, label, w.form['p:hostFilter'] === show ? '' : 'alt'))
          .join('') + checkbox(w, 'monitor', 'Auto-update every second (only opening the view is logged)'),
      ),
    run: (w, _cmd, arg) => {
      w.form['p:hostFilter'] = arg ?? w.form['p:hostFilter'] ?? 'ALL';
      execute(w, 'HIDDEN_HOST', 'HOST_LOG', 'VIEW_HOST_LOG', { show: w.form['p:hostFilter'] });
      w.liveEnd = w.out.length;
    },
    monitor: (w) => ({ fn: 'VIEW_HOST_LOG', params: { show: w.form['p:hostFilter'] ?? 'ALL' } }),
  },
  'HIDDEN_HOST.CREDENTIAL_CACHE': {
    commands: (w) => card('View cache', 'READ', btn(w, 'view', 'Compromised credentials')),
    run: (w) => execute(w, 'HIDDEN_HOST', 'CREDENTIAL_CACHE', 'VIEW_CACHE', {}),
  },
  'HIDDEN_HOST.INFILTRATION': {
    commands: (w) =>
      card(
        'Create proxy',
        'WRITE',
        input(w, 'proxyIp', 'Proxy IP (unused)', '10.1.0.77', true, true) +
          btns(btn(w, 'createProxy', 'Set up proxy · loud', 'loud', true)) +
          '<div class="kit-progress full" data-kit="PROXY"></div>',
        `${w.id}:createProxy`,
      ) +
      card(
        'Reroute IP',
        'WRITE',
        input(w, 'rerouteFrom', 'Reroute IP (blank: your own)', 'your workstation', true) +
          select(w, 'rerouteProxy', 'Appear as proxy', proxyOptions(), true) +
          input(w, 'rerouteSec', 'Seconds (1-60)', '10') +
          btns(btn(w, 'reroute', 'Reroute · noisy', '', true)) + timedSlot('HIDDEN_HOST.INFILTRATION.REROUTE_IP'),
        `${w.id}:reroute`,
      ) +
      card(
        'Create user',
        'WRITE',
        input(w, 'newName', 'Name', 'Dana Pruitt') +
          select(w, 'newRole', 'Role', ROLE_ORDER.map((id) => ({ value: id, label: ROLES[id].label })), true) +
          select(w, 'newProxy', 'At proxy', proxyOptions(), true) +
          btns(btn(w, 'createUser', 'Add user · noisy', '', true)) + timedSlot('HIDDEN_HOST.INFILTRATION.CREATE_USER'),
        `${w.id}:createUser`,
      ),
    run: (w, cmd) => {
      if (cmd === 'createProxy') runFresh(w, 'HIDDEN_HOST', 'INFILTRATION', 'CREATE_PROXY', { ip: w.form['p:proxyIp'] ?? '' }, ['proxyIp']);
      else if (cmd === 'reroute')
        runFresh(w, 'HIDDEN_HOST', 'INFILTRATION', 'REROUTE_IP', { source: w.form['p:rerouteFrom'] ?? '', proxy: w.form['p:rerouteProxy'] ?? '', seconds: w.form['p:rerouteSec'] || '10' }, []);
      else if (cmd === 'createUser')
        runFresh(w, 'HIDDEN_HOST', 'INFILTRATION', 'CREATE_USER', { name: w.form['p:newName'] ?? '', role: w.form['p:newRole'] ?? '', proxy: w.form['p:newProxy'] ?? '' }, ['newName']);
    },
  },
  'HIDDEN_HOST.SOCIAL': {
    commands: (w) =>
      card(
        'Spoofed message',
        'WRITE',
        input(w, 'spoofTo', 'To (employee)', 'Sarah') +
          input(w, 'spoofFrom', 'Appear from', 'Mike', true) +
          input(w, 'spoofText', 'Message', 'say something', true, true) +
          btns(btn(w, 'spoof', 'Send · noisy', '', true)) + timedSlot('HIDDEN_HOST.SOCIAL.SPOOFED_MESSAGE'),
        `${w.id}:spoof`,
      ) +
      card(
        'Scam account request',
        'WRITE',
        input(w, 'scamCust', 'From customer', 'Tanaka Holdings or CU3', true, true) +
          select(
            w,
            'scamKind',
            'Asking for',
            [
              { value: 'SET_PRIMARY', label: 'Make an account their primary' },
              { value: 'ADD_AND_PRIMARY', label: 'Add an account and make it primary' },
              { value: 'ADD_ACCOUNT', label: 'Add an account' },
              { value: 'REMOVE_ACCOUNT', label: 'Remove an account' },
            ],
            true,
          ) +
          input(w, 'scamAcct', 'Account', '18392') +
          btns(btn(w, 'scam', 'Plant request · noisy', '', true)) + timedSlot('HIDDEN_HOST.SOCIAL.SCAM_REQUEST'),
        `${w.id}:scam`,
      ) +
      card(
        'Scam payment request',
        'WRITE',
        input(w, 'scamPayFrom', 'From customer', 'Tanaka Holdings or CU3', true, true) +
          input(w, 'scamPayee', 'Pay to', 'Northwind Freight or CU7', true) +
          input(w, 'scamAmount', 'Amount', '400000') +
          select(
            w,
            'scamUrgent',
            'Urgency',
            [
              { value: 'NO', label: 'Normal' },
              { value: 'YES', label: 'Urgent (shorter deadline)' },
            ],
          ) +
          btns(btn(w, 'scamPay', 'Plant request · noisy', '', true)),
        `${w.id}:scamPay`,
      ),
    run: (w, cmd) => {
      if (cmd === 'spoof')
        runFresh(w, 'HIDDEN_HOST', 'SOCIAL', 'SPOOFED_MESSAGE', { to: w.form['p:spoofTo'] ?? '', from: w.form['p:spoofFrom'] ?? '', text: w.form['p:spoofText'] ?? '' }, ['spoofText']);
      else if (cmd === 'scam')
        runFresh(w, 'HIDDEN_HOST', 'SOCIAL', 'SCAM_REQUEST', { customer: w.form['p:scamCust'] ?? '', kind: w.form['p:scamKind'] ?? '', account: w.form['p:scamAcct'] ?? '' }, ['scamAcct']);
      else if (cmd === 'scamPay')
        runFresh(
          w,
          'HIDDEN_HOST',
          'SOCIAL',
          'SCAM_REQUEST',
          { customer: w.form['p:scamPayFrom'] ?? '', kind: 'PAYMENT', payee: w.form['p:scamPayee'] ?? '', amount: w.form['p:scamAmount'] ?? '', urgent: w.form['p:scamUrgent'] ?? 'NO' },
          ['scamAmount'],
        );
    },
  },
  'HIDDEN_HOST.CLEANUP': {
    commands: (w) =>
      card('Log wiper', 'WRITE', input(w, 'wipeId', 'Log entry', 'L12', true, true) + btns(btn(w, 'wipe', 'Wipe entry · noisy', '', true)) + timedSlot('HIDDEN_HOST.CLEANUP.LOG_WIPER'), `${w.id}:wipe`) +
      card(
        'Alert mute',
        'WRITE',
        `<p class="hint full">Hides the bank's minor alerts for 10s. Loud and reckless alerts, including this tool's own, still get through.</p>` +
          btns(btn(w, 'mute', 'Mute alerts (10s) · loud', 'loud')) + timedSlot('HIDDEN_HOST.CLEANUP.ALERT_MUTE'),
      ),
    run: (w, cmd) => {
      if (cmd === 'wipe') runFresh(w, 'HIDDEN_HOST', 'CLEANUP', 'LOG_WIPER', { logId: w.form['p:wipeId'] ?? '' }, ['wipeId']);
      else if (cmd === 'mute') execute(w, 'HIDDEN_HOST', 'CLEANUP', 'ALERT_MUTE', {});
    },
  },
  'HIDDEN_HOST.ACCESS': {
    commands: (w) => {
      const mods = view()
        .systems.filter((sys) => !sys.hidden)
        .flatMap((sys) => sys.modules.map((m) => ({ value: `${sys.id}.${m.id}`, label: `${sys.label} / ${m.label}` })));
      return (
        card('Code crack', 'WRITE', select(w, 'crackTarget', 'Module', mods, true) + btns(btn(w, 'crack', 'Start crack · noisy per digit', '', true)) + '<div class="kit-progress full" data-kit="CRACK"></div>', `${w.id}:crack`) +
        card('Unlock workstation', 'WRITE', input(w, 'unlockIp', 'Workstation', '10.1.0.12', true, true) + btns(btn(w, 'unlock', 'Unlock · loud', 'loud', true)) + '<div class="kit-progress full" data-kit="UNLOCK"></div>', `${w.id}:unlock`) +
        card('Lockout bomb', 'WRITE', input(w, 'bombIp', 'Workstation', '10.1.0.12', true, true) + btns(btn(w, 'bomb', 'Lock them out · noisy', '', true)) + timedSlot('HIDDEN_HOST.ACCESS.LOCKOUT_BOMB'), `${w.id}:bomb`)
      );
    },
    run: (w, cmd) => {
      if (cmd === 'crack') execute(w, 'HIDDEN_HOST', 'ACCESS', 'CRACK_CODE', { target: w.form['p:crackTarget'] ?? '' });
      else if (cmd === 'bomb') runFresh(w, 'HIDDEN_HOST', 'ACCESS', 'LOCKOUT_BOMB', { target: w.form['p:bombIp'] ?? '' }, ['bombIp']);
      else if (cmd === 'unlock') runFresh(w, 'HIDDEN_HOST', 'ACCESS', 'UNLOCK_WORKSTATION', { target: w.form['p:unlockIp'] ?? '' }, ['unlockIp']);
    },
  },
  'SECURITY.FIREWALL': {
    commands: (w) => {
      // Every module the player knows, except the Firewall itself and the hidden host (not the bank's to control).
      const mods = view()
        .systems.filter((sys) => !sys.hidden)
        .flatMap((sys) => sys.modules.filter((m) => !(sys.id === 'SECURITY' && m.id === 'FIREWALL')).map((m) => ({ value: `${sys.id}.${m.id}`, label: `${sys.label} / ${m.label}` })));
      // One address, three ways to act on it; revoking asks for a confirmation first.
      const confirming = w.form['p:revConfirm'] === 'YES';
      const block = confirming
        ? `<p class="warn full">This action is irreversible. After a ${view().settings.revokeCountdownSec}s countdown, <b>${esc(w.form['p:blockAddr'] ?? '')}</b> loses all access permanently (a workstation's owner also loses every credential). It can only be cancelled from the Firewall before then.</p>` +
          btns(btn(w, 'revokeConfirm', 'Confirm: revoke all access', 'danger') + btn(w, 'revokeBack', 'Back', 'alt'))
        : input(w, 'blockAddr', 'Address', 'workstation or system', true, true) +
          btns(btn(w, 'block', `Block for ${view().settings.blockSec}s`, 'danger', true) + btn(w, 'unblock', 'Unblock', 'alt', true) + btn(w, 'revokeAsk', 'Revoke all access…', 'danger', true)) +
          timedSlot('SECURITY.FIREWALL.BLOCK_ADDRESS', 'SECURITY.FIREWALL.UNBLOCK_ADDRESS');
      return (
        card('View firewall status', 'READ', btn(w, 'view', 'Status, blocks and revocations')) +
        card(
          'Control a module',
          'WRITE',
          select(w, 'target', 'Module', mods, true) +
            btns(
              // The three states its light shows: Offline, Online, Full access (online with security off).
              // Coloured like the light; the one matching the chosen module's state now is filled (updateModuleLights).
              btn(w, 'state:OFFLINE', 'Offline', 'st red', true) +
                btn(w, 'state:ONLINE', 'Online', 'st green', true) +
                btn(w, 'state:FULL', 'Full access', 'st blue', true),
            ) + timedSlot('SECURITY.FIREWALL.SET_MODULE_STATUS', 'SECURITY.FIREWALL.SET_SECURITY'),
          `${w.id}:state:OFFLINE`,
        ) +
        card('Block Address', 'WRITE', block, confirming ? undefined : `${w.id}:block`) +
        card('Cancel a revocation', 'WRITE', input(w, 'revId', 'Revocation', 'R1', true, true) + btns(btn(w, 'cancelRev', 'Cancel it', '', true)) + timedSlot('SECURITY.FIREWALL.CANCEL_REVOCATION'), `${w.id}:cancelRev`)
      );
    },
    run: (w, cmd, arg) => {
      const f = (k: string): string => w.form[`p:${k}`] ?? '';
      const fw = (fn: string, params: Record<string, string>, clear: string[] = []) => runFresh(w, 'SECURITY', 'FIREWALL', fn, params, clear);
      if (cmd === 'view') execute(w, 'SECURITY', 'FIREWALL', 'VIEW_STATUS', {});
      else if (cmd === 'state') void setModuleState(w, f('target'), arg ?? '');
      else if (cmd === 'block') fw('BLOCK_ADDRESS', { address: f('blockAddr') }, ['blockAddr']);
      else if (cmd === 'unblock') fw('UNBLOCK_ADDRESS', { address: f('blockAddr') }, ['blockAddr']);
      else if (cmd === 'cancelRev') fw('CANCEL_REVOCATION', { revocationId: f('revId') }, ['revId']);
      else if (cmd === 'revokeAsk' && f('blockAddr').trim()) {
        w.form['p:revConfirm'] = 'YES';
        renderWin(w);
      } else if (cmd === 'revokeBack') {
        w.form['p:revConfirm'] = 'NO';
        renderWin(w);
      } else if (cmd === 'revokeConfirm') {
        w.form['p:revConfirm'] = 'NO';
        fw('REVOKE_ALL_ACCESS', { address: f('blockAddr') }, ['blockAddr']);
        renderWin(w);
      }
    },
  },
  'SECURITY.MASTER_LOG': {
    commands: (w) =>
      card(
        'View log',
        'READ',
        // All white; the last one pressed (the one the auto-update keeps refreshing) is blue.
        ([['PLAYERS', 'Player activity'], ['ALL', 'Everything'], ['ALERTS', 'Alerts']] as const)
          .map(([show, label]) => btn(w, `view:${show}`, label, w.form['p:logFilter'] === show ? '' : 'alt'))
          .join('') + checkbox(w, 'monitor', 'Auto-update every second (only opening the view is logged)'),
      ) +
      card('Trace a log entry', 'WRITE', input(w, 'logId', 'Log entry', 'L12 or 12', true, true) + btns(btn(w, 'trace', 'Trace', '', true) + '<span class="trace-cool" title="Trace engine cooling down"></span>') + '<div class="kit-progress full" data-kit="TRACE"></div>', `${w.id}:trace`),
    run: (w, cmd, arg) => {
      if (cmd === 'view') {
        w.form['p:logFilter'] = arg ?? w.form['p:logFilter'] ?? 'PLAYERS';
        execute(w, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: w.form['p:logFilter'] });
        w.liveEnd = w.out.length; // the block just printed is the one a live monitor keeps replacing
      } else {
        // A live refresh would scroll the trace result away, so tracing stops the auto-update.
        if (w.form['p:monitor'] === 'YES') {
          w.form['p:monitor'] = 'NO';
          w.out.push({ cls: 'dim', text: 'Auto-update disabled so the trace result stays on screen.' });
        }
        runFresh(w, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: w.form['p:logId'] ?? '' }, ['logId']);
      }
    },
    monitor: (w) => ({ fn: 'VIEW_LOG', params: { show: w.form['p:logFilter'] ?? 'PLAYERS' } }),
  },
  'SECURITY.EMPLOYEE_RECORDS': {
    commands: (w) =>
      card('View employees', 'READ', btn(w, 'view', 'All employees')) +
      card('Reset a lockout', 'WRITE', input(w, 'lockAddr', 'Workstation', '10.1.0.12', true, true) + btns(btn(w, 'reset', 'Unlock now', '', true)) + timedSlot('SECURITY.EMPLOYEE_RECORDS.RESET_LOCKOUT'), `${w.id}:reset`),
    run: (w, cmd) => {
      if (cmd === 'view') execute(w, 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES', {});
      else runFresh(w, 'SECURITY', 'EMPLOYEE_RECORDS', 'RESET_LOCKOUT', { address: w.form['p:lockAddr'] ?? '' }, ['lockAddr']);
    },
  },
  'SECURITY.PERMISSIONS': {
    commands: (w) => {
      const v = view();
      const people = v.players.map((p) => ({ value: p.id, label: `${p.name} (${p.roleLabel})` }));
      const scopes = v.systems.filter((sys) => !sys.hidden).flatMap((sys) => [
        { value: `${sys.id}.*`, label: `All of ${sys.label}` },
        ...sys.modules.map((m) => ({ value: `${sys.id}.${m.id}`, label: `${sys.label} / ${m.label}` })),
      ]);
      const access = [
        { value: 'READ', label: 'Read only' },
        { value: 'WRITE', label: 'Read & write' },
      ];
      return (
        card('View credentials', 'READ', btn(w, 'view:ACTIVE', 'Active') + btn(w, 'view:ALL', 'All, incl. revoked', 'alt')) +
        card(
          'Revoke a credential',
          'WRITE',
          input(w, 'credentialId', 'Credential', 'C12 or 12', true, true) +
            btns(btn(w, 'revoke', 'Revoke', 'danger', true) + btn(w, 'cancelRevoke', 'Cancel a revocation', 'alt', true)) +
            timedSlot('SECURITY.PERMISSIONS.REVOKE_CREDENTIAL', 'SECURITY.PERMISSIONS.CANCEL_REVOKE'),
          `${w.id}:revoke`,
        ) +
        card(
          'Issue a credential',
          'WRITE',
          select(w, 'owner', 'Issue to', people, true) +
            select(w, 'scope', 'Access to', scopes, true) +
            select(w, 'permission', 'Permission', access, true) +
            btns(btn(w, 'create', 'Issue credential', '', true)) +
            timedSlot('SECURITY.PERMISSIONS.CREATE_CREDENTIAL'),
          `${w.id}:create`,
        )
      );
    },
    run: (w, cmd, arg) => {
      const f = (k: string): string => w.form[`p:${k}`] ?? '';
      if (cmd === 'view') execute(w, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', { show: arg ?? 'ACTIVE' });
      else if (cmd === 'revoke') runFresh(w, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: f('credentialId') }, ['credentialId']);
      else if (cmd === 'cancelRevoke') runFresh(w, 'SECURITY', 'PERMISSIONS', 'CANCEL_REVOKE', { credentialId: f('credentialId') }, ['credentialId']);
      else execute(w, 'SECURITY', 'PERMISSIONS', 'CREATE_CREDENTIAL', { owner: f('owner'), scope: f('scope'), permission: f('permission') });
    },
  },
  'CLIENT_DATA.CUSTOMER_RECORDS': {
    commands: (w) =>
      card('View customers', 'READ', btn(w, 'view:MINE', 'My customers') + btn(w, 'view:ALL', 'All customers', 'alt')) +
      card(
        'Add account',
        'WRITE',
        input(w, 'addReq', 'Request (optional)', 'REQ-1 or 1') +
          input(w, 'addCust', 'Customer', 'CU1 or 1') +
          input(w, 'addAcct', 'Account', '12345', true) +
          checkbox(w, 'addPrimary', 'Make it their primary account') +
          btns(btn(w, 'add', 'Add account', '', true)),
        `${w.id}:add`,
      ) +
      card(
        'Set primary account',
        'WRITE',
        input(w, 'priReq', 'Request (optional)', 'REQ-1 or 1') +
          input(w, 'priCust', 'Customer', 'CU1 or 1') +
          input(w, 'priAcct', 'Account', '12345', true) +
          btns(btn(w, 'primary', 'Set primary', '', true)),
        `${w.id}:primary`,
      ) +
      card(
        'Remove account',
        'WRITE',
        input(w, 'remReq', 'Request (optional)', 'REQ-1 or 1') +
          input(w, 'remCust', 'Customer', 'CU1 or 1') +
          input(w, 'remAcct', 'Account', '12345', true) +
          btns(btn(w, 'remove', 'Remove account', 'danger', true)),
        `${w.id}:remove`,
      ),
    run: (w, cmd, arg) => {
      const f = (k: string): string => w.form[`p:${k}`] ?? '';
      const mod = (fn: string, params: Record<string, string>, clear: string[]) => runFresh(w, 'CLIENT_DATA', 'CUSTOMER_RECORDS', fn, params, clear);
      if (cmd === 'view') execute(w, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: arg ?? 'MINE' });
      else if (cmd === 'add')
        mod('ADD_ACCOUNT', { customerId: f('addCust'), account: f('addAcct'), makePrimary: f('addPrimary') || 'NO', requestId: f('addReq') }, ['addCust', 'addAcct', 'addReq', 'addPrimary']);
      else if (cmd === 'primary') mod('SET_PRIMARY', { customerId: f('priCust'), account: f('priAcct'), requestId: f('priReq') }, ['priCust', 'priAcct', 'priReq']);
      else if (cmd === 'remove') mod('REMOVE_ACCOUNT', { customerId: f('remCust'), account: f('remAcct'), requestId: f('remReq') }, ['remCust', 'remAcct', 'remReq']);
    },
  },
  'CLIENT_DATA.VERIFICATION': {
    commands: (w) =>
      card('View verification queue', 'READ', btn(w, 'view:PENDING', 'Pending verification') + btn(w, 'view:ALL', 'All', 'alt')) +
      card('Verify a change', 'WRITE', input(w, 'changeId', 'Change', 'CH-1 or 1', true, true) + btns(btn(w, 'verify', 'Verify', '', true)), `${w.id}:verify`) +
      card(
        'Investigate changes',
        'READ',
        input(w, 'target', 'Customer or account', 'CU3 or 12345', true, true) + btns(btn(w, 'investigate', 'Show change history', 'alt', true)),
        `${w.id}:investigate`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'CLIENT_DATA', 'VERIFICATION', 'VIEW_VERIFICATION', { show: arg ?? 'PENDING' });
      else if (cmd === 'investigate') runFresh(w, 'CLIENT_DATA', 'VERIFICATION', 'INVESTIGATE_CHANGES', { target: w.form['p:target'] ?? '' }, ['target']);
      else runFresh(w, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: w.form['p:changeId'] ?? '' }, ['changeId']);
    },
  },
  'CLIENT_DATA.CLIENT_REQUESTS': {
    commands: (w) =>
      card('View requests', 'READ', btn(w, 'view:OPEN', 'Open requests') + btn(w, 'view:ALL', 'All requests', 'alt') + requestLinks()) +
      card(
        'Archive a request',
        'WRITE',
        input(w, 'requestId', 'Request', 'REQ-1 or 1', true, true) +
          input(w, 'reason', 'Reason', 'Why close it without acting?', true, true) +
          btns(btn(w, 'archive', 'Archive', 'danger', true)),
        `${w.id}:archive`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS', { show: arg ?? 'OPEN' });
      else runFresh(w, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: w.form['p:requestId'] ?? '', reason: w.form['p:reason'] ?? '' }, ['requestId', 'reason']);
    },
  },
  'TRANSACTIONS.PAYMENT_QUEUE': {
    commands: (w) =>
      card('View queue', 'READ', btn(w, 'view:ACTIVE', 'Pending payments') + btn(w, 'view:ALL', 'All payments', 'alt')) +
      card(
        'Create payment',
        'WRITE',
        input(w, 'requestId', 'Request (optional)', 'REQ-1 or 1') +
          input(w, 'originAccount', 'Originator account', '12345') +
          input(w, 'beneficiaryId', 'Beneficiary', 'CU1 or 1') +
          input(w, 'amount', 'Amount', '1,000,000 or 1m', true) +
          btn(w, 'create', 'Create', '', true),
        `${w.id}:create`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', { show: arg ?? 'ACTIVE' });
      else if (cmd === 'create') {
        const amount = parseAmount(w.form['p:amount'] ?? '');
        // Every payment needs its amount typed fresh.
        runFresh(w, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: w.form['p:originAccount'] ?? '', beneficiaryId: w.form['p:beneficiaryId'] ?? '', amount: amount === null ? '' : String(amount), requestId: w.form['p:requestId'] ?? '' }, ['amount', 'requestId']);
      }
    },
  },
  'TRANSACTIONS.RISK_CHECK': {
    commands: (w) =>
      viewCard(w, 'View risk queue', 'Pending check') +
      card(
        'Score risk',
        'WRITE',
        input(w, 'txId', 'Transaction', 'TX-0001 or 1', true, true) +
          scorePicker(w) +
          input(w, 'reason', 'Reason (optional)', 'Why this score?', true, true) +
          btns(btn(w, 'check', 'Submit score', '', true)),
        `${w.id}:check`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'TRANSACTIONS', 'RISK_CHECK', 'VIEW_RISK_QUEUE', { show: arg ?? 'PENDING' });
      else if (cmd === 'auto') void saveAuto(w, 'SET_AUTO_SCORE', { maxAmount: thresholdParam(w), source: w.form['p:source'] ?? '', origin: w.form['p:origin'] ?? '', payee: w.form['p:payee'] ?? '' });
      else runFresh(w, 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { ...txParam(w), score: w.form['p:score'] ?? '', reason: w.form['p:reason'] ?? '' }, ['txId', 'score', 'reason']);
    },
  },
  'TRANSACTIONS.AUTHORIZATION': {
    commands: (w) =>
      viewCard(w, 'View authorization queue', 'Pending authorization') +
      card(
        'Decide on a payment',
        'WRITE',
        input(w, 'txId', 'Transaction', 'TX-0001 or 1', true, true) +
          input(w, 'reason', 'Reason', 'Required to hold or reject', true, true) +
          btns(btn(w, 'APPROVE', 'Approve', '', true) + btn(w, 'HOLD', 'Hold', 'alt', true) + btn(w, 'REJECT', 'Reject', 'danger', true)),
        `${w.id}:APPROVE`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'TRANSACTIONS', 'AUTHORIZATION', 'VIEW_AUTH_QUEUE', { show: arg ?? 'PENDING' });
      else if (cmd === 'auto') void saveAuto(w, 'SET_AUTO_APPROVE', { level: w.form['p:level'] ?? '' });
      else runFresh(w, 'TRANSACTIONS', 'AUTHORIZATION', cmd, { ...txParam(w), reason: w.form['p:reason'] ?? '' }, ['txId', 'reason']);
    },
  },
  'TRANSACTIONS.SETTLEMENT': {
    commands: (w) =>
      viewCard(w, 'View settlement queue', 'Awaiting settlement') +
      card(
        'Pay out or claw back',
        'WRITE',
        input(w, 'txId', 'Transaction', 'TX-0001 or 1', true, true) +
          btns(btn(w, 'SETTLE', 'Settle', '', true) + btn(w, 'REVERSE', 'Reverse', 'danger', true)),
        `${w.id}:SETTLE`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'TRANSACTIONS', 'SETTLEMENT', 'VIEW_SETTLEMENT', { show: arg ?? 'PENDING' });
      else if (cmd === 'auto') void saveAuto(w, 'SET_AUTO_SETTLE', { maxAmount: thresholdParam(w) });
      else runFresh(w, 'TRANSACTIONS', 'SETTLEMENT', cmd, txParam(w), ['txId']);
    },
  },
};

/** "1,000,000", "$1m", "250k", "2.5M" -> number; null if unreadable. */
function parseAmount(raw: string): number | null {
  const m = raw.replace(/[$,\s]/g, '').toLowerCase().match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1));
}

function modulePageHtml(w: Win, r: ModuleRoute): string {
  const v = view();
  const page = MODULE_PAGES[`${r.system}.${r.module}`];
  // The credential row stays put at the top, the commands scroll under it.
  // data-open: whether it was in full access when drawn, so updateModuleLights redraws the page when that changes.
  const key = `${r.system}.${r.module}`;
  const cred = `<section class="mod-cred" aria-label="Credential" data-win="${w.id}" data-open-key="${key}" data-open="${fullAccess(v, key) ? 1 : 0}">${credentialFields(
    w,
    v,
    (c) => c.system === r.system && (c.module === null || c.module === r.module),
    // Prefer one that allows everything on this module.
    (c) => c.permission === 'WRITE' && c.fn === null,
    `${r.system}.${r.module}`,
  )}</section>`;
  return splitBody(w, cred + autoPanelHtml(w, r), `<div class="cmds">${page.commands(w)}</div>`);
}

/**
 * A system's pages (its module list and every module page): `pinned` stays at the top, `scrolling` scrolls
 * under it, and the terminal below keeps its share of the window, or the height the player dragged it to with
 * the bar above it. The window keeps that height from page to page, so the terminal never jumps.
 */
function splitBody(w: Win, pinned: string, scrolling: string): string {
  return `<div class="wbody mod">
    ${pinned}
    <div class="mod-top">${scrolling}</div>
    <div class="split" data-split="${w.id}" title="Drag to resize the terminal (double-click to reset)" aria-hidden="true"></div>
    ${terminalHtml(w, w.termH)}
  </div>`;
}

// ---- Workstation screens: your own (My workstation) or someone else's once logged in ------------
const TABS: [Tab, string][] = [
  ['profile', 'Profile'],
  ['codes', 'Credentials'],
  ['activity', 'Activity'],
  ['messages', 'Messages'],
];

/** Tabs + body for a workstation. `remote` = someone else's, shown read-only. */
/** Quitting, at the bottom of your own profile: a button, then a warning to confirm. */
function quitHtml(f: Record<string, string>): string {
  if (f.quitAsk !== 'YES') return `<div class="quit"><button class="small-btn danger" data-act="quitask">Quit…</button></div>`;
  return `<div class="quit asking"><p><b>Quit your job?</b> This cannot be undone. The bank's systems stop accepting you for the rest of the game, and everyone gets a parting message from you. The game ends when every Thief is out.</p>
    <button class="small-btn danger" data-act="quitdo">Confirm: I quit</button> <button class="small-btn" data-act="quitback">Back</button></div>`;
}

function workstationHtml(w: Win, ws: WorkstationView, current: Tab, remote: boolean): string {
  const f = w.form;
  const v = view();
  const others = v.players.filter((p) => p.id !== selected);
  if (!others.some((p) => p.id === f.shareTo)) f.shareTo = others[0]?.id ?? '';
  if (!others.some((p) => p.id === f.msgTo)) f.msgTo = others[0]?.id ?? '';
  const playerOpts = (cur: string): string =>
    others.map((p) => `<option value="${p.id}" ${cur === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const their = remote ? `${ws.name}'s` : 'Your';

  let body = '';
  if (current === 'profile') {
    const job = ws.job;
    const list = (items: string[]): string => `<ul class="job-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    body = `
      <dl class="kv"><dt>Name</dt><dd>${esc(ws.name)}</dd><dt>Role</dt><dd>${esc(ws.roleLabel)}</dd><dt>IP</dt><dd>${esc(ws.ip)}</dd>${ws.alias ? `<dt>Blacknet alias</dt><dd class="mono">${esc(ws.alias)}</dd>` : ''}<dt>Account</dt><dd>${esc(ws.bankAccount)}${ws.bankBalance === null ? "" : " · " + money(ws.bankBalance)}</dd></dl>
      ${ws.allegiance ? `<p class="side-line ${ws.allegiance}">You are ${ws.allegiance === 'BLACK' ? 'a thief' : 'a regular employee'}</p>` : ''}
      ${ws.objective === null ? '' : `<h4>${their} objective</h4><div class="note">${esc(ws.objective)}</div>`}
      ${ws.motivation === null ? '' : `<p class="hint">${esc(ws.motivation)}</p>`}
      <h4>Job: ${esc(ws.roleLabel)}</h4><p class="job-summary">${esc(job.summary)}</p>
      <h4>What you do</h4>${list(job.duties)}
      ${(job.checks ?? []).map((ch) => `
        <h4>${esc(ch.title)}</h4>${ch.intro ? `<p class="job-summary">${esc(ch.intro)}</p>` : ''}
        <table class="job-checks"><thead><tr><th>Look for</th><th>Where</th><th>What it suggests</th></tr></thead><tbody>${ch.rows
          .map((r) => `<tr><td>${esc(r.look)}</td><td>${esc(r.where)}</td><td>${esc(r.means)}</td></tr>`)
          .join('')}</tbody></table>`).join('')}
      <h4>Who you depend on</h4>${list(job.dependsOn)}
      <h4>Rules to know</h4>${list(job.rules)}
      ${job.operative ? `<div class="job-secret"><h4>Operative handbook</h4>${list(job.operative)}</div>` : ''}
      ${remote || ws.terminated ? '' : quitHtml(f)}`;
  } else if (current === 'codes') {
    body = `
      <p class="hint">Logs name the credential owner, not the person who typed the code.</p>
      ${remote || !CREDENTIAL_SHARING_ENABLED ? '' : `<div class="sharebar"><span>Share with</span><select data-f="shareTo">${playerOpts(f.shareTo)}</select></div>`}
      <table class="cred">${ws.credentials
        .map(
          (c) => `<tr>
            <td><span class="code ${c.status === 'REVOKED' ? 'rev' : ''}">${esc(c.code)}</span></td>
            <td>${esc(c.id)} ${c.own ? '' : `<em>${esc(c.ownerName)}'s</em>`}<br><small>${esc(c.scope)}${c.status === 'REVOKED' ? ', revoked' : ''}</small></td>
            ${remote || !CREDENTIAL_SHARING_ENABLED ? '' : `<td><button class="small-btn" data-act="share:${c.id}">Share</button></td>`}</tr>`,
        )
        .join('')}</table>`;
  } else if (current === 'activity') {
    body = `
      <p class="hint">${remote ? `What ${esc(ws.name)} actually did.` : 'Only you can read this. It records what you actually did.'}</p>
      <ul class="feed">${[...ws.activity].reverse().map((a) => `<li><time>${a.time}</time>${esc(a.text)}</li>`).join('') || '<li>Nothing yet.</li>'}</ul>`;
  } else {
    body = `
      ${ws.messages.map((m) => `<div class="msg ${m.incoming ? '' : 'sent'}"><small>${m.time} ${m.incoming ? 'from ' + esc(m.fromName) : 'to ' + esc(m.toName)}</small>${esc(m.text)}</div>`).join('') || '<p class="hint">No messages.</p>'}
      ${remote ? '' : `<label class="field"><span>To</span><select data-f="msgTo">${playerOpts(f.msgTo)}</select></label>
      <label class="field"><span>Message</span><textarea data-f="msgText" rows="3">${esc(f.msgText ?? '')}</textarea></label>
      <p><button class="small-btn" data-act="send">Send</button></p>`}`;
    if (!remote) seenMessages[selected] = ws.messages.filter((m) => m.incoming).length;
  }
  const act = (id: Tab): string => (remote ? `wtab:${w.id}:${id}` : `tab:${id}`);
  return `<div class="tabs" role="tablist">${TABS
    .map(([id, label]) => `<button role="tab" aria-selected="${current === id}" class="${current === id ? 'on' : ''}" data-act="${act(id)}">${label}</button>`)
    .join('')}</div><div class="wbody">${w.notice.map((l) => `<div class="notice ${l.cls}">${esc(l.text)}</div>`).join('')}${body}</div>`;
}

function personalHtml(w: Win): string {
  return workstationHtml(w, view().me, tab, false);
}

/** Browser page for a workstation address: locked, unlocked (read-only), or your own. */
function remoteHtml(w: Win, r: Extract<Route, { kind: 'workstation' }>): string {
  const v = view();
  const name = v.players.find((p) => p.id === r.playerId)?.name ?? r.address;
  if (r.playerId === selected) {
    return `<div class="wbody"><h2>This is your workstation</h2><p><button class="small-btn" data-act="me">Open My workstation</button></p></div>`;
  }
  const ws = v.remote[r.playerId];
  if (ws) {
    const current = (w.form.wtab as Tab | undefined) ?? 'profile';
    return `<div class="crumbs"><span>${esc(name)}'s workstation</span><i>/</i><span class="hint">logged in, read-only</span></div>${workstationHtml(w, ws, current, true)}`;
  }
  return `<div class="wbody"><div class="lock">
      <svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><rect x="10" y="21" width="28" height="20" rx="3"/><path d="M16 21v-6a8 8 0 0 1 16 0v6"/></svg>
      <h2>${esc(name)}'s workstation</h2>
      <p class="hint">${esc(r.address)}. Log in with ${esc(name)}'s workstation code.</p>
      ${credentialFields(w, v, (c) => c.system === 'WORKSTATION' && c.ownerName === name)}
      <button class="run" data-act="wunlock:${w.id}">Log in</button>
      ${w.notice.map((l) => `<div class="notice ${l.cls}">${esc(l.text)}</div>`).join('')}
    </div></div>`;
}

async function unlock(w: Win): Promise<void> {
  const r = route(w);
  if (!r || r.kind !== 'workstation') return;
  const result = await act({ type: 'ACCESS_WORKSTATION', playerId: selected, targetId: r.playerId, code: (w.form.code ?? '').trim() });
  w.notice = result.ok ? [] : [{ cls: 'bad', text: result.message }];
  w.form.manualCode = '';
  w.form.wtab = 'profile';
  renderWin(w);
  refresh();
}

function renderPersonal(force = false): void {
  for (const w of wins()) {
    if (w.kind !== 'personal' && route(w)?.kind !== 'workstation') continue;
    const el = winEl(w);
    // Do not wipe out something the player is typing.
    if (!force && el && el.contains(document.activeElement) && document.activeElement !== el) continue;
    renderWin(w);
  }
}

async function doShare(w: Win, credId: string): Promise<void> {
  const result = await act({ type: 'SHARE_CREDENTIAL', playerId: selected, credentialId: credId, toPlayerId: w.form.shareTo });
  w.notice = [{ cls: result.ok ? 'ok' : 'bad', text: result.message }];
  refresh();
  renderPersonal(true);
}

async function doQuit(w: Win): Promise<void> {
  const result = await act({ type: 'QUIT', playerId: selected });
  w.form.quitAsk = '';
  w.notice = [{ cls: result.ok ? 'ok' : 'bad', text: result.message }];
  refresh();
  renderPersonal(true);
}

async function doSend(w: Win): Promise<void> {
  const result = await act({ type: 'SEND_MESSAGE', playerId: selected, toPlayerId: w.form.msgTo, text: w.form.msgText ?? '' });
  if (result.ok) w.form.msgText = '';
  w.notice = result.ok ? [] : [{ cls: 'bad', text: result.message }];
  refresh();
  renderPersonal(true);
}

// ---- Notifications ------------------------------------------------------------------------------
const BELL_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;
const TOAST_MS = 5000;
/** Last notification id each seat has already popped up (N12 -> 12). */
const seenNotices: Record<PlayerId, number> = {};
const noticeNum = (id: string): number => Number(id.slice(1));

/** The page's bell: on or off. Only pages listed in WATCHABLE have one. */
function bellHtml(key: string): string {
  const what = WATCHABLE[key];
  if (!what) return '';
  const on = view().watching.includes(key);
  return `<button class="bell ${on ? 'on' : ''}" data-act="watch:${key}" title="Notify me when ${esc(what)}" aria-pressed="${on}">${BELL_SVG}<span>${on ? 'On' : 'Off'}</span></button>`;
}

// ---- Automation badge: each payment stage's setting at a glance; tap it for the details and to change it ----
const GEAR_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
type AutoStage = keyof StageAutomation;
const AUTO_STAGES: AutoStage[] = ['RISK_CHECK', 'AUTHORIZATION', 'SETTLEMENT'];
const autoStage = (r: Route): AutoStage | null =>
  r.kind === 'module' && r.system === 'TRANSACTIONS' && (AUTO_STAGES as string[]).includes(r.module) ? (r.module as AutoStage) : null;

/** The badge's text ("< $1,000,000", "Low", "Off") and the details' sentence. Null when this seat cannot read the stage. */
function autoText(stage: AutoStage): { short: string; long: string; on: boolean } | null {
  const a = view().automation;
  if (stage === 'RISK_CHECK' && a.RISK_CHECK) {
    const x = a.RISK_CHECK;
    if (x.maxAmount <= 0) return { short: 'Off', long: 'Automatic scoring is off: every payment waits for someone to score it.', on: false };
    const source = x.source === 'AUTOMATIC' ? 'automatic payments' : 'automatic and manual payments';
    const origin = x.origin === 'CUSTOMER' ? 'paid from a customer account' : 'paid from any account, floating ones too';
    const payee = x.payee === 'VERIFIED' ? 'to a verified primary' : 'to any primary, verified or not';
    return {
      short: `< ${money(x.maxAmount)}`,
      long: `Scores LOW by itself: ${source} up to ${money(x.maxAmount)}, ${origin}, ${payee}. Anything else waits for someone to score it.`,
      on: true,
    };
  }
  if (stage === 'AUTHORIZATION' && a.AUTHORIZATION) {
    const up = a.AUTHORIZATION.upTo;
    if (up === 'NONE') return { short: 'Off', long: 'Automatic approval is off: every risk-checked payment waits for someone to approve it.', on: false };
    const which = up === 'LOW' ? 'LOW' : `${up} or lower`;
    return { short: up[0] + up.slice(1).toLowerCase(), long: `Approves by itself: risk-checked payments scored ${which}. Anything scored higher waits for someone to decide.`, on: true };
  }
  if (stage === 'SETTLEMENT' && a.SETTLEMENT) {
    const max = a.SETTLEMENT.maxAmount;
    if (max <= 0) return { short: 'Off', long: 'Automatic settlement is off: every approved payment waits for someone to settle it.', on: false };
    return { short: `< ${money(max)}`, long: `Settles by itself: approved payments up to ${money(max)}. Larger ones wait for someone to settle them.`, on: true };
  }
  return null;
}

function autoBadgeHtml(w: Win, r: Route): string {
  const stage = autoStage(r);
  const t = stage && autoText(stage);
  if (!t) return '';
  const open = w.form.autoOpen === 'YES';
  return `<button class="auto-badge ${t.on ? 'on' : ''}" data-act="autoedit:${w.id}" title="Automation: tap for details" aria-expanded="${open}">${GEAR_SVG}<span>Auto: ${esc(t.short)}</span></button>`;
}

/** Opens or closes the details; opening starts the form on the current setting. */
function toggleAutoPanel(w: Win): void {
  const r = route(w);
  const stage = r && autoStage(r);
  if (!stage) return;
  if (w.form.autoOpen === 'YES') delete w.form.autoOpen;
  else {
    w.form.autoOpen = 'YES';
    const a = view().automation;
    if (stage === 'RISK_CHECK' && a.RISK_CHECK) {
      w.form['p:maxAmount'] = a.RISK_CHECK.maxAmount.toLocaleString('en-US');
      w.form['p:source'] = a.RISK_CHECK.source;
      w.form['p:origin'] = a.RISK_CHECK.origin;
      w.form['p:payee'] = a.RISK_CHECK.payee;
    } else if (stage === 'AUTHORIZATION' && a.AUTHORIZATION) w.form['p:level'] = a.AUTHORIZATION.upTo;
    else if (stage === 'SETTLEMENT' && a.SETTLEMENT) w.form['p:maxAmount'] = a.SETTLEMENT.maxAmount.toLocaleString('en-US');
  }
  renderWin(w);
}

/** The details, under the credential row: what the stage does by itself now, and the form to change it. */
function autoPanelHtml(w: Win, r: ModuleRoute): string {
  const stage = autoStage(r);
  const t = stage && w.form.autoOpen === 'YES' ? autoText(stage) : null;
  if (!stage || !t) return '';
  const fields =
    stage === 'RISK_CHECK'
      ? input(w, 'maxAmount', 'Up to (0 = off)', '1,000,000 or 1m', true, true) +
        select(w, 'source', 'Payments', [{ value: 'AUTOMATIC', label: 'Automatic only' }, { value: 'ALL', label: 'Also manual' }]) +
        select(w, 'origin', 'Paid from', [{ value: 'CUSTOMER', label: 'Customers only' }, { value: 'ANY', label: 'Also floating' }]) +
        select(w, 'payee', 'Payee primary', [{ value: 'VERIFIED', label: 'Verified only' }, { value: 'ANY', label: 'Also unverified' }])
      : stage === 'AUTHORIZATION'
        ? segPicker(w, 'level', 'Approve by itself up to', ['NONE', 'LOW', 'MEDIUM', 'HIGH'])
        : input(w, 'maxAmount', 'Up to (0 = off)', '1,000,000 or 1m', true, true);
  const readOnly = moduleAccess(view(), r.system, r.module) !== 'WRITE';
  return `<form class="auto-panel" data-mform="${w.id}:auto">
    <div class="cmd-head"><b>Automation</b><i class="perm WRITE">Write</i></div>
    <p class="auto-now">${esc(t.long)}</p>
    <div class="cmd-row">${fields}${btns(btn(w, 'auto', 'Save', '', true) + `<button class="cmd-btn alt" type="button" data-act="autoedit:${w.id}">Cancel</button>`)}</div>
    ${readOnly ? '<p class="hint">Changing it needs write access to this page.</p>' : ''}
  </form>`;
}

/** Saves a stage's automation with the page's credential; the details close once it worked. */
async function saveAuto(w: Win, fn: string, params: Record<string, string>): Promise<void> {
  const r = route(w);
  if (r?.kind !== 'module') return;
  if (await execute(w, r.system, r.module, fn, params)) {
    delete w.form.autoOpen;
    renderWin(w);
  }
}

async function toggleWatch(w: Win | undefined, key: string): Promise<void> {
  const [system, module] = key.split('.') as [SystemId, string];
  const on = !view().watching.includes(key);
  const result = await act({ type: 'SET_WATCH', playerId: selected, system, module, on });
  if (w) {
    // Said in the page's terminal, like a command's result.
    w.out.push({ cls: result.ok ? 'ok' : 'bad', text: result.message });
    if (w.out.length > TERMINAL_LINES) w.out.splice(0, w.out.length - TERMINAL_LINES);
    renderWin(w);
  } else if (!result.ok) toast(result.message, 'Notifications', true);
}

/** Pops up every notification this seat has not seen yet. Switching seats skips the backlog. */
function pollNotices(skip = false): void {
  const list = view().notifications;
  const seen = seenNotices[selected] ?? 0;
  const fresh = list.filter((n) => noticeNum(n.id) > seen);
  if (fresh.length) seenNotices[selected] = noticeNum(fresh[fresh.length - 1].id);
  if (!skip)
    for (const n of fresh.slice(-4)) toast(n.text, n.page, false, HOST_PAGES.has(n.page), { kind: 'module', system: n.system as SystemId, module: n.module });
}

/** Brings up a page: the window already showing it, or a new one. */
function openPage(r: Extract<Route, { kind: 'module' }>): void {
  const open = wins().find((w) => {
    const at = route(w);
    return w.kind === 'browser' && at?.kind === 'module' && at.system === r.system && at.module === r.module;
  });
  if (open) focusWin(open);
  else openWindow('browser', r);
}

/** The hidden host's page labels: their pop-ups get the host's look, so an operative spots them at once. */
const HOST_PAGES = new Set(findSystem('HIDDEN_HOST')!.modules.map((m) => m.label));

/** A pop-up. Any click dismisses it; with `go`, a click anywhere but its × (top right) also opens that page. */
function toast(text: string, page: string, error = false, host = false, go?: Extract<Route, { kind: 'module' }>): void {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('button');
  el.className = `toast${error ? ' err' : ''}${host ? ' host' : ''}`;
  el.innerHTML = `<b>${esc(page)}</b><span>${esc(text)}</span><i class="x" title="Close" aria-label="Close">×</i>`;
  const close = (): void => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener('click', (e) => {
    if (go && !(e.target as HTMLElement).closest('.x')) openPage(go);
    close();
  });
  if (go) el.title = `Open ${page}`;
  box.appendChild(el);
  setTimeout(close, TOAST_MS);
}

// ---- Tutorial: a Personal Banker's checklist for their first request, pinned to the desktop ----------------
/** Pages ("game:seat:SYSTEM.MODULE") opened while their tutorial step was due: the engine only sees actions. */
const tutorialPagesSeen = new Set<string>();
const tutorialKey = (): string => `${view().gameId}:${selected}`;
const TUTORIAL_CLOSED = 'cyberHeist.tutorialClosed';
const tutorialClosedHere = new Set<string>();
function tutorialClosed(): boolean {
  if (tutorialClosedHere.has(tutorialKey())) return true;
  try {
    return (JSON.parse(localStorage.getItem(TUTORIAL_CLOSED) ?? '[]') as string[]).includes(tutorialKey());
  } catch {
    return false;
  }
}
function closeTutorial(): void {
  tutorialClosedHere.add(tutorialKey());
  try {
    const list = JSON.parse(localStorage.getItem(TUTORIAL_CLOSED) ?? '[]') as string[];
    localStorage.setItem(TUTORIAL_CLOSED, JSON.stringify([...list, tutorialKey()].slice(-50)));
  } catch {
    // private window or blocked storage: closed for this page load only
  }
  renderTutorial();
}
let lastTutorialHtml: string | null = '';

/**
 * A new game forgets the screen's tutorial marks for its id (offline the id comes from the seed, so the same seed
 * would otherwise inherit the last game's closed panel and second window).
 */
function resetTutorials(gameId: string): void {
  const mine = (key: string): boolean => key.startsWith(`${gameId}:`);
  for (const key of [...tutorialClosedHere]) if (mine(key)) tutorialClosedHere.delete(key);
  for (const key of [...tutorialPagesSeen]) if (mine(key)) tutorialPagesSeen.delete(key);
  for (const key of Object.keys(tutorialMarksHere)) if (mine(key)) delete tutorialMarksHere[key];
  try {
    const closed = JSON.parse(localStorage.getItem(TUTORIAL_CLOSED) ?? '[]') as string[];
    localStorage.setItem(TUTORIAL_CLOSED, JSON.stringify(closed.filter((key) => !mine(key))));
    const marks = JSON.parse(localStorage.getItem(TUTORIAL_MARKS) ?? '{}') as Record<string, number>;
    localStorage.setItem(TUTORIAL_MARKS, JSON.stringify(Object.fromEntries(Object.entries(marks).filter(([key]) => !mine(key)))));
  } catch {
    // private window or blocked storage: nothing was kept there
  }
  lastTutorialHtml = null; // the next render always draws, even an empty panel
}

/** Each A&R part's page. */
const AR_PAGES: Record<ArPart, string> = { RISK: 'TRANSACTIONS.RISK_CHECK', SETTLE: 'TRANSACTIONS.SETTLEMENT', VERIFY: 'CLIENT_DATA.VERIFICATION' };

/** Screen-only tutorial marks ("game:seat:MARK" -> game seconds), kept in the browser: the engine never sees windows. */
const TUTORIAL_MARKS = 'cyberHeist.tutorialMarks';
const tutorialMarksHere: Record<string, number> = {};
function tutorialMark(mark: string): number | null {
  const key = `${tutorialKey()}:${mark}`;
  if (key in tutorialMarksHere) return tutorialMarksHere[key];
  try {
    return (JSON.parse(localStorage.getItem(TUTORIAL_MARKS) ?? '{}') as Record<string, number>)[key] ?? null;
  } catch {
    return null;
  }
}
function setTutorialMark(mark: string, t: number): void {
  const key = `${tutorialKey()}:${mark}`;
  tutorialMarksHere[key] = t;
  try {
    const all = JSON.parse(localStorage.getItem(TUTORIAL_MARKS) ?? '{}') as Record<string, number>;
    localStorage.setItem(TUTORIAL_MARKS, JSON.stringify(Object.fromEntries(Object.entries({ ...all, [key]: t }).slice(-100))));
  } catch {
    // private window or blocked storage: kept for this page load only
  }
}

/** Opening a page (or a window) its tutorial step is waiting for ticks that step. */
function noteTutorialRoute(r: Route | undefined): void {
  noteHeistRoute(r);
  const tu = view().tutorial;
  if (!r || !tu || tu.result) return;
  if (tu.kind === 'IT') renderTutorial(); // a second Security Systems window? (noteSecondWindow)
  if (r.kind !== 'module') return;
  const page = `${r.system}.${r.module}`;
  const due =
    tu.kind === 'BANKER'
      ? page === 'TRANSACTIONS.PAYMENT_QUEUE' && !!tu.requestId
      : tu.kind === 'IT' || tu.kind === 'MANAGER'
        ? page === 'SECURITY.MASTER_LOG'
        : (Object.keys(AR_PAGES) as ArPart[]).some((id) => AR_PAGES[id] === page && tu.parts[id].waited);
  if (!due) return;
  tutorialPagesSeen.add(`${tutorialKey()}:${page}`);
  renderTutorial();
}
const pageSeen = (page: string): boolean => tutorialPagesSeen.has(`${tutorialKey()}:${page}`);

type Step = { text: string; done: boolean; skipped?: boolean; sub?: boolean };
/** A category of steps; a finished one folds to its title. */
type StepGroup = { title: string; steps: Step[]; done: boolean };
const groupsHtml = (groups: StepGroup[]): string =>
  `<ol class="parts">${groups.map((g) => `<li class="part ${g.done ? 'done' : ''}"><b>${g.done ? '✓ ' : ''}${esc(g.title)}</b><ol>${g.done ? '' : stepsHtml(g.steps)}</ol></li>`).join('')}</ol>`;

/** Steps as list items; the first one not done is the current one. */
function stepsHtml(steps: Step[]): string {
  const now = steps.findIndex((x) => !x.done && !x.sub);
  return steps
    .map((x, i) => {
      const state = x.skipped ? 'skipped' : x.done ? 'done' : i === now ? 'now' : 'todo';
      return `<li class="${state}${x.sub ? ' sub' : ''}"><span class="tick" aria-hidden="true">${x.done ? '✓' : x.sub ? '!' : ''}</span><span>${esc(x.text)}</span></li>`;
    })
    .join('');
}

function bankerSteps(tu: Extract<TutorialView, { kind: 'BANKER' }>): Step[] {
  const raw: Step[] = [
    { text: 'Wait for a Client Request to come in', done: !!tu.requestId },
    { text: `Check the Client Request${tu.requestId ? ` (${tu.requestId})` : ''} in Client Data`, done: tu.viewed },
    { text: 'Open the Payment Queue in Transaction Processing', done: tu.openedQueue || pageSeen('TRANSACTIONS.PAYMENT_QUEUE') },
    { text: 'Enter the information to Create a Payment', done: tu.created },
    ...(tu.retry ? [{ text: 'Check the Client Request and make sure everything is entered correctly', done: false, sub: true }] : []),
    { text: 'Wait for Risk Check to complete', done: tu.riskChecked },
    { text: 'Authorize manually if needed', done: tu.approval !== null, skipped: tu.approval === 'AUTO' },
    { text: 'Wait for the payment to be settled', done: tu.settled },
  ];
  // A step counts as done once it, or any step after it, is done.
  const main = raw.filter((x) => !x.sub);
  return raw.map((x) => (x.sub ? x : { ...x, done: main.slice(main.indexOf(x)).some((y) => y.done) }));
}

const AR_TEXT: Record<ArPart, { title: string; steps: [string, string, string, string] }> = {
  RISK: {
    title: 'Risk score',
    steps: ['Wait for a payment to need a risk score', 'Open Risk Check in Transaction Processing', "Check the payee's account history in Client Data → Verification (Investigate changes)", 'Score the payment'],
  },
  SETTLE: {
    title: 'Settlement',
    steps: ['Wait for a payment to need settling', 'Open Settlement in Transaction Processing', "Check the payee's primary account in Client Data → Customer Records", 'Settle the payment'],
  },
  VERIFY: {
    title: 'Verification',
    steps: ['Wait for an account change to need verifying', 'Open Verification in Client Data', "Investigate the change's customer or account (Investigate changes)", 'Verify the change'],
  },
};

function arHtml(tu: Extract<TutorialView, { kind: 'AR' }>): string {
  return (['RISK', 'SETTLE', 'VERIFY'] as ArPart[])
    .map((id) => {
      const p = tu.parts[id];
      const t = AR_TEXT[id];
      const opened = p.waited && (p.opened || pageSeen(AR_PAGES[id]) || p.checked || p.done);
      // To save space: only the wait until work comes in, then only the steps still to do.
      const steps: Step[] = (
        p.waited
          ? [
              { text: t.steps[1], done: opened },
              { text: t.steps[2], done: p.checked || p.done },
              { text: t.steps[3], done: p.done },
            ]
          : [{ text: t.steps[0], done: false }]
      ).filter((x) => !x.done);
      return `<li class="part ${p.done ? 'done' : ''}"><b>${p.done ? '✓ ' : ''}${t.title}</b><ol>${p.done ? '' : stepsHtml(steps)}</ol></li>`;
    })
    .join('');
}

/**
 * IT: the steps shown so far, in stages (the hunt and the second window once a trace is done, the Firewall once
 * the second window is open), and whether all of it is done. The screen decides: the engine never sees windows.
 */
function itSteps(tu: Extract<TutorialView, { kind: 'IT' }>): { steps: Step[]; groups: StepGroup[]; done: boolean } {
  const st = tu.steps;
  const second = tutorialMark('SECOND_SECURITY');
  const firewall = second !== null && st.firewallAt !== null && st.firewallAt >= second;
  const logs: Step[] = [
    { text: 'Open the Master Log in Security Systems', done: st.openedLog || pageSeen('SECURITY.MASTER_LOG') },
    { text: "Switch on the Master Log's auto-update", done: st.autoUpdate },
    { text: 'Trace an entry in the Master Log', done: st.traced },
  ];
  if (st.traced && !st.firstTraceHidden) {
    // A hint first: the host's entries are only in the "Everything" view.
    logs.push({ text: 'View "Everything" in the Master Log', done: st.viewedEverything || st.tracedHidden });
    logs.push({ text: 'Find and trace an "Unknown server activity" entry', done: st.tracedHidden });
  }
  // The Firewall category appears with its first step, once a trace is done.
  const fw: Step[] = st.traced ? [{ text: 'Open a second Security Systems window', done: second !== null }] : [];
  if (second !== null) fw.push({ text: 'Check the Firewall status', done: firewall });
  const groups: StepGroup[] = [{ title: 'Check the logs', steps: logs, done: st.traced && logs.every((x) => x.done) }];
  if (fw.length) groups.push({ title: 'Check the firewall', steps: fw, done: firewall });
  return { steps: [...logs, ...fw], groups, done: groups.length === 2 && groups.every((g) => g.done) };
}

/** Bank Manager: steps appear as there is something to see; an "all" view counts only once its step is shown. */
function managerSteps(tu: Extract<TutorialView, { kind: 'MANAGER' }>): { steps: Step[]; done: boolean } {
  const st = tu.steps;
  const after = (at: number | null, from: number | null): boolean => at !== null && from !== null && at >= from;
  const opened = st.openedLog || pageSeen('SECURITY.MASTER_LOG') || st.traced;
  const all: (Step & { shown: boolean })[] = [
    { text: 'View all customers in Client Data → Customer Records', done: st.customersAll, shown: true },
    { text: 'View all client requests in Client Data → Client Requests', done: after(st.requestsAllAt, tu.requestsFrom), shown: tu.requestsFrom !== null },
    { text: 'View all payments in Transaction Processing → Payment Queue', done: after(st.paymentsAllAt, tu.paymentsFrom), shown: tu.paymentsFrom !== null },
    { text: 'Open the Master Log in Security Systems', done: opened, shown: true },
    { text: 'Trace an entry in the Master Log', done: st.traced, shown: opened },
  ];
  return { steps: all.filter((x) => x.shown), done: all.every((x) => x.shown && x.done) };
}

function tutorialHtml(): string {
  const tu = view().tutorial;
  if (!tu || tutorialClosed()) return '';
  const title =
    tu.kind === 'BANKER' ? 'Your first payment' : tu.kind === 'IT' ? 'Your first day: security' : tu.kind === 'MANAGER' ? 'Your job is to watch everything!' : 'Your first day: any order';
  const it = tu.kind === 'IT' ? itSteps(tu) : tu.kind === 'MANAGER' ? managerSteps(tu) : null;
  let body: string;
  if (tu.result || it?.done) {
    const text =
      tu.result === 'FAILED'
        ? 'Your request expired. Tutorial cannot be complete.'
        : tu.kind === 'BANKER'
          ? 'Congratulations your first payment is complete!'
          : "Congratulations, now you know how to do your job!";
    body = `<div class="tutorial-result ${tu.result ?? 'DONE'}"><p>${text}</p><button class="cmd-btn" data-act="tutclose">Close</button></div>`;
  } else if (it) body = tu.kind === 'IT' ? groupsHtml(itSteps(tu).groups) : `<ol>${stepsHtml(it.steps)}</ol>`;
  else body = tu.kind === 'BANKER' ? `<ol>${stepsHtml(bankerSteps(tu))}</ol>` : `<ol class="parts">${arHtml(tu as Extract<TutorialView, { kind: 'AR' }>)}</ol>`;
  // It stays on screen until the player closes it at the end.
  return `<aside class="tutorial" aria-label="Tutorial">
    <h3 class="tutorial-head">${title}</h3>
    ${body}
  </aside>`;
}

/** IT: two Security Systems windows open at once, once a trace is done, ticks "Open a second Security Systems window". */
function noteSecondWindow(): void {
  const tu = view().tutorial;
  if (tu?.kind !== 'IT' || !tu.steps.traced || tutorialMark('SECOND_SECURITY') !== null) return;
  const security = wins().filter((w) => {
    const r = w.kind === 'browser' ? route(w) : undefined;
    return (r?.kind === 'system' || r?.kind === 'module') && r.system === 'SECURITY';
  });
  if (security.length >= 2) setTutorialMark('SECOND_SECURITY', view().t);
}

// ---- The heist: a Thief's second panel, under their cover job's ----------------------------------
let heistFolded = false;

/** Opening the host, or a tool kit's page, ticks its personal task (the engine only sees actions). */
function noteHeistRoute(r: Route | undefined): void {
  if (!view().heist || !r || (r.kind !== 'system' && r.kind !== 'module') || r.system !== 'HIDDEN_HOST') return;
  const marks = ['HOST_OPENED', ...(r.kind === 'module' && HOST_KITS.includes(r.module) ? ['KIT_OPENED'] : [])].filter((m) => tutorialMark(m) === null);
  for (const m of marks) setTutorialMark(m, view().t);
  if (marks.length) renderTutorial();
}

function heistHtml(): string {
  const h = view().heist;
  if (!h) return '';
  const t = h.tasks;
  const personal: Step[] = [
    { text: 'Open the Unregistered host', done: t.openedHost || tutorialMark('HOST_OPENED') !== null },
    { text: 'Say "hi" on Blacknet', done: t.posted },
    { text: 'Check your mule account numbers in the Target Ledger', done: t.ledger },
    { text: 'Check your personal tool kit', done: t.kit || tutorialMark('KIT_OPENED') !== null },
  ];
  // The heist: one step at a time, each gone once done (and done for good).
  const p = h.progress;
  const heist: Step[] = [
    { text: "Get a mule account onto a customer's file", done: p.onFile },
    { text: 'Make a mule account a primary account', done: p.primary },
    { text: 'Start earning money', done: p.earning },
    { text: `Reach your cash goal: ${money(h.stolen)} / ${money(h.goal)}`, done: p.goalMet },
    { text: 'Hold it until close of business, or get out of there!', done: false },
  ];
  const now = heist.find((x) => !x.done)!;
  const groups: StepGroup[] = [
    { title: 'Personal tasks', steps: personal, done: personal.every((x) => x.done) },
    { title: 'The heist', steps: [now], done: false },
  ];
  return `<aside class="tutorial heist" aria-label="The heist">
    <div class="tutorial-head"><span>The heist</span><button data-act="heistfold" aria-expanded="${!heistFolded}">${heistFolded ? 'Show' : 'Hide'}</button></div>
    ${heistFolded ? '' : groupsHtml(groups)}
  </aside>`;
}

function renderTutorial(): void {
  noteSecondWindow();
  const html = tutorialHtml() + heistHtml();
  if (html === lastTutorialHtml) return;
  lastTutorialHtml = html;
  $('tutorial').innerHTML = html;
}

// ---- Taskbar ----------------------------------------------------------------------------------
function renderTaskbar(): void {
  const v = view();
  const unread = v.me.messages.filter((m) => m.incoming).length - (seenMessages[selected] ?? 0);
  const top = topWin();
  $('taskbar').innerHTML = `
    <button class="me" data-act="me">My workstation${unread > 0 ? `<span class="unread">${unread}</span>` : ''}</button>
    <span class="tasks">${wins()
      .map((w) => `<button class="task ${w === top ? 'on' : ''} ${w.min ? 'min' : ''}" data-act="task:${w.id}">${esc(winTitle(w))}</button>`)
      .join('')}</span>`;
}

// ---- Render orchestration -------------------------------------------------------------------
function renderAll(): void {
  terminal.render();
  renderDev();
  renderScenario();
  renderStatus();
  renderRail();
  renderIcons();
  renderWins();
  renderTaskbar();
  renderTruth();
  renderTutorial();
}

/** After any game action: everything that can change except browser windows the player is using. */
function refresh(): void {
  pollNotices();
  renderStatus();
  renderRail();
  renderIcons();
  renderTaskbar();
  renderTruth();
  renderScenario();
  renderPersonal();
  renderTutorial();
}

// ---- Events ---------------------------------------------------------------------------------
app.addEventListener('click', (e) => {
  notePressed((e.target as HTMLElement).closest<HTMLButtonElement>('.win button'));
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const [act, ...args] = (el.dataset.act ?? '').split(':');
  const w = args[0] ? winById(Number(args[0])) : undefined;
  const hostWin = winById(Number(el.closest<HTMLElement>('.win')?.dataset.win));
  switch (act) {
    case 'endhide':
    case 'endshow':
      endHidden = act === 'endhide';
      renderStatus();
      break;
    case 'speed':
      speed = Number(args[0]);
      if (hostSession && hostSession.paused !== (speed === 0)) void hostSession.setPaused(speed === 0);
      renderDev();
      break;
    case 'skip':
      vNow += Number(args[0]) * 1000;
      advanceState(game, vNow);
      refresh();
      break;
    case 'dump':
      downloadState(game, hostSession?.code ?? watcher?.code ?? `seed${game.seed >>> 0}`);
      break;
    case 'newgame': {
      const table = (app.querySelector('[data-f="scenario"]') as HTMLSelectElement | null)?.value;
      scenario = table === 'DUO' || table === 'SOLO' ? table : null;
      const count = Math.floor(Number((app.querySelector('[data-f="count"]') as HTMLInputElement | null)?.value));
      playerCount = Number.isFinite(count) ? clamp(count, MIN_PLAYERS, MAX_PLAYERS) : playerCount;
      const raw = (app.querySelector('[data-f="seed"]') as HTMLInputElement | null)?.value;
      const n = Number(raw);
      newGame(Number.isFinite(n) && raw !== '' ? n : Math.floor(Math.random() * 1e9));
      break;
    }
    case 'online':
      void goOnline();
      break;
    case 'truth':
      truthOpen = !truthOpen;
      renderDev();
      renderTruth();
      break;
    case 'open':
      openWindow('browser', { kind: 'system', system: args[0] as SystemId });
      break;
    case 'me':
      openPersonal();
      break;
    case 'task': {
      const t = winById(Number(args[0]));
      if (!t) break;
      if (!t.min && t === topWin()) minimizeWin(t);
      else focusWin(t);
      break;
    }
    case 'wmin':
      if (w) minimizeWin(w);
      break;
    case 'wmax':
      if (w) toggleMax(w);
      break;
    case 'wclose':
      if (w) closeWin(w);
      break;
    case 'wback':
      if (w && w.idx > 0) {
        w.idx -= 1;
        showRoute(w);
      }
      break;
    case 'wfwd':
      if (w && w.idx < w.history.length - 1) {
        w.idx += 1;
        showRoute(w);
      }
      break;
    case 'watch':
      toggleWatch(hostWin, args[0]);
      break;
    case 'wgo':
      if (w) {
        const [, system, module] = args as [string, SystemId, string?];
        if (module) navigate(w, { kind: 'module', system, module });
        else navigate(w, { kind: 'system', system });
      }
      break;
    case 'wclear':
      if (w) {
        w.out = [];
        renderWin(w);
      }
      break;
    case 'heistfold':
      heistFolded = !heistFolded;
      renderTutorial();
      break;
    case 'tutclose':
      closeTutorial();
      break;
    case 'page':
      openPage({ kind: 'module', system: args[0] as SystemId, module: args[1] });
      break;
    case 'autoedit':
      if (w) toggleAutoPanel(w);
      break;
    case 'mcmd': {
      const r = w && route(w);
      if (w && r?.kind === 'module') MODULE_PAGES[`${r.system}.${r.module}`]?.run(w, args[1], args[2]);
      break;
    }
    case 'wunlock':
      if (w) unlock(w);
      break;
    case 'wtab':
      if (w) {
        w.form.wtab = args[1];
        renderWin(w);
      }
      break;
    case 'tab':
      tab = args[0] as Tab;
      if (hostWin) hostWin.notice = [];
      renderPersonal(true);
      renderTaskbar();
      break;
    case 'share':
      if (hostWin) doShare(hostWin, args[0]);
      break;
    case 'send':
      if (hostWin) doSend(hostWin);
      break;
    case 'quitask':
    case 'quitback':
      if (hostWin) {
        hostWin.form.quitAsk = act === 'quitask' ? 'YES' : '';
        renderPersonal(true);
      }
      break;
    case 'quitdo':
      if (hostWin) doQuit(hostWin);
      break;
  }
});

app.addEventListener('submit', (e) => {
  const form = e.target as HTMLElement;
  if (form.dataset.mform) {
    e.preventDefault();
    notePressed(((e as SubmitEvent).submitter as HTMLButtonElement | null) ?? form.querySelector<HTMLButtonElement>('button[type=submit]'));
    const [id, ...formCmd] = form.dataset.mform.split(':');
    // The button that was pressed decides the command; Enter uses the form's default.
    // "cmd" or "cmd:arg", from the button that was pressed (Enter uses the form's default).
    const [cmd, arg] = ((e as SubmitEvent).submitter?.dataset.cmd ?? formCmd.join(':')).split(':');
    const mw = winById(Number(id));
    const r = mw && route(mw);
    if (mw && r?.kind === 'module') MODULE_PAGES[`${r.system}.${r.module}`]?.run(mw, cmd, arg);
    return;
  }
  const w = winById(Number(form.dataset.addr));
  if (!w) return;
  e.preventDefault();
  goAddress(w);
});

app.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const key = el.dataset.f;
  if (!key) return;
  const w = winById(Number(el.closest<HTMLElement>('.win')?.dataset.win));
  if (w) {
    if (key === 'addr') w.addr = el.value;
    else if (key === 'credSel') {
      w.form.credSel = el.value;
      renderWin(w);
      if (el.value === 'manual') winEl(w)?.querySelector<HTMLInputElement>('[data-f="code"]')?.focus({ preventScroll: true });
    } else if (key === 'code') {
      if (w.form.credSel === 'manual') w.form.manualCode = w.form.code = el.value;
    } else w.form[key] = el instanceof HTMLInputElement && el.type === 'checkbox' ? (el.checked ? 'YES' : 'NO') : el.value;
    if (key === 'p:target') updateModuleLights(); // Control a module: show the newly chosen module's state
    if (key === 'p:monitor' && w.form[key] === 'YES') {
      const r = route(w);
      if (r?.kind === 'module') MODULE_PAGES[`${r.system}.${r.module}`]?.run(w, 'view');
    }
    return;
  }
  switch (key) {
    case 'claim':
      void client?.claim(el.value);
      break;
    case 'seat':
      selected = el.value;
      pollNotices(true); // a seat you just sat down at shows only what arrives from now on
      renderAll();
      break;
    case 'god':
      god = (el as HTMLInputElement).checked;
      renderRail();
      break;
  }
});

// ---- Window dragging and resizing ------------------------------------------------------------
/** A drag in progress: moving by the title bar, or resizing from an edge or corner (`dir`: n, se, w, ...). */
let drag: { w: Win; el: HTMLElement; dir: string | null; sx: number; sy: number; x: number; y: number; ww: number; wh: number; snap: Snap } | null = null;
/**
 * Snapping, as on a desktop OS: drag a window's title bar to the left or right edge of the desk to fill that
 * half. A preview shows where it will land.
 */
type Snap = 'left' | 'right' | null;
const SNAP_EDGE = 8;
function snapAt(clientX: number): Snap {
  const r = $('desk').getBoundingClientRect();
  if (clientX <= r.left + SNAP_EDGE) return 'left';
  if (clientX >= r.right - SNAP_EDGE) return 'right';
  return null;
}
/** Where a snap puts a window, in desk coordinates. */
function snapRect(snap: 'left' | 'right'): { x: number; y: number; w: number; h: number } {
  const { w: dw, h: dh } = deskSize();
  const half = Math.floor(dw / 2);
  return snap === 'left' ? { x: 0, y: 0, w: half, h: dh } : { x: half, y: 0, w: dw - half, h: dh };
}
function showSnapPreview(snap: Snap, under?: Win): void {
  const el = $('snap');
  el.hidden = !snap;
  if (!snap) return;
  const r = snapRect(snap);
  // Same layer as the dragged window but earlier in the page, so it shows just beneath it.
  const inset = 6;
  Object.assign(el.style, { left: `${r.x + inset}px`, top: `${r.y + inset}px`, width: `${r.w - 2 * inset}px`, height: `${r.h - 2 * inset}px`, zIndex: String(under?.z ?? 1) });
}
const MIN_W = 340;
const MIN_H = 220;
/** The resize handles: four edges and four corners. The south-east corner also shows the grip. */
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
const resizeHandles = (): string => RESIZE_DIRS.map((d) => `<div class="rz ${d}${d === 'se' ? ' grip' : ''}" data-resize="${d}" aria-hidden="true"></div>`).join('');

/** Dragging the splitter between a module page's commands and its terminal. */
let split: { w: Win; term: HTMLElement; sy: number; h0: number; max: number } | null = null;
const TERM_MIN_H = 100;
const COMMANDS_MIN_H = 110; // .mod-top's min-height

$('wins').addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  const el = target.closest<HTMLElement>('.win');
  const w = el && winById(Number(el.dataset.win));
  if (!el || !w) return;
  if (topWin() !== w) focusWin(w);
  const bar = target.closest<HTMLElement>('[data-split]');
  if (bar && e.button === 0) {
    const term = el.querySelector<HTMLElement>('.wbody.mod > .term');
    const top = el.querySelector<HTMLElement>('.wbody.mod > .mod-top');
    if (!term || !top) return;
    split = { w, term, sy: e.clientY, h0: term.offsetHeight, max: term.offsetHeight + top.offsetHeight - COMMANDS_MIN_H };
    bar.setPointerCapture(e.pointerId);
    el.classList.add('splitting');
    e.preventDefault();
    return;
  }
  const handle = target.closest<HTMLElement>('[data-drag],[data-resize]');
  if (!handle || target.closest('button') || w.max || e.button !== 0) return;
  const dir = handle.dataset.resize ?? null;
  if (dir) {
    w.sized = true;
    delete w.unsnap; // resized by hand: this is its size now
  }
  drag = { w, el, dir, sx: e.clientX, sy: e.clientY, x: w.x, y: w.y, ww: w.w, wh: w.h, snap: null };
  handle.setPointerCapture(e.pointerId);
  el.classList.add('dragging');
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (split) {
    const s = split;
    s.w.termH = Math.round(clamp(s.h0 - (e.clientY - s.sy), TERM_MIN_H, Math.max(TERM_MIN_H, s.max)));
    s.term.style.flex = `0 0 ${s.w.termH}px`;
    return;
  }
  if (!drag) return;
  const { w, dir, sx, sy, x, y, ww, wh } = drag;
  const { w: dw, h: dh } = deskSize();
  const dx = e.clientX - sx;
  const dy = e.clientY - sy;
  if (!dir) {
    // Dragging a snapped window away gives it back its old size, keeping the grab point under the pointer.
    if (w.unsnap && Math.hypot(dx, dy) > 4) {
      const grab = (sx - drag.el.getBoundingClientRect().left) / w.w;
      w.w = w.unsnap.w;
      w.h = w.unsnap.h;
      delete w.unsnap;
      drag.x = sx - $('desk').getBoundingClientRect().left - grab * w.w;
      drag.ww = w.w;
      drag.wh = w.h;
    }
    w.x = clamp(drag.x + dx, 80 - w.w, dw - 80);
    w.y = clamp(y + dy, 0, dh - 34);
    drag.snap = snapAt(e.clientX);
    showSnapPreview(drag.snap, w);
  } else {
    // East and south stretch the far edge; west and north move the near edge and keep the far one still.
    if (dir.includes('e')) w.w = clamp(ww + dx, MIN_W, Math.max(MIN_W, dw - x));
    if (dir.includes('s')) w.h = clamp(wh + dy, MIN_H, Math.max(MIN_H, dh - y));
    if (dir.includes('w')) {
      w.x = clamp(x + dx, Math.min(0, x), x + ww - MIN_W);
      w.w = ww + x - w.x;
    }
    if (dir.includes('n')) {
      w.y = clamp(y + dy, Math.min(0, y), y + wh - MIN_H);
      w.h = wh + y - w.y;
    }
  }
  placeWin(w, drag.el);
});

const endDrag = (): void => {
  if (split) {
    winEl(split.w)?.classList.remove('splitting');
    split = null;
    return;
  }
  if (!drag) return;
  const { w, el, snap, ww, wh } = drag;
  el.classList.remove('dragging');
  drag = null;
  showSnapPreview(null);
  if (snap) {
    const r = snapRect(snap);
    slideWin(
      w,
      () => {
        w.unsnap ??= { w: ww, h: wh };
        Object.assign(w, r);
        w.sized = true;
      },
      (node) => placeWin(w, node),
    );
  }
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', () => {
  if (drag) drag.snap = null; // an interrupted drag never snaps
  endDrag();
});

// The desktop never scrolls: focusing an input in a window that sticks out would otherwise shift everything.
$('desk').addEventListener('scroll', () => {
  $('desk').scrollTop = 0;
  $('desk').scrollLeft = 0;
});

$('wins').addEventListener('dblclick', (e) => {
  const target = e.target as HTMLElement;
  // Double-clicking the terminal's splitter gives it back its automatic height.
  const splitter = target.closest<HTMLElement>('[data-split]');
  const sw = splitter && winById(Number(splitter.dataset.split));
  if (sw) {
    delete sw.termH;
    renderWin(sw);
    return;
  }
  const bar = target.closest<HTMLElement>('[data-drag]');
  const w = bar && winById(Number(bar.dataset.drag));
  if (!w || target.closest('button')) return;
  toggleMax(w);
});

// ---- Clock ---------------------------------------------------------------------------------------
/** Offline and host: the game's clock. It keeps running in a background tab (see startTicker). */
function tickClock(): void {
  tickCount++;
  // The host sends everyone their views about once a second, and saves the game now and then.
  if (hostSession && tickCount % Math.round(1000 / TICK_MS) === 0) hostSession.publish();
  if (hostSession && tickCount % Math.round(10000 / TICK_MS) === 0) void hostSession.saveSnapshot({ state: game, vNow, speed });
  if (speed === 0 || game.status !== 'RUNNING') return;
  vNow += TICK_MS * speed;
  advanceState(game, vNow);
  if (game.status !== 'RUNNING') {
    hostSession?.publish();
    return refresh();
  }
  updateClock();
  pollNotices();
  renderTutorial();
  if (tickCount % 8 === 0) {
    renderTruth();
    renderScenario();
  }
}

/** Remote screens: every update from the host. Only the clock ticking? Then only the clock is redrawn. */
let lastShape = '';
function onRemoteView(): void {
  if (!client?.view || !client.seat) return; // between seats
  if (client.seat !== selected || !lastView) {
    selected = client.seat;
    lastView = client.view;
    pollNotices(true); // a seat you just sat down at shows only what arrives from now on
    lastShape = '';
    renderAll();
    return;
  }
  const v = client.view;
  const shape = JSON.stringify({ ...v, t: 0, clock: '', me: { ...v.me, lockedForSec: 0 }, paused: client.paused });
  if (shape === lastShape) {
    updateClock();
    return;
  }
  lastShape = shape;
  refresh();
}

// Handy in the browser console: cyberHeist.state
Object.defineProperty(window, 'cyberHeist', { get: () => ({ state: game, now: vNow, view: view() }) });

if (watcher) {
  let first = true;
  watcher.db.onValue(`games/${watcher.code}/watch/${watcher.key}`, (text) => {
    if (typeof text !== 'string') return;
    const copy = JSON.parse(text) as WatchCopy;
    game = copy.state;
    vNow = copy.vNow;
    if (first) {
      first = false;
      selected = game.playerOrder[0];
      for (const id of game.playerOrder) seenNotices[id] = Number.MAX_SAFE_INTEGER; // no backlog of pop-ups
      renderAll();
    } else {
      if (!game.players[selected]) selected = game.playerOrder[0];
      refresh();
      updateClock();
    }
  });
} else if (client) {
  client.onChange(onRemoteView);
  onRemoteView();
} else {
  startTicker(TICK_MS, tickClock);
  if (MODE.kind === 'host') {
    if (MODE.snapshot) resumeGame(MODE.snapshot);
    else newGame(Math.floor(Math.random() * 1e9));
    serve(MODE.db, MODE.code);
    renderDev();
  } else {
    const urlSeed = Number(new URLSearchParams(location.search).get('seed'));
    newGame(Number.isFinite(urlSeed) && urlSeed > 0 ? urlSeed : 1);
  }
}
