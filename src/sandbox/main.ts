// Local single-browser sandbox. One person can play every seat by switching players on the left.
// It talks to the engine exactly the way a client will later talk to the server: applyAction(state, action, now).

import './style.css';
import { advanceState, applyAction, createGame, findFn, fmtClock, getPlayerView, money, SYSTEMS } from '../engine';
import type { Action, GameState, ParamSpec, PlayerId, PlayerView, SystemId } from '../engine';

const NAMES = ['Jeremy', 'Sarah', 'Mike', 'David', 'Lisa', 'Anna', 'Omar', 'Priya', 'Chen', 'Rosa'];
const ROSTER = NAMES.map((name, i) => ({ id: `p${i}`, name }));
const TICK_MS = 250;

// ---- Sandbox state ----------------------------------------------------------------
let game: GameState;
let vNow = 0; // virtual "now" in ms, advanced by the timer
let speed = 1; // 0 = paused
let selected: PlayerId = ROSTER[0].id;
let tab: 'profile' | 'codes' | 'activity' | 'messages' = 'profile';
let god = false;
let codeManual = false;
let tickCount = 0;
const form: Record<string, string> = {};
const consoles: Record<PlayerId, { cls: string; text: string }[]> = {};
const seenMessages: Record<PlayerId, number> = {};

const app = document.getElementById('app') as HTMLElement;
app.innerHTML = `
  <div class="shell">
    <header id="hdr"></header>
    <div class="cols">
      <nav id="rail" aria-label="Players"></nav>
      <main>
        <section id="term-form" class="panel"></section>
        <section id="term-out" aria-live="polite"></section>
      </main>
      <aside id="node" class="panel"></aside>
    </div>
    <details id="god"><summary>Ground truth (spoilers)</summary><div id="god-body"></div></details>
  </div>`;
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const view = (): PlayerView => getPlayerView(game, selected);

// ---- Game lifecycle ----------------------------------------------------------------
function newGame(seed: number): void {
  const autoProcess = game ? game.config.autoProcess : true;
  vNow = Date.now();
  game = createGame({ seed, players: ROSTER, now: vNow, config: { autoProcess } });
  for (const p of ROSTER) {
    consoles[p.id] = [{ cls: 'dim', text: 'Workstation ready. Pick a function, enter a 4-digit credential code, and run it.' }];
    seenMessages[p.id] = 0;
  }
  selected = ROSTER[0].id;
  tab = 'profile';
  codeManual = false;
  form.code = '';
  form.fn = '';
  renderAll();
}

// ---- Rendering: header -----------------------------------------------------------------
function renderHeader(): void {
  const btn = (act: string, label: string, on: boolean): string =>
    `<button data-act="${act}" class="${on ? 'on' : ''}">${label}</button>`;
  const ended = game.status === 'ENDED';
  const banner = ended
    ? `<div class="banner ${game.winner === 'WHITE' ? 'white' : 'black'}">${game.winner === 'WHITE' ? 'White Hats win' : 'Black Hats win'}. ${esc(game.endReason)}</div>`
    : '';
  $('hdr').innerHTML = `
    <div class="brand">Cyber-Heist <span>sandbox</span></div>
    <div class="clock"><b id="clk"></b><small id="left"></small></div>
    <div class="throughput"><div class="bar"><i id="bar"></i></div><span id="thr"></span></div>
    <div class="controls">
      ${btn('speed:0', 'Pause', speed === 0)}${btn('speed:1', '1x', speed === 1)}${btn('speed:5', '5x', speed === 5)}${btn('speed:20', '20x', speed === 20)}
      <button data-act="skip:30">+30s</button>
      <label><input type="checkbox" data-f="auto" ${game.config.autoProcess ? 'checked' : ''}> auto-process routine payments</label>
      <label><input type="checkbox" data-f="god" ${god ? 'checked' : ''}> show allegiances</label>
      <label>seed <input type="number" data-f="seed" value="${game.seed >>> 0}"></label>
      <button data-act="newgame">New game</button>
    </div>
    ${banner}`;
  updateClock();
}

