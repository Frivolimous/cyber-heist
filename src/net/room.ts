// Making, joining and starting rooms.

import { createGame, MAX_PLAYERS, MIN_PLAYERS } from '../engine';
import type { GameState } from '../engine';
import type { Db } from './db';
import { cleanName, newRoomCode, ROOM_TTL_MS, roomPath } from './protocol';
import type { LobbyEntry, RoomMeta } from './protocol';

/** Opens a new room with a code nobody is using. The creator is its host. Old rooms are cleared out first. */
export async function createRoom(db: Db, dev: boolean): Promise<string> {
  await sweepRooms(db).catch((e) => console.warn('Could not clear out old rooms', e));
  for (let i = 0; i < 20; i++) {
    const code = newRoomCode();
    if (await db.get(roomPath(code, 'meta'))) continue;
    const now = Date.now();
    const meta: RoomMeta = { hostUid: db.uid, dev, status: dev ? 'RUNNING' : 'LOBBY', createdAt: now };
    await db.set(roomPath(code, 'meta'), meta);
    await db.set(`rooms/${code}`, now);
    return code;
  }
  throw new Error('Could not find a free room code.');
}

/** Deletes every room older than ROOM_TTL_MS. Returns the codes it deleted. */
export async function sweepRooms(db: Db, now = Date.now()): Promise<string[]> {
  const rooms = ((await db.get('rooms')) as Record<string, number> | null) ?? {};
  const old = Object.entries(rooms).filter(([, t]) => typeof t === 'number' && t < now - ROOM_TTL_MS).map(([code]) => code);
  for (const code of old) {
    await db.remove(roomPath(code));
    await db.remove(`rooms/${code}`);
  }
  return old;
}

export async function roomMeta(db: Db, code: string): Promise<RoomMeta | null> {
  return ((await db.get(roomPath(code, 'meta'))) as RoomMeta | null) ?? null;
}

/** Puts this player in a room's lobby. Returns why not, if they cannot join. */
export async function joinLobby(db: Db, code: string, rawName: string): Promise<string | null> {
  const name = cleanName(rawName);
  if (!name) return 'Type your name.';
  const meta = await roomMeta(db, code);
  if (!meta) return `There is no game with the code ${code}.`;
  if (meta.dev) return `${code} is an online sandbox. Open it as a tester instead.`;
  if (meta.status !== 'LOBBY') return 'That game has already started.';
  const lobby = ((await db.get(roomPath(code, 'lobby'))) as Record<string, LobbyEntry> | null) ?? {};
  if (Object.entries(lobby).some(([uid, e]) => uid !== db.uid && e.name.toLowerCase() === name.toLowerCase())) return `Someone called ${name} is already in. Pick another name.`;
  if (!lobby[db.uid] && Object.keys(lobby).length >= MAX_PLAYERS) return `That game is full (${MAX_PLAYERS} players).`;
  await db.set(roomPath(code, `lobby/${db.uid}`), { name, t: lobby[db.uid]?.t ?? Date.now() } satisfies LobbyEntry);
  return null;
}

export const leaveLobby = (db: Db, code: string): Promise<void> => db.remove(roomPath(code, `lobby/${db.uid}`));

/** The lobby in joining order. */
export const lobbyOrder = (lobby: Record<string, LobbyEntry> | null): [string, LobbyEntry][] =>
  Object.entries(lobby ?? {}).sort((a, b) => a[1].t - b[1].t);

/**
 * Host: deals seats to everyone in the lobby and starts the game. Returns the new game, or why it cannot
 * start. Player ids are p1, p2... in joining order; the engine deals roles and sides at random.
 */
export async function startRoom(db: Db, code: string, now: number): Promise<GameState | string> {
  const lobby = lobbyOrder((await db.get(roomPath(code, 'lobby'))) as Record<string, LobbyEntry> | null);
  if (lobby.length < MIN_PLAYERS) return `You need at least ${MIN_PLAYERS} players (${lobby.length} joined).`;
  const players = lobby.map(([, e], i) => ({ id: `p${i + 1}`, name: e.name }));
  const state = createGame({ seed: Math.floor(Math.random() * 1e9), players, now, id: `game-${code}` });
  const seats = Object.fromEntries(lobby.map(([uid], i) => [uid, `p${i + 1}`]));
  await db.update(roomPath(code), { seats, 'meta/status': 'RUNNING' });
  return state;
}
