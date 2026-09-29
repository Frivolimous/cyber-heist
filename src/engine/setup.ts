// Builds a fresh game: roles, allegiances, credentials, bank data and private info packets.

import { DEFAULT_CONFIG, ENCRYPTION_ENABLED, HIDDEN_HOST, HOST_KITS, HOST_SHARED_MODULES, ROLES, ROLE_ORDER, SYSTEMS } from './catalog';
import { addLog, keyOf, money, nextId } from './core';
import { createCredential } from './credentials';
import { spawnNpc } from './bank';
import { assignBankers, spawnRequest } from './requests';
import { pick, rand, randInt, shuffle } from './rng';
import type { GameConfig, GameState, InfoPacket, Player, SystemId } from './types';

export interface NewGameOptions {
  id?: string;
  seed: number;
  players: { id: string; name: string }[];
  now: number;
  config?: Partial<GameConfig>;
}

/** Everyone the bank deals with, companies and people alike: all customers (CU1..CU14). */
const CUSTOMER_NAMES = [
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
];
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
  const config: GameConfig = { ...DEFAULT_CONFIG, ...o.config };
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
    totals: { processedNpc: 0, stolen: 0 },
    hiddenHost: HIDDEN_HOST,
    counters: { log: 0, alert: 0, cred: 0, tx: 0, msg: 0, packet: 0, req: 0, change: 0, revoke: 0, host: 0, player: 0, crack: 0 },
  };

  for (const sys of SYSTEMS) for (const m of sys.modules) s.modules[keyOf(sys.id, m.id)] = { status: 'ONLINE', open: false, encryption: [] };

  const n = o.players.length;
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

  // Roles: round-robin over a shuffled order so roles overlap evenly.
  const roleOrder = shuffle(s, s.playerOrder);
  const roleOf = new Map<string, (typeof ROLE_ORDER)[number]>();
  roleOrder.forEach((id, i) => roleOf.set(id, ROLE_ORDER[i % ROLE_ORDER.length]));

  // Allegiances.
  const blackCount = Math.min(n - 1, Math.max(1, config.blackHatCount ?? Math.round(n * 0.3)));
  const blackIds = new Set(shuffle(s, s.playerOrder).slice(0, blackCount));

  // Bank data.
  // Each customer starts with 1-3 accounts; the first is primary.
  s.customers = CUSTOMER_NAMES.map((name, i) => {
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
      packets: [],
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
  dealPackets(s);

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
 * Deals the hidden host's tool kits: every operative gets one, then each kit left over has an even chance
 * of going to a random operative as a second. With more kits than operatives, some go unused.
 */
function dealKits(s: GameState): void {
  const blacks = s.playerOrder.filter((id) => s.players[id].allegiance === 'BLACK');
  if (!blacks.length) return;
  const kits = shuffle(s, HOST_KITS);
  const give = (owner: string, module: string): void => {
    const cred = createCredential(s, { owner, system: 'BLACKHAT_DB', module, permission: 'WRITE', issuedBy: null });
    s.players[owner].heldCredentialIds.push(cred.id);
  };
  kits.slice(0, blacks.length).forEach((kit, i) => give(blacks[i % blacks.length], kit));
  for (const kit of kits.slice(blacks.length)) if (rand(s) < 0.5) give(pick(s, blacks), kit);
}

function dealPackets(s: GameState): void {
  const c = s.config;
  const blacks = s.playerOrder.map((id) => s.players[id]).filter((p) => p.allegiance === 'BLACK');
  const custs = shuffle(s, s.customers);
  const mules = s.targets.map((t) => t.account);
  const dbCred = Object.values(s.credentials).find((cr) => cr.system === 'BLACKHAT_DB' && cr.module === 'BLACKNET' && cr.owner === blacks[0].id);
  const code = dbCred?.code ?? '0000';
  const spy = blacks.length ? pick(s, blacks) : null;

  const pools: Record<SystemId, string[]> = {
    SECURITY: [
      `A firewall route table lists an unregistered host at ${s.hiddenHost}. Nobody on staff owns it.`,
      `Traffic keeps reaching ${s.hiddenHost}, a host that Employee Records cannot explain.`,
      `Traces only work on log entries younger than ${c.traceMaxAgeSec}s, and each trace has a ${c.traceCooldownSec}s cooldown.`,
      `${c.lockoutAfterFails} failed attempts in a row lock a workstation for ${c.lockoutSec}s.`,
      ...(ENCRYPTION_ENABLED ? ['Bypassing encryption in the Firewall raises an alert in the Master Log.'] : []),
      'The Master Log stops recording while it is offline. Log ids keep counting, so gaps show.',
      'Employee Records list the registered workstation IP of every employee.',
      'IT Specialists can issue credentials in anyone\'s name. New credentials show up in the Permissions module.',
    ],
    CLIENT_DATA: [
      `${custs[0].id} (${custs[0].name}) opened with primary account ${custs[0].originalPrimary}.`,
      `${custs[1].id} (${custs[1].name}) opened with primary account ${custs[1].originalPrimary}.`,
      'Every account change (added, removed, or a new primary) waits in the Verification queue until someone verifies it.',
      'Client Requests can only be read by the customer\'s personal banker, or with a credential for all of Client Data.',
      'Investigate Changes lists every account change together with the credential owner behind it.',
      'By default only Personal Bankers can change customers\' accounts and verify them.',
    ],
    TRANSACTIONS: [
      `Account ${mules[0]} is not registered to any customer or employee.`,
      `Account ${mules[1]} is not registered to any customer or employee.`,
      'A payment is paid into whichever account is the beneficiary\'s primary at the moment it settles, not when it was queued.',
      'Risk is scored by hand. Approvers see the score, the reason and whose credential gave it.',
      `A settled payment can be reversed for ${c.reversalWindowSec}s.`,
      'Approval needs a completed risk check first.',
    ],
    BLACKHAT_DB: [
      `An operative's access code for the unregistered host has digit 1 = ${code[0]}.`,
      `An operative's access code for the unregistered host has digit 2 = ${code[1]}.`,
      `An operative's access code for the unregistered host has digit 3 = ${code[2]}.`,
      `An operative's access code for the unregistered host has digit 4 = ${code[3]}.`,
      `There are ${blacks.length} operatives on the staff.`,
      spy ? `One operative's workstation IP is ${spy.ip}.` : 'The unregistered host has never been accessed.',
      'Operatives coordinate on a message board and post under aliases.',
    ],
  };

  for (const system of Object.keys(pools) as SystemId[]) {
    const pool = pools[system];
    const dealt = shuffle(s, s.playerOrder.map((_, i) => pool[i % pool.length]));
    s.playerOrder.forEach((pid, i) => {
      const packet: InfoPacket = { id: nextId(s, 'packet', 'P'), system, text: dealt[i] };
      s.players[pid].packets.push(packet);
    });
  }
}
