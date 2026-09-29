// Builds a fresh game: roles, allegiances, credentials and bank data.

import { DEFAULT_CONFIG, hackerCount, HIDDEN_HOST, HOST_KITS, HOST_SHARED_MODULES, MAX_PLAYERS, MIN_PLAYERS, roleCounts, ROLES, ROLE_ORDER, SYSTEMS } from './catalog';
import { addLog, keyOf, money } from './core';
import { createCredential } from './credentials';
import { spawnNpc } from './bank';
import { assignBankers, spawnRequest } from './requests';
import { pick, rand, randInt, shuffle } from './rng';
import type { GameConfig, GameState, Player, RoleId } from './types';

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

/**
 * The values that scale with the table, from the per-player settings in `base`:
 * - targets: whiteTargetPerPlayer x players, blackTargetPerHacker x Black Hats;
 * - client requests: each Personal Banker gets one about every requestEverySecPerBanker seconds;
 * - automatic payments fill the rest, so that automatic payments plus requested payments add up to about
 *   volumePerPlayer x players over the game. Manual payments count toward the target only when they fulfil
 *   a payment request (see bank.ts), so the requested share is money the team has to earn by acting on requests.
 */
export function scaledConfig(base: GameConfig, n: number, hackers: number): Pick<GameConfig, 'whiteTarget' | 'blackTarget' | 'npcIntervalSec' | 'requestIntervalSec'> {
  const bankers = roleCounts(n).PERSONAL_BANKER;
  const requestIntervalSec = base.requestEverySecPerBanker / bankers;
  const requests = base.durationSec / requestIntervalSec;
  const avgRequested = (base.npcMinAmount + base.maxManualAmount) / 2; // request amounts are uniform in this range
  const requestedVolume = requests * (1 - base.requestChangeShare) * avgRequested;
  const avgNpc = (base.npcMinAmount + base.npcMaxAmount) / 2;
  const npcVolume = Math.max(base.volumePerPlayer * n - requestedVolume, avgNpc); // at least one payment's worth
  return {
    whiteTarget: base.whiteTargetPerPlayer * n,
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
    transactions: [],
    targets: [],
    blacknet: [],
    totals: { processed: 0, stolen: 0 },
    hiddenHost: HIDDEN_HOST,
    counters: { log: 0, alert: 0, cred: 0, tx: 0, msg: 0, req: 0, change: 0, revoke: 0, host: 0, player: 0, crack: 0 },
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
    return { id: `CU${i + 1}`, name, bankerId: null, accounts, primary: accounts[0], originalPrimary: accounts[0], lastModifiedAt: null, history: [] };
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

  addLog(s, { actor: 'SYSTEM', kind: 'BOOT', message: 'Bank network online. Shift started.', sourceIp: null, actualPlayerId: null });
  for (let i = 0; i < 3; i++) spawnNpc(s);
  for (let i = 0; i < 2; i++) spawnRequest(s);
  return s;
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