function updateClock(): void {
  const v = view();
  $('clk').textContent = v.clock;
  $('left').textContent = `${mmss(v.durationSec - v.t)} left`;
  ($('bar') as HTMLElement).style.width = `${Math.min(100, (v.processedNpc / v.whiteTarget) * 100)}%`;
  $('thr').textContent = `${money(v.processedNpc)} of ${money(v.whiteTarget)} legitimate payments settled`;
}

// ---- Rendering: players ------------------------------------------------------------------
function renderRail(): void {
  $('rail').innerHTML = game.playerOrder
    .map((id) => {
      const p = game.players[id];
      const v = getPlayerView(game, id);
      const unread = p.messages.filter((m) => m.to === id).length - (seenMessages[id] ?? 0);
      return `<button class="pl ${id === selected ? 'sel' : ''}" data-act="player:${id}">
        <span class="nm">${esc(p.name)}</span><span class="rl">${esc(v.me.roleLabel)}</span>
        ${god ? `<i class="tag ${p.allegiance}">${p.allegiance === 'BLACK' ? 'Black' : 'White'}</i>` : ''}
        ${unread > 0 ? `<span class="unread">${unread}</span>` : ''}
      </button>`;
    })
    .join('');
}

// ---- Rendering: terminal form ------------------------------------------------------------------
function credCovers(c: PlayerView['me']['credentials'][number], system: string, module: string, fn: string, write: boolean): boolean {
  return (
    c.status === 'ACTIVE' &&
    c.system === system &&
    (c.module === null || c.module === module) &&
    (c.fn === null || c.fn === fn) &&
    (c.permission === 'WRITE' || !write)
  );
}

function fnOptions(v: PlayerView): string {
  const groups = v.systems
    .map((sys) =>
      sys.modules
        .map(
          (m) =>
            `<optgroup label="${esc(sys.label)} / ${esc(m.label)}">${m.fns
              .map((f) => {
                const val = `${sys.id}|${m.id}|${f.id}`;
                return `<option value="${val}" ${form.fn === val ? 'selected' : ''}>${esc(f.label)}${f.permission === 'WRITE' ? ' (write)' : ''}</option>`;
              })
              .join('')}</optgroup>`,
        )
        .join(''),
    )
    .join('');
  const net = `<optgroup label="Network"><option value="CONNECT" ${form.fn === 'CONNECT' ? 'selected' : ''}>Connect to a host by address</option></optgroup>`;
  return groups + net;
}

