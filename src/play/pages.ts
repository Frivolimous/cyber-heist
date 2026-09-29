// The pages around the game: the landing page, a player's lobby, and the facilitator's host screen for a
// real game. The game screen itself is the sandbox's (main.ts), run as a remote screen.

import './play.css';
import { advanceState, applyAction, dayPhaseAt, endSummary, fmtClock, MIN_PLAYERS, money } from '../engine';
import type { GameState } from '../engine';
import { boot } from '../sandbox/mode';
import { ClientSession } from '../net/client';
import { firebaseConfig, loadFirebaseConfig, openDb, useLocalNet } from '../net/config';
import type { Db } from '../net/db';
import { HostSession, loadSnapshot, startTicker } from '../net/host';
import { normRoomCode, roomPath } from '../net/protocol';
import type { LobbyEntry } from '../net/protocol';
import { createRoom, joinLobby, leaveLobby, lobbyOrder, roomMeta, startRoom } from '../net/room';

const app = document.getElementById('app') as HTMLElement;
const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** A link to this site with these parameters, keeping ?net=local if this tab uses it. */
function link(params: Record<string, string>): string {
  const url = new URL(location.href);
  url.search = '';
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (new URLSearchParams(location.search).get('net') === 'local') url.searchParams.set('net', 'local');
  return url.toString();
}

/** Changes the address without reloading (a new room's code, so a reload comes back to it). */
const setAddress = (params: Record<string, string>): void => history.replaceState(null, '', link(params));

const netNote = (): string =>
  useLocalNet()
    ? `<p class="net-note">Local mode: games are shared only between tabs of this browser.${firebaseConfig() ? '' : ' Add a Firebase config (see <code>.env.example</code>) to play across devices.'}</p>`
    : '';

function page(body: string, wide = false): void {
  app.innerHTML = `<main class="play"><div class="play-card ${wide ? 'wide' : ''}"><h1 class="play-title">Cyber-Heist</h1>${body}</div></main>`;
}

function problem(text: string): void {
  page(`<p class="play-error">${esc(text)}</p><p><a href="${esc(link({}))}">Back to the start</a></p>`);
}

/** Loads the game screen for this tab. */
async function startScreen(): Promise<void> {
  app.innerHTML = '';
  await import('../sandbox/main');
}

// ---- Routing -----------------------------------------------------------------------------------

export async function route(q: URLSearchParams): Promise<void> {
  await loadFirebaseConfig();
  const [host, test, run, game] = ['host', 'test', 'run', 'game'].map((k) => q.get(k));
  if (!host && !test && !run && !game) return landing();
  page('<p class="play-wait">Connecting...</p>');
  let db: Db;
  try {
    db = await openDb();
  } catch (e) {
    return problem(`Could not connect to the game server: ${(e as Error).message}`);
  }
  if (host) return sandboxHost(db, host);
  if (test) return tester(db, normRoomCode(test));
  if (run) return facilitator(db, run);
  return player(db, normRoomCode(game!));
}

// ---- Landing -----------------------------------------------------------------------------------

function landing(): void {
  page(
    `<p class="play-lede">A social deduction heist for 6 to 30 players on a video call, each on their own computer.</p>
    <form class="play-form" data-form="join">
      <h2>Join a game</h2>
      <label>Game code <input name="code" maxlength="4" autocomplete="off" placeholder="ABCD" required></label>
      <button type="submit">Join</button>
    </form>
    <div class="play-row">
      <section><h2>Host a game</h2><p>Open a room, share the code, start when everyone is in. The host runs the game and does not play.</p>
        <a class="btn" href="${esc(link({ run: 'new' }))}">Open a room</a></section>
      <section><h2>Sandbox</h2><p>Try the game alone, switching seats, with dev tools.</p>
        <a class="btn alt" href="${esc(link({ sandbox: '' }))}">Offline sandbox</a>
        <a class="btn alt" href="${esc(link({ host: 'new' }))}">Online sandbox</a></section>
    </div>
    ${netNote()}`,
    true,
  );
  app.querySelector('[data-form="join"]')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normRoomCode(new FormData(e.target as HTMLFormElement).get('code') as string);
    if (code.length === 4) location.href = link({ game: code });
  });
}

// ---- Online sandbox --------------------------------------------------------------------------

async function sandboxHost(db: Db, raw: string): Promise<void> {
  let code = normRoomCode(raw);
  if (raw === 'new') {
    code = await createRoom(db, true);
    setAddress({ host: code });
  } else {
    const meta = await roomMeta(db, code);
    if (!meta?.dev) return problem(`There is no online sandbox with the code ${code}.`);
    if (meta.hostUid !== db.uid) return problem(`The online sandbox ${code} is hosted in another tab. Open it as a tester instead: ${link({ test: code })}`);
  }
  boot.current = { kind: 'host', db, code, snapshot: await loadSnapshot(db, code) };
  await startScreen();
}

