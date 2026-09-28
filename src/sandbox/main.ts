// Local single-browser sandbox. The yellow bar at the top is sandbox tooling; everything below it is the
// player screen exactly as one player would see it. It talks to the engine the way a client will later
// talk to the server: applyAction(state, action, now).

import './style.css';
import {
  advanceState,
  applyAction,
  createGame,
  ENCRYPTION_ENABLED,
  findFn,
  findModule,
  findSystem,
  fmtClock,
  getPlayerView,
  grantMasterAccess,
  money,
  SYSTEMS,
} from '../engine';
import type { Action, FnDef, GameState, ParamSpec, PlayerId, PlayerView, SystemId, WorkstationView } from '../engine';

const NAMES = ['Jeremy', 'Sarah', 'Mike', 'David', 'Lisa', 'Anna', 'Omar', 'Priya', 'Chen', 'Rosa'];
const ROSTER = NAMES.map((name, i) => ({ id: `p${i}`, name }));
const MASTER_SEAT = ROSTER[0].id; // this seat gets whole-system credentials for every system
const TICK_MS = 250;
const TASKBAR_H = 44;

type Line = { cls: string; text: string };
type Route =
  | { kind: 'system'; system: SystemId }
  | { kind: 'module'; system: SystemId; module: string }
  | { kind: 'fn'; system: SystemId; module: string; fn: string }
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
  out: Line[];
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
  game = createGame({ seed, players: ROSTER, now: vNow, config: { autoProcess } });
  grantMasterAccess(game, MASTER_SEAT);
  desks = {};
  for (const p of ROSTER) seenMessages[p.id] = 0;
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
      .map((id) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(game.players[id].name)}${id === MASTER_SEAT ? ' (master access)' : ''}</option>`)
      .join('')}</select></label>
    <span class="grp">${btn('speed:0', 'Pause', speed === 0)}${btn('speed:1', '1x', speed === 1)}${btn('speed:5', '5x', speed === 5)}${btn('speed:20', '20x', speed === 20)}<button data-act="skip:30">+30s</button></span>
    <label><input type="checkbox" data-f="auto" ${game.config.autoProcess ? 'checked' : ''}> auto-process routine payments</label>
    <label><input type="checkbox" data-f="god" ${god ? 'checked' : ''}> show allegiances</label>
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
      return `${p.name.padEnd(8)} ${p.allegiance.padEnd(6)} ${p.role.padEnd(22)} ${p.ip}`;
    })
    .join('\n');
  const logs = s.logs
    .filter((l) => l.actor !== 'SYSTEM')
    .slice(-40)
    .map((l) => `[${t(l.t)}] ${l.id.padEnd(5)} says ${(l.actor === 'UNKNOWN' ? 'UNKNOWN' : (s.players[l.actor]?.name ?? l.actor)).padEnd(8)} truth ${(s.players[l.actualPlayerId ?? '']?.name ?? '-').padEnd(8)} ${l.sourceIp ?? ''}  ${l.message}`)
    .join('\n');
  const txs = s.transactions
    .slice(-25)
    .map((x) => `${x.id} ${money(x.amount).padStart(11)} ${x.status.padEnd(12)} ${x.origin.padEnd(6)} to ${s.beneficiaries[x.beneficiaryId].name} ${x.settledTo ?? ''} ${x.fraud ? 'FRAUD' : ''}`)
    .join('\n');
  const bn = s.blacknet.map((m) => `[${t(m.t)}] ${m.alias} (really ${s.players[m.ownerId].name}): ${m.text}`).join('\n');
  const targets = s.targets.map((x) => `${x.account} ${x.status}`).join('   ');
  el.innerHTML = `
    <div class="truth-head"><b>Ground truth (spoilers)</b><button data-act="truth" aria-label="Close ground truth">Close</button></div>
    <div class="totals"><span>settled: ${money(s.totals.processedNpc)}</span><span>stolen: ${money(s.totals.stolen)} / ${money(s.config.blackTarget)}</span><span>targets: ${esc(targets)}</span></div>
    <h4>People</h4><pre>${esc(people)}</pre>
    <h4>Player activity: what the log says vs who did it</h4><pre>${esc(logs || 'No player activity yet.')}</pre>
    <h4>Payments</h4><pre>${esc(txs)}</pre>
    <h4>Blacknet</h4><pre>${esc(bn || 'No Blacknet posts.')}</pre>`;
}

// ---- Game: status bar -----------------------------------------------------------------
function renderStatus(): void {
  const v = view();
  const ended = game.status === 'ENDED';
  const banner = ended
    ? `<div class="banner ${game.winner === 'WHITE' ? 'white' : 'black'}">${game.winner === 'WHITE' ? 'White Hats win' : 'Black Hats win'}. ${esc(game.endReason)}</div>`
    : '';
  $('status').innerHTML = `
    <div class="who"><b>${esc(v.me.name)}</b><span>${esc(v.me.roleLabel)}</span>
      <span class="chip ${v.me.allegiance}">${v.me.allegiance === 'BLACK' ? 'Black Hat' : 'White Hat'}</span>
      <span id="lock" class="chip lock" hidden></span></div>
    <div class="clock"><b id="clk"></b><small id="left"></small></div>
    <div class="throughput"><div class="bar"><i id="bar"></i></div><span id="thr"></span></div>
    ${banner}`;
  updateClock();
}

function updateClock(): void {
  const v = view();
  $('clk').textContent = v.clock;
  $('left').textContent = `${mmss(v.durationSec - v.t)} left`;
  $('bar').style.width = `${Math.min(100, (v.processedNpc / v.whiteTarget) * 100)}%`;
  $('thr').textContent = `${money(v.processedNpc)} of ${money(v.whiteTarget)} legitimate payments settled`;
  const lock = $('lock');
  lock.hidden = v.me.lockedForSec <= 0;
  lock.textContent = `Workstation locked ${v.me.lockedForSec}s`;
}

// ---- Game: employee sidebar ------------------------------------------------------------
function renderRail(): void {
  $('rail').innerHTML = `<h3>Employees</h3>${game.playerOrder
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
  if (r.kind === 'fn') a += '/' + slug(r.fn);
  return a;
}

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
  };
  list.push(win);
  renderWin(win);
  fitWin(win);
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
  w.out = [];
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

