// A player's side of an online game: follows their seat and view, and sends actions to the host.

import type { Action, ActionResult, PlayerId, PlayerView } from '../engine';
import type { Db, Unsubscribe } from './db';
import { failResult, joinView, roomPath } from './protocol';
import type { RoomMeta } from './protocol';

/** How long to wait for the host to answer an action. */
const ANSWER_TIMEOUT_MS = 15000;

export class ClientSession {
  seat: PlayerId | null = null;
  view: PlayerView | null = null;
  meta: RoomMeta | null = null;
  private listeners = new Set<() => void>();
  private unsubs: Unsubscribe[] = [];
  private viewUnsub: Unsubscribe | null = null;

  constructor(
    readonly db: Db,
    readonly code: string,
  ) {}

  start(): void {
    this.unsubs.push(
      this.db.onValue(roomPath(this.code, 'meta'), (v) => {
        this.meta = v as RoomMeta | null;
        this.emit();
      }),
      this.db.onValue(roomPath(this.code, `seats/${this.db.uid}`), (v) => this.sit(typeof v === 'string' ? v : null)),
      this.db.presence(roomPath(this.code, `presence/${this.db.uid}`)),
    );
  }

  /** The host has paused the game. */
  get paused(): boolean {
    return !!this.meta?.paused;
  }

  stop(): void {
    this.unsubs.forEach((u) => u());
    this.viewUnsub?.();
    this.unsubs = [];
  }

  /** Called whenever the seat, the view or the room changes. */
  onChange(cb: () => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    this.listeners.forEach((cb) => cb());
  }

  private sit(pid: PlayerId | null): void {
    if (pid === this.seat) return;
    this.seat = pid;
    this.view = null;
    this.viewUnsub?.();
    this.viewUnsub = pid
      ? this.db.onValue(roomPath(this.code, `views/${pid}`), (parts) => {
          const v = joinView(parts);
          if (!v) return;
          this.view = v;
          this.emit();
        })
      : null;
    this.emit();
  }

  /** Dev rooms: ask the host for a seat (any real one). */
  claim(pid: PlayerId): Promise<void> {
    return this.db.set(roomPath(this.code, `claims/${this.db.uid}`), pid);
  }

  /** Sends an action and waits for the host's answer. The host decides whose seat it is played from. */
  async send(action: Action): Promise<ActionResult> {
    let key: string;
    try {
      key = await this.db.push(roomPath(this.code, 'actions'), { uid: this.db.uid, action: JSON.stringify(action) });
    } catch {
      return failResult('Could not reach the game. Check your connection.');
    }
    const path = roomPath(this.code, `results/${this.db.uid}/${key}`);
    return new Promise((resolve) => {
      let done = false;
      let unsub: Unsubscribe | null = null;
      const finish = (r: ActionResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub?.();
        resolve(r);
      };
      const timer = setTimeout(() => finish(failResult('No answer from the host. Is the host still connected?')), ANSWER_TIMEOUT_MS);
      unsub = this.db.onValue(path, (v) => {
        if (typeof v !== 'string') return;
        void this.db.remove(path);
        finish(JSON.parse(v) as ActionResult);
      });
      if (done) unsub();
    });
  }
}
