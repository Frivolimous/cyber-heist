// Small helpers shared by the engine, handlers and setup code.

import { findModule, findSystem } from './catalog';
import { randInt } from './rng';
import { notify } from './notify';
import type { ActionResult, Alert, Block, Customer, GameState, LogEntry, Player, Reroute, SystemId } from './types';

/** A system's network address. The unregistered host's is random each game. */
export const systemAddress = (s: GameState, id: SystemId): string => (id === 'BLACKHAT_DB' ? s.hiddenHost : (findSystem(id)?.address ?? ''));

export const keyOf = (system: string, module: string): string => `${system}.${module}`;

export function gameTime(s: GameState): number {
  return Math.max(0, (s.now - s.startedAt) / 1000);
}

/** Game time as players see it everywhere (logs, records, the header): elapsed minutes and seconds, "07:42". */
export function fmtClock(t: number): string {
  const total = Math.max(0, Math.floor(t));
  return [Math.floor(total / 60), total % 60].map((n) => String(n).padStart(2, '0')).join(':');
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

/**
 * Raises a Master Log alert. `tier` (1-4) is its severity; while an Alert mute is active, tier 1-2 alerts are dropped.
 * `owner`: whose name the alerted activity is under (they are not notified of it).
 */
export function addAlert(s: GameState, kind: string, message: string, logId: string | null, tier = 2, owner: string | null = null): Alert | null {
  const t = gameTime(s);
  if (tier <= 2 && t < s.alertMuteUntil) return null; // muted: dropped entirely, no id consumed
  const a: Alert = { id: nextId(s, 'alert', 'A'), t, kind, message, logId, tier };
  s.alerts.push(a);
  notify(s, 'SECURITY', 'MASTER_LOG', message, { owner });
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

/** How many real seats the game has (planted users are records, not seats). */
export const tableSize = (s: GameState): number => s.playerOrder.filter((id) => !s.players[id].fake).length;

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
  const series = /^\s*([wx])\s*\d+\s*$/i.exec(v); // a workstation login (W) or a host credential (X)
  if (series) return `${series[1].toUpperCase()}${Number(digits(v))}`;
  const d = digits(v);
  return d ? `C${Number(d)}` : v.trim().toUpperCase();
};
/** "12345" or "ACC-12345" -> "ACC-12345", otherwise null. */
export const normAccount = (v: string): string | null => {
  const m = v.trim().toUpperCase().match(/^(?:ACC-?)?(\d{5})$/);
  return m ? `ACC-${m[1]}` : null;
};

/** The customer an account number belongs to, if any (accounts can also float, owned by nobody). */
export function accountOwner(s: GameState, account: string): Customer | undefined {
  return s.customers.find((c) => c.accounts.includes(account));
}

/** What the customer believes their accounts are (older saved games: the bank's records). */
export const knownOf = (c: Customer): Customer['known'] => c.known ?? { accounts: c.accounts, primary: c.primary };

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

/** The IP reroute in force for an address, if any (the latest one that has not expired). */
export function activeReroute(s: GameState, ip: string, t: number): Reroute | undefined {
  return [...s.reroutes].reverse().find((r) => r.fromIp === ip && r.until > t);
}

/** The IP a player's activity currently appears to come from: their own, unless their workstation is rerouted. */
export function effectiveIp(s: GameState, p: Player, t: number): string {
  return activeReroute(s, p.ip, t)?.toIp ?? p.ip;
}

/** The unregistered host's address as it currently appears in records: its own, unless it is rerouted. */
export function effectiveHost(s: GameState, t: number): string {
  return activeReroute(s, s.hiddenHost, t)?.toIp ?? s.hiddenHost;
}

/** Adds an entry to the hidden host's own log. */
export function addHostLog(s: GameState, message: string, alert = false): void {
  s.hostLog.push({ id: nextId(s, 'host', 'H'), t: gameTime(s), message, alert });
}

// ---- Money --------------------------------------------------------------------
/** An account exists only if it is in the registry (GameState.balances); anything else is refused. */
export const accountExists = (s: GameState, account: string): boolean => account in s.balances;
export const balanceOf = (s: GameState, account: string): number => s.balances[account] ?? 0;

/** Moves money between two existing accounts; the stolen total follows the Target Ledger balances. */
export function moveMoney(s: GameState, from: string, to: string, amount: number): void {
  s.balances[from] = balanceOf(s, from) - amount;
  s.balances[to] = balanceOf(s, to) + amount;
  s.totals.stolen = s.targets.reduce((sum, tg) => sum + balanceOf(s, tg.account), 0);
}

/**
 * Blacknet handles. Every player is dealt one at random when the game starts (more than MAX_PLAYERS, so they
 * never repeat) and cannot change it; a post carries the alias of the credential's owner.
 */
export const HACKER_ALIASES = [
  // A quarter in l33t...
  'Z3r0_C00l', 'Gh0st_1n_th3_Sh3ll', 'xX_R00tK1t_Xx', 'K3rn3l_P4n1c', 'Bl4ck_1C3',
  '0xD34DB33F', 'St4ck_Sm4sh3r', 'N1ghtCr4wl3r', 'L0g1c_B0mb', 'Ph1sh_H00k',
  // ...the rest plain.
  'CrashOverride', 'AcidBurn', 'PhantomPhreak', 'NeonRaven', 'DarkTangent', 'ShadowRunner',
  'BytePhantom', 'ZeroDay', 'GlitchWitch', 'MalwareMaven', 'SynapticSnake', 'HexEditor',
  'ColdBoot', 'CyberWolf', 'NullPointer', 'PacketRat', 'DaemonShell', 'VoidWalker',
  'Overflow', 'SpoofMaster', 'TrojanHorse', 'BitRot', 'ChaosCode', 'WhiteNoise',
  'CronJob', 'SilkRoute', 'NetRunner', 'BackdoorBandit', 'FirewallFreak', 'Sudo_Rm_Rf',
];

/** An alias nobody in the game has yet (for players added mid-game); the list order, then numbered. */
export function unusedAlias(s: GameState): string {
  const taken = new Set(Object.values(s.players).map((p) => p.alias));
  return HACKER_ALIASES.find((a) => !taken.has(a)) ?? `Gh0st_${Object.keys(s.players).length}`;
}

/** A fresh account number that nothing uses yet (not registered, not a player's or planted user's number). */
export function unusedAccountNumber(s: GameState): string {
  const players = new Set(Object.values(s.players).map((p) => p.bankAccount));
  for (;;) {
    const a = `ACC-${randInt(s, 10000, 99999)}`;
    if (!accountExists(s, a) && !players.has(a)) return a;
  }
}
