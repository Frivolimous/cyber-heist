// Local single-browser sandbox. The yellow bar at the top is sandbox tooling; everything below it is the
// player screen exactly as one player would see it. It talks to the engine the way a client will later
// talk to the server: applyAction(state, action, now).

import './style.css';
import {
  advanceState,
  applyAction,
  createGame,
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
  WATCHABLE,
} from '../engine';
import type { Action, GameState, Pace, PlayerId, PlayerView, SystemId, WorkstationView } from '../engine';

const NAMES = ['Jeremy', 'Sarah', 'Mike', 'David', 'Lisa', 'Anna', 'Omar', 'Priya', 'Chen', 'Rosa', 'Tariq', 'Mei', 'Hugo', 'Zara', 'Ivan', 'Nina', 'Kofi', 'Elena', 'Raj', 'Sofia'];
/** Sandbox seats p0..p(n-1); past the name list, seats are numbered. */
const rosterOf = (n: number): { id: string; name: string }[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: NAMES[i] ?? `Player ${i + 1}` }));
let playerCount = 10;
const MASTER_SEAT = 'p0'; // this seat gets whole-system credentials for every system
const TICK_MS = 250;
const TASKBAR_H = 44;
const TERMINAL_LINES = 100;

type Line = { cls: string; text: string };
type Route =
  | { kind: 'system'; system: SystemId }
  | { kind: 'module'; system: SystemId; module: string }
  | { kind: 'workstation'; playerId: PlayerId; address: string }
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
  liveEnd?: number; // live monitor: w.out length right after its last block (so the next refresh can replace it)
}

// ---- Sandbox state ----------------------------------------------------------------
let game: GameState;
let vNow = 0; // virtual "now" in ms, advanced by the timer
let speed = 1; // 0 = paused
let selected: PlayerId = MASTER_SEAT;
type Tab = 'profile' | 'codes' | 'activity' | 'messages';
let tab: Tab = 'profile';
let god = false;
let truthOpen = false;
let tickCount = 0;
let desks: Record<PlayerId, Win[]> = {}; // each seat keeps its own open windows
let winSeq = 0;
let zSeq = 10;
const seenMessages: Record<PlayerId, number> = {};

const app = document.getElementById('app') as HTMLElement;
app.innerHTML = `
  <div class="shell">
    <section id="dev" class="dev" aria-label="Sandbox controls"></section>
    <section class="screen" aria-label="Player screen">
      <header id="status" class="status"></header>
      <div class="screen-body">
        <nav id="rail" aria-label="Employees"></nav>
        <div id="desk" class="desk">
          <div id="icons" class="icons"></div>
          <div id="wins"></div>
          <footer id="taskbar" class="taskbar"></footer>
          <div id="toasts" class="toasts" aria-live="polite"></div>
        </div>
      </div>
    </section>
    <aside id="truth" class="dev truth" aria-label="Ground truth" hidden></aside>
  </div>`;
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const slug = (id: string): string => id.toLowerCase().replace(/_/g, '-');
const view = (): PlayerView => getPlayerView(game, selected);

const ICONS: Record<SystemId, string> = {
  SECURITY: '<path d="M24 5 8 11v11c0 10 7 17 16 21 9-4 16-11 16-21V11z"/><path d="m17 24 5 5 9-10"/>',
  CLIENT_DATA: '<rect x="6" y="10" width="36" height="28" rx="3"/><circle cx="18" cy="22" r="4"/><path d="M11 32c1-4 4-6 7-6s6 2 7 6M29 19h8M29 25h8M29 31h5"/>',
  TRANSACTIONS: '<path d="M8 17h28l-7-7M40 31H12l7 7"/>',
  BLACKHAT_DB: '<path d="M8 30c4-2 10-3 16-3s12 1 16 3M13 28l3-16c1-3 4-3 6-2l2 1 2-1c2-1 5-1 6 2l3 16"/><circle cx="18" cy="36" r="3"/><circle cx="30" cy="36" r="3"/><path d="M21 36h6"/>',
};
const icon = (id: SystemId, size = 48): string =>
  `<svg viewBox="0 0 48 48" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;

// ---- Game lifecycle ----------------------------------------------------------------
function newGame(seed: number): void {
  const autoProcess = game ? game.config.autoProcess : true;
  vNow = Date.now();
  const roster = rosterOf(playerCount);
  game = createGame({ seed, players: roster, now: vNow, config: { autoProcess } });
  grantMasterAccess(game, MASTER_SEAT);
  desks = {};
  for (const p of roster) {
    seenMessages[p.id] = 0;
    seenNotices[p.id] = 0;
  }
  if (!game.players[selected]) selected = MASTER_SEAT;
  tab = 'profile';
  renderAll();
}

// ---- Sandbox controls (not part of the game) ----------------------------------------
function renderDev(): void {
  const btn = (act: string, label: string, on: boolean): string =>
    `<button data-act="${act}" class="${on ? 'on' : ''}">${label}</button>`;
  $('dev').innerHTML = `
    <span class="dev-tag">Sandbox</span>
    <label>Viewing as <select data-f="seat">${game.playerOrder
      .filter((id) => !game.players[id].fake) // planted users are records, not seats you can control
      .map((id) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(game.players[id].name)}${id === MASTER_SEAT ? ' (master access)' : ''}</option>`)
      .join('')}</select></label>
    <span class="grp">${btn('speed:0', 'Pause', speed === 0)}${btn('speed:1', '1x', speed === 1)}${btn('speed:5', '5x', speed === 5)}${btn('speed:20', '20x', speed === 20)}<button data-act="skip:30">+30s</button></span>
    <label><input type="checkbox" data-f="auto" ${game.config.autoProcess ? 'checked' : ''}> auto-process routine payments</label>
    <label><input type="checkbox" data-f="god" ${god ? 'checked' : ''}> show allegiances</label>
    <label>players <input type="number" data-f="count" min="${MIN_PLAYERS}" max="${MAX_PLAYERS}" value="${playerCount}" title="Applies on New game"></label>
    <label>seed <input type="number" data-f="seed" value="${game.seed >>> 0}"></label>
    <button data-act="newgame">New game</button>
    <button data-act="truth" class="${truthOpen ? 'on' : ''}">Ground truth</button>
    <span class="dev-note">Everything below this bar is the game.</span>`;
}