/** Address bar: "10.0.0.30", "10.0.0.30/settlement" or "10.0.0.30/settlement/settle". */
function goAddress(w: Win): void {
  const raw = w.addr.trim();
  const [host = '', modSlug, fnSlug] = raw.replace(/^[a-z]+:\/\//i, '').split('/').filter(Boolean);
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
  const fn = mod && fnSlug ? mod.fns.find((f) => slug(f.id) === fnSlug) : undefined;
  if ((modSlug && !mod) || (fnSlug && !fn)) {
    return navigate(w, { kind: 'noroute', address: raw, message: `${sys.label} has no page at that path.` });
  }
  if (mod && fn) navigate(w, { kind: 'fn', system: sys.id, module: mod.id, fn: fn.id });
  else if (mod) navigate(w, { kind: 'module', system: sys.id, module: mod.id });
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
      parts.push(crumb(mod.label, r.kind === 'module' ? null : `wgo:${w.id}:${sys.id}:${mod.id}`));
      if (r.kind === 'fn') parts.push(crumb(findFn(r.system, r.module, r.fn)!.label, null));
    }
    crumbs = `<div class="crumbs">${parts.join('<i>/</i>')}</div>`;
    if (r.kind === 'system') {
      body = `<div class="tiles">${sys.modules
        .map((m) => `<button class="tile" data-act="wgo:${w.id}:${sys.id}:${m.id}"><b>${esc(m.label)}</b><small>${m.fns.length} function${m.fns.length === 1 ? '' : 's'}</small></button>`)
        .join('')}</div>`;
    } else if (r.kind === 'module' && MODULE_PAGES[`${r.system}.${r.module}`]) {
      body = modulePageHtml(w, r);
    } else if (r.kind === 'module') {
      const mod = findModule(r.system, r.module)!;
      body = `<div class="fnlist">${mod.fns
        .map(
          (f) => `<button class="fnbtn" data-act="wgo:${w.id}:${sys.id}:${mod.id}:${f.id}">
            <span><b>${esc(f.label)}</b><small>${esc(f.description)}</small></span>
            <i class="perm ${f.permission}">${f.permission === 'WRITE' ? 'Write' : 'Read'}</i></button>`,
        )
        .join('')}</div>`;
    } else {
      body = fnHtml(w, r);
    }
  }
  return `${nav}${crumbs}<div class="wbody">${body}</div>`;
}

// ---- Function page (the original terminal form, one per window) -------------------------
function credCovers(c: PlayerView['me']['credentials'][number], system: string, module: string, fn: string, write: boolean): boolean {
  return (
    c.status === 'ACTIVE' &&
    c.system === system &&
    (c.module === null || c.module === module) &&
    (c.fn === null || c.fn === fn) &&
    (c.permission === 'WRITE' || !write)
  );
}

