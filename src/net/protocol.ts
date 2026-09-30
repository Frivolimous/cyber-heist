// The online game's data layout and the pure helpers both sides use.
//
// rooms/{code}        createdAt              every room, so old ones can be found and deleted
// games/{code}/
//   meta              { hostUid, dev, status: LOBBY | RUNNING | ENDED, createdAt, paused }
//   lobby/{uid}       { name, t }            players waiting to start (written by each player)
//   seats/{uid}       playerId               who plays which seat (written by the host)
//   claims/{uid}      playerId               dev rooms only: a tester asks to sit at a seat
//   actions/{key}     { uid, action }        a player's action, waiting for the host (JSON text)
//   results/{uid}/{k} ActionResult           the host's answer to that action (JSON text)
//   views/{pid}/{part} PlayerView, in parts  all that player may see (JSON text per part)
//   presence/{uid}    true                   while that player's screen is connected
//   hostState         the full game, so a reloaded host can carry on (JSON text; host only)
//   watch/{key}       DEV ONLY: the full game for the watcher link; readable only by whoever knows the key
//
// Values are stored as JSON text wherever the shape is the engine's: the database drops empty arrays and
// nulls, which would change what the engine and the screen receive.

import type { Action, ActionResult, PlayerId, PlayerView } from '../engine';

export type RoomStatus = 'LOBBY' | 'RUNNING' | 'ENDED';

export interface RoomMeta {
  hostUid: string;
  /** A dev room: the online sandbox, where testers pick any seat. Otherwise a real game with a lobby. */
  dev: boolean;
  status: RoomStatus;
  createdAt: number;
  /** The host paused the clock: players see a notice, and their actions wait. */
  paused?: boolean;
}

/** Rooms older than this are deleted the next time anyone opens a room. A game lasts 20 minutes. */
export const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

export interface LobbyEntry {
  name: string;
  t: number;
}

export const roomPath = (code: string, sub = ''): string => `games/${code}${sub ? '/' + sub : ''}`;

/** DEV ONLY: a watcher key, long and random enough that it cannot be guessed. */
export function newWatchKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Room codes: four letters, none that are easy to confuse (no I, O). */
export function newRoomCode(random: () => number = Math.random): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 4 }, () => letters[Math.floor(random() * letters.length)]).join('');
}

export const normRoomCode = (raw: string): string => raw.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

/** A player's name as typed in the lobby. */
export const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').trim().slice(0, 16);

// ---- Views -------------------------------------------------------------------------------

const ME = 'me_';

/**
 * A view as separate parts, so the host only rewrites what changed (the clock changes every second, the
 * activity log now and then). `me` is split one level further.
 */
export function splitView(v: PlayerView): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === 'me') for (const [mk, mval] of Object.entries(val as object)) parts[ME + mk] = JSON.stringify(mval ?? null);
    else parts[k] = JSON.stringify(val ?? null);
  }
  return parts;
}

/** Puts the parts back together. Null while the view is incomplete (nothing published yet). */
export function joinView(parts: unknown): PlayerView | null {
  if (!parts || typeof parts !== 'object') return null;
  const out: Record<string, unknown> = {};
  const me: Record<string, unknown> = {};
  for (const [k, text] of Object.entries(parts as Record<string, string>)) {
    if (k.startsWith(ME)) me[k.slice(ME.length)] = JSON.parse(text);
    else out[k] = JSON.parse(text);
  }
  if (!('clock' in out) || !('id' in me)) return null;
  out.me = me;
  return out as unknown as PlayerView;
}

// ---- Actions ----------------------------------------------------------------------------

const ACTION_TYPES: Action['type'][] = ['EXECUTE', 'SHARE_CREDENTIAL', 'SEND_MESSAGE', 'CONNECT', 'ACCESS_WORKSTATION', 'SET_WATCH'];

/**
 * A client's action as the host will apply it: one of the known kinds, and always as the seat the sender
 * sits at, whatever playerId they sent. Null if it is not an action at all.
 */
export function parseAction(text: unknown, playerId: PlayerId): Action | null {
  if (typeof text !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (!ACTION_TYPES.includes(a.type as Action['type'])) return null;
  if (a.params !== undefined && (typeof a.params !== 'object' || a.params === null || Array.isArray(a.params))) return null;
  return { ...a, playerId } as Action;
}

export const failResult = (message: string): ActionResult => ({ ok: false, message });