function renderTruth(): void {
  const el = $('truth');
  el.hidden = !truthOpen;
  if (!truthOpen) return;
  const s = game;
  const t = (x: number): string => fmtClock(s.config, x);
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
  const history = s.transactions
    .slice(-8)
    .map((x) => [`${x.id}`, ...x.history.map((e) => `  [${t(e.t)}] ${e.action.padEnd(12)} records: ${who(e.by).padEnd(8)} truth: ${who(e.actualPlayerId).padEnd(8)} ${e.detail ?? ''}`)].join('\n'))
    .join('\n');
  const bn = s.blacknet.map((m) => `[${t(m.t)}] ${m.alias} (really ${s.players[m.ownerId].name}): ${m.text}`).join('\n');
  const targets = s.targets.map((x) => `${x.account} ${x.status}`).join('   ');
  el.innerHTML = `
    <div class="truth-head"><b>Ground truth (spoilers)</b><button data-act="truth" aria-label="Close ground truth">Close</button></div>
    <div class="totals"><span>settled: ${money(s.totals.processed)}</span><span>stolen: ${money(s.totals.stolen)} / ${money(s.config.blackTarget)}</span><span>targets: ${esc(targets)}</span></div>
    <h4>People</h4><pre>${esc(people)}</pre>
    <h4>Player activity: what the log says vs who did it</h4><pre>${esc(logs || 'No player activity yet.')}</pre>
    <h4>Payments</h4><pre>${esc(txs)}</pre>
    <h4>Payment history (last 8)</h4><pre>${esc(history)}</pre>
    <h4>Blacknet</h4><pre>${esc(bn || 'No Blacknet posts.')}</pre>`;
}

// ---- Game: status bar -----------------------------------------------------------------
function renderStatus(): void {
  const v = view();
  const ended = game.status === 'ENDED';
  const banner = ended
    ? `<div class="banner ${game.winner === 'WHITE' ? 'white' : game.winner === 'BLACK' ? 'black' : 'none'}">${game.winner === 'WHITE' ? 'White Hats win' : game.winner === 'BLACK' ? 'Black Hats win' : 'Everybody loses'}. ${esc(game.endReason)}</div>`
    : '';
  $('status').innerHTML = `
    <div class="who"><b>${esc(v.me.name)}</b><span>${esc(v.me.roleLabel)}</span>
      <span class="chip ${v.me.allegiance}">${v.me.allegiance === 'BLACK' ? 'Black Hat' : 'White Hat'}</span>
      <span id="lock" class="chip lock" hidden></span></div>
    <div class="clock"><span id="phase" class="phase"></span><span id="pace" class="pace"></span><b id="left"></b></div>
    <div class="throughput"><div class="bar"><i id="bar"></i></div><span id="thr"></span></div>
    ${banner}`;
  updateClock();
}

const PACE_TEXT: Record<Pace, string> = { SLOW: 'Slow', MEDIUM: 'Medium', BUSY: 'Busy', CLOSED: 'Closed' };

function updateClock(): void {
  const v = view();
  // Time of day, how busy it is, and the countdown.
  $('phase').textContent = v.dayPhase;
  const pace = $('pace');
  pace.textContent = PACE_TEXT[v.pace];
  pace.className = `pace ${v.pace}`;
  $('left').textContent = mmss(v.durationSec - v.t);
  $('bar').style.width = `${Math.min(100, (v.processed / v.whiteTarget) * 100)}%`;
  $('thr').textContent = `${money(v.processed)} of ${money(v.whiteTarget)} legitimate payments settled`;
  const lock = $('lock');
  lock.hidden = v.me.lockedForSec <= 0;
  lock.textContent = `Workstation locked ${v.me.lockedForSec}s`;
}

