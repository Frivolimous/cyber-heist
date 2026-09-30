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
import { newWatchKey, normRoomCode, roomPath } from '../net/protocol';
import { downloadState } from '../sandbox/dump';
import { mountSettings } from '../sandbox/settings';
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

// ---- How to play ------------------------------------------------------------------------------
// A new player's first introduction: the few ideas that make the game make sense. Their job description (on
// their workstation, once the game starts) is the second.

const HOW_TO_PLAY = (): string => {
  return `<h2>How to play</h2>
  <p>
    You work at a bank, along with your fellow employees. A few of you, however, are also secret
    THIEVES planning to steal a whole bunch of money!
  </p>

  <h3>Competing Objectives</h3>
  <ul>
    <li>
      The bank wins if it settles enough legitimate customer payments by close of business, or all
      the thieves have been locked out of the system. If you're a regular employee, you want to make
      sure the bank wins.
    </li>
    <li>The Thieves win if their secret accounts hold enough stolen money whenever the game ends.</li>
    <li>Careless use of the Firewall can shut the whole bank down instead. If that happens, everybody loses!</li>
  </ul>

  <h3>Your job</h3>
  <p>
    Everyone, even the thieves, has a legitimate job in the bank: Personal Bankers look after
    customers and process their payments, Accounts &amp; Receivables check and pay them out, IT
    Specialists run security, and the Bank Manager oversees it all. The bank only works if each part
    does its job.
  </p>
  <p>
    The thieves have jobs too: it is their cover. They will still need to do their legit work or
    other players might get suspicious!
  </p>
  <p>
    When the game starts, open My workstation and read your job description to learn more about your
    responsibilities.
  </p>

  <h3>Codes are everything</h3>
  <p>
    Every action needs a 4-digit code. The logs record whose code was used, not who typed it: anyone
    who learns your code can act as you, and the blame lands on you.
  </p>

  <h3>How money gets stolen</h3>
  <p>
    A payment lands in the customer's main (primary) account at the moment it is paid out. The
    thieves will try to quietly swap a customer's primary for a mule account so all the incoming
    money goes to them. Thieves also have hidden tools to cover their tracks and mislead the bank,
    and they can coordinate them on a secret host living in the bank's network.
  </p>

  <h3>How thieves get caught</h3>
  <p>
    A trace on a log entry reveals which workstation really did it. Activity on the secret host might
    also leave evidence in the logs.
  </p>
  <p>
    Suss out the thieves by examining suspicious activity, suspicious behavior, or by tracing
    suspicious logs. Revoke all of their codes, or use the Firewall to shut down their workstation for
    good, and they are out of the game!
  </p>

  <h3>Talk</h3>
  <p>
    You play on a video call. Say what you see, ask what others did, accuse, defend. Send private
    messages through your workstation if needed.
  </p>
  <p>
    The thieves can also communicate privately through their secret host on the network. Be ready for
    coordinated attacks!
  </p>
  <p class="how-tip">You look things up and type them yourself (names, account numbers, codes): nothing is filled in for you.
  That is part of the game.</p>
  <form method="dialog"><button class="btn">Got it</button></form>`;
};

/** Adds a "How to play" button that opens the introduction. */
function howToPlayButton(): string {
  return '<button type="button" class="btn alt how-btn" data-how>How to play</button>';
}
function wireHowToPlay(): void {
  const btn = app.querySelector<HTMLButtonElement>('[data-how]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    let dlg = document.querySelector<HTMLDialogElement>('dialog.how');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'how play';
      dlg.innerHTML = HOW_TO_PLAY();
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) dlg!.close(); // a click on the backdrop closes it
      });
      document.body.append(dlg);
    }
    dlg.showModal();
    dlg.scrollTop = 0; // showModal focuses "Got it" at the bottom; start at the top
  });
}

// ---- Routing -----------------------------------------------------------------------------------

export async function route(q: URLSearchParams): Promise<void> {
  await loadFirebaseConfig();
  const [host, test, run, game, watch] = ['host', 'test', 'run', 'game', 'watch'].map((k) => q.get(k));
  if (!host && !test && !run && !game && !watch) return landing();
  page('<p class="play-wait">Connecting...</p>');
  let db: Db;
  try {
    db = await openDb();
  } catch (e) {
    return problem(`Could not connect to the game server: ${(e as Error).message}`);
  }
  try {
    if (host) return await sandboxHost(db, host);
    if (test) return await tester(db, normRoomCode(test));
    if (run) return await facilitator(db, run);
    if (watch) return await watcher(db, normRoomCode(watch), q.get('key') ?? '');
    return await player(db, normRoomCode(game!));
  } catch (e) {
    // A refused read or write (database rules) would otherwise leave the page on "Connecting..." for good.
    console.error(e);
    return problem(`The game server refused that: ${(e as Error).message}`);
  }
}

// ---- Landing -----------------------------------------------------------------------------------

function landing(): void {
  page(
    `<p class="play-lede">A social deduction heist for 6 to 30 players on a video call, each on their own computer.</p>
    ${howToPlayButton()}
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
  wireHowToPlay();
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
    const scenario = new URLSearchParams(location.search).get('scenario'); // a dev test scenario for the first game
    setAddress({ host: code, ...(scenario ? { scenario } : {}) });
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

// ---- DEV ONLY: the watcher link (remove before any public release; see README.md) --------------------
// ?watch=CODE&key=K: a read-only copy of a running game, from the key its host screen shows. It writes
// nothing to the game, so it appears nowhere a player could see it.

async function watcher(db: Db, code: string, key: string): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(key)) return problem('That watcher link is incomplete.');
  page('<p class="play-wait">Waiting for the host...</p>');
  const first = await db.get(roomPath(code, `watch/${key}`)).catch(() => null);
  if (typeof first !== 'string') return problem(`Nothing to watch for game ${code} with that key (the host publishes it a few seconds after the start).`);
  boot.current = { kind: 'watch', db, code, key };
  await startScreen();
}

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
        ${howToPlayButton()}
        <button class="btn alt" data-leave>Leave</button>`,
      );
      wireHowToPlay();
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
  runGame(db, code, snap.state, snap.vNow, snap.speed, snap.watchKey);
}

