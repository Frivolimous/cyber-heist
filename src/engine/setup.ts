// Builds a fresh game: roles, allegiances, credentials and bank data.

import { DEFAULT_CONFIG, hackerCount, HIDDEN_HOST, HOST_KITS, HOST_SHARED_MODULES, MAX_PLAYERS, MIN_PLAYERS, roleCounts, ROLES, ROLE_ORDER, SYSTEMS } from './catalog';
import { addLog, keyOf, money } from './core';
import { createCredential } from './credentials';
import { spawnNpc } from './bank';
import { assignBankers, assignContacts, schedulePhishing, spawnRequest } from './requests';
import { pick, rand, randInt, shuffle } from './rng';
import type { GameConfig, GameState, Player, RoleId, WealthTier } from './types';

export interface NewGameOptions {
  id?: string;
  seed: number;
  players: { id: string; name: string }[];
  now: number;
  config?: Partial<GameConfig>;
}

/**
 * Everyone the bank might deal with, companies and people alike. Each game picks customersPerBanker per
 * Personal Banker at random from this pool (42 names = 3 per banker at the 30-player cap of 14 bankers).
 */
export const CUSTOMER_NAMES = [
  'Alder & Finch LLC',
  'Marisol Ortega',
  'Tanaka Holdings',
  'Pryce Dental Group',
  'Nadia Volkov',
  'Brightwater Logistics',
  'Northwind Freight',
  'Halcyon Insurance',
  'Redfern Utilities',
  'Kessler & Sons',
  'Meridian Leasing',
  'Cobalt Payroll',
  'Ivy Lane Property',
  'Sable Medical Supply',
  'Okafor Engineering',
  'Delphine Arceneaux',
  'Greywell Pharmacy',
  'Bastion Security Ltd',
  'Tomasz Wieczorek',
  'Harbor & Pine Realty',
  'Luminary Film Co',
  'Priyanka Raghavan',
  'Copperleaf Farms',
  'Westgate Auto Group',
  'Juniper Veterinary',
  'Elias Brandt',
  'Quarry Stone Supply',
  'Silverline Couriers',
  'Aurora Daycare Centers',
  'Mateo Figueroa',
  'Keystone Plumbing',
  'Oakhurst Vineyards',
  'Fenwick Law Partners',
  'Yuki Hashimoto',
  'Riverbend Hospital Trust',
  'Blue Heron Bakery',
  'Stratton Aerospace',
  'Amara Nwosu',
  'Lakeside Storage Co',
  'Vantage Print Works',
  'Corinne Dubois',
  'Summit Outdoor Gear',
];

/** The private people in CUSTOMER_NAMES (everyone else is a company, which writes through a made-up contact). */
export const PERSON_CUSTOMERS: ReadonlySet<string> = new Set([
  'Marisol Ortega', 'Nadia Volkov', 'Delphine Arceneaux', 'Tomasz Wieczorek', 'Priyanka Raghavan',
  'Elias Brandt', 'Mateo Figueroa', 'Yuki Hashimoto', 'Amara Nwosu', 'Corinne Dubois',
]);

/**
 * The values that scale with the table, from the per-player settings in `base`:
 * - targets: whiteTargetPerPlayer x players, blackTargetPerHacker x Black Hats;
 * - client requests: each Personal Banker gets one about every requestEverySecPerBanker seconds;
 * - automatic payments fill the rest, so that automatic payments plus requested payments add up to about
 *   volumePerPlayer x players over the game, but never more than MAX_AUTO_SHARE of the bank target. Manual
 *   payments count toward the target only when they fulfil a payment request (see bank.ts), so the requested
 *   share is money the team has to earn by acting on requests: automatic traffic alone can never win.
 * Amounts are capped by what the paying account holds (affordableAmount in bank.ts), so the average payment is
 * below the middle of its range; the factors below are measured averages over simulated games.
 */