// ---- Game: employee sidebar ------------------------------------------------------------
function renderRail(): void {
  $('rail').innerHTML = `<h3>Employees</h3>${game.playerOrder
    .filter((id) => !game.players[id].fake) // planted users are records, not real people: only the system views show them
    .map((id) => {
      const p = game.players[id];
      const v = getPlayerView(game, id);
      return `<div class="pl ${id === selected ? 'me' : ''}">
        <span class="nm">${esc(p.name)}${id === selected ? ' <small>(you)</small>' : ''}</span><span class="rl">${esc(v.me.roleLabel)}</span>
        ${god ? `<i class="tag ${p.allegiance}" title="Sandbox: allegiance">${p.allegiance === 'BLACK' ? 'Black' : 'White'}</i>` : ''}
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

function routeAddress(r: Route): string {
  if (r.kind === 'noroute' || r.kind === 'workstation') return r.address;
  let a = findSystem(r.system)?.address ?? '';
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

function winTitle(w: Win): string {
  if (w.kind === 'personal') return 'My workstation';
  const r = route(w);
  if (r?.kind === 'workstation') return `${game.players[r.playerId]?.name ?? r.address}'s workstation`;
  if (!r || r.kind === 'noroute') return 'Network';
  return findSystem(r.system)?.label ?? r.system;
}

function openWindow(kind: Win['kind'], first?: Route): Win {
  const list = wins();
  const { w: dw, h: dh } = deskSize();
  const w = Math.max(340, Math.min(640, dw - 20));
  const h = Math.max(220, Math.min(500, dh - 20));
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

function focusWin(w: Win): void {
  w.min = false;
  w.z = ++zSeq;
  placeWin(w);
  markFocus();
  renderTaskbar();
}

function markFocus(): void {
  const top = topWin();
  $('wins')
    .querySelectorAll<HTMLElement>('.win')
    .forEach((el) => el.classList.toggle('focused', Number(el.dataset.win) === top?.id));
}

function closeWin(w: Win): void {
  desks[selected] = wins().filter((x) => x !== w);
  winEl(w)?.remove();
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
    w.out = [{ cls: 'hs', text: `[${fmtClock(game.config, view().t)}] Logged in to ${sys.label} (${sys.address})` }];
  }
  delete w.form.credSel;
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
function goAddress(w: Win): void {
  const raw = w.addr.trim();
  const [host = '', modSlug, extra] = raw.replace(/^[a-z]+:\/\//i, '').split('/').filter(Boolean);
  let sys = SYSTEMS.find((s) => s.address === host);
  if (!sys || !view().me.knownSystems.includes(sys.id)) {
    // Unknown address: ask the network. This is how the hidden host and other workstations are found.
    const r = applyAction(game, { type: 'CONNECT', playerId: selected, address: host }, vNow);
    game = r.state;
    refresh();
    if (!r.result.ok) return navigate(w, { kind: 'noroute', address: raw, message: r.result.message });
    if (r.result.workstation) return navigate(w, { kind: 'workstation', playerId: r.result.workstation, address: host });
    sys = SYSTEMS.find((s) => s.address === host);
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
  $('wins').innerHTML = '';
  for (const w of wins()) renderWin(w);
  markFocus();
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
  const onHost = !!r && 'system' in r && r.system === 'BLACKHAT_DB';
  el.classList.toggle('host', onHost);
  el.classList.toggle('kit', onHost && r.kind === 'module' && HOST_KITS.includes(r.module));
  el.innerHTML = titleBar(w) + (w.kind === 'personal' ? personalHtml(w) : browserHtml(w)) + `<div class="grip" data-resize="${w.id}" aria-hidden="true"></div>`;
  const out = el.querySelector('.out');
  if (out) out.scrollTop = out.scrollHeight;
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
  let crumbs = '';
  let body = '';
  if (r.kind === 'noroute') {
    const known = view().systems.map((s) => `${esc(s.label)} <code>${esc(s.address)}</code>`).join('<br>');
    body = `<div class="noroute"><h2>Can't reach ${esc(r.address || 'that address')}</h2><p>${esc(r.message)}</p><p class="hint">Addresses you know:<br>${known}</p></div>`;
  } else {
    const sys = findSystem(r.system)!;
    const crumb = (label: string, act: string | null): string =>
      act ? `<button data-act="${act}">${esc(label)}</button>` : `<span>${esc(label)}</span>`;
    const parts = [crumb(sys.label, r.kind === 'system' ? null : `wgo:${w.id}:${sys.id}`)];
    if (r.kind !== 'system') {
      const mod = findModule(r.system, r.module)!;
      parts.push(crumb(mod.label, null));
    }
    crumbs = `<div class="crumbs">${parts.join('<i>/</i>')}${r.kind === 'module' ? bellHtml(`${r.system}.${r.module}`) : ''}</div>`;
    if (r.kind === 'system') {
      body = `<div class="tiles">${sys.modules
        .map((m) => {
          const a = moduleAccess(view(), sys.id, m.id);
          const kit = sys.id === 'BLACKHAT_DB' && HOST_KITS.includes(m.id);
          return `<button class="tile ${kit ? 'kit' : ''} ${a === 'NONE' ? 'locked' : ''}" data-act="wgo:${w.id}:${sys.id}:${m.id}"><b>${esc(m.label)}</b><i class="perm ${a}">${ACCESS_TEXT[a]}</i></button>`;
        })
        .join('')}</div>${terminalHtml(w)}`;
    } else if (MODULE_PAGES[`${r.system}.${r.module}`]) {
      body = modulePageHtml(w, r);
    } else {
      const empty = findModule(r.system, r.module)?.fns.length === 0;
      body = `<p class="hint">${empty ? 'No tools in this kit yet.' : 'This module has no page yet.'}</p>${terminalHtml(w)}`;
    }
  }
  return `${nav}${crumbs}<div class="wbody">${body}</div>`;
}

type Cred = PlayerView['me']['credentials'][number];

/** "Yours · Read & write · all of Transaction Processing" */
function credLabel(c: Cred): string {
  const who = c.own ? 'Yours' : `${c.ownerName}'s`;
  const access = c.permission === 'WRITE' ? 'Read & write' : 'Read only';
  const where = c.fn
    ? findFn(c.system, c.module ?? '', c.fn)?.label ?? c.fn
    : c.module
      ? findModule(c.system, c.module)?.label ?? c.module
      : `all of ${findSystem(c.system)?.label ?? c.system}`;
  return `${who} · ${access} · ${where}`;
}

/**
 * Credential dropdown + code box. Lists only active credentials that `applies` accepts, then "Manual code".
 * With no such credentials the first option is "No credentials granted". Only "Manual code" makes the
 * code box editable. Starts on the first credential `prefer` accepts (else the first listed).
 */
function credentialFields(w: Win, v: PlayerView, applies: (c: Cred) => boolean, prefer?: (c: Cred) => boolean, openKey?: string): string {
  const list = v.me.credentials.filter((c) => c.status === 'ACTIVE' && applies(c));
  const open = openKey !== undefined && v.openModules.includes(openKey);
  const opts: [string, string][] = [
    ...(open ? [['open', 'No code needed (security is off)'] as [string, string]] : []),
    ...(list.length ? list.map((c): [string, string] => [c.id, credLabel(c)]) : [['none', 'No credentials granted'] as [string, string]]), ['manual', 'Manual code']];
  if (!opts.some(([id]) => id === w.form.credSel)) w.form.credSel = (prefer && list.find(prefer)?.id) || opts[0][0];
  const sel = w.form.credSel;
  const manual = sel === 'manual';
  w.form.code = manual ? (w.form.manualCode ?? '') : (list.find((c) => c.id === sel)?.code ?? '');
  return `<div class="cred-row">
      <label class="field grow"><span>Credential</span><select data-f="credSel" class="${sel === 'none' ? 'none' : ''}">${opts
        .map(([id, label]) => `<option value="${id}" class="${id === 'none' ? 'none' : ''}" ${id === sel ? 'selected' : ''}>${esc(label)}</option>`)
        .join('')}</select></label>
      <label class="field"><span>4-digit code</span><input class="mono code" data-f="code" maxlength="4" inputmode="numeric" value="${esc(w.form.code)}" ${manual ? 'placeholder="0000"' : 'readonly tabindex="-1"'} autocomplete="off"></label>
    </div>`;
}

/** The window's terminal: persists across one system's pages, with a Clear button. */
function terminalHtml(w: Win): string {
  return `<section class="mod-sec term"><h3>Terminal <button type="button" class="term-clear" data-act="wclear:${w.id}">Clear</button></h3><div class="out" aria-live="polite">${w.out.map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('') || '<div class="dim">Output appears here.</div>'}</div></section>`;
}

/** Runs one function with the window's credential code and prints the result to the window's terminal. */
function execute(w: Win, system: SystemId, module: string, fn: string, params: Record<string, string>): boolean {
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
  const res = applyAction(game, action, vNow);
  game = res.state;
  w.out.push({ cls: 'cmd', text: `[${findModule(system, module)?.label ?? module}] > ${def?.label ?? fn}` }, { cls: res.result.ok ? 'ok' : 'bad', text: res.result.message });
  for (const line of res.result.lines ?? []) w.out.push({ cls: 'row', text: line });
  if (w.out.length > TERMINAL_LINES) w.out.splice(0, w.out.length - TERMINAL_LINES);
  renderWin(w);
  refresh();
  return res.result.ok;
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
function tickMonitors(): void {
  for (const w of wins()) {
    const r = route(w);
    if (w.min || !r || r.kind !== 'module' || w.form['p:monitor'] !== 'YES') continue;
    const spec = MODULE_PAGES[`${r.system}.${r.module}`]?.monitor?.(w);
    if (!spec) continue;
    const res = applyAction(
      game,
      { type: 'EXECUTE', playerId: selected, code: (w.form.code ?? '').trim(), system: r.system, module: r.module, fn: spec.fn, params: spec.params, quiet: true },
      vNow,
    );
    game = res.state;
    if (!res.result.ok) {
      w.form['p:monitor'] = 'NO';
      w.out.push({ cls: 'bad', text: `Auto-update stopped: ${res.result.message}` });
      renderWin(w);
      continue;
    }
    const title = `[${findModule(r.system, r.module)?.label ?? r.module}] > ${findFn(r.system, r.module, spec.fn)?.label ?? spec.fn} (live)`;
    const block: Line[] = [{ cls: 'cmd', text: title }, { cls: 'ok', text: res.result.message }, ...(res.result.lines ?? []).map((text) => ({ cls: 'row', text }))];
    // Replace the previous live block if it is still the last thing in the terminal.
    const start = w.liveEnd !== undefined && w.liveEnd === w.out.length ? w.out.map((l) => l.cls).lastIndexOf('cmd') : w.out.length;
    w.out.splice(start, w.out.length - start, ...block);
    if (w.out.length > TERMINAL_LINES) w.out.splice(0, w.out.length - TERMINAL_LINES);
    w.liveEnd = w.out.length;
    renderTerminal(w);
  }
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
/** Low / Medium / High, nothing preselected so Enter cannot file a score by accident. */
const scorePicker = (w: Win): string =>
  `<fieldset class="field full seg"><span>Score</span><div class="seg-opts">${['LOW', 'MEDIUM', 'HIGH']
    .map(
      (s) =>
        `<label class="seg-opt ${s}"><input type="radio" name="score-${w.id}" data-f="p:score" value="${s}" ${w.form['p:score'] === s ? 'checked' : ''}><span>${s[0] + s.slice(1).toLowerCase()}</span></label>`,
    )
    .join('')}</div></fieldset>`;
/** A dropdown for command cards. Starts on the first option; the choice sticks for the window. */
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
function runFresh(w: Win, system: SystemId, module: string, fn: string, params: Record<string, string>, clear: string[]): void {
  if (execute(w, system, module, fn, params)) {
    for (const k of clear) w.form[`p:${k}`] = '';
    renderWin(w);
  }
}
const txParam = (w: Win): Record<string, string> => ({ txId: w.form['p:txId'] ?? '' });
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
  'BLACKHAT_DB.BLACKNET': {
    commands: (w) =>
      card('Read messages', 'READ', btn(w, 'view', 'Read the board') + checkbox(w, 'monitor', 'Auto-update every second (only opening the board is logged)')) +
      card(
        'Post a message',
        'WRITE',
        input(w, 'alias', 'Alias', 'ghost') + input(w, 'text', 'Message', 'say something', true, true) + btns(btn(w, 'post', 'Post', '', true)),
        `${w.id}:post`,
      ),
    run: (w, cmd) => {
      if (cmd === 'view') {
        execute(w, 'BLACKHAT_DB', 'BLACKNET', 'READ_MESSAGES', {});
        w.liveEnd = w.out.length;
      } else runFresh(w, 'BLACKHAT_DB', 'BLACKNET', 'POST_MESSAGE', { alias: w.form['p:alias'] ?? '', text: w.form['p:text'] ?? '' }, ['text']);
    },
    monitor: () => ({ fn: 'READ_MESSAGES', params: {} }),
  },
  'BLACKHAT_DB.TARGET_LEDGER': {
    commands: (w) =>
      card('View targets', 'READ', btn(w, 'view', 'All target accounts')) +
      card(
        'Set a target\'s status',
        'WRITE',
        input(w, 'account', 'Account', '12345', true, true) +
          btns(btn(w, 'status:READY', 'Ready', '', true) + btn(w, 'status:PREPARE', 'Prepare', 'alt', true) + btn(w, 'status:ABORT', 'Abort', 'danger', true)),
        `${w.id}:status:READY`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'BLACKHAT_DB', 'TARGET_LEDGER', 'VIEW_TARGETS', {});
      else runFresh(w, 'BLACKHAT_DB', 'TARGET_LEDGER', 'SET_TARGET_STATUS', { account: w.form['p:account'] ?? '', status: arg ?? '' }, ['account']);
    },
  },
  'BLACKHAT_DB.HOST_LOG': {
    commands: (w) =>
      card(
        'View host log',
        'READ',
        btn(w, 'view:ALL', 'Everything') + btn(w, 'view:ALERTS', 'Alerts', 'alt') + checkbox(w, 'monitor', 'Auto-update every second (only opening the view is logged)'),
      ),
    run: (w, _cmd, arg) => {
      w.form['p:hostFilter'] = arg ?? w.form['p:hostFilter'] ?? 'ALL';
      execute(w, 'BLACKHAT_DB', 'HOST_LOG', 'VIEW_HOST_LOG', { show: w.form['p:hostFilter'] });
      w.liveEnd = w.out.length;
    },
    monitor: (w) => ({ fn: 'VIEW_HOST_LOG', params: { show: w.form['p:hostFilter'] ?? 'ALL' } }),
  },
  'BLACKHAT_DB.CREDENTIAL_CACHE': {
    commands: (w) => card('View cache', 'READ', btn(w, 'view', 'Compromised credentials')),
    run: (w) => execute(w, 'BLACKHAT_DB', 'CREDENTIAL_CACHE', 'VIEW_CACHE', {}),
  },
  'BLACKHAT_DB.INFILTRATION': {
    commands: (w) =>
      card(
        'Reroute IP',
        'WRITE',
        input(w, 'toIp', 'Appear as IP', '10.1.0.14', true, true) +
          btns(
            btn(w, 'reroute:10', '10s · noisy', '', true) +
              btn(w, 'reroute:30', '30s · loud', 'loud', true) +
              btn(w, 'reroute:60', '60s · reckless', 'reckless', true),
          ),
        `${w.id}:reroute:10`,
      ) +
      card(
        'Create user',
        'WRITE',
        input(w, 'newName', 'Name', 'Dana Pruitt') +
          select(w, 'newRole', 'Role', ROLE_ORDER.map((id) => ({ value: id, label: ROLES[id].label })), true) +
          input(w, 'newIp', 'IP address', '10.1.0.30', true) +
          btns(btn(w, 'createUser', 'Add user · noisy', '', true)),
        `${w.id}:createUser`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'reroute') runFresh(w, 'BLACKHAT_DB', 'INFILTRATION', 'REROUTE_IP', { toIp: w.form['p:toIp'] ?? '', duration: arg ?? '' }, ['toIp']);
      else if (cmd === 'createUser')
        runFresh(w, 'BLACKHAT_DB', 'INFILTRATION', 'CREATE_USER', { name: w.form['p:newName'] ?? '', role: w.form['p:newRole'] ?? '', ip: w.form['p:newIp'] ?? '' }, ['newName', 'newIp']);
    },
  },
  'BLACKHAT_DB.SOCIAL': {
    commands: (w) =>
      card(
        'Spoofed message',
        'WRITE',
        input(w, 'spoofTo', 'To (employee)', 'Sarah') +
          input(w, 'spoofFrom', 'Appear from', 'Mike', true) +
          input(w, 'spoofText', 'Message', 'say something', true, true) +
          btns(btn(w, 'spoof', 'Send · noisy', '', true)),
        `${w.id}:spoof`,
      ) +
      card(
        'Scam request',
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
          btns(btn(w, 'scam', 'Plant request · noisy', '', true)),
        `${w.id}:scam`,
      ),
    run: (w, cmd) => {
      if (cmd === 'spoof')
        runFresh(w, 'BLACKHAT_DB', 'SOCIAL', 'SPOOFED_MESSAGE', { to: w.form['p:spoofTo'] ?? '', from: w.form['p:spoofFrom'] ?? '', text: w.form['p:spoofText'] ?? '' }, ['spoofText']);
      else if (cmd === 'scam')
        runFresh(w, 'BLACKHAT_DB', 'SOCIAL', 'SCAM_REQUEST', { customer: w.form['p:scamCust'] ?? '', kind: w.form['p:scamKind'] ?? '', account: w.form['p:scamAcct'] ?? '' }, ['scamAcct']);
    },
  },
  'BLACKHAT_DB.CLEANUP': {
    commands: (w) =>
      card('Log wiper', 'WRITE', input(w, 'wipeId', 'Log entry', 'L12', true, true) + btns(btn(w, 'wipe', 'Wipe entry · noisy', '', true)), `${w.id}:wipe`) +
      card(
        'Alert mute',
        'WRITE',
        `<p class="hint full">Hides the bank's minor alerts for 10s. Loud and reckless alerts, including this tool's own, still get through.</p>` +
          btns(btn(w, 'mute', 'Mute alerts (10s) · loud', 'loud')),
      ),
    run: (w, cmd) => {
      if (cmd === 'wipe') runFresh(w, 'BLACKHAT_DB', 'CLEANUP', 'LOG_WIPER', { logId: w.form['p:wipeId'] ?? '' }, ['wipeId']);
      else if (cmd === 'mute') execute(w, 'BLACKHAT_DB', 'CLEANUP', 'ALERT_MUTE', {});
    },
  },
  'BLACKHAT_DB.ACCESS': {
    commands: (w) => {
      const mods = view()
        .systems.filter((sys) => !sys.hidden)
        .flatMap((sys) => sys.modules.map((m) => ({ value: `${sys.id}.${m.id}`, label: `${sys.label} / ${m.label}` })));
      return (
        card('Code crack', 'WRITE', select(w, 'crackTarget', 'Module', mods, true) + btns(btn(w, 'crack', 'Start crack · noisy per digit', '', true)), `${w.id}:crack`) +
        card('Lockout bomb', 'WRITE', input(w, 'bombIp', 'Workstation', '10.1.0.12', true, true) + btns(btn(w, 'bomb', 'Lock them out · noisy', '', true)), `${w.id}:bomb`)
      );
    },
    run: (w, cmd) => {
      if (cmd === 'crack') execute(w, 'BLACKHAT_DB', 'ACCESS', 'CRACK_CODE', { target: w.form['p:crackTarget'] ?? '' });
      else if (cmd === 'bomb') runFresh(w, 'BLACKHAT_DB', 'ACCESS', 'LOCKOUT_BOMB', { target: w.form['p:bombIp'] ?? '' }, ['bombIp']);
    },
  },
  'SECURITY.FIREWALL': {
    commands: (w) => {
      // Every module the player knows, except the Firewall itself and the hidden host (not the bank's to control).
      const mods = view()
        .systems.filter((sys) => !sys.hidden)
        .flatMap((sys) => sys.modules.filter((m) => !(sys.id === 'SECURITY' && m.id === 'FIREWALL')).map((m) => ({ value: `${sys.id}.${m.id}`, label: `${sys.label} / ${m.label}` })));
      const confirming = w.form['p:revConfirm'] === 'YES';
      const revoke = confirming
        ? `<p class="warn full">This action is irreversible. After a ${game.config.revokeCountdownSec}s countdown, <b>${esc(w.form['p:revAddr'] ?? '')}</b> loses all access permanently (a workstation's owner also loses every credential). It can only be cancelled from the Firewall before then.</p>` +
          btns(btn(w, 'revokeConfirm', 'Confirm: revoke all access', 'danger') + btn(w, 'revokeBack', 'Back', 'alt'))
        : input(w, 'revAddr', 'Address', 'workstation or system', true, true) + btns(btn(w, 'revokeAsk', 'Revoke all access…', 'danger', true));
      return (
        card('View firewall status', 'READ', btn(w, 'view', 'Status, blocks and revocations')) +
        card(
          'Control a module',
          'WRITE',
          select(w, 'target', 'Module', mods, true) +
            btns(
              btn(w, 'module:OFFLINE', 'Take offline', 'danger', true) +
                btn(w, 'module:ONLINE', 'Bring online', 'alt', true) +
                btn(w, 'security:OFF', 'Security off', 'danger', true) +
                btn(w, 'security:ON', 'Security on', 'alt', true),
            ),
          `${w.id}:module:OFFLINE`,
        ) +
        card(
          `Block an address (${game.config.blockSec}s)`,
          'WRITE',
          input(w, 'blockAddr', 'Address', 'workstation or system', true, true) + btns(btn(w, 'block', 'Block', 'danger', true) + btn(w, 'unblock', 'Unblock', 'alt', true)),
          `${w.id}:block`,
        ) +
        card('Revoke all access', 'WRITE', revoke, confirming ? undefined : `${w.id}:revokeAsk`) +
        card('Cancel a revocation', 'WRITE', input(w, 'revId', 'Revocation', 'R1', true, true) + btns(btn(w, 'cancelRev', 'Cancel it', '', true)), `${w.id}:cancelRev`)
      );
    },
    run: (w, cmd, arg) => {
      const f = (k: string): string => w.form[`p:${k}`] ?? '';
      const fw = (fn: string, params: Record<string, string>, clear: string[] = []) => runFresh(w, 'SECURITY', 'FIREWALL', fn, params, clear);
      if (cmd === 'view') execute(w, 'SECURITY', 'FIREWALL', 'VIEW_STATUS', {});
      else if (cmd === 'module') execute(w, 'SECURITY', 'FIREWALL', 'SET_MODULE_STATUS', { target: f('target'), status: arg ?? '' });
      else if (cmd === 'security') execute(w, 'SECURITY', 'FIREWALL', 'SET_SECURITY', { target: f('target'), security: arg ?? '' });
      else if (cmd === 'block') fw('BLOCK_ADDRESS', { address: f('blockAddr') }, ['blockAddr']);
      else if (cmd === 'unblock') fw('UNBLOCK_ADDRESS', { address: f('blockAddr') }, ['blockAddr']);
      else if (cmd === 'cancelRev') fw('CANCEL_REVOCATION', { revocationId: f('revId') }, ['revId']);
      else if (cmd === 'revokeAsk' && f('revAddr').trim()) {
        w.form['p:revConfirm'] = 'YES';
        renderWin(w);
      } else if (cmd === 'revokeBack') {
        w.form['p:revConfirm'] = 'NO';
        renderWin(w);
      } else if (cmd === 'revokeConfirm') {
        w.form['p:revConfirm'] = 'NO';
        fw('REVOKE_ALL_ACCESS', { address: f('revAddr') }, ['revAddr']);
        renderWin(w);
      }
    },
  },
  'SECURITY.MASTER_LOG': {
    commands: (w) =>
      card(
        'View log',
        'READ',
        btn(w, 'view:PLAYERS', 'Player activity') + btn(w, 'view:ALL', 'Everything', 'alt') + btn(w, 'view:ALERTS', 'Alerts', 'alt') + checkbox(w, 'monitor', 'Auto-update every second (only opening the view is logged)'),
      ) +
      card('Trace a log entry', 'WRITE', input(w, 'logId', 'Log entry', 'L12 or 12', true, true) + btns(btn(w, 'trace', 'Trace', '', true)), `${w.id}:trace`),
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
      card('Reset a lockout', 'WRITE', input(w, 'lockAddr', 'Workstation', '10.1.0.12', true, true) + btns(btn(w, 'reset', 'Unlock now', '', true)), `${w.id}:reset`),
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
        card('Revoke a credential', 'WRITE', input(w, 'credentialId', 'Credential', 'C12 or 12', true, true) + btns(btn(w, 'revoke', 'Revoke', 'danger', true)), `${w.id}:revoke`) +
        card('Cancel a revocation', 'WRITE', input(w, 'cancelCred', 'Credential', 'C12 or 12', true, true) + btns(btn(w, 'cancelRevoke', 'Cancel it', '', true)), `${w.id}:cancelRevoke`) +
        card(
          'Issue a credential',
          'WRITE',
          select(w, 'owner', 'Issue to', people, true) +
            select(w, 'scope', 'Access to', scopes, true) +
            select(w, 'permission', 'Permission', access, true) +
            btns(btn(w, 'create', 'Issue credential', '', true)),
          `${w.id}:create`,
        )
      );
    },
    run: (w, cmd, arg) => {
      const f = (k: string): string => w.form[`p:${k}`] ?? '';
      if (cmd === 'view') execute(w, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', { show: arg ?? 'ACTIVE' });
      else if (cmd === 'revoke') runFresh(w, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: f('credentialId') }, ['credentialId']);
      else if (cmd === 'cancelRevoke') runFresh(w, 'SECURITY', 'PERMISSIONS', 'CANCEL_REVOKE', { credentialId: f('cancelCred') }, ['cancelCred']);
      else execute(w, 'SECURITY', 'PERMISSIONS', 'CREATE_CREDENTIAL', { owner: f('owner'), scope: f('scope'), permission: f('permission') });
    },
  },
  'CLIENT_DATA.CUSTOMER_RECORDS': {
    commands: (w) =>
      card('View customers', 'READ', btn(w, 'view:MINE', 'My customers') + btn(w, 'view:ALL', 'All customers', 'alt')) +
      card(
        'Add account',
        'WRITE',
        input(w, 'addCust', 'Customer', 'CU1') +
          input(w, 'addAcct', 'Account', '12345', true) +
          input(w, 'addReq', 'Request (optional)', 'REQ-1') +
          checkbox(w, 'addPrimary', 'Make it their primary account') +
          btns(btn(w, 'add', 'Add account', '', true)),
        `${w.id}:add`,
      ) +
      card(
        'Set primary account',
        'WRITE',
        input(w, 'priCust', 'Customer', 'CU1') +
          input(w, 'priAcct', 'Account', '12345', true) +
          input(w, 'priReq', 'Request (optional)', 'REQ-1') +
          btns(btn(w, 'primary', 'Set primary', '', true)),
        `${w.id}:primary`,
      ) +
      card(
        'Remove account',
        'WRITE',
        input(w, 'remCust', 'Customer', 'CU1') +
          input(w, 'remAcct', 'Account', '12345', true) +
          input(w, 'remReq', 'Request (optional)', 'REQ-1') +
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
      card(
        'Investigate changes',
        'READ',
        input(w, 'target', 'Customer or account', 'CU3 or 12345', true, true) + btns(btn(w, 'investigate', 'Show change history', 'alt', true)),
        `${w.id}:investigate`,
      ) +
      card('Verify a change', 'WRITE', input(w, 'changeId', 'Change', 'CH-1 or 1', true, true) + btns(btn(w, 'verify', 'Verify', '', true)), `${w.id}:verify`),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'CLIENT_DATA', 'VERIFICATION', 'VIEW_VERIFICATION', { show: arg ?? 'PENDING' });
      else if (cmd === 'investigate') runFresh(w, 'CLIENT_DATA', 'VERIFICATION', 'INVESTIGATE_CHANGES', { target: w.form['p:target'] ?? '' }, ['target']);
      else runFresh(w, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: w.form['p:changeId'] ?? '' }, ['changeId']);
    },
  },
  'CLIENT_DATA.CLIENT_REQUESTS': {
    commands: (w) =>
      card('View requests', 'READ', btn(w, 'view:OPEN', 'Open requests') + btn(w, 'view:ALL', 'All requests', 'alt')) +
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
        input(w, 'originAccount', 'Originator account', '12345') +
          input(w, 'beneficiaryId', 'Beneficiary', 'CU1') +
          input(w, 'amount', 'Amount', '1,000,000 or 1m', true) +
          input(w, 'requestId', 'Request (optional)', 'REQ-1') +
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
          input(w, 'reason', 'Reason', 'Why this score?', true, true) +
          btns(btn(w, 'check', 'Submit score', '', true)),
        `${w.id}:check`,
      ),
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'TRANSACTIONS', 'RISK_CHECK', 'VIEW_RISK_QUEUE', { show: arg ?? 'PENDING' });
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
  return `
    <section class="mod-sec"><h3>Credential</h3>${credentialFields(
      w,
      v,
      (c) => c.system === r.system && (c.module === null || c.module === r.module),
      // Prefer one that allows everything on this module.
      (c) => c.permission === 'WRITE' && c.fn === null,
      `${r.system}.${r.module}`,
    )}</section>
    <section class="mod-sec"><h3>Commands</h3><div class="cmds">${page.commands(w)}</div></section>
    ${terminalHtml(w)}`;
}