function paramField(spec: ParamSpec, v: PlayerView, form: Record<string, string>): string {
  const key = `p:${spec.name}`;
  const label = `<span>${esc(spec.label)}${spec.optional ? ' (optional)' : ''}</span>`;
  const select = (opts: { value: string; label: string }[]): string => {
    if (!(key in form) || !opts.some((o) => o.value === form[key])) form[key] = opts[0]?.value ?? '';
    return `<label class="field">${label}<select data-f="${key}">${opts
      .map((o) => `<option value="${esc(o.value)}" ${form[key] === o.value ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select></label>`;
  };
  switch (spec.kind) {
    case 'select':
      return select((spec.options ?? []).map((o) => ({ value: o, label: o })));
    case 'player':
      return select(v.players.map((p) => ({ value: p.id, label: `${p.name} (${p.roleLabel})` })));
    case 'module':
      return select(
        v.systems.flatMap((sys) => sys.modules.map((m) => ({ value: `${sys.id}.${m.id}`, label: `${sys.label} / ${m.label}` }))),
      );
    case 'scope':
      return select(
        v.systems.flatMap((sys) => [
          { value: `${sys.id}.*`, label: `${sys.label} (whole system)` },
          ...sys.modules.map((m) => ({ value: `${sys.id}.${m.id}`, label: `${sys.label} / ${m.label}` })),
        ]),
      );
    default:
      return `<label class="field">${label}<input data-f="${key}" value="${esc(form[key] ?? '')}" placeholder="${esc(spec.placeholder ?? '')}" autocomplete="off"></label>`;
  }
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
function credentialFields(w: Win, v: PlayerView, applies: (c: Cred) => boolean, prefer?: (c: Cred) => boolean): string {
  const list = v.me.credentials.filter((c) => c.status === 'ACTIVE' && applies(c));
  const opts: [string, string][] = [...(list.length ? list.map((c): [string, string] => [c.id, credLabel(c)]) : [['none', 'No credentials granted'] as [string, string]]), ['manual', 'Manual code']];
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

function terminalHtml(w: Win): string {
  return `<div class="out" aria-live="polite">${w.out.map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('') || '<div class="dim">Output appears here.</div>'}</div>`;
}

function fnHtml(w: Win, r: Extract<Route, { kind: 'fn' }>): string {
  const v = view();
  const def = findFn(r.system, r.module, r.fn) as FnDef;
  const params = def.params.map((p) => paramField(p, v, w.form)).join('');
  return `<div class="fn">
      <h2>${esc(def.label)} <i class="perm ${def.permission}">${def.permission === 'WRITE' ? 'Write' : 'Read'}</i></h2>
      <p class="hint">${esc(def.description)}</p>
      ${credentialFields(
        w,
        v,
        (c) => c.system === r.system && (c.module === null || c.module === r.module),
        (c) => credCovers(c, r.system, r.module, r.fn, def.permission === 'WRITE'),
      )}
      ${params ? `<div class="grid2">${params}</div>` : ''}
      ${ENCRYPTION_ENABLED ? `<label class="field"><span>Encryption layer codes, only if the module is encrypted (comma separated)</span><input data-f="enc" value="${esc(w.form.enc ?? '')}" autocomplete="off"></label>` : ''}
      <button class="run" data-act="wrun:${w.id}">Run</button>
    </div>
    ${terminalHtml(w)}`;
}

function run(w: Win): void {
  const r = route(w);
  if (!r || r.kind !== 'fn') return;
  const def = findFn(r.system, r.module, r.fn);
  const params: Record<string, string> = {};
  for (const p of def?.params ?? []) params[p.name] = w.form[`p:${p.name}`] ?? '';
  execute(w, r.system, r.module, r.fn, params);
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
  w.out.push({ cls: 'cmd', text: `> ${def?.label ?? fn}` }, { cls: res.result.ok ? 'ok' : 'bad', text: res.result.message });
  for (const line of res.result.lines ?? []) w.out.push({ cls: 'row', text: line });
  if (w.out.length > 300) w.out.splice(0, w.out.length - 300);
  renderWin(w);
  refresh();
  return res.result.ok;
}

// ---- Module pages: one screen per module (credential, commands, terminal) ------------------------
// Modules listed here skip the function layer. The rest still show a list of functions.

type ModuleRoute = Extract<Route, { kind: 'module' }>;
const MODULE_PAGES: Record<string, { commands: (w: Win) => string; run: (w: Win, cmd: string, arg?: string) => void }> = {
  'TRANSACTIONS.PAYMENT_QUEUE': {
    commands: (w) => `
      <div class="cmd-card">
        <div class="cmd-head"><b>View queue</b><i class="perm READ">Read</i></div>
        <div class="cmd-row">
          <button class="cmd-btn" data-act="mcmd:${w.id}:view:ACTIVE">Pending payments</button>
          <button class="cmd-btn alt" data-act="mcmd:${w.id}:view:ALL">All payments</button>
        </div>
      </div>
      <form class="cmd-card" data-mform="${w.id}:create">
        <div class="cmd-head"><b>Create payment</b><i class="perm WRITE">Write</i></div>
        <div class="cmd-row">
          <label class="field"><span>Beneficiary</span><input data-f="p:beneficiaryId" value="${esc(w.form['p:beneficiaryId'] ?? '')}" placeholder="B1" autocomplete="off" size="6"></label>
          <label class="field grow"><span>Amount</span><input data-f="p:amount" value="${esc(w.form['p:amount'] ?? '')}" placeholder="1,000,000 or 1m" autocomplete="off"></label>
          <button class="cmd-btn" type="submit">Create</button>
        </div>
      </form>`,
    run: (w, cmd, arg) => {
      if (cmd === 'view') execute(w, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', { show: arg ?? 'ACTIVE' });
      else if (cmd === 'amount') {
        w.form['p:amount'] = arg ?? '';
        renderWin(w);
      } else if (cmd === 'create') {
        const amount = parseAmount(w.form['p:amount'] ?? '');
        const created = execute(w, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', {
          beneficiaryId: w.form['p:beneficiaryId'] ?? '',
          amount: amount === null ? '' : String(amount),
        });
        // Every payment needs its amount typed fresh.
        if (created) {
          w.form['p:amount'] = '';
          renderWin(w);
        }
      }
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
    )}</section>
    <section class="mod-sec"><h3>Commands</h3><div class="cmds">${page.commands(w)}</div></section>
    <section class="mod-sec term"><h3>Terminal</h3>${terminalHtml(w)}</section>`;
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
    const sysLabel = (id: string): string => SYSTEMS.find((s) => s.id === id)?.label ?? id;
    body = `
      <dl class="kv"><dt>Name</dt><dd>${esc(ws.name)}</dd><dt>Role</dt><dd>${esc(ws.roleLabel)}</dd><dt>IP</dt><dd>${esc(ws.ip)}</dd><dt>Account</dt><dd>${esc(ws.bankAccount)}</dd></dl>
      <h4>${their} objective</h4><div class="note">${esc(ws.objective)}</div>
      <p class="hint">${esc(ws.motivation)}</p>
      <h4>Private information</h4>
      ${ws.packets.map((p) => `<div class="packet"><small>${esc(p.system === 'BLACKHAT_DB' ? 'Network rumours' : sysLabel(p.system))}</small>${esc(p.text)}</div>`).join('')}`;
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
    .join('')}</div><div class="wbody">${w.out.map((l) => `<div class="notice ${l.cls}">${esc(l.text)}</div>`).join('')}${body}</div>`;
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
      ${w.out.map((l) => `<div class="notice ${l.cls}">${esc(l.text)}</div>`).join('')}
    </div></div>`;
}

function unlock(w: Win): void {
  const r = route(w);
  if (!r || r.kind !== 'workstation') return;
  const res = applyAction(game, { type: 'ACCESS_WORKSTATION', playerId: selected, targetId: r.playerId, code: (w.form.code ?? '').trim() }, vNow);
  game = res.state;
  w.out = res.result.ok ? [] : [{ cls: 'bad', text: res.result.message }];
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
  w.out = [{ cls: r.result.ok ? 'ok' : 'bad', text: r.result.message }];
  refresh();
  renderPersonal(true);
}

function doSend(w: Win): void {
  const r = applyAction(game, { type: 'SEND_MESSAGE', playerId: selected, toPlayerId: w.form.msgTo, text: w.form.msgText ?? '' }, vNow);
  game = r.state;
  if (r.result.ok) w.form.msgText = '';
  w.out = r.result.ok ? [] : [{ cls: 'bad', text: r.result.message }];
  refresh();
  renderPersonal(true);
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
    case 'wgo':
      if (w) {
        const [, system, module, fn] = args as [string, SystemId, string?, string?];
        if (module && fn) navigate(w, { kind: 'fn', system, module, fn });
        else if (module) navigate(w, { kind: 'module', system, module });
        else navigate(w, { kind: 'system', system });
      }
      break;
    case 'wrun':
      if (w) run(w);
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
      if (hostWin) hostWin.out = [];
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
    const [id, cmd] = form.dataset.mform.split(':');
    const mw = winById(Number(id));
    const r = mw && route(mw);
    if (mw && r?.kind === 'module') MODULE_PAGES[`${r.system}.${r.module}`]?.run(mw, cmd);
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
    } else w.form[key] = el.value;
    return;
  }
  switch (key) {
    case 'seat':
      selected = el.value;
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
  if (tickCount % 8 === 0) renderTruth();
}, TICK_MS);

// Handy in the browser console: cyberHeist.state
Object.defineProperty(window, 'cyberHeist', { get: () => ({ state: game, now: vNow }) });

const urlSeed = Number(new URLSearchParams(location.search).get('seed'));
newGame(Number.isFinite(urlSeed) && urlSeed > 0 ? urlSeed : 1);