const NPC_AMOUNT_FACTOR = 0.87; // average automatic payment / middle of npcMinAmount..npcMaxAmount
const REQUEST_AMOUNT_FACTOR = 0.45; // average requested payment / middle of npcMinAmount..maxManualAmount
const MAX_AUTO_SHARE = 0.8; // automatic volume is capped at this share of the bank target
export function scaledConfig(base: GameConfig, n: number, hackers: number): Pick<GameConfig, 'whiteTarget' | 'blackTarget' | 'npcIntervalSec' | 'requestIntervalSec'> {
  const bankers = roleCounts(n).PERSONAL_BANKER;
  const requestIntervalSec = base.requestEverySecPerBanker / bankers;
  const requests = base.durationSec / requestIntervalSec;
  const avgRequested = (REQUEST_AMOUNT_FACTOR * (base.npcMinAmount + base.maxManualAmount)) / 2;
  const requestedVolume = requests * (1 - base.requestChangeShare) * avgRequested;
  const avgNpc = (NPC_AMOUNT_FACTOR * (base.npcMinAmount + base.npcMaxAmount)) / 2;
  const whiteTarget = base.whiteTargetPerPlayer * n;
  const npcVolume = Math.max(Math.min(base.volumePerPlayer * n - requestedVolume, MAX_AUTO_SHARE * whiteTarget), avgNpc); // at least one payment's worth
  return {
    whiteTarget,
    blackTarget: base.blackTargetPerHacker * hackers,
    npcIntervalSec: base.durationSec / (npcVolume / avgNpc),
    requestIntervalSec,
  };
}
const WHITE_MOTIVATIONS = [
  'You flagged a near-miss last quarter and nobody listened. This time you want to be right.',
  'Your bonus depends on uptime, and you have a mortgage.',
  'You are new here and want to prove the bank was right to hire you.',
  'You trained half of this floor and take every breach personally.',
];
const BLACK_MOTIVATIONS = [
  'You are deep in debt and the payout would clear it.',
  'You were passed over for promotion twice.',
  'You believe the bank has it coming.',
  'You were promised a cut and have already spent it.',
];