// ---- Workstation screens: your own (My workstation) or someone else's once logged in ------------
const TABS: [Tab, string][] = [
  ['profile', 'Profile'],
  ['codes', 'Credentials'],
  ['activity', 'Activity'],
  ['messages', 'Messages'],
];

/** Tabs + body for a workstation. `remote` = someone else's, shown read-only. */
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
      <dl class="kv"><dt>Name</dt><dd>${esc(ws.name)}</dd><dt>Role</dt><dd>${esc(ws.roleLabel)}</dd><dt>IP</dt><dd>${esc(ws.ip)}</dd><dt>Account</dt><dd>${esc(ws.bankAccount)}${ws.bankBalance === null ? "" : " · " + money(ws.bankBalance)}</dd></dl>
      <h4>${their} objective</h4><div class="note">${esc(ws.objective)}</div>
      <p class="hint">${esc(ws.motivation)}</p>
      <h4>Job: ${esc(ws.roleLabel)}</h4><p class="job-summary">${esc(job.summary)}</p>
      <h4>What you do</h4>${list(job.duties)}
      <h4>Your tools</h4>${list(job.tools)}
      <h4>Who you depend on</h4>${list(job.dependsOn)}
      <h4>Rules to know</h4>${list(job.rules)}
      ${job.operative ? `<div class="job-secret"><h4>Operative handbook</h4>${list(job.operative)}</div>` : ''}`;
  } else if (current === 'codes') {
    body = `
      <p class="hint">Logs name the credential owner, not the person who typed the code.</p>
      ${remote ? '' : `<div class="sharebar"><span>Share with</span><select data-f="shareTo">${playerOpts(f.shareTo)}</select></div>`}
      <table class="cred">${ws.credentials
        .map(
          (c) => `<tr>
            <td><span class="code ${c.status === 'REVOKED' ? 'rev' : ''}">${esc(c.code)}</span></td>
            <td>${esc(c.id)} ${c.own ? '' : `<em>${esc(c.ownerName)}'s</em>`}<br><small>${esc(c.scope)}${c.status === 'REVOKED' ? ', revoked' : ''}</small></td>
            ${remote ? '' : `<td><button class="small-btn" data-act="share:${c.id}">Share</button></td>`}</tr>`,
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
      <p class="hint">${esc(r.address)}. Log in with one of ${esc(name)}'s credential codes.</p>
      ${credentialFields(w, v, (c) => c.ownerName === name)}
      <button class="run" data-act="wunlock:${w.id}">Log in</button>
      ${w.notice.map((l) => `<div class="notice ${l.cls}">${esc(l.text)}</div>`).join('')}
    </div></div>`;
}

function unlock(w: Win): void {
  const r = route(w);
  if (!r || r.kind !== 'workstation') return;
  const res = applyAction(game, { type: 'ACCESS_WORKSTATION', playerId: selected, targetId: r.playerId, code: (w.form.code ?? '').trim() }, vNow);
  game = res.state;
  w.notice = res.result.ok ? [] : [{ cls: 'bad', text: res.result.message }];
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

function doShare(w: Win, credId: string): void {
  const r = applyAction(game, { type: 'SHARE_CREDENTIAL', playerId: selected, credentialId: credId, toPlayerId: w.form.shareTo }, vNow);
  game = r.state;
  w.notice = [{ cls: r.result.ok ? 'ok' : 'bad', text: r.result.message }];
  refresh();
  renderPersonal(true);
}

function doSend(w: Win): void {
  const r = applyAction(game, { type: 'SEND_MESSAGE', playerId: selected, toPlayerId: w.form.msgTo, text: w.form.msgText ?? '' }, vNow);
  game = r.state;
  if (r.result.ok) w.form.msgText = '';
  w.notice = r.result.ok ? [] : [{ cls: 'bad', text: r.result.message }];
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
  return `<button class="bell ${on ? 'on' : ''}" data-act="watch:${key}" title="Notify me about ${esc(what)}" aria-pressed="${on}">${BELL_SVG}<span>${on ? 'On' : 'Off'}</span></button>`;
}

function toggleWatch(w: Win | undefined, key: string): void {
  const [system, module] = key.split('.') as [SystemId, string];
  const on = !view().watching.includes(key);
  const r = applyAction(game, { type: 'SET_WATCH', playerId: selected, system, module, on }, vNow);
  game = r.state;
  if (!r.result.ok) toast(r.result.message, 'Notifications', true);
  if (w) renderWin(w);
}

/** Pops up every notification this seat has not seen yet. Switching seats skips the backlog. */
function pollNotices(skip = false): void {
  const list = game.players[selected]?.notifications ?? [];
  const seen = seenNotices[selected] ?? 0;
  const fresh = list.filter((n) => noticeNum(n.id) > seen);
  if (fresh.length) seenNotices[selected] = noticeNum(fresh[fresh.length - 1].id);
  if (!skip) for (const n of fresh.slice(-4)) toast(n.text, n.page);
}

function toast(text: string, page: string, error = false): void {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('button');
  el.className = `toast${error ? ' err' : ''}`;
  el.innerHTML = `<b>${esc(page)}</b><span>${esc(text)}</span>`;
  const close = (): void => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener('click', close);
  box.appendChild(el);
  setTimeout(close, TOAST_MS);
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
  renderDev();
  renderStatus();
  renderRail();
  renderIcons();
  renderWins();
  renderTaskbar();
  renderTruth();
}

/** After any game action: everything that can change except browser windows the player is using. */
function refresh(): void {
  pollNotices();
  renderStatus();
  renderIcons();
  renderTaskbar();
  renderTruth();
  renderPersonal();
}

// ---- Events ---------------------------------------------------------------------------------
app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const [act, ...args] = (el.dataset.act ?? '').split(':');
  const w = args[0] ? winById(Number(args[0])) : undefined;
  const hostWin = winById(Number(el.closest<HTMLElement>('.win')?.dataset.win));
  switch (act) {
    case 'speed':
      speed = Number(args[0]);
      renderDev();
      break;
    case 'skip':
      vNow += Number(args[0]) * 1000;
      advanceState(game, vNow);
      refresh();
      break;
    case 'newgame': {
      const count = Math.floor(Number((app.querySelector('[data-f="count"]') as HTMLInputElement | null)?.value));
      playerCount = Number.isFinite(count) ? clamp(count, MIN_PLAYERS, MAX_PLAYERS) : playerCount;
      const raw = (app.querySelector('[data-f="seed"]') as HTMLInputElement | null)?.value;
      const n = Number(raw);
      newGame(Number.isFinite(n) && raw !== '' ? n : Math.floor(Math.random() * 1e9));
      break;
    }
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
      if (!t.min && t === topWin()) {
        t.min = true;
        placeWin(t);
        markFocus();
        renderTaskbar();
      } else focusWin(t);
      break;
    }
    case 'wmin':
      if (w) {
        w.min = true;
        placeWin(w);
        markFocus();
        renderTaskbar();
      }
      break;
    case 'wmax':
      if (w) {
        w.max = !w.max;
        renderWin(w);
      }
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
  }
});

