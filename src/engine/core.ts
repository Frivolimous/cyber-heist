// Small helpers shared by the engine, handlers and setup code.

import { findModule } from './catalog';
import type { ActionResult, Alert, Block, Customer, GameConfig, GameState, LogEntry, Player } from './types';

export const keyOf = (system: string, module: string): string => `${system}.${module}`;

export function gameTime(s: GameState): number {
  return Math.max(0, (s.now - s.startedAt) / 1000);
}

export function fmtClock(config: GameConfig, t: number): string {
  const total = Math.floor(config.clockStart + t);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const sec = total % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

export function money(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

export function ok(message: string, lines?: string[]): ActionResult {
  return { ok: true, message, lines };
}
export function fail(message: string): ActionResult {
  return { ok: false, message };
}

export function nextId(s: GameState, kind: keyof GameState['counters'], prefix: string, pad = 0): string {
  s.counters[kind] += 1;
  return prefix + String(s.counters[kind]).padStart(pad, '0');
}

/** Appends to the Master Log. While the Master Log is offline entries are dropped (ids still advance = visible gap). */
export function addLog(s: GameState, e: Omit<LogEntry, 'id' | 't'>): LogEntry {
  const entry: LogEntry = { id: nextId(s, 'log', 'L'), t: gameTime(s), ...e };
  if (s.modules[keyOf('SECURITY', 'MASTER_LOG')].status === 'ONLINE') s.logs.push(entry);
  return entry;
}

export function addAlert(s: GameState, kind: string, message: string, logId: string | null): Alert {
  const a: Alert = { id: nextId(s, 'alert', 'A'), t: gameTime(s), kind, message, logId };
  s.alerts.push(a);
  return a;
}

export function note(p: Player, t: number, text: string): void {
  p.activity.push({ t, text });
}

export function targetLabel(system: string, module: string): string {
  if (system === 'BLACKHAT_DB') return 'an unregistered host';
  return findModule(system, module)?.label ?? `${system}.${module}`;
}

/** Who is recorded when a module's security is off and nobody entered a code. */
export const ANONYMOUS = 'ANONYMOUS';

export function nameOf(s: GameState, actor: string): string {
  if (actor === 'SYSTEM' || actor === 'UNKNOWN') return actor;
  if (actor === ANONYMOUS) return 'Anonymous';
  return s.players[actor]?.name ?? actor;
}

// ---- Tolerant id parsing (players type "12" or "tx 12") -------------------
const digits = (v: string): string | null => v.match(/\d+/)?.[0] ?? null;
export const normTx = (v: string): string => {
  const d = digits(v);
  return d ? `TX-${d.padStart(4, '0')}` : v.trim().toUpperCase();
};
export const normReq = (v: string): string => {
  const d = digits(v);
  return d ? `REQ-${Number(d)}` : v.trim().toUpperCase();
};
export const normChange = (v: string): string => {
  const d = digits(v);
  return d ? `CH-${Number(d)}` : v.trim().toUpperCase();
};
export const normCust = (v: string): string => {
  const d = digits(v);
  return d ? `CU${Number(d)}` : v.trim().toUpperCase();
};
export const normLog = (v: string): string => {
  const d = digits(v);
  return d ? `L${Number(d)}` : v.trim().toUpperCase();
};
export const normCred = (v: string): string => {
  const d = digits(v);
  return d ? `C${Number(d)}` : v.trim().toUpperCase();
};
/** "12345" or "ACC-12345" -> "ACC-12345", otherwise null. */
export const normAccount = (v: string): string | null => {
  const m = v.trim().toUpperCase().match(/^(?:ACC-?)?(\d{5})$/);
  return m ? `ACC-${m[1]}` : null;
};

/** Any traffic to the hidden host raises a (throttled) alert without the address; tracing its log entry gives clues. */
export function flagHiddenTraffic(s: GameState, entry: LogEntry): void {
  const last = [...s.alerts].reverse().find((a) => a.kind === 'UNREGISTERED_HOST');
  if (!last || gameTime(s) - last.t >= 30) {
    addAlert(s, 'UNREGISTERED_HOST', 'Traffic to an unregistered host detected', entry.id);
  }
}

/** The customer an account number belongs to, if any (accounts can also float, owned by nobody). */
export function accountOwner(s: GameState, account: string): Customer | undefined {
  return s.customers.find((c) => c.accounts.includes(account));
}

/** An account is verified when no change that added it or made it primary is still waiting for verification. */
export function accountVerified(c: Customer, account: string): boolean {
  return !c.history.some((h) => h.account === account && h.action !== 'REMOVE_ACCOUNT' && !h.verified);
}

/** The block currently in force on an address, if any (temporary blocks expire; permanent ones never do). */
export function activeBlock(s: GameState, address: string): Block | undefined {
  const t = gameTime(s);
  return s.blocks.find((b) => b.address === address && (b.until === null || b.until > t));
}

export function blockText(s: GameState, b: Block): string {
  return b.until === null ? 'permanently' : `for ${Math.ceil(b.until - gameTime(s))}s`;
}

/** Adds an entry to the hidden host's own log. */
export function addHostLog(s: GameState, message: string, alert = false): void {
  s.hostLog.push({ id: nextId(s, 'host', 'H'), t: gameTime(s), message, alert });
}