export function createGame(o: NewGameOptions): GameState {
  const n = o.players.length;
  if (n < MIN_PLAYERS) throw new Error(`Cyber-Heist needs at least ${MIN_PLAYERS} players (got ${n}).`);
  if (n > MAX_PLAYERS) throw new Error(`Cyber-Heist allows at most ${MAX_PLAYERS} players (got ${n}).`);
  // Scaled values are derived from the per-player settings; anything the caller sets explicitly wins.
  const base: GameConfig = { ...DEFAULT_CONFIG, ...o.config };
  const blackCount = Math.min(n - 1, Math.max(1, base.blackHatCount ?? hackerCount(n)));
  const config: GameConfig = { ...base, ...scaledConfig(base, n, blackCount), ...o.config };
  const s: GameState = {
    id: o.id ?? `game-${o.seed}`,
    seed: o.seed,
    rngState: o.seed | 0,
    config,
    status: 'RUNNING',
    winner: null,
    endReason: null,
    startedAt: o.now,
    now: o.now,
    lastNpcAt: 0,
    players: {},
    playerOrder: o.players.map((p) => p.id),
    credentials: {},
    modules: {},
    logs: [],
    alerts: [],
    customers: [],
    requests: [],
    blocks: [],
    reroutes: [],
    cracks: [],
    alertMuteUntil: 0,
    hostLog: [],
    revocations: [],
    lastRequestAt: 0,
    phishSchedule: [],
    transactions: [],
    balances: {},
    targets: [],
    blacknet: [],
    totals: { processed: 0, stolen: 0 },
    hiddenHost: HIDDEN_HOST,
    counters: { log: 0, alert: 0, cred: 0, tx: 0, msg: 0, req: 0, change: 0, revoke: 0, host: 0, player: 0, crack: 0, notice: 0 },
  };

  for (const sys of SYSTEMS) for (const m of sys.modules) s.modules[keyOf(sys.id, m.id)] = { status: 'ONLINE', open: false, encryption: [] };

  const usedAccounts = new Set<string>();
  const newAccount = (): string => {
    for (;;) {
      const a = `ACC-${randInt(s, 10000, 99999)}`;
      if (!usedAccounts.has(a)) {
        usedAccounts.add(a);
        return a;
      }
    }
  };

  // Roles: the counts come from the player count (roleCounts), dealt over a shuffled seat order.
  const counts = roleCounts(n);
  const roleSeats = ROLE_ORDER.flatMap((role) => Array.from({ length: counts[role] }, () => role));
  const roleOf = new Map<string, RoleId>();
  shuffle(s, s.playerOrder).forEach((id, i) => roleOf.set(id, roleSeats[i]));

  // Allegiances: hackerCount(n) Black Hats, unless the config fixes the number (blackCount, above).
  const blackIds = new Set(shuffle(s, s.playerOrder).slice(0, blackCount));

  // Bank data.
  // customersPerBanker per Personal Banker, drawn at random from the name pool (CU1, CU2, ... in draw order).
  // Each customer starts with 1-3 accounts; the first is primary.
  const customerCount = Math.min(CUSTOMER_NAMES.length, counts.PERSONAL_BANKER * config.customersPerBanker);
  s.customers = shuffle(s, CUSTOMER_NAMES).slice(0, customerCount).map((name, i) => {
    const accounts = Array.from({ length: randInt(s, 1, 3) }, () => newAccount());
    return { id: `CU${i + 1}`, name, bankerId: null, accounts, primary: accounts[0], originalPrimary: accounts[0], lastModifiedAt: null, history: [], wealth: 'SMALL' as WealthTier, person: false, contact: '', strikes: 0, suspended: false };
  });
  const statuses = ['READY', 'PREPARE', 'ABORT'] as const;
  s.targets = statuses.map((status) => ({ account: newAccount(), status }));

  // Players.
  for (let i = 0; i < n; i++) {
    const { id, name } = o.players[i];
    const allegiance = blackIds.has(id) ? 'BLACK' : 'WHITE';
    const p: Player = {
      id,
      name,
      role: roleOf.get(id)!,
      allegiance,
      objective: '',
      motivation: pick(s, allegiance === 'BLACK' ? BLACK_MOTIVATIONS : WHITE_MOTIVATIONS),
      ip: `10.1.0.${11 + i}`,
      bankAccount: newAccount(),
      heldCredentialIds: [],
      knownSystems: ['SECURITY', 'CLIENT_DATA', 'TRANSACTIONS'],
      activity: [],
      messages: [],
      failStreak: 0,
      lockedUntil: 0,
      lastTraceAt: -9999,
      failTotal: 0,
      lastActiveAt: null,
      monitoring: [],
      remoteAccess: [],
      watching: [],
      notifications: [],
    };
    const mins = Math.round(config.durationSec / 60);
    p.objective =
      allegiance === 'WHITE'
        ? `Keep the bank running: get ${money(config.whiteTarget)} of customer payments settled within ${mins} minutes, and stop anyone diverting ${money(config.blackTarget)}. Find the Black Hats.`
        : `Divert ${money(config.blackTarget)} into your Target Ledger accounts within ${mins} minutes. Stay hidden: the logs name the credential, not the hand. There are ${blackCount} operatives in total. Coordinate on Blacknet at ${HIDDEN_HOST}.`;
    s.players[id] = p;

    for (const t of ROLES[p.role].creds) {
      const cred = createCredential(s, { owner: id, system: t.system, module: t.module, permission: t.permission, issuedBy: null });
      p.heldCredentialIds.push(cred.id);
    }
    if (allegiance === 'BLACK') {
      // Every operative can use the host's shared modules; tool kits are dealt below.
      for (const module of HOST_SHARED_MODULES) {
        const cred = createCredential(s, { owner: id, system: 'BLACKHAT_DB', module, permission: 'WRITE', issuedBy: null });
        p.heldCredentialIds.push(cred.id);
      }
      p.knownSystems.push('BLACKHAT_DB');
    }
  }
  dealKits(s);

  assignBankers(s);
  fundAccounts(s);

  addLog(s, { actor: 'SYSTEM', kind: 'BOOT', message: 'Bank network online. Shift started.', sourceIp: null, actualPlayerId: null });
  for (let i = 0; i < 3; i++) spawnNpc(s);
  for (let i = 0; i < 2; i++) spawnRequest(s);
  assignContacts(s, PERSON_CUSTOMERS);
  schedulePhishing(s);
  return s;
}