app.addEventListener('submit', (e) => {
  const form = e.target as HTMLElement;
  if (form.dataset.mform) {
    e.preventDefault();
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
    if (key === 'p:monitor' && w.form[key] === 'YES') {
      const r = route(w);
      if (r?.kind === 'module') MODULE_PAGES[`${r.system}.${r.module}`]?.run(w, 'view');
    }
    return;
  }
  switch (key) {
    case 'seat':
      selected = el.value;
      pollNotices(true); // a seat you just sat down at shows only what arrives from now on
      renderAll();
      break;
    case 'auto':
      game.config.autoProcess = (el as HTMLInputElement).checked;
      break;
    case 'god':
      god = (el as HTMLInputElement).checked;
      renderRail();
      break;
  }
});

// ---- Window dragging and resizing ------------------------------------------------------------
let drag: { w: Win; el: HTMLElement; mode: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number } | null = null;

$('wins').addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  const el = target.closest<HTMLElement>('.win');
  const w = el && winById(Number(el.dataset.win));
  if (!el || !w) return;
  if (topWin() !== w) focusWin(w);
  const handle = target.closest<HTMLElement>('[data-drag],[data-resize]');
  if (!handle || target.closest('button') || w.max || e.button !== 0) return;
  const mode = handle.dataset.resize ? 'resize' : 'move';
  if (mode === 'resize') w.sized = true;
  drag = { w, el, mode, sx: e.clientX, sy: e.clientY, ox: mode === 'move' ? w.x : w.w, oy: mode === 'move' ? w.y : w.h };
  handle.setPointerCapture(e.pointerId);
  el.classList.add('dragging');
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const { w, mode, sx, sy, ox, oy } = drag;
  const { w: dw, h: dh } = deskSize();
  const dx = e.clientX - sx;
  const dy = e.clientY - sy;
  if (mode === 'move') {
    w.x = clamp(ox + dx, 80 - w.w, dw - 80);
    w.y = clamp(oy + dy, 0, dh - 34);
  } else {
    w.w = clamp(ox + dx, 340, Math.max(340, dw - w.x));
    w.h = clamp(oy + dy, 220, Math.max(220, dh - w.y));
  }
  placeWin(w, drag.el);
});