async function tester(db: Db, code: string): Promise<void> {
  const meta = await roomMeta(db, code);
  if (!meta?.dev) return problem(`There is no online sandbox with the code ${code}.`);
  const session = new ClientSession(db, code);
  session.start();
  if (!(await db.get(roomPath(code, `seats/${db.uid}`)))) await session.claim('p0');
  page('<p class="play-wait">Waiting for the host...</p>');
  await untilView(session);
  boot.current = { kind: 'client', session, dev: true };
  await startScreen();
}

const untilView = (session: ClientSession): Promise<void> =>
  new Promise((resolve) => {
    if (session.view) return resolve();
    const off = session.onChange(() => {
      if (!session.view) return;
      off();
      resolve();
    });
  });

// ---- Player --------------------------------------------------------------------------------------

async function player(db: Db, code: string): Promise<void> {
  const meta = await roomMeta(db, code);
  if (!meta) return problem(`There is no game with the code ${code}.`);
  if (meta.dev) return problem(`${code} is an online sandbox. Testers open ${link({ test: code })}`);
  if (await db.get(roomPath(code, `seats/${db.uid}`))) return play(db, code);
  if (meta.status !== 'LOBBY') return problem('That game has already started.');
  const mine = (await db.get(roomPath(code, `lobby/${db.uid}`))) as LobbyEntry | null;
  if (mine) return waitingRoom(db, code);
  page(
    `<form class="play-form" data-form="name">
      <h2>Join game ${esc(code)}</h2>
      <label>Your name <input name="name" maxlength="16" autocomplete="off" placeholder="As on the video call" required autofocus></label>
      <button type="submit">Join</button>
      <p class="play-error" data-err hidden></p>
    </form>${netNote()}`,
  );
  app.querySelector('[data-form="name"]')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = await joinLobby(db, code, new FormData(e.target as HTMLFormElement).get('name') as string);
    if (!err) return waitingRoom(db, code);
    const el = app.querySelector<HTMLElement>('[data-err]')!;
    el.hidden = false;
    el.textContent = err;
  });
}

function waitingRoom(db: Db, code: string): void {
  const offs: (() => void)[] = [];
  const leave = (): void => offs.forEach((f) => f());
  offs.push(
    db.onValue(roomPath(code, 'lobby'), (v) => {
      const lobby = lobbyOrder(v as Record<string, LobbyEntry> | null);
      if (!lobby.some(([uid]) => uid === db.uid)) return; // just left
      page(
        `<h2>Game ${esc(code)}</h2>
        <p>You are in. The game starts when the host starts it.</p>
        <ul class="play-list">${lobby.map(([uid, e]) => `<li>${esc(e.name)}${uid === db.uid ? ' <small>(you)</small>' : ''}</li>`).join('')}</ul>
        <p class="play-hint">${lobby.length} joined; at least ${MIN_PLAYERS} are needed.</p>
        <button class="btn alt" data-leave>Leave</button>`,
      );
      app.querySelector('[data-leave]')!.addEventListener('click', async () => {
        leave();
        await leaveLobby(db, code);
        location.href = link({});
      });
    }),
    db.onValue(roomPath(code, `seats/${db.uid}`), (seat) => {
      if (typeof seat !== 'string') return;
      leave();
      void play(db, code);
    }),
  );
}

async function play(db: Db, code: string): Promise<void> {
  page('<p class="play-wait">Starting...</p>');
  const session = new ClientSession(db, code);
  session.start();
  await untilView(session);
  boot.current = { kind: 'client', session, dev: false };
  await startScreen();
}

// ---- Facilitator: a real game's host -----------------------------------------------------------

async function facilitator(db: Db, raw: string): Promise<void> {
  let code = normRoomCode(raw);
  if (raw === 'new') {
    code = await createRoom(db, false);
    setAddress({ run: code });
  }
  const meta = await roomMeta(db, code);
  if (!meta || meta.dev) return problem(`There is no game with the code ${code}.`);
  if (meta.hostUid !== db.uid) return problem(`Game ${code} is hosted from another tab or device.`);
  if (meta.status === 'LOBBY') return hostLobby(db, code);
  const snap = await loadSnapshot(db, code);
  if (!snap) return problem(`Game ${code} was started, but its saved state is missing.`);
  runGame(db, code, snap.state, snap.vNow, snap.speed);
}