function hostLobby(db: Db, code: string): void {
  const joinUrl = link({ game: code });
  // The page is drawn once; only the player list redraws as people join, so the settings form keeps its state.
  page(
    `<h2>Game <span class="code">${esc(code)}</span></h2>
    <p>Players open <a href="${esc(joinUrl)}" target="_blank" rel="noopener">${esc(joinUrl)}</a>, or go to the start page and type the code.</p>
    <div data-lobby></div>
    <div data-settings></div>
    <button class="btn" data-start disabled>Start the game</button>
    <p class="play-error" data-err hidden></p>
    <p class="play-hint">You run the game from this tab: keep it open until the end.</p>
    ${netNote()}`,
    true,
  );
  const settings = mountSettings(app.querySelector<HTMLElement>('[data-settings]')!);
  const start = app.querySelector<HTMLButtonElement>('[data-start]')!;
  const err = app.querySelector<HTMLElement>('[data-err]')!;
  const off = db.onValue(roomPath(code, 'lobby'), (v) => {
    const lobby = lobbyOrder(v as Record<string, LobbyEntry> | null);
    app.querySelector('[data-lobby]')!.innerHTML = `<ul class="play-list">${lobby.map(([, e]) => `<li>${esc(e.name)}</li>`).join('') || '<li class="empty">Nobody yet.</li>'}</ul>
      <p class="play-hint">${lobby.length} joined; ${MIN_PLAYERS} to 30 players. Roles and sides are dealt at random when you start.</p>`;
    start.disabled = lobby.length < MIN_PLAYERS;
  });
  start.addEventListener('click', async () => {
    const custom = settings();
    const problem = custom.errors.length ? `Fix the custom settings first: ${custom.errors.join(' ')}` : null;
    const vNow = Date.now();
    const started = problem ?? (await startRoom(db, code, vNow, custom.config));
    if (typeof started === 'string') {
      err.hidden = false;
      err.textContent = started;
      return;
    }
    off();
    runGame(db, code, started, vNow, 1);
  });
}

/** The facilitator's screen while the game runs: this tab is the game's engine for every player. */
function runGame(db: Db, code: string, first: GameState, startVNow: number, startSpeed: number, startWatchKey?: string): void {
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
  // DEV ONLY: the watcher link's secret key, kept with the saved game so a reloaded host keeps the same link.
  const watchKey = startWatchKey ?? newWatchKey();
  const watchUrl = link({ watch: code, key: watchKey });
  const save = (): Promise<void> => host.saveSnapshot({ state: s, vNow, speed, watchKey });
  const publishWatch = (): Promise<void> => host.publishWatch(watchKey, { state: s, vNow });
  void publishWatch();
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
    if (ticks % 12 === 0 && (s.status === 'RUNNING' || !ended)) void publishWatch();
    if (ticks % 40 === 0 || (s.status !== 'RUNNING' && ticks % 4 === 0 && !ended)) {
      void save();
      if (s.status !== 'RUNNING') ended = true;
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (s.status === 'RUNNING') e.preventDefault(); // closing this tab stops the game for everyone
  });

  let devOpen = false;
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
        : `<p class="play-hint">Settled today: ${money(s.transactions.reduce((sum, tx) => (tx.status === 'SETTLED' ? sum + tx.amount : sum), 0))} of the bank's ${money(s.config.whiteTarget)} target (players see this total too, which includes diverted and embezzled payments; the bank's real progress stays hidden until the end).</p>
          ${speed ? '' : '<p class="fac-paused">Paused: the clock is stopped and players cannot act.</p>'}
          <button class="btn ${speed ? 'alt' : ''}" data-pause>${speed ? 'Pause the game' : 'Resume the game'}</button>`}
      <h3>Players <small class="play-hint">${connected} of ${people.length} connected</small></h3>
      <ul class="play-list">${people
        .map((id) => `<li class="${host.isOnline(id) ? 'on' : 'off'}"><i class="dot" aria-hidden="true"></i>${esc(s.players[id].name)}${host.isOnline(id) ? '' : ' <small>not connected</small>'}${s.players[id].terminated ? ' <small>terminated</small>' : ''}</li>`)
        .join('')}</ul>
      <p class="play-hint">This tab runs the game for everyone: keep it open${end ? '' : ' until the end'}. Players rejoin with ${esc(link({ game: code }))}</p>
      <details class="fac-dev"${devOpen ? ' open' : ''}><summary>Dev tools</summary>
        <button class="btn alt" data-dump>Download state</button>
        <p class="play-hint">Watcher link (read only, full view; keep it to yourself): <a href="${esc(watchUrl)}" target="_blank" rel="noopener">${esc(watchUrl)}</a></p>
      </details>`,
      true,
    );
    const dev = app.querySelector<HTMLDetailsElement>('.fac-dev')!;
    dev.addEventListener('toggle', () => (devOpen = dev.open));
    app.querySelector('[data-dump]')!.addEventListener('click', () => downloadState(s, code));
    app.querySelector('[data-pause]')?.addEventListener('click', () => {
      speed = speed ? 0 : 1;
      void host.setPaused(speed === 0);
      void save();
      render();
    });
  }
  render();
}

