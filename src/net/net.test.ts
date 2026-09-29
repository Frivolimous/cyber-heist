// The online protocol end to end on the in-memory database: lobby, start, seats, actions and views.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, getPlayerView } from '../engine';
import type { Action, GameState } from '../engine';
import { LocalDb, memoryNetwork } from './db';
import { ClientSession } from './client';
import { HostSession } from './host';
import { joinView, parseAction, roomPath, splitView } from './protocol';
import { createRoom, joinLobby, startRoom } from './room';

const NAMES = ['Ana', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay'];

/** Lets pending listeners and promises run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await settle();
  assert.ok(cond(), `timed out waiting for ${what}`);
}

async function startedRoom() {
  const net = memoryNetwork();
  const hostDb = new LocalDb('host', net.store, net.hub);
  const dbs = NAMES.map((_, i) => new LocalDb(`u${i}`, net.store, net.hub));
  const code = await createRoom(hostDb, false);
  for (let i = 0; i < dbs.length; i++) assert.equal(await joinLobby(dbs[i], code, NAMES[i]), null);
  const started = await startRoom(hostDb, code, 1_000_000);
  assert.ok(typeof started !== 'string', String(started));
  let state = started as GameState;
  const applied: Action[] = [];
  const host = new HostSession(hostDb, code, {
    apply: (a) => {
      applied.push(a);
      const r = applyAction(state, a, state.now);
      state = r.state;
      return r.result;
    },
    state: () => state,
  }, false);
  host.start();
  return { net, hostDb, dbs, code, host, applied, state: () => state };
}

test('lobby: names are required and unique, and nobody joins once the game has started', async () => {
  const net = memoryNetwork();
  const hostDb = new LocalDb('host', net.store, net.hub);
  const a = new LocalDb('a', net.store, net.hub);
  const b = new LocalDb('b', net.store, net.hub);
  const code = await createRoom(hostDb, false);
  assert.match(code, /^[A-HJ-NP-Z]{4}$/);
  assert.match((await joinLobby(a, 'ZZZZ', 'Ana'))!, /no game/);
  assert.match((await joinLobby(a, code, '   '))!, /name/);
  assert.equal(await joinLobby(a, code, 'Ana'), null);
  assert.match((await joinLobby(b, code, 'ana'))!, /already in/);
  assert.match((await startRoom(hostDb, code, 0)) as string, /at least 6/);
  await hostDb.set(roomPath(code, 'meta/status'), 'RUNNING');
  assert.match((await joinLobby(b, code, 'Ben'))!, /already started/);
});

test('start: everyone in the lobby gets a seat, and each player receives only their own view', async () => {
  const { dbs, code, state, net } = await startedRoom();
  const s = state();
  assert.deepEqual(s.playerOrder, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.deepEqual(s.playerOrder.map((id) => s.players[id].name), NAMES);

  const client = new ClientSession(dbs[2], code);
  client.start();
  await until(() => !!client.view, 'the view');
  assert.equal(client.seat, 'p3');
  assert.equal(client.view!.me.name, 'Cal');
  assert.equal(client.meta!.status, 'RUNNING');
  assert.deepEqual(client.view, JSON.parse(JSON.stringify(getPlayerView(s, 'p3'))), 'exactly what the engine gives that player');
  // Only seated players' views exist in the database.
  const views = net.store.keys().filter((k) => k.includes('/views/')).map((k) => k.split('/')[3]);
  assert.deepEqual([...new Set(views)].sort(), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
});

test('actions: the host applies them as the sender\'s seat, whatever playerId they claim, and answers', async () => {
  const { dbs, code, applied, state } = await startedRoom();
  const client = new ClientSession(dbs[0], code);
  client.start();
  await until(() => !!client.view, 'the view');

  // Pretending to be p2 does not work: the action is played from p1's seat.
  const r = await client.send({ type: 'SEND_MESSAGE', playerId: 'p2', toPlayerId: 'p3', text: 'hello' });
  assert.ok(r.ok, r.message);
  assert.equal(applied.at(-1)!.playerId, 'p1');
  assert.equal(state().players.p3.messages.at(-1)!.from, 'p1');
  await until(() => client.view!.me.messages.length === 1, 'the new message in the view');

  // Garbage and unknown kinds are refused without touching the game.
  const n = applied.length;
  const bad = await client.send({ type: 'CHEAT', playerId: 'p1' } as unknown as Action);
  assert.equal(bad.message, 'Unknown action.');
  assert.equal(applied.length, n);

  // Someone without a seat is refused.
  const stranger = new ClientSession(new LocalDb('nobody', (client.db as LocalDb)['store'], (client.db as LocalDb)['hub']), code);
  assert.match((await stranger.send({ type: 'CONNECT', playerId: 'p1', address: '10.0.0.10' })).message, /do not have a seat/);
});

test('views: the host only rewrites the parts that changed', async () => {
  const { host, net } = await startedRoom();
  await settle();
  const writes: string[][] = [];
  net.hub.on((paths) => writes.push(paths));
  host.publish();
  assert.equal(writes.length, 0, 'nothing changed, nothing written');
});

test('protocol: views survive the round trip and actions are checked', () => {
  const v = { clock: '00:01', t: 1, list: [], me: { id: 'p1', activity: [], name: 'Ana' } } as unknown as ReturnType<typeof getPlayerView>;
  assert.deepEqual(joinView(splitView(v)), v);
  assert.equal(joinView(null), null);
  assert.equal(parseAction('not json', 'p1'), null);
  assert.equal(parseAction(JSON.stringify({ type: 'EXECUTE', params: [1] }), 'p1'), null);
  assert.equal(parseAction(JSON.stringify({ type: 'CONNECT', playerId: 'p9', address: 'x' }), 'p1')!.playerId, 'p1');
});

test('dev rooms: a tester claims any real seat and gets that view', async () => {
  const net = memoryNetwork();
  const hostDb = new LocalDb('host', net.store, net.hub);
  const code = await createRoom(hostDb, true);
  const { state } = await startedRoomState();
  const host = new HostSession(hostDb, code, { apply: () => ({ ok: true, message: '' }), state: () => state }, true);
  host.start();
  const client = new ClientSession(new LocalDb('tester', net.store, net.hub), code);
  client.start();
  await client.claim('p4');
  await until(() => client.view?.me.id === 'p4', 'seat p4');
  await client.claim('nope');
  await settle();
  assert.equal(client.seat, 'p4', 'an unknown seat is not granted');
  assert.match((await joinLobby(new LocalDb('x', net.store, net.hub), code, 'Zed'))!, /online sandbox/);
});

async function startedRoomState(): Promise<{ state: GameState }> {
  const r = await startedRoom();
  return { state: r.state() };
}