const endDrag = (): void => {
  drag?.el.classList.remove('dragging');
  drag = null;
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// The desktop never scrolls: focusing an input in a window that sticks out would otherwise shift everything.
$('desk').addEventListener('scroll', () => {
  $('desk').scrollTop = 0;
  $('desk').scrollLeft = 0;
});

$('wins').addEventListener('dblclick', (e) => {
  const target = e.target as HTMLElement;
  const bar = target.closest<HTMLElement>('[data-drag]');
  const w = bar && winById(Number(bar.dataset.drag));
  if (!w || target.closest('button')) return;
  w.max = !w.max;
  renderWin(w);
});

// ---- Clock ---------------------------------------------------------------------------------------
setInterval(() => {
  if (speed === 0 || game.status !== 'RUNNING') return;
  vNow += TICK_MS * speed;
  advanceState(game, vNow);
  tickCount++;
  if (game.status !== 'RUNNING') return refresh();
  updateClock();
  pollNotices();
  if (tickCount % 8 === 0) renderTruth();
}, TICK_MS);

// Handy in the browser console: cyberHeist.state
Object.defineProperty(window, 'cyberHeist', { get: () => ({ state: game, now: vNow }) });

const urlSeed = Number(new URLSearchParams(location.search).get('seed'));
newGame(Number.isFinite(urlSeed) && urlSeed > 0 ? urlSeed : 1);
