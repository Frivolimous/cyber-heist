// The host's side of an online game. The host's browser holds the whole game and runs the engine; this
// takes players' actions from the database, applies them as the sender's seat, answers each one, and
// publishes to every seated player only their own view.

import { getPlayerView } from '../engine';
import type { Action, ActionResult, GameState, PlayerId } from '../engine';
import type { Db, Unsubscribe } from './db';
import { failResult, parseAction, roomPath, splitView } from './protocol';
import type { RoomMeta } from './protocol';

export interface HostHooks {
  /** Applies an action to the host's game (and redraws the host's screen). */
  apply(action: Action): ActionResult;
  /** The game as it is now. */
  state(): GameState;
}

/** What a reloaded host needs to carry on. */
export interface HostSnapshot {
  state: GameState;
  vNow: number;
  speed: number;
  /** DEV ONLY: the secret key of this game's watcher copy (see publishWatch). */
  watchKey?: string;
}

/** DEV ONLY: what the watcher link reads: the whole game and the host's clock. */
export interface WatchCopy {
  state: GameState;
  vNow: number;
}

export class HostSession {
  /** uid -> seat. */
  seats: Record<string, PlayerId> = {};
  /** uids whose screens are connected right now. */
  online = new Set<string>();
  /** While paused, players' actions are refused (the host's own, in the sandbox, still go through). */
  paused = false;
  private published: Record<PlayerId, Record<string, string>> = {};
  private unsubs: Unsubscribe[] = [];
  private status: RoomMeta['status'] | null = null;
  private onSeatsChanged: (() => void) | null = null;

  constructor(
    readonly db: Db,
    readonly code: string,
    private hooks: HostHooks,
    readonly dev: boolean,
  ) {}

  start(onSeatsChanged?: () => void): void {
    this.onSeatsChanged = onSeatsChanged ?? null;
    let actionsOn = false;
    this.unsubs.push(
      this.db.onValue(roomPath(this.code, 'seats'), (v) => {
        this.seats = (v as Record<string, PlayerId> | null) ?? {};
        this.onSeatsChanged?.();
        // Actions are only handled once the seats are known, or early ones would be refused.
        if (!actionsOn) {
          actionsOn = true;
          this.unsubs.push(this.db.onChildAdded(roomPath(this.code, 'actions'), (key, value) => this.handle(key, value)));
        }
        this.publish();
      }),
    );
    if (this.dev) this.unsubs.push(this.db.onValue(roomPath(this.code, 'claims'), (v) => this.grantClaims(v as Record<string, string> | null)));
    this.unsubs.push(
      this.db.onValue(roomPath(this.code, 'presence'), (v) => {
        this.online = new Set(Object.keys((v as Record<string, true> | null) ?? {}));
        this.onSeatsChanged?.();
      }),
    );
  }

  /** Pauses or resumes: players see a notice, and their actions are refused while paused. */
  setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    return this.db.set(roomPath(this.code, 'meta/paused'), paused);
  }

  /** Is someone seated at this seat connected right now? */
  isOnline(pid: PlayerId): boolean {
    return Object.entries(this.seats).some(([uid, seat]) => seat === pid && this.online.has(uid));
  }

  stop(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  /** A fresh game in the same room (dev sandbox: New game): old views go, seats that no longer exist too. */
  async reset(): Promise<void> {
    this.published = {};
    const s = this.hooks.state();
    const seats = Object.fromEntries(Object.entries(this.seats).filter(([, pid]) => s.players[pid] && !s.players[pid].fake));
    await this.db.update(roomPath(this.code), { views: null, seats, 'meta/status': 'RUNNING' });
    this.status = 'RUNNING';
    this.publish();
  }

  /** Seats played from other screens that are connected now: seat -> how many. */
  remoteSeats(): Record<PlayerId, number> {
    const out: Record<PlayerId, number> = {};
    for (const [uid, pid] of Object.entries(this.seats)) if (this.online.has(uid)) out[pid] = (out[pid] ?? 0) + 1;
    return out;
  }

  private handle(key: string, value: unknown): void {
    const v = (value ?? {}) as { uid?: string; action?: unknown };
    const uid = typeof v.uid === 'string' ? v.uid : '';
    const pid = this.seats[uid];
    let result: ActionResult;
    const action = pid ? parseAction(v.action, pid) : null;
    if (!pid) result = failResult('You do not have a seat in this game.');
    else if (!action) result = failResult('Unknown action.');
    else if (this.paused) result = failResult('The game is paused.');
    else {
      try {
        result = this.hooks.apply(action);
      } catch (e) {
        console.error('Action failed on the host', action, e);
        result = failResult('That did not work (the host hit an error).');
      }
    }
    // The answer, the action's removal and the new views go out in one write, so they arrive together.
    const updates = this.viewUpdates();
    updates[`actions/${key}`] = null;
    if (uid) updates[`results/${uid}/${key}`] = JSON.stringify(result);
    void this.db.update(roomPath(this.code), updates);
  }

  /** Dev rooms: a tester's claim on a seat is granted if the seat is a real one. */
  private grantClaims(claims: Record<string, string> | null): void {
    const s = this.hooks.state();
    const updates: Record<string, unknown> = {};
    for (const [uid, pid] of Object.entries(claims ?? {})) {
      if (this.seats[uid] === pid || !s.players[pid] || s.players[pid].fake) continue;
      updates[`seats/${uid}`] = pid;
    }
    if (Object.keys(updates).length) void this.db.update(roomPath(this.code), updates);
  }

  /** Sends every seated player whatever changed in their view (and the room status once it ends). */
  publish(): void {
    const updates = this.viewUpdates();
    if (Object.keys(updates).length) void this.db.update(roomPath(this.code), updates);
  }

  private viewUpdates(): Record<string, unknown> {
    const s = this.hooks.state();
    const updates: Record<string, unknown> = {};
    for (const pid of new Set(Object.values(this.seats))) {
      if (!s.players[pid]) continue;
      const parts = splitView(getPlayerView(s, pid));
      const prev = (this.published[pid] ??= {});
      for (const [k, text] of Object.entries(parts)) {
        if (prev[k] === text) continue;
        prev[k] = text;
        updates[`views/${pid}/${k}`] = text;
      }
    }
    const status = s.status === 'ENDED' ? 'ENDED' : 'RUNNING';
    if (status !== this.status) {
      this.status = status;
      updates['meta/status'] = status;
    }
    return updates;
  }

  /** Saves the whole game for a reload. Host-only data: players never read it. */
  saveSnapshot(snap: HostSnapshot): Promise<void> {
    return this.db.set(roomPath(this.code, 'hostState'), JSON.stringify(snap));
  }

  /**
   * DEV ONLY (remove before any public release): writes the whole game where the watcher link reads it,
   * under a secret key nobody can list. See the warning in README.md.
   */
  publishWatch(key: string, copy: WatchCopy): Promise<void> {
    return this.db.set(roomPath(this.code, `watch/${key}`), JSON.stringify(copy));
  }
}

export async function loadSnapshot(db: Db, code: string): Promise<HostSnapshot | null> {
  const text = await db.get(roomPath(code, 'hostState'));
  return typeof text === 'string' ? (JSON.parse(text) as HostSnapshot) : null;
}

/**
 * Calls `fn` every `ms`, even while the tab is in the background. Browsers slow timers in hidden tabs
 * to once a minute, which would freeze the game for everyone; a worker's timers are not slowed.
 */
export function startTicker(ms: number, fn: () => void): () => void {
  try {
    const src = `setInterval(() => postMessage(0), ${ms});`;
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = fn;
    return () => worker.terminate();
  } catch {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
}