function hostLobby(db: Db, code: string): void {
  const joinUrl = link({ game: code });
  const off = db.onValue(roomPath(code, 'lobby'), (v) => {
    const lobby = lobbyOrder(v as Record<string, LobbyEntry> | null);
    page(
      `<h2>Game <span class="code">${esc(code)}</span></h2>
      <p>Players open <a href="${esc(joinUrl)}" target="_blank" rel="noopener">${esc(joinUrl)}</a>, or go to the start page and type the code.</p>
      <ul class="play-list">${lobby.map(([, e]) => `<li>${esc(e.name)}</li>`).join('') || '<li class="empty">Nobody yet.</li>'}</ul>
      <p class="play-hint">${lobby.length} joined; ${MIN_PLAYERS} to 30 players. Roles and sides are dealt at random when you start.</p>
      <button class="btn" data-start ${lobby.length < MIN_PLAYERS ? 'disabled' : ''}>Start the game</button>
      <p class="play-error" data-err hidden></p>
      <p class="play-hint">You run the game from this tab: keep it open until the end.</p>
      ${netNote()}`,
      true,
    );
    app.querySelector('[data-start]')!.addEventListener('click', async () => {
      const vNow = Date.now();
      const started = await startRoom(db, code, vNow);
      if (typeof started === 'string') {
        const el = app.querySelector<HTMLElement>('[data-err]')!;
        el.hidden = false;
        el.textContent = started;
        return;
      }
      off();
      runGame(db, code, started, vNow, 1);
    });
  });
}

/** The facilitator's screen while the game runs: this tab is the game's engine for every player. */
function runGame(db: Db, code: string, first: GameState, startVNow: number, startSpeed: number): void {
  let s = first;
  let vNow = startVNow;
  let speed = startSpeed;
  let last = performance.now();
  let ticks = 0;
  let ended = false; // the final state has been saved
  const host = new HostSession(db, code, {
    apply: (a) => {
      const r = applyAction(s, a, vNow);
      s = r.state;
      return r.result;
    },
    state: () => s,
  }, false);
  const save = (): Promise<void> => host.saveSnapshot({ state: s, vNow, speed });
  void save();
  host.start(() => render());
  void host.setPaused(speed === 0);
  startTicker(250, () => {
    const now = performance.now();
    vNow += (now - last) * speed;
    last = now;
    if (s.status === 'RUNNING') advanceState(s, vNow);
    ticks++;
    if (ticks % 4 === 0) {
      host.publish();
      render();
    }
    if (ticks % 40 === 0 || (s.status !== 'RUNNING' && ticks % 4 === 0 && !ended)) {
      void save();
      if (s.status !== 'RUNNING') ended = true;
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (s.status === 'RUNNING') e.preventDefault(); // closing this tab stops the game for everyone
  });

  function render(): void {
    const t = Math.max(0, (s.now - s.startedAt) / 1000);
    const phase = dayPhaseAt(s.config.durationSec, t);
    const people = s.playerOrder.filter((id) => !s.players[id].fake);
    const connected = people.filter((id) => host.isOnline(id)).length;
    const end = endSummary(s);
    page(
      `<div class="fac-head"><h2>Game <span class="code">${esc(code)}</span></h2>
        <div class="fac-clock"><b>${fmtClock(t)}</b> / ${fmtClock(s.config.durationSec)}<span>${esc(phase.label)}</span></div></div>
      ${end
        ? `<section class="fac-end"><h3>${esc(end.headline)}</h3><p>${esc(end.text)}</p>
            <div class="fac-teams">${end.teams
              .map(
                (team) => `<div><h4>${esc(team.label)}: ${team.won ? 'won' : 'lost'}</h4><p>${money(team.made)} of ${money(team.target)}</p>
                  <ul>${team.members.map((m) => `<li>${esc(m.name)}, ${esc(m.roleLabel)}${m.terminated ? ' (terminated)' : ''}${m.embezzled ? `, embezzled ${money(m.embezzled)}` : ''}</li>`).join('')}</ul></div>`,
              )
              .join('')}</div></section>`
        : `<div class="fac-bar"><i style="width:${Math.min(100, (s.totals.processed / s.config.whiteTarget) * 100)}%"></i></div>
          <p class="play-hint">${money(s.totals.processed)} of ${money(s.config.whiteTarget)} legitimate payments settled.</p>
          ${speed ? '' : '<p class="fac-paused">Paused: the clock is stopped and players cannot act.</p>'}
          <button class="btn ${speed ? 'alt' : ''}" data-pause>${speed ? 'Pause the game' : 'Resume the game'}</button>`}
      <h3>Players <small class="play-hint">${connected} of ${people.length} connected</small></h3>
      <ul class="play-list">${people
        .map((id) => `<li class="${host.isOnline(id) ? 'on' : 'off'}"><i class="dot" aria-hidden="true"></i>${esc(s.players[id].name)}${host.isOnline(id) ? '' : ' <small>not connected</small>'}${s.players[id].terminated ? ' <small>terminated</small>' : ''}</li>`)
        .join('')}</ul>
      <p class="play-hint">This tab runs the game for everyone: keep it open${end ? '' : ' until the end'}. Players rejoin with ${esc(link({ game: code }))}</p>`,
      true,
    );
    app.querySelector('[data-pause]')?.addEventListener('click', () => {
      speed = speed ? 0 : 1;
      void host.setPaused(speed === 0);
      void save();
      render();
    });
  }
  render();
}