/**
 * Customer wealth, as a fixed split every game: 20% wealthy, 30% mid-sized, the rest (half) small.
 * The range is the customer's total starting money across all their accounts.
 */
export const WEALTH_TIERS: { tier: WealthTier; share: number; min: number; max: number }[] = [
  { tier: 'WEALTHY', share: 0.2, min: 30_000_000, max: 60_000_000 },
  { tier: 'MID', share: 0.3, min: 5_000_000, max: 15_000_000 },
  { tier: 'SMALL', share: 0.5, min: 250_000, max: 2_000_000 }, // takes the remainder, so the counts always add up
];

/**
 * Opens the books: every customer gets a wealth tier and money spread over their accounts (the primary holds
 * 60-85%, the rest is split at random), players get $1,000-$100,000 in their own account, and the Target
 * Ledger (mule) accounts start empty.
 */
function fundAccounts(s: GameState): void {
  const n = s.customers.length;
  const wealthy = Math.round(n * WEALTH_TIERS[0].share);
  const mid = Math.round(n * WEALTH_TIERS[1].share);
  const tiers = s.customers.map((_, i): WealthTier => (i < wealthy ? 'WEALTHY' : i < wealthy + mid ? 'MID' : 'SMALL'));
  shuffle(s, tiers).forEach((tier, i) => {
    const c = s.customers[i];
    const range = WEALTH_TIERS.find((w) => w.tier === tier)!;
    const total = randInt(s, range.min / 1000, range.max / 1000) * 1000;
    c.wealth = tier;
    const others = c.accounts.filter((a) => a !== c.primary);
    const primary = others.length ? Math.round((total * (0.6 + rand(s) * 0.25)) / 1000) * 1000 : total;
    s.balances[c.primary] = primary;
    const cuts = others.map(() => rand(s) + 0.1);
    const cutTotal = cuts.reduce((a, b) => a + b, 0);
    others.forEach((a, j) => (s.balances[a] = Math.round(((total - primary) * cuts[j]) / cutTotal / 1000) * 1000));
  });
  for (const tg of s.targets) s.balances[tg.account] = 0;
  for (const id of s.playerOrder) s.balances[s.players[id].bankAccount] = randInt(s, 1000, 100_000);
}

/** Sandbox/testing: give one player a whole-system WRITE credential for every system, hidden host included. */
export function grantMasterAccess(s: GameState, playerId: string): void {
  const p = s.players[playerId];
  for (const sys of SYSTEMS) {
    const cred = createCredential(s, { owner: p.id, system: sys.id, module: null, permission: 'WRITE', issuedBy: null });
    p.heldCredentialIds.push(cred.id);
    if (!p.knownSystems.includes(sys.id)) p.knownSystems.push(sys.id);
  }
}

/**
 * Deals the hidden host's tool kits: every operative gets one. With more kits than operatives, each kit
 * left over has an even chance of going to a random operative as a second, so some go unused. With more
 * operatives than kits (15+ players), the shuffled kits repeat so nobody goes without.
 */
function dealKits(s: GameState): void {
  const blacks = s.playerOrder.filter((id) => s.players[id].allegiance === 'BLACK');
  if (!blacks.length) return;
  const kits = shuffle(s, HOST_KITS);
  const give = (owner: string, module: string): void => {
    const cred = createCredential(s, { owner, system: 'BLACKHAT_DB', module, permission: 'WRITE', issuedBy: null });
    s.players[owner].heldCredentialIds.push(cred.id);
  };
  blacks.forEach((owner, i) => give(owner, kits[i % kits.length]));
  for (const kit of kits.slice(blacks.length)) if (rand(s) < 0.5) give(pick(s, blacks), kit);
}