function paramField(spec: ParamSpec, v: PlayerView): string {
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

function currentFn(v: PlayerView): { system: string; module: string; fn: string } | null {
  const valid = new Set<string>(['CONNECT']);
  for (const sys of v.systems) for (const m of sys.modules) for (const f of m.fns) valid.add(`${sys.id}|${m.id}|${f.id}`);
  if (!valid.has(form.fn)) {
    const first = v.systems[0]?.modules[0]?.fns[0];
    form.fn = first ? `${v.systems[0].id}|${v.systems[0].modules[0].id}|${first.id}` : 'CONNECT';
  }
  if (form.fn === 'CONNECT') return null;
  const [system, module, fn] = form.fn.split('|');
  return { system, module, fn };
}

function autoPickCode(v: PlayerView, sel: { system: string; module: string; fn: string } | null): void {
  if (codeManual || !sel) return;
  const def = findFn(sel.system, sel.module, sel.fn);
  const hit = v.me.credentials.find((c) => credCovers(c, sel.system, sel.module, sel.fn, def?.permission === 'WRITE'));
  form.code = hit ? hit.code : '';
}

function renderForm(): void {
  const v = view();
  const sel = currentFn(v);
  autoPickCode(v, sel);
  const def = sel ? findFn(sel.system, sel.module, sel.fn) : undefined;
  const params = sel
    ? (def?.params ?? []).map((p) => paramField(p, v)).join('')
    : `<label class="field"><span>Host address</span><input data-f="p:address" value="${esc(form['p:address'] ?? '')}" placeholder="10.x.x.x" autocomplete="off"></label>`;
  const creds = v.me.credentials
    .map((c) => `<option value="${c.code}" ${form.code === c.code ? 'selected' : ''}>${esc(c.id)} ${c.own ? 'yours' : esc(c.ownerName + "'s")}: ${esc(c.scope)}${c.status === 'REVOKED' ? ' (revoked)' : ''}</option>`)
    .join('');
  $('term-form').innerHTML = `
    <h2>${esc(v.me.name)}, ${esc(v.me.roleLabel)}
      <span class="chip ${v.me.allegiance}">${v.me.allegiance === 'BLACK' ? 'Black Hat' : 'White Hat'}</span>
      ${v.me.lockedForSec > 0 ? `<span class="chip lock">workstation locked ${v.me.lockedForSec}s</span>` : ''}
    </h2>
    <label class="field"><span>Function</span><select data-f="fn">${fnOptions(v)}</select></label>
    ${def ? `<p class="hint">${esc(def.description)}</p>` : '<p class="hint">Type an address you have learned to make that host appear in the function list.</p>'}
    ${sel ? `<div class="grid2">
      <label class="field"><span>Credential you hold</span><select data-f="credPick"><option value="">Choose, or type a code</option>${creds}</select></label>
      <label class="field"><span>4-digit code</span><input class="mono" data-f="code" maxlength="4" inputmode="numeric" value="${esc(form.code ?? '')}" autocomplete="off" placeholder="0000"></label>
    </div>` : ''}
    <div class="grid2">${params}</div>
    ${sel ? `<label class="field"><span>Encryption layer codes, only if the module is encrypted (comma separated)</span><input data-f="enc" value="${esc(form.enc ?? '')}" autocomplete="off"></label>` : ''}
    <button class="run" data-act="exec">Run</button>`;
}

function renderOut(): void {
  const out = $('term-out');
  out.innerHTML = (consoles[selected] ?? []).map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join('');
  out.scrollTop = out.scrollHeight;
}

function say(pid: PlayerId, cls: string, text: string): void {
  const list = (consoles[pid] ??= []);
  list.push({ cls, text });
  if (list.length > 400) list.splice(0, list.length - 400);
}

// ---- Rendering: personal node ----------------------------------------------------------------------
function renderNode(): void {
  const v = view();
  const tabs: [typeof tab, string][] = [
    ['profile', 'Profile'],
    ['codes', 'Credentials'],
    ['activity', 'Activity'],
    ['messages', 'Messages'],
  ];
  const others = v.players.filter((p) => p.id !== selected);
  if (!form.shareTo || form.shareTo === selected) form.shareTo = others[0]?.id ?? '';
  if (!form.msgTo || form.msgTo === selected) form.msgTo = others[0]?.id ?? '';
  const playerOpts = (cur: string): string =>
    others.map((p) => `<option value="${p.id}" ${cur === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  let body = '';
  if (tab === 'profile') {
    const sysLabel = (id: string): string => SYSTEMS.find((s) => s.id === id)?.label ?? id;
    body = `
      <h3>Personal information</h3>
      <dl class="kv"><dt>Name</dt><dd>${esc(v.me.name)}</dd><dt>Role</dt><dd>${esc(v.me.roleLabel)}</dd><dt>IP</dt><dd>${esc(v.me.ip)}</dd><dt>Account</dt><dd>${esc(v.me.bankAccount)}</dd></dl>
      <h4>Your objective</h4><div class="note">${esc(v.me.objective)}</div>
      <p class="hint">${esc(v.me.motivation)}</p>
      <h4>Private information</h4>
      ${v.me.packets.map((p) => `<div class="packet"><small>${esc(p.system === 'BLACKHAT_DB' ? 'Network rumours' : sysLabel(p.system))}</small>${esc(p.text)}</div>`).join('')}`;
  } else if (tab === 'codes') {
    body = `
      <h3>Credentials you hold</h3>
      <p class="hint">Logs name the credential owner, not the person who typed the code.</p>
      <div class="sharebar"><span>Share with</span><select data-f="shareTo">${playerOpts(form.shareTo)}</select></div>
      <table class="cred">${v.me.credentials
        .map(
          (c) => `<tr>
            <td><span class="code ${c.status === 'REVOKED' ? 'rev' : ''}">${esc(c.code)}</span></td>
            <td>${esc(c.id)} ${c.own ? '' : `<em>${esc(c.ownerName)}'s</em>`}<br><small>${esc(c.scope)}${c.status === 'REVOKED' ? ', revoked' : ''}</small></td>
            <td><button class="small-btn" data-act="share:${c.id}">Share</button></td></tr>`,
        )
        .join('')}</table>`;
  } else if (tab === 'activity') {
    body = `
      <h3>Personal activity log</h3>
      <p class="hint">Only you can read this. It records what you actually did.</p>
      <ul class="feed">${[...v.me.activity].reverse().map((a) => `<li><time>${a.time}</time>${esc(a.text)}</li>`).join('') || '<li>Nothing yet.</li>'}</ul>`;
  } else {
    body = `
      <h3>Private messages</h3>
      ${v.me.messages.map((m) => `<div class="msg ${m.incoming ? '' : 'out'}"><small>${m.time} ${m.incoming ? 'from ' + esc(m.fromName) : 'to ' + esc(m.toName)}</small>${esc(m.text)}</div>`).join('') || '<p class="hint">No messages.</p>'}
      <label class="field"><span>To</span><select data-f="msgTo">${playerOpts(form.msgTo)}</select></label>
      <label class="field"><span>Message</span><textarea data-f="msgText" rows="3">${esc(form.msgText ?? '')}</textarea></label>
      <p><button class="small-btn" data-act="send">Send</button></p>`;
    seenMessages[selected] = v.me.messages.filter((m) => m.incoming).length;
  }
  $('node').innerHTML = `<div class="tabs" role="tablist">${tabs
    .map(([id, label]) => `<button role="tab" class="${tab === id ? 'on' : ''}" data-act="tab:${id}">${label}</button>`)
    .join('')}</div><div class="tabbody">${body}</div>`;
}

// ---- Rendering: ground truth ---------------------------------------------------------------------------
function renderGod(): void {
  const det = $('god') as HTMLDetailsElement;
  if (!det.open) return;
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
  $('god-body').innerHTML = `
    <div class="totals"><span>settled: ${money(s.totals.processedNpc)}</span><span>stolen: ${money(s.totals.stolen)} / ${money(s.config.blackTarget)}</span><span>targets: ${esc(targets)}</span></div>
    <pre>${esc(people)}</pre><pre>${esc(logs || 'No player activity yet.')}</pre><pre>${esc(txs)}</pre><pre>${esc(bn || 'No Blacknet posts.')}</pre>`;
}

function renderAll(): void {
  renderHeader();
  renderRail();
  renderForm();
  renderOut();
  renderNode();
  renderGod();
}
function afterAction(): void {
  renderHeader();
  renderRail();
  renderOut();
  renderNode();
  renderGod();
  renderFormLockChip();
}
/** Re-render the form only when the lock state changes, so typed values are never lost mid-edit. */
function renderFormLockChip(): void {
  const v = view();
  const chip = $('term-form').querySelector('.chip.lock');
  if ((v.me.lockedForSec > 0) !== Boolean(chip)) renderForm();
}

// ---- Actions ----------------------------------------------------------------------------------------------
function run(): void {
  const v = view();
  const sel = currentFn(v);
  let action: Action;
  let title: string;
  if (!sel) {
    action = { type: 'CONNECT', playerId: selected, address: form['p:address'] ?? '' };
    title = `connect ${form['p:address'] ?? ''}`;
  } else {
    const def = findFn(sel.system, sel.module, sel.fn);
    const params: Record<string, string> = {};
    for (const p of def?.params ?? []) params[p.name] = form[`p:${p.name}`] ?? '';
    action = {
      type: 'EXECUTE',
      playerId: selected,
      code: (form.code ?? '').trim(),
      system: sel.system as SystemId,
      module: sel.module,
      fn: sel.fn,
      params,
      encCodes: (form.enc ?? '').split(/[\s,]+/).filter(Boolean),
    };
    title = `${def?.label ?? sel.fn}`;
  }
  const r = applyAction(game, action, vNow);
  game = r.state;
  say(selected, 'cmd', `> ${title}`);
  say(selected, r.result.ok ? 'ok' : 'bad', r.result.message);
  for (const line of r.result.lines ?? []) say(selected, 'row', line);
  afterAction();
}

function doShare(credId: string): void {
  const r = applyAction(game, { type: 'SHARE_CREDENTIAL', playerId: selected, credentialId: credId, toPlayerId: form.shareTo }, vNow);
  game = r.state;
  say(selected, r.result.ok ? 'ok' : 'bad', r.result.message);
  afterAction();
}

function doSend(): void {
  const r = applyAction(game, { type: 'SEND_MESSAGE', playerId: selected, toPlayerId: form.msgTo, text: form.msgText ?? '' }, vNow);
  game = r.state;
  if (r.result.ok) form.msgText = '';
  else say(selected, 'bad', r.result.message);
  afterAction();
}

// ---- Events ---------------------------------------------------------------------------------------------
app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const [act, arg] = (el.dataset.act ?? '').split(':');
  switch (act) {
    case 'speed':
      speed = Number(arg);
      renderHeader();
      break;
    case 'skip':
      vNow += Number(arg) * 1000;
      advanceState(game, vNow);
      afterAction();
      break;
    case 'newgame': {
      const raw = (app.querySelector('[data-f="seed"]') as HTMLInputElement | null)?.value;
      const n = Number(raw);
      newGame(Number.isFinite(n) && raw !== '' ? n : Math.floor(Math.random() * 1e9));
      break;
    }
    case 'player':
      selected = arg;
      codeManual = false;
      form.msgText = '';
      renderAll();
      break;
    case 'tab':
      tab = arg as typeof tab;
      renderNode();
      renderRail();
      break;
    case 'exec':
      run();
      break;
    case 'share':
      doShare(arg);
      break;
    case 'send':
      doSend();
      break;
  }
});

app.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const key = el.dataset.f;
  if (!key) return;
  switch (key) {
    case 'auto':
      game.config.autoProcess = (el as HTMLInputElement).checked;
      break;
    case 'god':
      god = (el as HTMLInputElement).checked;
      renderRail();
      break;
    case 'seed':
      break;
    case 'fn':
      form.fn = el.value;
      renderForm();
      break;
    case 'credPick':
      if (el.value) {
        form.code = el.value;
        codeManual = true;
        (app.querySelector('[data-f="code"]') as HTMLInputElement).value = el.value;
      }
      break;
    case 'code':
      form.code = el.value;
      codeManual = true;
      break;
    default:
      form[key] = el.value;
  }
});

$('god').addEventListener('toggle', renderGod);

// ---- Clock ---------------------------------------------------------------------------------------------------
setInterval(() => {
  if (speed === 0 || game.status !== 'RUNNING') return;
  vNow += TICK_MS * speed;
  const before = game.status;
  advanceState(game, vNow);
  tickCount++;
  if (game.status !== before) return renderAll();
  updateClock();
  if (tickCount % 8 === 0) {
    renderRail();
    renderGod();
    renderFormLockChip();
  }
}, TICK_MS);

// Handy in the browser console: cyberHeist.state
Object.defineProperty(window, 'cyberHeist', { get: () => ({ state: game, now: vNow }) });

const urlSeed = Number(new URLSearchParams(location.search).get('seed'));
newGame(Number.isFinite(urlSeed) && urlSeed > 0 ? urlSeed : 1);
