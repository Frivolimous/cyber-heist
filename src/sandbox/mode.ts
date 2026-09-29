// How the game screen (main.ts) runs. The entry point (app.ts) sets this before loading the screen.

import type { ClientSession } from '../net/client';
import type { Db } from '../net/db';
import type { HostSnapshot } from '../net/host';

export type Boot =
  /** Offline sandbox: this tab holds the game, and the dev bar switches seats. */
  | { kind: 'offline' }
  /** Online sandbox host: as offline, but the game is also played from other tabs and devices. */
  | { kind: 'host'; db: Db; code: string; snapshot: HostSnapshot | null }
  /** A remote screen: one seat, driven by the host. `dev`: a tester in an online sandbox (can switch seats). */
  | { kind: 'client'; session: ClientSession; dev: boolean };

export const boot: { current: Boot } = { current: { kind: 'offline' } };
