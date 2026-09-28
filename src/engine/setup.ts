// Builds a fresh game: roles, allegiances, credentials, bank data and private info packets.

import { DEFAULT_CONFIG, HIDDEN_HOST, ROLES, ROLE_ORDER, SYSTEMS } from './catalog';
import { addLog, keyOf, money, nextId } from './core';
import { createCredential } from './credentials';
import { spawnNpc } from './bank';
import { pick, randInt, shuffle } from './rng';
import type { Beneficiary, GameConfig, GameState, InfoPacket, Player, SystemId } from './types';

export interface NewGameOptions {
  id?: string;
  seed: number;
  players: { id: string; name: string }[];
  now: number;
  config?: Partial<GameConfig>;
}

const CUSTOMER_NAMES = ['Alder & Finch LLC', 'Marisol Ortega', 'Tanaka Holdings', 'Pryce Dental Group', 'Nadia Volkov', 'Brightwater Logistics'];
const BENEFICIARY_NAMES = [
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
    beneficiaries: {},
    transactions: [],
    targets: [],
    blacknet: [],
    totals: { processedNpc: 0, stolen: 0 },
    hiddenHost: HIDDEN_HOST,
    counters: { log: 0, alert: 0, cred: 0, tx: 0, msg: 0, packet: 0 },
  };

  for (const sys of SYSTEMS) for (const m of sys.modules) s.modules[keyOf(sys.id, m.id)] = { status: 'ONLINE', encryption: [] };

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
  s.customers = CUSTOMER_NAMES.map((name, i) => ({ id: `CU${i + 1}`, name, account: newAccount() }));
  BENEFICIARY_NAMES.forEach((name, i) => {
    const account = newAccount();
    const b: Beneficiary = { id: `B${i + 1}`, name, account, originalAccount: account, verified: true, lastModifiedAt: null, history: [] };
    s.beneficiaries[b.id] = b;
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
      const cred = createCredential(s, { owner: id, system: 'BLACKHAT_DB', module: null, permission: 'WRITE', issuedBy: null });
      p.heldCredentialIds.push(cred.id);
      p.knownSystems.push('BLACKHAT_DB');
    }
  }

  dealPackets(s);

  addLog(s, { actor: 'SYSTEM', kind: 'BOOT', message: 'Bank network online. Shift started.', sourceIp: null, actualPlayerId: null });
  for (let i = 0; i < 3; i++) spawnNpc(s);
  return s;
}

function dealPackets(s: GameState): void {
  const c = s.config;
  const blacks = s.playerOrder.map((id) => s.players[id]).filter((p) => p.allegiance === 'BLACK');
  const bens = shuffle(s, Object.values(s.beneficiaries));
  const mules = s.targets.map((t) => t.account);
  const dbCred = Object.values(s.credentials).find((cr) => cr.system === 'BLACKHAT_DB' && cr.owner === blacks[0].id);
  const code = dbCred?.code ?? '0000';
  const spy = blacks.length ? pick(s, blacks) : null;

  const pools: Record<SystemId, string[]> = {
    SECURITY: [
      `A firewall route table lists an unregistered host at ${s.hiddenHost}. Nobody on staff owns it.`,
      `Traffic keeps reaching ${s.hiddenHost}, a host that Employee Records cannot explain.`,
      `Traces only work on log entries younger than ${c.traceMaxAgeSec}s, and each trace has a ${c.traceCooldownSec}s cooldown.`,
      `${c.lockoutAfterFails} failed attempts in a row lock a workstation for ${c.lockoutSec}s.`,
      'Bypassing encryption in the Firewall raises an alert in Intrusion Detection.',
      'The Master Log stops recording while it is offline. Log ids keep counting, so gaps show.',
      'Employee Records list the registered workstation IP of every employee.',
    ],
    CLIENT_DATA: [
      `Beneficiary ${bens[0].id} (${bens[0].name}) was set up with account ${bens[0].originalAccount}.`,
      `Beneficiary ${bens[1].id} (${bens[1].name}) was set up with account ${bens[1].originalAccount}.`,
      `Changing a beneficiary's account un-verifies it. Verifying clears that flag, but risk checks still flag records edited in the last ${Math.round(c.recentModifySec / 60)} minutes.`,
      'IT Specialists can issue credentials in anyone\'s name. New credentials show up in the Permissions module.',
      'Investigate Changes lists every account change together with the credential owner behind it.',
      'By default only Personal Bankers can edit and verify beneficiaries.',
    ],
    TRANSACTIONS: [
      `Account ${mules[0]} is not registered to any customer, employee or beneficiary.`,
      `Account ${mules[1]} is not registered to any customer, employee or beneficiary.`,
      'A payment is settled to whichever account its beneficiary has at that moment, not when it was queued.',
      `Payments above ${money(c.largeAmount)} are flagged by the risk check.`,
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
