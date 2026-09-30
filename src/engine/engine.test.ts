import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountVerified, applyAction, CHANNELS, createGame, CREDENTIAL_SHARING_ENABLED, DAY_PHASES, dayPhaseAt, nextArrival, paceMultiplier, ENCRYPTION_ENABLED, getPlayerView, grantMasterAccess, thiefCountFor, HOST_KITS, HOST_SHARED_MODULES, MAX_PLAYERS, MIN_PLAYERS, roleCounts, SYSTEMS, tick } from './index';
import type { Action, ActionResult, GameConfig, GameState, Player, RoleId, SystemId } from './index';
import { NPC_AMOUNT_FACTOR, REQUEST_AMOUNT_FACTOR } from './setup';

const NAMES = ['Jeremy', 'Sarah', 'Mike', 'David', 'Lisa', 'Anna', 'Omar', 'Priya', 'Chen', 'Rosa'];
const PLAYERS = NAMES.map((name, i) => ({ id: `p${i}`, name }));
const T0 = 1_000_000;
/** Tests drive every payment stage by hand unless they switch the automation on. */
const MANUAL: GameConfig['automation'] = { scoreMax: 0, scoreSource: 'AUTOMATIC', scoreOrigin: 'CUSTOMER', scorePayee: 'VERIFIED', approveUpTo: 'NONE', settleMax: 0 };
const EVERYTHING: GameConfig['automation'] = { scoreMax: 1e12, scoreSource: 'ALL', scoreOrigin: 'ANY', scorePayee: 'ANY', approveUpTo: 'HIGH', settleMax: 1e12 };

class Sim {
  s: GameState;
  sec = 0;
  constructor(config: Partial<GameConfig> = {}, seed = 42) {
    this.s = createGame({ seed, players: PLAYERS, now: T0, config: { automation: MANUAL, ...config } });
  }
  at(sec: number): this {
    this.sec = sec;
    this.s = tick(this.s, T0 + sec * 1000);
    return this;
  }
  do(action: Action): ActionResult {
    const r = applyAction(this.s, action, T0 + this.sec * 1000);
    this.s = r.state;
    return r.result;
  }
  run(
    pid: string,
    code: string,
    system: SystemId,
    module: string,
    fn: string,
    params: Record<string, string> = {},
    encCodes?: string[],
  ): ActionResult {
    // Tests that are not about judgement get a default score / reason; tests about them pass their own.
    if (fn === 'RUN_RISK_CHECK') params = { score: 'LOW', reason: 'test', ...params };
    if (fn === 'HOLD' || fn === 'REJECT') params = { reason: 'test', ...params };
    return this.do({ type: 'EXECUTE', playerId: pid, code, system, module, fn, params, encCodes });
  }
  code(pid: string, system: SystemId, module: string | null): string {
    const c = Object.values(this.s.credentials).find((x) => x.owner === pid && x.system === system && x.module === module);
    assert.ok(c, `${pid} has no credential for ${system}.${module}`);
    return c.code;
  }
  byRole(role: RoleId): Player[] {
    return Object.values(this.s.players).filter((p) => p.role === role);
  }
  /** The personal banker assigned to a customer. */
  bankerOf(customerId: string): Player {
    return this.s.players[this.s.customers.find((c) => c.id === customerId)!.bankerId!];
  }
  /** Opens floating accounts (by their 5 digits) so tests can add them to customers or pay from them. */
  open(balance: number, ...digits: string[]): void {
    for (const d of digits) this.s.balances[`ACC-${d}`] = balance;
  }
  lastLog(): string {
    return this.s.logs[this.s.logs.length - 1].message;
  }
}

/** Infiltration shortcuts for a player with whole-host access (grantMasterAccess). */
function hostRun(sim: Sim, pid: string, fn: string, params: Record<string, string>): ActionResult {
  return sim.run(pid, sim.code(pid, 'HIDDEN_HOST', null), 'HIDDEN_HOST', 'INFILTRATION', fn, params);
}
function plantAt(sim: Sim, pid: string, name: string, ip: string): ActionResult {
  const proxy = hostRun(sim, pid, 'CREATE_PROXY', { ip });
  assert.ok(proxy.ok, proxy.message);
  return hostRun(sim, pid, 'CREATE_USER', { name, role: 'PERSONAL_BANKER', proxy: ip });
}

test('setup deals roles, allegiances, unique codes and a job description for everyone', () => {
  const { s } = new Sim();
  const ps = Object.values(s.players);
  assert.equal(ps.filter((p) => p.allegiance === 'BLACK').length, 3);
  // 10 players: 1 Bank Manager, 2 IT, 4 Personal Bankers, 3 Accounts & Receivables.
  const counts: Record<RoleId, number> = { BANK_MANAGER: 1, IT_SPECIALIST: 2, PERSONAL_BANKER: 4, ACCOUNTS_RECEIVABLES: 3 };
  for (const [role, n] of Object.entries(counts)) assert.equal(ps.filter((p) => p.role === role).length, n, role);
  const codes = Object.values(s.credentials).map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const p of ps) {
    const job = getPlayerView(s, p.id).me.job;
    assert.ok(job.summary && job.duties.length && job.tools.length && job.rules.length, p.role);
    assert.equal(!!job.operative, p.allegiance === 'BLACK', 'only operatives get the handbook');
    assert.equal(p.knownSystems.includes('HIDDEN_HOST'), p.allegiance === 'BLACK');
    const hasDb = Object.values(s.credentials).some((c) => c.owner === p.id && c.system === 'HIDDEN_HOST');
    assert.equal(hasDb, p.allegiance === 'BLACK');
  }
});

test('any table of 6 to 30: roles and thieves follow the formulas, and every operative gets a kit', () => {
  const table = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  assert.throws(() => createGame({ seed: 1, players: table(MIN_PLAYERS - 1), now: T0 }), /at least 6 players/);
  assert.throws(() => createGame({ seed: 1, players: table(MAX_PLAYERS + 1), now: T0 }), /at most 30 players/);
  // Spot checks against the formulas, as [n, Bank Manager, IT, Personal Banker, A&R, thieves].
  const expected = [
    [6, 1, 1, 2, 2, 2],
    [7, 1, 2, 2, 2, 2], // the fixed exception
    [9, 1, 2, 4, 2, 3],
    [13, 1, 2, 6, 4, 4],
    [8, 1, 2, 3, 2, 2],
    [10, 1, 2, 4, 3, 3],
    [14, 1, 3, 6, 4, 4],
    [20, 1, 4, 9, 6, 6],
  ];
  for (const [n, bm, it, pb, ar, thieves] of expected) {
    assert.deepEqual(roleCounts(n), { BANK_MANAGER: bm, IT_SPECIALIST: it, PERSONAL_BANKER: pb, ACCOUNTS_RECEIVABLES: ar }, `n=${n}`);
    assert.equal(thiefCountFor(n), thieves, `n=${n}`);
  }
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    const s = createGame({ seed: n, players: table(n), now: T0 });
    const ps = Object.values(s.players);
    const want = roleCounts(n);
    for (const role of Object.keys(want) as RoleId[]) assert.equal(ps.filter((p) => p.role === role).length, want[role], `n=${n} ${role}`);
    assert.ok(Object.values(want).every((k) => k >= 1), `n=${n}: every role is present`);
    const blacks = ps.filter((p) => p.allegiance === 'BLACK');
    assert.equal(blacks.length, thiefCountFor(n), `n=${n} thieves`);
    for (const b of blacks) {
      const kits = Object.values(s.credentials).filter((c) => c.owner === b.id && HOST_KITS.includes(c.module ?? ''));
      assert.ok(kits.length >= 1, `n=${n}: ${b.name} has a kit`);
    }
  }
});

test('allegiances: every role but the Bank Manager has at least one regular employee, at every table size', () => {
  let managerWasBlack = false;
  for (let n = MIN_PLAYERS + 1; n <= MAX_PLAYERS; n++) {
    for (let seed = 1; seed <= 40; seed++) {
      const s = createGame({ seed, players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), now: T0 });
      const players = Object.values(s.players);
      assert.equal(players.filter((p) => p.allegiance === 'BLACK').length, thiefCountFor(n), `n=${n} seed=${seed}`);
      for (const role of ['IT_SPECIALIST', 'PERSONAL_BANKER', 'ACCOUNTS_RECEIVABLES'] as RoleId[]) {
        assert.ok(players.some((p) => p.role === role && p.allegiance === 'WHITE'), `n=${n} seed=${seed}: no regular employee ${role}`);
      }
      managerWasBlack ||= players.some((p) => p.role === 'BANK_MANAGER' && p.allegiance === 'BLACK');
    }
  }
  assert.ok(managerWasBlack, 'the Bank Manager can still be a Thief');
});

test('6 players: the Bank Manager shares the Firewall, and the lone IT or the Manager (never both) can be a Thief', () => {
  let itWasBlack = false;
  let managerWasBlack = false;
  for (let seed = 1; seed <= 80; seed++) {
    const s = createGame({ seed, players: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), now: T0 });
    const players = Object.values(s.players);
    const black = (role: RoleId) => players.some((p) => p.role === role && p.allegiance === 'BLACK');
    assert.ok(!(black('IT_SPECIALIST') && black('BANK_MANAGER')), `seed=${seed}: IT and Manager both Thieves`);
    for (const role of ['PERSONAL_BANKER', 'ACCOUNTS_RECEIVABLES'] as RoleId[]) {
      assert.ok(players.some((p) => p.role === role && p.allegiance === 'WHITE'), `seed=${seed}: no regular employee ${role}`);
    }
    itWasBlack ||= black('IT_SPECIALIST');
    managerWasBlack ||= black('BANK_MANAGER');
  }
  assert.ok(itWasBlack && managerWasBlack, 'either one can be the Thief');
  const firewall = (n: number) => {
    const s = createGame({ seed: 1, players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), now: T0 });
    const bm = Object.values(s.players).find((p) => p.role === 'BANK_MANAGER')!;
    return Object.values(s.credentials).find((c) => c.owner === bm.id && c.module === 'FIREWALL')!.permission;
  };
  assert.equal(firewall(6), 'WRITE');
  assert.equal(firewall(7), 'READ');
});

test('the economy scales with the table: targets, customers, requests and automatic traffic', () => {
  const table = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  for (const n of [MIN_PLAYERS, 10, 20, MAX_PLAYERS]) {
    const s = createGame({ seed: n, players: table(n), now: T0 });
    const c = s.config;
    const bankers = roleCounts(n).PERSONAL_BANKER;
    assert.equal(c.durationSec, 20 * 60);
    assert.equal(c.whiteTarget, 15_000_000 * n, `n=${n} bank target`);
    assert.equal(c.blackTarget, 1_000_000 * thiefCountFor(n), `n=${n} thief target`);
    assert.equal(s.customers.length, 3 * bankers, `n=${n} customers`);
    assert.ok(new Set(s.customers.map((x) => x.name)).size === s.customers.length, 'no duplicate customers');
    // Each banker gets a request about every 90 seconds.
    assert.ok(Math.abs((c.requestIntervalSec * bankers) - 90) < 1e-9, `n=${n} request rate`);
    // Expected offered volume (automatic + requested, at the measured average amounts) is at most $17.4m per
    // player, and automatic traffic is capped at 80% of the bank target so it can never win on its own.
    const requested = (c.durationSec / c.requestIntervalSec) * (1 - c.requestChangeShare) * ((REQUEST_AMOUNT_FACTOR * c.requestAmountFactor * (c.requestMinAmount + c.requestMaxAmount)) / 2);
    const automatic = (c.durationSec / c.npcIntervalSec) * ((NPC_AMOUNT_FACTOR * (c.npcMinAmount + c.npcMaxAmount)) / 2);
    assert.ok(Math.abs(automatic - Math.min(17_400_000 * n - requested, 0.8 * c.whiteTarget)) < 1, `n=${n} automatic volume ${automatic}`);
  }
  // Customers are drawn at random: different seeds, different line-ups.
  const names = (seed: number) => createGame({ seed, players: table(10), now: T0 }).customers.map((x) => x.name).join();
  assert.notEqual(names(1), names(2));
  // Explicit config still wins over the scaled defaults.
  assert.equal(createGame({ seed: 1, players: table(10), now: T0, config: { whiteTarget: 5 } }).config.whiteTarget, 5);
});

test('manual payments count toward the bank target only when they fulfil a payment request', () => {
  const sim = new Sim({ requestChangeShare: 0 });
  grantMasterAccess(sim.s, 'p0');
  const code = sim.code('p0', 'TRANSACTIONS', null);
  const go = (module: string, fn: string, params: Record<string, string>) => sim.run('p0', code, 'TRANSACTIONS', module, fn, params);
  const pay = (params: Record<string, string>): number => {
    const before = sim.s.totals.processed;
    assert.ok(go('PAYMENT_QUEUE', 'CREATE_TRANSACTION', params).ok);
    const id = sim.s.transactions.at(-1)!.id;
    go('RISK_CHECK', 'RUN_RISK_CHECK', { txId: id });
    go('AUTHORIZATION', 'APPROVE', { txId: id });
    assert.ok(go('SETTLEMENT', 'SETTLE', { txId: id }).ok);
    return sim.s.totals.processed - before;
  };
  sim.at(1);
  const [r1, r2] = sim.s.requests.filter((r) => r.kind === 'PAYMENT');
  const from = (r: typeof r1) => r.originAccount!;
  // Made up, no request: does not count.
  assert.equal(pay({ originAccount: from(r1), beneficiaryId: r1.payeeId!, amount: '1000000' }), 0);
  // Linked, but not what was asked (wrong amount): does not count.
  assert.equal(pay({ originAccount: from(r1), beneficiaryId: r1.payeeId!, amount: String(r1.amount! + 1000), requestId: r1.id }), 0);
  // Linked and matching payee and amount: counts in full.
  assert.equal(pay({ originAccount: from(r2), beneficiaryId: r2.payeeId!, amount: String(r2.amount), requestId: r2.id }), r2.amount);
});

test('time of day: phases follow time remaining, busy phases are faster, and nothing arrives after close', () => {
  const D = 20 * 60;
  const at = (minutesLeft: number) => dayPhaseAt(D, D - minutesLeft * 60);
  assert.deepEqual([at(18), at(14), at(10), at(8), at(5), at(2), at(0.5)].map((p) => `${p.label}/${p.pace}`), [
    'Morning/SLOW',
    'Morning/MEDIUM',
    'Lunch Rush/BUSY',
    'Afternoon/SLOW',
    'Afternoon/MEDIUM',
    'End of Day/BUSY',
    'Close of Business/CLOSED',
  ]);
  // Busy runs 4x as fast as slow, medium 2x; the game-wide average rate is unchanged.
  const m = (label: string, pace: string) => paceMultiplier(DAY_PHASES.find((p) => p.label === label && p.pace === pace)!);
  assert.ok(Math.abs(m('Lunch Rush', 'BUSY') / m('Morning', 'SLOW') - 4) < 1e-9);
  const avg = DAY_PHASES.reduce((sum, p) => sum + paceMultiplier(p) * (p.to - p.from), 0);
  assert.ok(Math.abs(avg - 1) < 1e-9);
  // Over a whole day, arrivals every 10s on average still number about D / 10 (floor rounding aside).
  let n = 0;
  let last = 0;
  for (let t = nextArrival(D, 0, 10); t < Infinity; t = nextArrival(D, t, 10)) {
    n++;
    last = t;
  }
  assert.ok(Math.abs(n - D / 10) <= 1, `arrivals ${n}`);
  assert.ok(last <= D * 0.95, 'nothing arrives at close of business');
  // In a live game, nothing new arrives in the last minute.
  const sim = new Sim();
  sim.at(D - 60);
  const [tx, req] = [sim.s.transactions.length, sim.s.requests.length];
  sim.at(D - 1);
  assert.deepEqual([sim.s.transactions.length, sim.s.requests.length], [tx, req]);
  assert.equal(getPlayerView(sim.s, 'p0').dayPhase, 'Close of Business');
});

test('same seed gives the same game; different seed does not', () => {
  const a = createGame({ seed: 7, players: PLAYERS, now: T0 });
  const b = createGame({ seed: 7, players: PLAYERS, now: T0 });
  const c = createGame({ seed: 8, players: PLAYERS, now: T0 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});

test('logs name the credential owner, not the person at the keyboard; TRACE reveals the origin', () => {
  const sim = new Sim();
  const [owner] = sim.byRole('BANK_MANAGER');
  const [analyst2] = sim.byRole('IT_SPECIALIST');
  const [thief] = sim.byRole('PERSONAL_BANKER');
  const ownerCode = sim.code(owner.id, 'SECURITY', 'MASTER_LOG');

  sim.at(10);
  const r = sim.run(thief.id, ownerCode, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG');
  assert.ok(r.ok, r.message);
  const entry = sim.s.logs[sim.s.logs.length - 1];
  assert.equal(entry.message, `${owner.name} accessed Master Log`);
  assert.equal(entry.actor, owner.id);
  assert.equal(
    sim.s.players[thief.id].heldCredentialIds.some((id) => sim.s.credentials[id].owner === owner.id),
    CREDENTIAL_SHARING_ENABLED,
    'typing a code keeps the credential only while credential sharing is on',
  );
  assert.ok(sim.s.players[thief.id].activity.some((a) => a.text.includes(`${owner.name}'s credential`)), 'personal log tells the truth');

  sim.at(20);
  const idsCode = sim.code(analyst2.id, 'SECURITY', 'MASTER_LOG');
  const tr = sim.run(analyst2.id, idsCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: entry.id });
  assert.ok(tr.ok, tr.message);
  assert.ok(tr.message.includes(thief.ip), tr.message);
  const again = sim.run(analyst2.id, idsCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: entry.id });
  assert.equal(again.ok, false);
  assert.match(again.message, /cooling down/);
});

test('failed guesses are logged as UNKNOWN, alert Intrusion Detection, and lock the workstation', () => {
  const sim = new Sim();
  const [p] = sim.byRole('PERSONAL_BANKER');
  const used = new Set(Object.values(sim.s.credentials).map((c) => c.code));
  const wrong = ['0000', '1111', '2222', '3333', '4444'].filter((c) => !used.has(c));
  sim.at(5);
  for (let i = 0; i < 3; i++) {
    const r = sim.run(p.id, wrong[i], 'SECURITY', 'MASTER_LOG', 'VIEW_LOG');
    assert.equal(r.message, 'Access denied.');
  }
  assert.equal(sim.s.logs.filter((l) => l.kind === 'AUTH_FAIL').length, 3);
  assert.equal(sim.s.logs.find((l) => l.kind === 'AUTH_FAIL')!.actor, 'UNKNOWN');
  assert.ok(sim.s.alerts.some((a) => a.kind === 'AUTH_FAIL'));
  const locked = sim.run(p.id, sim.code(p.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS');
  assert.equal(locked.ok, false);
  assert.match(locked.message, /locked/);
  sim.at(5 + sim.s.config.lockoutSec + 1);
  const free = sim.run(p.id, sim.code(p.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS');
  assert.ok(free.ok, free.message);
});

test('a valid credential without the right scope is denied and attributed to its owner', () => {
  const sim = new Sim();
  const [pb] = sim.byRole('PERSONAL_BANKER');
  sim.at(3);
  const r = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'TRANSACTIONS', 'SETTLEMENT', 'SETTLE', { txId: '1' });
  assert.equal(r.message, 'Access denied.');
  assert.equal(sim.lastLog(), `${pb.name}'s credential was denied on Settlement`);
});

test('encryption is disabled: the Firewall offers no encryption functions', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  sim.at(10);
  const r = sim.run(admin.id, sim.code(admin.id, 'SECURITY', 'FIREWALL'), 'SECURITY', 'FIREWALL', 'ADD_ENCRYPTION', { target: 'SECURITY.MASTER_LOG', code: '7777' });
  assert.equal(r.ok, false);
});

test('encryption locks a module until every layer code is supplied; bypass strips it and alerts', { skip: !ENCRYPTION_ENABLED && 'encryption disabled' }, () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const [analyst] = sim.byRole('BANK_MANAGER');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const log = sim.code(analyst.id, 'SECURITY', 'MASTER_LOG');
  sim.at(10);
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'ADD_ENCRYPTION', { target: 'SECURITY.MASTER_LOG', code: '7777' }).ok);
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'ADD_ENCRYPTION', { target: 'SECURITY.MASTER_LOG', code: '8888' }).ok);

  const blocked = sim.run(analyst.id, log, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG');
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /2 layers/);
  const partial = sim.run(analyst.id, log, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', {}, ['7777']);
  assert.equal(partial.ok, false);
  const full = sim.run(analyst.id, log, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', {}, ['7777', '8888']);
  assert.ok(full.ok, full.message);

  const wrong = sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REMOVE_ENCRYPTION', { target: 'SECURITY.MASTER_LOG', code: '1234' });
  assert.equal(wrong.ok, false);
  assert.ok(sim.s.logs.some((l) => l.kind === 'DECRYPT_FAIL'));

  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'BYPASS_ENCRYPTION', { target: 'SECURITY.MASTER_LOG' }).ok);
  assert.ok(sim.s.alerts.some((a) => a.kind === 'ENCRYPTION_BYPASS'));
  assert.ok(sim.run(analyst.id, log, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG').ok);

  const self = sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'ADD_ENCRYPTION', { target: 'SECURITY.FIREWALL', code: '5555' });
  assert.equal(self.ok, false);
});

test('taking the Master Log offline leaves a gap in the log ids', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  sim.at(5);
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'SET_MODULE_STATUS', { target: 'SECURITY.MASTER_LOG', status: 'OFFLINE' }).ok);
  assert.equal(sim.lastLog(), `${admin.name} took Master Log offline`);
  const idBefore = sim.s.counters.log;
  const n = sim.s.logs.length;
  assert.ok(sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS').ok);
  assert.equal(sim.s.logs.length, n, 'nothing recorded while offline');
  assert.ok(sim.s.counters.log > idBefore, 'ids still advance');
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'SET_MODULE_STATUS', { target: 'SECURITY.MASTER_LOG', status: 'ONLINE' }).ok);
  assert.equal(sim.lastLog(), `${admin.name} brought Master Log back online`);
});

test('fraud pipeline: making a mule account the payee\'s primary diverts a payment at settlement, and reversal claws it back', () => {
  const sim = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000 });
  const pb = sim.bankerOf(sim.s.transactions[0].beneficiaryId); // only a customer's own banker may change their accounts
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const tx = sim.s.transactions[0];
  const payee = sim.s.customers.find((c) => c.id === tx.beneficiaryId)!;
  const originalPrimary = payee.primary;
  const mule = sim.s.targets[0].account;
  const cr = sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');

  const arCode = (m: string): string => sim.code(ar.id, 'TRANSACTIONS', m);
  sim.at(30);
  assert.ok(sim.run(ar.id, arCode('RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id }).ok);
  assert.equal(sim.s.transactions[0].riskResult, 'LOW');
  const approve = (id: string) => sim.run(pb.id, sim.code(pb.id, 'TRANSACTIONS', 'AUTHORIZATION'), 'TRANSACTIONS', 'AUTHORIZATION', 'APPROVE', { txId: id });
  assert.ok(approve(tx.id).ok);

  // Diverted AFTER approval: settlement still pays whatever the payee's primary account is now.
  sim.at(40);
  const add = sim.run(pb.id, cr, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: payee.id, account: mule.slice(4), makePrimary: 'YES' });
  assert.ok(add.ok, add.message);
  const inv = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'VERIFICATION'), 'CLIENT_DATA', 'VERIFICATION', 'INVESTIGATE_CHANGES', { target: payee.id });
  assert.ok(inv.lines!.some((l) => l.includes(`added ${mule}`)));
  assert.ok(inv.lines!.some((l) => l.includes(`primary ${originalPrimary} -> ${mule}`) && l.includes(`by ${pb.name}`)), inv.lines!.join('\n'));

  const st = sim.run(ar.id, arCode('SETTLEMENT'), 'TRANSACTIONS', 'SETTLEMENT', 'SETTLE', { txId: tx.id });
  assert.ok(st.ok, st.message);
  assert.ok(st.message.includes(mule));
  assert.equal(sim.s.totals.stolen, tx.amount, 'stolen = what sits in the Target Ledger accounts');
  assert.equal(sim.s.balances[mule], tx.amount);
  assert.equal(sim.s.totals.processed, 0);
  assert.equal(sim.s.status, 'RUNNING');

  // A clawback fails while the mule account no longer holds the money...
  sim.at(100);
  const payerBefore = sim.s.balances[tx.originAccount];
  sim.s.balances[mule] = tx.amount - 1;
  const blocked = sim.run(ar.id, arCode('SETTLEMENT'), 'TRANSACTIONS', 'SETTLEMENT', 'REVERSE', { txId: tx.id });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /no longer holds/);
  assert.equal(sim.s.transactions[0].status, 'SETTLED');
  // ...and works once it does: the money goes back to the account it came from.
  sim.s.balances[mule] = tx.amount;
  const rev = sim.run(ar.id, arCode('SETTLEMENT'), 'TRANSACTIONS', 'SETTLEMENT', 'REVERSE', { txId: tx.id });
  assert.ok(rev.ok, rev.message);
  assert.equal(sim.s.balances[tx.originAccount], payerBefore + tx.amount);
  assert.equal(sim.s.totals.stolen, 0);

  // A reversed payment cannot be reversed again; and the window closes.
  const tx2 = sim.s.transactions[1];
  sim.run(ar.id, arCode('RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx2.id });
  approve(tx2.id);
  sim.run(ar.id, arCode('SETTLEMENT'), 'TRANSACTIONS', 'SETTLEMENT', 'SETTLE', { txId: tx2.id });
  sim.at(100 + sim.s.config.reversalWindowSec + 5);
  const late = sim.run(ar.id, arCode('SETTLEMENT'), 'TRANSACTIONS', 'SETTLEMENT', 'REVERSE', { txId: tx2.id });
  assert.equal(late.ok, false);
  assert.match(late.message, /window/);
});

test('the hidden system assessment flags recent primary changes; verifying clears only the unverified flag', () => {
  const sim = new Sim({ npcMinAmount: 1_000_000, npcMaxAmount: 1_000_000 });
  const pb = sim.bankerOf(sim.s.transactions[0].beneficiaryId);
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const tx = sim.s.transactions[0];
  const payee = tx.beneficiaryId;
  sim.at(20);
  sim.open(0, '12345');
  const add = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: payee, account: '12345', makePrimary: 'YES' });
  assert.ok(add.ok, add.message);
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.deepEqual(sim.s.transactions[0].riskFlags, ['UNVERIFIED_PRIMARY', 'RECENTLY_CHANGED_PRIMARY']);
  for (const h of sim.s.customers.find((c) => c.id === payee)!.history) sim.run(ar.id, sim.code(ar.id, 'CLIENT_DATA', 'VERIFICATION'), 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: h.id });
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.deepEqual(sim.s.transactions[0].riskFlags, ['RECENTLY_CHANGED_PRIMARY']);
  sim.at(20 + sim.s.config.recentModifySec + 1);
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.deepEqual(sim.s.transactions[0].riskFlags, []);
});

test('Thieves win as soon as stolen money reaches the target', () => {
  const sim = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000 });
  const pb = sim.bankerOf(sim.s.transactions[0].beneficiaryId);
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const ben = sim.s.transactions[0].beneficiaryId;
  const mule = sim.s.targets[0].account;
  sim.at(10);
  const add = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: ben, account: mule, makePrimary: 'YES' });
  assert.ok(add.ok, add.message);
  const q = sim.code(pb.id, 'TRANSACTIONS', 'PAYMENT_QUEUE');
  // Paid from a customer who can afford it.
  const from = sim.s.customers.find((c) => c.id !== ben && (sim.s.balances[c.primary] ?? 0) >= 3_000_000)!.primary;
  const created = sim.run(pb.id, q, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: from, beneficiaryId: ben, amount: '3000000' });
  assert.ok(created.ok, created.message);
  const id = sim.s.transactions[sim.s.transactions.length - 1].id;
  // Risk and settlement are A&R's; approval is the banker's.
  for (const [who, mod, fn] of [[ar, 'RISK_CHECK', 'RUN_RISK_CHECK'], [pb, 'AUTHORIZATION', 'APPROVE'], [ar, 'SETTLEMENT', 'SETTLE']] as const) {
    const r = sim.run(who.id, sim.code(who.id, 'TRANSACTIONS', mod), 'TRANSACTIONS', mod, fn, { txId: id });
    assert.ok(r.ok, r.message);
  }
  assert.equal(sim.s.status, 'ENDED');
  assert.equal(sim.s.winner, 'BLACK');
  const after = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS');
  assert.equal(after.message, 'The game is over.');
});

test('NPC traffic arrives on a schedule, and the bank wins at close of business once enough is settled', () => {
  const sim = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000 });
  assert.equal(sim.s.transactions.length, 3);
  // Arrivals follow the time of day: count the scheduled ones due by t=120 (a slow morning).
  const c = sim.s.config;
  let due = 0;
  for (let t = nextArrival(c.durationSec, 0, c.npcIntervalSec); t <= 120; t = nextArrival(c.durationSec, t, c.npcIntervalSec)) due++;
  assert.ok(due >= 1);
  sim.at(120);
  assert.equal(sim.s.transactions.length, 3 + due);

  const win = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000, whiteTarget: 8_000_000, automation: EVERYTHING });
  win.at(300);
  assert.ok(win.s.totals.processed >= 8_000_000);
  assert.equal(win.s.status, 'RUNNING', 'meeting the target early does not end the game');
  win.at(win.s.config.durationSec + 1);
  assert.equal(win.s.status, 'ENDED');
  assert.equal(win.s.winner, 'WHITE');
  assert.equal(win.s.endKind, 'WHITE_TARGET');
  assert.match(win.s.endReason!, /clearing its \$8,000,000 target/);
});

test('when time runs out with neither goal met, both sides lose', () => {
  const sim = new Sim({ durationSec: 60 });
  sim.at(59);
  assert.equal(sim.s.status, 'RUNNING');
  sim.at(61);
  assert.equal(sim.s.status, 'ENDED');
  assert.equal(sim.s.winner, null, 'neither side made its goal: both lose');
  assert.equal(sim.s.endKind, 'BANK_SHORT');
  assert.match(sim.s.endReason!, /neither side made its goal/);
  const end = getPlayerView(sim.s, 'p0').end!;
  assert.equal(end.headline, 'Everybody loses');
  assert.ok(end.teams.every((t) => !t.won));
});

test('Blacknet aliases: dealt at random, unique, fixed; a post carries the credential owner\'s alias', () => {
  const table = Array.from({ length: MAX_PLAYERS }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const aliases = (seed: number) => Object.values(createGame({ seed, players: table, now: T0 }).players).map((p) => p.alias);
  assert.equal(new Set(aliases(1)).size, MAX_PLAYERS, 'never repeated, even at a full table');
  assert.notDeepEqual(aliases(1), aliases(2), 'different each game');
  assert.deepEqual(aliases(1), aliases(1), 'the same seed deals the same aliases');

  const sim = new Sim();
  const [a, b] = Object.values(sim.s.players).filter((p) => p.allegiance === 'BLACK');
  sim.at(5);
  assert.ok(sim.run(a.id, sim.code(a.id, 'HIDDEN_HOST', 'BLACKNET'), 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: 'hi', alias: 'ignored' }).ok);
  assert.ok(sim.run(a.id, sim.code(b.id, 'HIDDEN_HOST', 'BLACKNET'), 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: 'framed' }).ok);
  const board = sim.run(b.id, sim.code(b.id, 'HIDDEN_HOST', 'BLACKNET'), 'HIDDEN_HOST', 'BLACKNET', 'READ_MESSAGES').lines!;
  assert.ok(board[0].endsWith(`${a.alias}: hi`), board[0]);
  assert.ok(board[1].endsWith(`${b.alias}: framed`), 'a borrowed code posts as its owner');
  // Only Thieves see an alias on their workstation.
  const white = Object.values(sim.s.players).find((p) => p.allegiance === 'WHITE')!;
  assert.equal(getPlayerView(sim.s, a.id).me.alias, a.alias);
  assert.equal(getPlayerView(sim.s, white.id).me.alias, null);
});

test('hidden host: guarded by credentials, discoverable through alerts, reachable once you know the address', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const [analyst] = sim.byRole('BANK_MANAGER');
  const [it] = sim.byRole('IT_SPECIALIST');
  const white = Object.values(sim.s.players).find((p) => p.allegiance === 'WHITE' && p.id !== analyst.id && p.id !== it.id)!;
  const dbCode = sim.code(black.id, 'HIDDEN_HOST', 'BLACKNET');

  sim.at(30);
  assert.ok(sim.run(black.id, dbCode, 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: 'target B3 is ready' }).ok);
  // Only a cryptic, nameless system entry: hidden from "Player activity", visible under "Everything".
  const entry = sim.s.logs.at(-1)!;
  assert.equal(entry.message, 'Unknown server activity');
  assert.equal(entry.actor, 'SYSTEM');
  const logCode = sim.code(analyst.id, 'SECURITY', 'MASTER_LOG');
  const logView = (show: string) => sim.run(analyst.id, logCode, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show }).lines!.join('\n');
  assert.ok(!logView('PLAYERS').includes('Unknown server activity'));
  assert.ok(logView('ALL').split('\n').some((l) => l.includes(entry.id) && l.endsWith('Unknown server activity')));
  assert.ok(!logView('ALL').includes(black.name), 'nobody is named');

  // Tracing it only gives one true, partial clue.
  const trace = sim.run(analyst.id, logCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: entry.id });
  assert.ok(trace.message.includes('routed through a relay.'), trace.message);
  assert.ok(clueIsTrue(sim, trace.message, entry), trace.message);

  // A regular employee without a code gets nothing.
  const denied = sim.run(white.id, '0000', 'HIDDEN_HOST', 'BLACKNET', 'READ_MESSAGES');
  assert.equal(denied.ok, false);

  // Everyday host use is exposure tier 1: it raises no alert at all.
  const alerts = sim.run(analyst.id, sim.code(analyst.id, 'SECURITY', 'MASTER_LOG'), 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: 'ALERTS' });
  assert.ok(!alerts.lines!.some((l) => l.includes(`(log ${entry.id})`)), alerts.lines!.join('\n'));

  // Knowing the address makes the system appear; a wrong address does not.
  if (!sim.s.players[it.id].knownSystems.includes('HIDDEN_HOST')) {
    assert.equal(getPlayerView(sim.s, it.id).systems.some((x) => x.id === 'HIDDEN_HOST'), false);
    assert.equal(sim.do({ type: 'CONNECT', playerId: it.id, address: '10.66.6.7' }).ok, false);
    assert.ok(sim.do({ type: 'CONNECT', playerId: it.id, address: sim.s.hiddenHost }).ok);
  }
  assert.equal(getPlayerView(sim.s, it.id).systems.some((x) => x.id === 'HIDDEN_HOST'), true);

  // The unregistered host is not the bank's: Permissions can neither issue nor list credentials for it.
  const perms = sim.code(it.id, 'SECURITY', 'PERMISSIONS');
  const mint = sim.run(it.id, perms, 'SECURITY', 'PERMISSIONS', 'CREATE_CREDENTIAL', { owner: it.id, scope: 'HIDDEN_HOST.*', permission: 'READ' });
  assert.equal(mint.message, 'Unknown system.');
  const reg = sim.run(it.id, perms, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', { show: 'ALL' });
  assert.ok(!reg.lines!.some((l) => l.includes('Unregistered host')));
});

test('sharing a credential is private (when switched on); revoking one is visible and blocks its use', () => {
  const sim = new Sim();
  const [analyst] = sim.byRole('BANK_MANAGER');
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const [it] = sim.byRole('IT_SPECIALIST');
  const cred = Object.values(sim.s.credentials).find((c) => c.owner === analyst.id && c.module === 'MASTER_LOG')!;
  sim.at(10);
  const logsBefore = sim.s.logs.length;
  assert.equal(sim.do({ type: 'SHARE_CREDENTIAL', playerId: pb.id, credentialId: cred.id, toPlayerId: analyst.id }).ok, false);
  const shared = sim.do({ type: 'SHARE_CREDENTIAL', playerId: analyst.id, credentialId: cred.id, toPlayerId: pb.id });
  if (CREDENTIAL_SHARING_ENABLED) {
    assert.ok(shared.ok);
    assert.equal(sim.s.logs.length, logsBefore, 'sharing writes nothing to the Master Log');
    assert.ok(sim.s.players[pb.id].activity.some((a) => a.text.includes(cred.code)));
  } else assert.equal(shared.message, 'Credential sharing is switched off.');

  assert.ok(sim.run(it.id, sim.code(it.id, 'SECURITY', 'PERMISSIONS'), 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: cred.id }).ok);
  assert.ok(sim.s.players[analyst.id].activity.some((a) => a.text.includes('was revoked')));
  const blocked = sim.run(pb.id, cred.code, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG');
  assert.equal(blocked.message, 'Access denied.');
  assert.ok(sim.s.logs.some((l) => l.kind === 'AUTH_REVOKED'));
});

test('private messages reach exactly two inboxes', () => {
  const sim = new Sim();
  assert.ok(sim.do({ type: 'SEND_MESSAGE', playerId: 'p0', toPlayerId: 'p1', text: 'meet me at the vault' }).ok);
  assert.equal(sim.s.players.p0.messages.length, 1);
  assert.equal(sim.s.players.p1.messages.length, 1);
  assert.equal(sim.s.players.p2.messages.length, 0);
  assert.equal(sim.do({ type: 'SEND_MESSAGE', playerId: 'p0', toPlayerId: 'p0', text: 'hi me' }).ok, false);
});

test('a player view never contains other players\' secrets', () => {
  const sim = new Sim();
  const v = getPlayerView(sim.s, 'p0');
  assert.deepEqual(Object.keys(v.players[0]).sort(), ['id', 'name', 'roleLabel']);
  const json = JSON.stringify(v);
  const mine = new Set(sim.s.players.p0.heldCredentialIds);
  for (const c of Object.values(sim.s.credentials)) {
    if (!mine.has(c.id)) assert.ok(!json.includes(`"code":"${c.code}"`), `leaked ${c.id}`);
  }
  const me = sim.s.players.p0;
  for (const p of Object.values(sim.s.players)) {
    if (p.allegiance !== me.allegiance) assert.ok(!json.includes(p.objective), 'the other side\'s objective leaked');
  }
});

test('master access reaches every system', () => {
  const sim = new Sim();
  grantMasterAccess(sim.s, 'p0');
  assert.equal(getPlayerView(sim.s, 'p0').systems.length, SYSTEMS.length);
  for (const sys of SYSTEMS) {
    const code = sim.code('p0', sys.id, null);
    const read = sys.modules.flatMap((m) => m.fns.map((f) => ({ m, f }))).find((x) => x.f.permission === 'READ');
    if (read) assert.ok(sim.run('p0', code, sys.id, read.m.id, read.f.id).ok, sys.id);
  }
});

test("another player's workstation unlocks only with their workstation code, and leaves a trace", () => {
  const sim = new Sim();
  const [visitor, target] = [sim.s.players.p1, sim.s.players.p2];
  sim.at(5);
  const found = sim.do({ type: 'CONNECT', playerId: visitor.id, address: target.ip });
  assert.ok(found.ok);
  assert.equal(found.workstation, target.id);

  // A valid code that belongs to someone else does not open the workstation.
  const wrong = sim.do({ type: 'ACCESS_WORKSTATION', playerId: visitor.id, targetId: target.id, code: sim.code(visitor.id, ...firstCred(sim, visitor.id)) });
  assert.equal(wrong.message, 'Access denied.');
  assert.equal(sim.s.logs.at(-1)!.kind, 'WORKSTATION_DENIED');
  assert.deepEqual(getPlayerView(sim.s, visitor.id).remote, {});

  // Nor does one of the target's bank codes: only their workstation login.
  const bank = sim.do({ type: 'ACCESS_WORKSTATION', playerId: visitor.id, targetId: target.id, code: sim.code(target.id, ...firstCred(sim, target.id)) });
  assert.equal(bank.message, 'Access denied.');

  const targetCode = sim.code(target.id, 'WORKSTATION', null);
  assert.ok(sim.do({ type: 'ACCESS_WORKSTATION', playerId: visitor.id, targetId: target.id, code: targetCode }).ok);
  assert.equal(sim.lastLog(), `${target.name} logged in to their workstation (${target.ip})`);
  assert.ok(sim.s.players[target.id].activity.at(-1)!.text.includes(visitor.ip), 'owner sees where it came from');
  const remote = getPlayerView(sim.s, visitor.id).remote[target.id];
  assert.equal(remote.name, target.name);
  assert.ok(remote.credentials.some((c) => c.code === targetCode));
  // A visitor never sees the owner's side, objective or motivation; the owner still does.
  assert.deepEqual([remote.allegiance, remote.objective, remote.motivation], [null, null, null]);
  // Nor, on a Thief's workstation, anything of the hidden host's.
  const thief = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK' && p.id !== visitor.id)!;
  assert.ok(sim.do({ type: 'ACCESS_WORKSTATION', playerId: visitor.id, targetId: thief.id, code: sim.code(thief.id, 'WORKSTATION', null) }).ok);
  const seen = getPlayerView(sim.s, visitor.id).remote[thief.id];
  assert.equal(seen.alias, null);
  assert.equal(seen.job.operative, undefined);
  assert.ok(!seen.credentials.some((c) => c.system === 'HIDDEN_HOST') && !seen.knownSystems.includes('HIDDEN_HOST'));
  assert.ok(getPlayerView(sim.s, thief.id).me.job.operative, 'the thief still has their handbook');
  assert.equal(getPlayerView(sim.s, target.id).me.objective, sim.s.players[target.id].objective);

  // The workstation's own login is never listed in Permissions and cannot be revoked.
  const admin = whiteIt(sim);
  const perm = sim.code(admin.id, 'SECURITY', 'PERMISSIONS');
  const credId = Object.values(sim.s.credentials).find((c) => c.code === targetCode)!.id;
  assert.match(credId, /^W\d+$/);
  const listed = sim.run(admin.id, perm, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', { show: 'ALL' }).lines!;
  assert.ok(!listed.some((l) => l.startsWith(credId + ' ')));
  assert.match(sim.run(admin.id, perm, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: credId.toLowerCase() }).message, /cannot be revoked/);
  assert.ok(getPlayerView(sim.s, visitor.id).remote[target.id], 'still logged in');
});

test('Access / Unlock workstation: a hidden new login after 30s, stopped by a block on either end, revocable by id', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const [t1, t2] = Object.values(sim.s.players).filter((p) => p.allegiance === 'WHITE');
  const admin = whiteIt(sim);
  grantMasterAccess(sim.s, black.id);
  const host = sim.code(black.id, 'HIDDEN_HOST', null);
  const unlock = (ip: string) => sim.run(black.id, host, 'HIDDEN_HOST', 'ACCESS', 'UNLOCK_WORKSTATION', { target: ip });
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const perm = sim.code(admin.id, 'SECURITY', 'PERMISSIONS');
  const sec = sim.s.config.unlockSec;

  sim.at(3);
  assert.match(unlock('nope').message, /No workstation/);
  assert.match(unlock(black.ip).message, /your own workstation/);
  assert.ok(unlock(t1.ip).ok);
  assert.equal(sim.s.alerts.at(-1)!.kind, 'WORKSTATION_UNLOCK');
  assert.match(sim.s.alerts.at(-1)!.message, new RegExp(t1.ip.replace(/\./g, '\\.')));
  assert.equal(sim.s.logs.find((l) => l.id === sim.s.alerts.at(-1)!.logId)!.exposure, 3);

  // Blocking the target stops it; so does blocking the operative.
  sim.at(10);
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'BLOCK_ADDRESS', { address: t1.ip }).ok);
  sim.at(11);
  assert.ok(sim.s.unlocks[0].done);
  assert.match(sim.s.players[black.id].activity.at(-1)!.text, /stopped/);
  assert.ok(unlock(t2.ip).ok);
  sim.at(12);
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'BLOCK_ADDRESS', { address: black.ip }).ok);
  sim.at(3 + sec + 5);
  assert.ok(sim.s.unlocks.every((u) => u.done));
  assert.equal(Object.values(sim.s.credentials).filter((c) => c.system === 'WORKSTATION' && !c.fixed).length, 0);

  // Left alone, it makes a new workstation credential for the target that only the operative holds.
  sim.at(sim.sec + sim.s.config.blockSec + 1);
  assert.ok(unlock(t2.ip).ok);
  const before = sim.s.counters.cred;
  sim.at(sim.sec + sec + 1);
  const cred = Object.values(sim.s.credentials).find((c) => c.system === 'WORKSTATION' && !c.fixed)!;
  assert.equal(cred.owner, t2.id);
  assert.equal(cred.id, `C${before + 1}`);
  assert.ok(sim.s.players[black.id].heldCredentialIds.includes(cred.id));
  assert.ok(!sim.s.players[t2.id].heldCredentialIds.includes(cred.id), 'the target is not told');
  assert.match(sim.s.players[black.id].activity.at(-1)!.text, new RegExp(`code ${cred.code}`));
  assert.ok(sim.do({ type: 'ACCESS_WORKSTATION', playerId: black.id, targetId: t2.id, code: cred.code }).ok);

  // Permissions never lists it (a gap in the ids), but it can be revoked by id, which ends the session.
  const listed = sim.run(admin.id, perm, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', { show: 'ALL' }).lines!;
  assert.ok(!listed.some((l) => l.startsWith(cred.id + ' ')));
  assert.ok(sim.run(admin.id, perm, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: cred.id }).ok);
  assert.deepEqual(getPlayerView(sim.s, black.id).remote, {});
});

function firstCred(sim: Sim, pid: string): [SystemId, string | null] {
  const c = Object.values(sim.s.credentials).find((x) => x.owner === pid)!;
  return [c.system, c.module];
}

test('stage views: pending shows what is waiting, all adds what the stage already handled', () => {
  const sim = new Sim();
  grantMasterAccess(sim.s, 'p0');
  const code = sim.code('p0', 'TRANSACTIONS', null);
  const view = (module: string, fn: string, show: string): string[] => {
    const r = sim.run('p0', code, 'TRANSACTIONS', module, fn, { show });
    assert.ok(r.ok, r.message);
    return (r.lines ?? []).filter((l) => l.startsWith('TX-0001'));
  };
  const has = (module: string, fn: string, show: string): boolean => view(module, fn, show).length > 0;
  sim.at(1);

  assert.ok(has('RISK_CHECK', 'VIEW_RISK_QUEUE', 'PENDING'));
  sim.run('p0', code, 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: '1' });
  assert.ok(!has('RISK_CHECK', 'VIEW_RISK_QUEUE', 'PENDING'));
  assert.ok(has('RISK_CHECK', 'VIEW_RISK_QUEUE', 'ALL'));
  assert.ok(has('AUTHORIZATION', 'VIEW_AUTH_QUEUE', 'PENDING'));

  sim.run('p0', code, 'TRANSACTIONS', 'AUTHORIZATION', 'APPROVE', { txId: '1' });
  assert.ok(!has('RISK_CHECK', 'VIEW_RISK_QUEUE', 'ALL'), 'approved payments leave the risk view');
  assert.ok(!has('AUTHORIZATION', 'VIEW_AUTH_QUEUE', 'PENDING'));
  assert.ok(has('AUTHORIZATION', 'VIEW_AUTH_QUEUE', 'ALL'));
  assert.ok(has('SETTLEMENT', 'VIEW_SETTLEMENT', 'PENDING'));

  sim.run('p0', code, 'TRANSACTIONS', 'SETTLEMENT', 'SETTLE', { txId: '1' });
  assert.ok(!has('AUTHORIZATION', 'VIEW_AUTH_QUEUE', 'ALL'), 'settled payments leave the authorization view');
  assert.ok(!has('SETTLEMENT', 'VIEW_SETTLEMENT', 'PENDING'));
  assert.ok(has('SETTLEMENT', 'VIEW_SETTLEMENT', 'ALL'));

  // Stage views show codes and accounts, never customer names.
  const b = sim.s.customers.find((c) => c.id === sim.s.transactions[0].beneficiaryId)!;
  assert.ok(!view('AUTHORIZATION', 'VIEW_AUTH_QUEUE', 'ALL').concat(view('SETTLEMENT', 'VIEW_SETTLEMENT', 'ALL')).some((l) => l.includes(b.name)));
});

test('manual payments come from a typed customer account, and the queue shows both ends', () => {
  const sim = new Sim();
  grantMasterAccess(sim.s, 'p0');
  const code = sim.code('p0', 'TRANSACTIONS', null);
  const cust = sim.s.customers[3];
  const ben = sim.s.customers[1];
  const from = cust.accounts.at(-1)!; // any of the customer's accounts, not only the primary
  sim.at(1);
  const create = (originAccount: string) =>
    sim.run('p0', code, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount, beneficiaryId: 'CU2', amount: '1000000' });

  assert.equal(create('00000').message, 'There is no account with that number.');
  assert.ok(create(from.replace('ACC-', '')).ok, 'digits alone are accepted');

  const tx = sim.s.transactions.at(-1)!;
  assert.equal(tx.customerId, cust.id);
  assert.equal(tx.originAccount, from);
  const row = sim.run('p0', code, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {}).lines!.find((l) => l.startsWith(tx.id))!;
  assert.ok(row.includes(`${cust.id} ${from} -> CU2 ${ben.primary}`), row);
  assert.ok(!row.includes(cust.name) && !row.includes(ben.name), 'queue rows show codes, not names');

  // A floating account can pay too; its originator shows as UNKNOWN.
  const mule = sim.s.targets[0].account;
  assert.ok(create(mule).ok);
  const floating = sim.s.transactions.at(-1)!;
  assert.equal(floating.customerId, null);
  const frow = sim.run('p0', code, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {}).lines!.find((l) => l.startsWith(floating.id))!;
  assert.ok(frow.includes(`UNKNOWN ${mule} -> CU2`), frow);
});

test('payment history records every step with the credential owner and the real actor', () => {
  const sim = new Sim();
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const [intruder] = sim.byRole('BANK_MANAGER');
  // Each stage's code belongs to the role that works it: approvals are the banker's, the rest A&R's.
  const ownerOf = (m: string): Player => (m === 'AUTHORIZATION' ? pb : ar);
  sim.at(1);
  // The intruder works the whole pipeline with other people's codes.
  const steps = [['RISK_CHECK', 'RUN_RISK_CHECK'], ['AUTHORIZATION', 'HOLD'], ['AUTHORIZATION', 'APPROVE'], ['SETTLEMENT', 'SETTLE'], ['SETTLEMENT', 'REVERSE']];
  for (const [m, fn] of steps) {
    const r = sim.run(intruder.id, sim.code(ownerOf(m).id, 'TRANSACTIONS', m), 'TRANSACTIONS', m, fn, { txId: '1' });
    assert.ok(r.ok, `${fn}: ${r.message}`);
  }
  const tx = sim.s.transactions[0];
  assert.deepEqual(tx.history.map((e) => e.action), ['CREATED', 'RISK_CHECKED', 'HELD', 'APPROVED', 'SETTLED', 'REVERSED']);
  assert.equal(tx.history[0].by, 'SYSTEM');
  tx.history.slice(1).forEach((e, i) => {
    assert.equal(e.by, ownerOf(steps[i][0]).id, 'records name the credential owner');
    assert.equal(e.actualPlayerId, intruder.id, 'truth names who typed it');
  });
  assert.equal(tx.debitedFrom, tx.originAccount);
  assert.match(tx.history[1].detail!, /^risk (LOW|MEDIUM|HIGH)/);
});

test('money is conserved: settlements, failures, a diversion, a reversal and a mule paying out move it, never make or lose it', () => {
  const sim = new Sim({ automation: EVERYTHING, blackTarget: 1e12 }); // the diversion must not end the day early
  grantMasterAccess(sim.s, 'p0');
  const tx = sim.code('p0', 'TRANSACTIONS', null);
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  const total = () => Object.values(sim.s.balances).reduce((a, b) => a + b, 0);
  // The only money that enters: a customer's new account, "opened elsewhere", arrives with its own balance.
  // It floats (on no customer) when it appears, so nothing can have moved it yet: count it on first sight.
  const known = new Set(Object.keys(sim.s.balances));
  let expected = total();
  const tickTo = (t: number) => {
    while (sim.sec < t) {
      sim.at(sim.sec + 1);
      for (const [acc, bal] of Object.entries(sim.s.balances)) {
        if (known.has(acc)) continue;
        known.add(acc);
        expected += bal;
      }
      assert.equal(total(), expected, `t=${sim.sec}: money appeared or vanished`);
    }
  };

  tickTo(120);
  // A diversion: a mule account becomes a customer's primary, and payments to them settle into it.
  const victim = sim.s.customers.find((c) => c.id !== sim.s.customers[0].id)!;
  const mule = sim.s.targets[0].account;
  assert.ok(sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: victim.id, account: mule, makePrimary: 'YES' }).ok);
  const payer = sim.s.customers.find((c) => c.id !== victim.id && sim.s.balances[c.primary] >= 3_000_000)!;
  const pay = (from: string, to: string, amount: number) => {
    assert.ok(sim.run('p0', tx, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: from, beneficiaryId: to, amount: String(amount) }).ok);
    return sim.s.transactions.at(-1)!;
  };
  const diverted = pay(payer.primary, victim.id, 1_000_000);
  const kept = pay(payer.primary, victim.id, 500_000);
  // A payment the account cannot cover fails at settlement and moves nothing.
  const poor = sim.s.customers.find((c) => c.id !== victim.id && sim.s.balances[c.primary] < 5_000_000)!;
  const failing = pay(poor.primary, victim.id, 9_000_000);
  tickTo(125);
  const status = (id: string) => sim.s.transactions.find((t) => t.id === id)!.status;
  assert.equal(status(diverted.id), 'SETTLED');
  assert.equal(status(failing.id), 'FAILED');
  assert.equal(sim.s.balances[mule], 1_500_000);

  // A reversal claws one back; then the mule pays the rest on.
  assert.ok(sim.run('p0', tx, 'TRANSACTIONS', 'SETTLEMENT', 'REVERSE', { txId: kept.id }).ok);
  assert.equal(sim.s.balances[mule], 1_000_000);
  pay(mule, payer.id, 1_000_000);
  tickTo(130);
  assert.equal(sim.s.balances[mule], 0);

  // And the rest of the day, with every stage automated.
  tickTo(sim.s.config.durationSec + 1);
  assert.ok(Object.values(sim.s.balances).every((b) => b >= 0), 'no account ever goes below zero');
  assert.ok(sim.s.transactions.filter((t) => t.status === 'SETTLED').length > 50, 'plenty of money moved');
});

test('automation: each stage handles what its settings cover, signed as SYSTEM; settings are logged and HIGH approval alerts', () => {
  const sim = new Sim();
  assert.deepEqual(createGame({ seed: 1, players: PLAYERS, now: T0 }).automation, { scoreMax: 1_000_000, scoreSource: 'AUTOMATIC', scoreOrigin: 'CUSTOMER', scorePayee: 'VERIFIED', approveUpTo: 'LOW', settleMax: 1_000_000 });
  grantMasterAccess(sim.s, 'p0');
  const master = sim.code('p0', 'TRANSACTIONS', null);
  const go = (module: string, fn: string, params: Record<string, string>) => sim.run('p0', master, 'TRANSACTIONS', module, fn, params);
  const payer = sim.s.customers.find((c) => sim.s.balances[c.primary] >= 10_000_000)!;
  const payee = sim.s.customers.find((c) => c.id !== payer.id)!;
  const pay = (amount: number, from = payer.primary) => {
    assert.ok(go('PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: from, beneficiaryId: payee.id, amount: String(amount) }).ok);
    return sim.s.transactions.at(-1)!.id;
  };
  const tx = (id: string) => sim.s.transactions.find((t) => t.id === id)!;
  sim.at(1);

  // Settings: typed and checked, logged under the credential owner.
  assert.match(go('RISK_CHECK', 'SET_AUTO_SCORE', { maxAmount: 'lots', source: 'AUTOMATIC', origin: 'CUSTOMER', payee: 'VERIFIED' }).message, /max amount/);
  assert.ok(go('RISK_CHECK', 'SET_AUTO_SCORE', { maxAmount: '1,000,000', source: 'AUTOMATIC', origin: 'CUSTOMER', payee: 'VERIFIED' }).ok);
  assert.match(sim.lastLog(), /changed automatic scoring/);
  assert.ok(go('AUTHORIZATION', 'SET_AUTO_APPROVE', { level: 'LOW' }).ok);
  assert.ok(go('SETTLEMENT', 'SET_AUTO_SETTLE', { maxAmount: '1000000' }).ok);
  assert.equal(sim.s.alerts.length, 0);

  // Scoring: a manual payment waits while only automatic payments are scored; then goes all the way.
  const small = pay(900_000);
  sim.at(2);
  assert.equal(tx(small).status, 'QUEUED');
  go('RISK_CHECK', 'SET_AUTO_SCORE', { maxAmount: '1000000', source: 'ALL', origin: 'CUSTOMER', payee: 'VERIFIED' });
  sim.at(3);
  assert.equal(tx(small).status, 'SETTLED');
  assert.deepEqual(tx(small).history.map((e) => `${e.action}:${e.by}`), ['CREATED:p0', 'RISK_CHECKED:SYSTEM', 'APPROVED:SYSTEM', 'SETTLED:SYSTEM']);

  // From a floating account: only scored once floating accounts are allowed.
  sim.open(5_000_000, '77777');
  const floating = pay(500_000, 'ACC-77777');
  sim.at(4);
  assert.equal(tx(floating).status, 'QUEUED');

  // Over the scoring max: a human scores it; approval follows the score; settlement stops above its max.
  const big = pay(2_000_000);
  const risky = pay(2_000_000);
  sim.at(5);
  assert.equal(tx(big).status, 'QUEUED');
  go('RISK_CHECK', 'RUN_RISK_CHECK', { txId: big, score: 'LOW' });
  go('RISK_CHECK', 'RUN_RISK_CHECK', { txId: risky, score: 'MEDIUM' });
  sim.at(6);
  assert.equal(tx(big).status, 'AUTHORIZED', 'approved automatically, too big to settle automatically');
  assert.equal(tx(risky).status, 'RISK_CHECKED');

  // Approving everything up to HIGH raises an alert naming the credential owner.
  assert.ok(go('AUTHORIZATION', 'SET_AUTO_APPROVE', { level: 'HIGH' }).ok);
  assert.match(sim.s.alerts.at(-1)!.message, new RegExp(`${sim.s.players.p0.name} set automatic approval to HIGH`));
  sim.at(7);
  assert.equal(tx(risky).status, 'AUTHORIZED');
  // 0 switches a stage off.
  go('SETTLEMENT', 'SET_AUTO_SETTLE', { maxAmount: '0' });
  const last = pay(100_000);
  sim.at(8);
  assert.equal(tx(last).status, 'AUTHORIZED');
  assert.ok(go('SETTLEMENT', 'VIEW_SETTLEMENT', {}).lines![0].includes('Automatic settlement: off'));
});

test('stage rows: both accounts, who handled it (credential owner or channel), and never the risk flags', () => {
  const sim = new Sim();
  const owner = sim.byRole('PERSONAL_BANKER').find((p) => p.id !== 'p0')!; // bankers create payments
  const intruder = sim.byRole('BANK_MANAGER').find((p) => p.id !== 'p0')!;
  grantMasterAccess(sim.s, 'p0');
  const master = sim.code('p0', 'TRANSACTIONS', null);
  sim.at(1);
  // The intruder creates a payment with the owner's code: records must say the owner made it.
  const cust = sim.s.customers[0];
  const made = sim.run(intruder.id, sim.code(owner.id, 'TRANSACTIONS', 'PAYMENT_QUEUE'), 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', {
    originAccount: cust.primary,
    beneficiaryId: 'CU2',
    amount: '4000000',
  });
  assert.ok(made.ok, made.message);
  const mine = sim.s.transactions.at(-1)!;
  const batch = sim.s.transactions[0];
  assert.ok(CHANNELS.includes(batch.channel!), 'automatic payments get a channel');

  const lines = sim.run('p0', master, 'TRANSACTIONS', 'RISK_CHECK', 'VIEW_RISK_QUEUE', { show: 'PENDING' }).lines!;
  const rowOf = (id: string) => lines.slice(lines.findIndex((l) => l.startsWith(id)), lines.findIndex((l) => l.startsWith(id)) + 2).join('\n');
  assert.ok(rowOf(mine.id).includes(`${cust.primary} -> CU2 ${sim.s.customers[1].primary}`), rowOf(mine.id));
  assert.match(rowOf(mine.id), new RegExp(`created [0-9]{2}:[0-9]{2} by ${owner.name}`));
  assert.ok(!rowOf(mine.id).includes(intruder.name));
  assert.match(rowOf(batch.id), new RegExp(`by ${batch.channel}`));

  // Risk flags (large amount, manual entry) exist on the payment but are never shown.
  const checked = sim.run('p0', master, 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: mine.id });
  assert.ok(mine.riskFlags.length === 0 && sim.s.transactions.at(-1)!.riskFlags.length > 0);
  const auth = sim.run('p0', master, 'TRANSACTIONS', 'AUTHORIZATION', 'VIEW_AUTH_QUEUE', {}).lines!.join('\n');
  const queue = sim.run('p0', master, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {}).lines!.join('\n');
  for (const text of [checked.message, auth, queue]) assert.ok(!/LARGE_AMOUNT|MANUAL_ENTRY/.test(text), text);
  assert.match(auth, /risk (LOW|MEDIUM|HIGH) by Jeremy/);
});

test('risk is scored by hand, the reason optional; hold and reject need a reason; reasons show in the stage views', () => {
  const sim = new Sim();
  grantMasterAccess(sim.s, 'p0');
  const code = sim.code('p0', 'TRANSACTIONS', null);
  const run = (module: string, fn: string, params: Record<string, string>) => sim.do({ type: 'EXECUTE', playerId: 'p0', code, system: 'TRANSACTIONS', module, fn, params });
  sim.at(1);

  assert.match(run('RISK_CHECK', 'RUN_RISK_CHECK', { txId: '1', reason: 'fine' }).message, /Pick a risk score/);
  assert.equal(sim.s.transactions[0].status, 'QUEUED', 'nothing changes without a score');
  assert.ok(run('RISK_CHECK', 'RUN_RISK_CHECK', { txId: '1', score: 'LOW', reason: '   ' }).ok, 'no reason is fine');
  assert.equal(sim.s.transactions[0].riskReason, null);
  assert.ok(run('RISK_CHECK', 'RUN_RISK_CHECK', { txId: '1', score: 'high', reason: 'new account, big amount' }).ok);
  assert.equal(sim.s.transactions[0].riskResult, 'HIGH');

  assert.match(run('AUTHORIZATION', 'HOLD', { txId: '1' }).message, /reason for holding/);
  assert.ok(run('AUTHORIZATION', 'HOLD', { txId: '1', reason: 'calling the customer' }).ok);
  assert.match(run('AUTHORIZATION', 'REJECT', { txId: '1', reason: '' }).message, /reason for rejecting/);

  const auth = run('AUTHORIZATION', 'VIEW_AUTH_QUEUE', { show: 'ALL' }).lines!.join('\n');
  assert.match(auth, /risk HIGH by Jeremy: "new account, big amount"/);
  assert.match(auth, /held by Jeremy: "calling the customer"/);

  assert.ok(run('AUTHORIZATION', 'APPROVE', { txId: '1', reason: 'customer confirmed' }).ok, 'approve takes an optional reason');
  const settle = run('SETTLEMENT', 'VIEW_SETTLEMENT', {}).lines!.join('\n');
  assert.match(settle, /approved by Jeremy: "customer confirmed"/);
});

test('client requests: bankers are assigned, requests arrive over time, and each banker sees only their own', () => {
  const sim = new Sim();
  const bankers = sim.byRole('PERSONAL_BANKER');
  assert.ok(sim.s.customers.every((c) => bankers.some((b) => b.id === c.bankerId)), 'every customer has a personal banker');
  assert.equal(sim.s.requests.length, 2, 'two requests waiting at the start');
  // Three more arrive on the (time-of-day) schedule.
  const c = sim.s.config;
  let third = 0;
  for (let i = 0; i < 3; i++) third = nextArrival(c.durationSec, third, c.requestIntervalSec);
  sim.at(third + 0.5);
  assert.equal(sim.s.requests.length, 5);
  for (const r of sim.s.requests) {
    const cust = sim.s.customers.find((c) => c.id === r.customerId)!;
    assert.ok(r.text.includes(cust.name), 'signed with the customer name');
    assert.ok(!/CU[0-9]/.test(r.text), 'never uses customer codes');
    if (r.kind === 'PAYMENT') assert.ok(r.text.includes(sim.s.customers.find((c) => c.id === r.payeeId)!.name), 'names who to pay');
  }

  const [a, b] = bankers;
  const inbox = (p: Player, code: string) => sim.run(p.id, code, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS', { show: 'ALL' }).lines!.filter((l) => l.startsWith('REQ-'));
  const aCode = sim.code(a.id, 'CLIENT_DATA', 'CLIENT_REQUESTS');
  const mine = sim.s.requests.filter((x) => x.bankerId === a.id).length;
  assert.equal(inbox(a, aCode).length, mine);
  // Someone else typing a's code sees a's inbox, not their own.
  assert.equal(inbox(b, aCode).length, mine);
  // The Bank Manager reads every banker's requests, read-only.
  const [bm] = sim.byRole('BANK_MANAGER');
  const bmCode = sim.code(bm.id, 'CLIENT_DATA', 'CLIENT_REQUESTS');
  assert.equal(inbox(bm, bmCode).length, sim.s.requests.length);
  const open = sim.s.requests.find((r) => r.status === 'OPEN')!;
  assert.equal(sim.run(bm.id, bmCode, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: open.id, reason: 'x' }).message, 'Access denied.');
  // A whole-system Client Data credential sees everyone's.
  grantMasterAccess(sim.s, 'p0');
  assert.equal(inbox(sim.s.players.p0, sim.code('p0', 'CLIENT_DATA', null)).length, sim.s.requests.length);
});

test('client requests close by linking a payment or an account change, or by archiving with a reason', () => {
  const sim = new Sim({ requestChangeShare: 0.5, requestDeadlineSec: 9999, urgentDeadlineSec: 9999 }); // deadlines are tested separately
  grantMasterAccess(sim.s, 'p0');
  sim.at(sim.s.config.requestIntervalSec * 12 + 1);
  const pay = sim.s.requests.find((r) => r.kind === 'PAYMENT')!;
  const add = sim.s.requests.find((r) => r.kind === 'ADD_ACCOUNT' || r.kind === 'ADD_AND_PRIMARY')!;
  assert.ok(pay && add, 'payment and account requests arrived');
  const tx = sim.code('p0', 'TRANSACTIONS', null);
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  const createFor = (requestId: string) =>
    sim.run('p0', tx, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: pay.originAccount!, beneficiaryId: pay.payeeId!, amount: String(pay.amount), requestId });

  assert.match(createFor(add.id).message, /asks for a new/);
  assert.match(createFor('REQ-999').message, /No such client request/);
  const made = createFor(pay.id.replace('REQ-', ''));
  assert.ok(made.ok && made.message.includes(`${pay.id} is done`), made.message);
  const payment = sim.s.transactions.at(-1)!;
  const now = (id: string) => sim.s.requests.find((r) => r.id === id)!; // every action returns a fresh state
  assert.equal(payment.requestId, pay.id);
  assert.equal(now(pay.id).status, 'DONE');
  assert.equal(now(pay.id).txId, payment.id);
  assert.match(createFor(pay.id).message, /already done/);
  const queue = sim.run('p0', tx, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {}).lines!.find((l) => l.startsWith(payment.id))!;
  assert.ok(queue.endsWith(`for ${pay.id}`), queue);

  const added = sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', {
    customerId: add.customerId,
    account: add.account!,
    makePrimary: add.kind === 'ADD_AND_PRIMARY' ? 'YES' : 'NO',
    requestId: add.id,
  });
  assert.ok(added.ok, added.message);
  assert.equal(now(add.id).status, 'DONE');

  const other = sim.s.requests.find((r) => r.status === 'OPEN')!;
  const archive = (reason: string) => sim.run('p0', cd, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: other.id, reason });
  assert.match(archive(' ').message, /reason for archiving/);
  assert.ok(archive('duplicate of an earlier request').ok);
  assert.equal(now(other.id).status, 'ARCHIVED');
  assert.equal(now(other.id).archiveReason, 'duplicate of an earlier request');
});

test('a banker cannot archive (or even see) another banker\'s request', () => {
  const sim = new Sim();
  const [a, b] = sim.byRole('PERSONAL_BANKER');
  // Wait until the other banker has an open request.
  const open = () => sim.s.requests.find((r) => r.bankerId === b.id && r.status === 'OPEN');
  for (let t = 0; !open() && t < 1200; t += 10) sim.at(t);
  const theirs = open()!;
  const r = sim.run(a.id, sim.code(a.id, 'CLIENT_DATA', 'CLIENT_REQUESTS'), 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: theirs.id, reason: 'mine now' });
  assert.equal(r.message, 'No such client request.');
  assert.equal(sim.s.requests.find((x) => x.id === theirs.id)!.status, 'OPEN');
});

test('Permissions lives in Security; every account change waits in the Verification queue', () => {
  const sim = new Sim();
  assert.ok(SYSTEMS.find((s) => s.id === 'SECURITY')!.modules.some((m) => m.id === 'PERMISSIONS'));
  assert.ok(!SYSTEMS.find((s) => s.id === 'CLIENT_DATA')!.modules.some((m) => m.id === 'PERMISSIONS'));
  const [it] = sim.byRole('IT_SPECIALIST');
  assert.ok(sim.run(it.id, sim.code(it.id, 'SECURITY', 'PERMISSIONS'), 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS').ok);

  const pb = sim.bankerOf('CU2');
  const ver = sim.code(pb.id, 'CLIENT_DATA', 'VERIFICATION');
  const view = (show: string) => sim.run(pb.id, ver, 'CLIENT_DATA', 'VERIFICATION', 'VIEW_VERIFICATION', { show }).lines!;
  sim.at(5);
  assert.deepEqual(view('PENDING'), ['Nothing here.']);
  sim.open(0, '54321');
  sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: 'CU2', account: '54321', makePrimary: 'YES' });
  // Adding an account as primary is two changes: the account, then the new primary. Each waits for verification.
  const pending = view('PENDING');
  assert.equal(pending.length, 2);
  assert.ok(pending[0].startsWith('CH-1 ') && pending[0].includes('CU2') && pending[0].includes('added ACC-54321') && pending[0].endsWith('[UNVERIFIED]'), pending[0]);
  assert.ok(pending[1].includes('-> ACC-54321') && pending[1].includes(`by ${pb.name}`), pending[1]);
  // Bankers can see the queue but not verify: that is Accounts & Receivables' (and the Bank Manager's) job.
  assert.equal(sim.run(pb.id, ver, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: 'CH-1' }).message, 'Access denied.');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const arVer = sim.code(ar.id, 'CLIENT_DATA', 'VERIFICATION');
  assert.match(sim.run(ar.id, arVer, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: 'CH-9' }).message, /No such change/);
  sim.run(ar.id, arVer, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: '1' });
  assert.equal(view('PENDING').length, 1);
  sim.run(ar.id, arVer, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: 'CH-2' });
  assert.deepEqual(view('PENDING'), ['Nothing here.']);
  assert.ok(view('ALL').every((l) => l.endsWith(`[VERIFIED by ${ar.name}]`)));
});

test('customer accounts: 3 per banker; add, set primary and remove, with their rules and history', () => {
  const sim = new Sim();
  assert.equal(sim.s.customers.length, 3 * sim.byRole('PERSONAL_BANKER').length);
  for (const c of sim.s.customers) {
    assert.ok(c.accounts.length >= 1 && c.accounts.length <= 3 && c.accounts.includes(c.primary));
  }
  const pb = sim.bankerOf('CU5'); // only a customer's own banker can change their accounts
  const other = Object.values(sim.s.players).find((p) => p.id !== pb.id)!;
  const cr = sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');
  const run = (fn: string, params: Record<string, string>) => sim.run(other.id, cr, 'CLIENT_DATA', 'CUSTOMER_RECORDS', fn, params);
  const cu = () => sim.s.customers.find((c) => c.id === 'CU5')!;
  const start = cu().primary;
  const floating = sim.s.targets[1].account; // a mule account nobody owns yet
  sim.at(3);

  assert.match(run('ADD_ACCOUNT', { customerId: 'CU5', account: sim.s.customers[0].primary }).message, /belongs to another customer/);
  assert.match(run('ADD_ACCOUNT', { customerId: 'CU5', account: start }).message, /already on CU5/);
  assert.ok(run('ADD_ACCOUNT', { customerId: 'cu5', account: floating }).ok, 'floating accounts can be attached; tags are case-insensitive');
  assert.equal(cu().primary, start, 'adding without "make primary" leaves payments alone');
  assert.match(run('SET_PRIMARY', { customerId: 'CU5', account: '99999' }).message, /not one of CU5's accounts/);
  assert.ok(run('SET_PRIMARY', { customerId: '5', account: floating }).ok);
  assert.equal(cu().primary, floating);
  assert.equal(accountVerified(cu(), floating), false);
  assert.match(run('REMOVE_ACCOUNT', { customerId: 'CU5', account: floating }).message, /primary account. Make another/);
  assert.ok(run('REMOVE_ACCOUNT', { customerId: 'CU5', account: start }).ok, 'the old primary can go once it is not primary');
  assert.ok(!cu().accounts.includes(start));

  // Every change is on record, attributed to the credential owner; the truth is kept separately.
  assert.deepEqual(cu().history.map((h) => h.action), ['ADD_ACCOUNT', 'SET_PRIMARY', 'REMOVE_ACCOUNT']);
  assert.ok(cu().history.every((h) => h.byOwner === pb.id && h.actualPlayerId === other.id));
  const investigate = (target: string) =>
    sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'VERIFICATION'), 'CLIENT_DATA', 'VERIFICATION', 'INVESTIGATE_CHANGES', { target });
  const inv = investigate('CU5').lines!.join('\n');
  assert.ok(inv.includes(`added ${floating}`) && inv.includes(`primary ${start} -> ${floating}`) && inv.includes(`removed ${start}`), inv);
  // Looking up an account follows it across customers and says where it is now.
  const byAccount = investigate(start.slice(4));
  assert.ok(byAccount.message.startsWith(`${start}: now floating`), byAccount.message);
  assert.equal(byAccount.lines!.length, 2, 'it stopped being primary, then was removed');
  assert.ok(investigate(floating).message.includes('on CU5') && investigate(floating).message.includes('(primary)'));

  // A payment to CU5 now lands in the new primary.
  grantMasterAccess(sim.s, 'p0');
  const master = sim.code('p0', 'TRANSACTIONS', null);
  const go = (fn: string, module: string, params: Record<string, string>) => sim.run('p0', master, 'TRANSACTIONS', module, fn, params);
  assert.ok(go('CREATE_TRANSACTION', 'PAYMENT_QUEUE', { originAccount: sim.s.customers[0].primary, beneficiaryId: 'CU5', amount: '1000000' }).ok);
  const id = sim.s.transactions.at(-1)!.id;
  go('RUN_RISK_CHECK', 'RISK_CHECK', { txId: id });
  go('APPROVE', 'AUTHORIZATION', { txId: id });
  go('SETTLE', 'SETTLEMENT', { txId: id });
  assert.equal(sim.s.transactions.at(-1)!.settledTo, floating);
  assert.equal(sim.s.totals.stolen, 1_000_000, 'the floating account was a mule');

  // The Target Ledger shows where each mule account sits and what it holds.
  const bh = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const ledger = sim.run(bh.id, sim.code(bh.id, 'HIDDEN_HOST', 'TARGET_LEDGER'), 'HIDDEN_HOST', 'TARGET_LEDGER', 'VIEW_TARGETS');
  assert.ok(ledger.message.includes('$1,000,000 of'), ledger.message);
  assert.match(ledger.lines!.find((l) => l.startsWith(floating))!, /CU5 \(primary\)\s+\$1,000,000$/);
  assert.match(ledger.lines!.find((l) => l.startsWith(sim.s.targets[0].account))!, /floating\s+\$0$/);
});

test('Customer Records: bankers see their own customers by default and can view all; nobody else has any of their own', () => {
  const sim = new Sim();
  const [a, b] = sim.byRole('PERSONAL_BANKER');
  const code = sim.code(a.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');
  const shown = (pid: string, c: string) =>
    sim.run(pid, c, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS').lines!.filter((l) => l.startsWith('CU')).map((l) => l.split(' ')[0]);
  const mine = sim.s.customers.filter((c) => c.bankerId === a.id).map((c) => c.id);
  assert.deepEqual(shown(a.id, code), mine);
  assert.deepEqual(shown(b.id, code), mine, "a borrowed code shows its owner's customers");
  const all = (pid: string, c: string) => sim.run(pid, c, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: 'ALL' }).lines!.filter((l) => l.startsWith('CU')).length;
  assert.equal(all(a.id, code), sim.s.customers.length, 'a banker can view every customer');
  // ...but still change only their own.
  const theirs = sim.s.customers.find((c) => c.bankerId === b.id)!;
  assert.match(sim.run(a.id, code, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'SET_PRIMARY', { customerId: theirs.id, account: theirs.primary }).message, /not one of/);
  // Staff with no customers of their own read every customer by default; "my customers" says they have none.
  for (const role of ['ACCOUNTS_RECEIVABLES', 'IT_SPECIALIST', 'BANK_MANAGER'] as const) {
    const [p] = sim.byRole(role);
    const own = sim.code(p.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');
    assert.equal(shown(p.id, own).length, sim.s.customers.length, role);
    assert.equal(sim.run(p.id, own, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: 'MINE' }).message, 'You have no customers assigned to you.', role);
  }
});

test('the risk queue flags unverified payee primaries and unverified originator accounts', () => {
  const sim = new Sim();
  grantMasterAccess(sim.s, 'p0');
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  const tx = sim.code('p0', 'TRANSACTIONS', null);
  sim.at(1);
  sim.open(5_000_000, '11111', '22222');
  // CU3 gets a new primary (unverified); CU4 gets a new account (unverified) that then sends money.
  sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: 'CU3', account: '11111', makePrimary: 'YES' });
  sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: 'CU4', account: '22222' });
  const create = (originAccount: string, beneficiaryId: string) =>
    sim.run('p0', tx, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount, beneficiaryId, amount: '1000000' });
  const clean = sim.s.customers.find((c) => c.id === 'CU1')!.primary;
  create(clean, 'CU2');
  create(clean, 'CU3');
  create('22222', 'CU2');
  const lines = sim.run('p0', tx, 'TRANSACTIONS', 'RISK_CHECK', 'VIEW_RISK_QUEUE', {}).lines!;
  const head = (n: number) => lines.find((l) => l.startsWith(sim.s.transactions.at(n)!.id))!;
  assert.ok(!head(-3).includes('UNVERIFIED'), head(-3));
  assert.ok(head(-2).endsWith("!! UNVERIFIED: payee's primary"), head(-2));
  assert.ok(head(-1).endsWith('!! UNVERIFIED: originator account'), head(-1));

  // Verifying the changes clears the flags.
  for (const c of sim.s.customers) for (const h of c.history) sim.run('p0', cd, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: h.id });
  assert.ok(!sim.run('p0', tx, 'TRANSACTIONS', 'RISK_CHECK', 'VIEW_RISK_QUEUE', {}).lines!.some((l) => l.includes('UNVERIFIED')));
});

test('bankers can only change their own customers\' accounts; a whole-system Client Data credential can change any', () => {
  const sim = new Sim();
  const [a] = sim.byRole('PERSONAL_BANKER');
  const code = sim.code(a.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');
  const mine = sim.s.customers.find((c) => c.bankerId === a.id)!;
  const theirs = sim.s.customers.find((c) => c.bankerId !== a.id)!;
  const add = (customerId: string, account: string) =>
    sim.run(a.id, code, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId, account });
  sim.at(1);
  sim.open(0, '31313', '32323', '34343');
  assert.ok(add(mine.id, '31313').ok);
  assert.equal(add(theirs.id, '32323').message, `${theirs.id} is not one of ${a.name}'s customers.`);
  assert.match(sim.run(a.id, code, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'SET_PRIMARY', { customerId: theirs.id, account: theirs.accounts[0] }).message, /not one of/);
  grantMasterAccess(sim.s, 'p0');
  assert.ok(sim.run('p0', sim.code('p0', 'CLIENT_DATA', null), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: theirs.id, account: '32323' }).ok);

  // IT sees every customer, but read-only.
  const [it] = sim.byRole('IT_SPECIALIST');
  const itCode = sim.code(it.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');
  const view = sim.run(it.id, itCode, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS');
  assert.equal(view.lines!.filter((l) => l.startsWith('CU')).length, sim.s.customers.length);
  assert.equal(sim.run(it.id, itCode, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: 'CU1', account: '34343' }).message, 'Access denied.');
});

test('Firewall shows every module and its status; the registry lists active credentials unless asked for all', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const status = () => sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'VIEW_STATUS');
  sim.at(1);
  assert.equal(status().message, 'Firewall: everything online.');
  assert.ok(!status().lines!.some((l) => l.includes('Blacknet')), 'the hidden host is not listed');
  sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'SET_MODULE_STATUS', { target: 'TRANSACTIONS.SETTLEMENT', status: 'OFFLINE' });
  assert.equal(status().message, 'Firewall: 1 offline.');
  assert.ok(status().lines!.some((l) => l.startsWith('Transaction Processing / Settlement') && l.includes('OFFLINE')));

  const [it] = sim.byRole('IT_SPECIALIST');
  const perms = sim.code(it.id, 'SECURITY', 'PERMISSIONS');
  const reg = (show: string) => sim.run(it.id, perms, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', { show }).lines!;
  const victim = Object.values(sim.s.credentials).find((c) => c.owner === admin.id && c.system !== 'SECURITY')!;
  sim.run(it.id, perms, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: victim.id });
  assert.ok(!reg('ACTIVE').some((l) => l.startsWith(victim.id + ' ')));
  assert.ok(reg('ALL').some((l) => l.startsWith(victim.id + ' ') && l.includes('REVOKED')));
  assert.ok(reg('ALL').some((l) => l.includes('Read & write · Firewall')), 'scopes read like the credential picker');
});

test('live monitors: opening one is logged, its quiet refreshes are not', () => {
  const sim = new Sim();
  const [analyst] = sim.byRole('BANK_MANAGER');
  const code = sim.code(analyst.id, 'SECURITY', 'MASTER_LOG');
  const read = (quiet: boolean) => sim.do({ type: 'EXECUTE', playerId: analyst.id, code, system: 'SECURITY', module: 'MASTER_LOG', fn: 'VIEW_LOG', params: {}, quiet });
  sim.at(5);
  const logs = sim.s.logs.length;
  const notes = sim.s.players[analyst.id].activity.length;
  // The first read of a view is always logged, even if it asks to be quiet.
  assert.ok(read(true).ok);
  assert.equal(sim.s.logs.length, logs + 1, 'opening a monitor is logged');
  const opened = sim.s.logs.length;
  assert.ok(read(true).ok);
  assert.equal(sim.s.logs.length, opened, 'refreshes leave no Master Log entry');
  assert.equal(sim.s.players[analyst.id].activity.length, notes + 1, 'only the opening read is in the activity log');
  assert.ok(read(false).ok);
  assert.equal(sim.s.logs.length, opened + 1, 'a normal read is always logged');
});

test('firewall: switching a module\'s security off lets anyone in without a code, logged as Anonymous', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const view = () => sim.run(pb.id, '', 'TRANSACTIONS', 'SETTLEMENT', 'VIEW_SETTLEMENT', {});
  sim.at(2);
  assert.equal(view().message, 'Enter a 4-digit code.', 'security on: a code is required');
  assert.match(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'SET_SECURITY', { target: 'SECURITY.FIREWALL', security: 'OFF' }).message, /cannot be switched off/);
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'SET_SECURITY', { target: 'TRANSACTIONS.SETTLEMENT', security: 'OFF' }).ok);
  assert.ok(sim.lastLog().includes('switched security OFF for Settlement'));

  assert.ok(view().ok, 'no code needed now');
  const entry = sim.s.logs.at(-1)!;
  assert.equal(entry.message, 'Anonymous accessed Settlement (open access)');
  assert.equal(entry.actor, 'ANONYMOUS');
  assert.equal(entry.sourceIp, pb.ip, 'Trace can still find the workstation');
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'SET_SECURITY', { target: 'TRANSACTIONS.SETTLEMENT', security: 'ON' }).ok);
  assert.equal(view().message, 'Enter a 4-digit code.');
});

test('firewall: blocking an address for a minute, and unblocking it early', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const fwRun = (fn: string, address: string) => sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', fn, { address });
  const arView = () => sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'PAYMENT_QUEUE'), 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {});
  sim.at(2);
  assert.equal(fwRun('BLOCK_ADDRESS', '10.9.9.9').message, 'No such address on the network.');

  // A workstation: that player is cut off.
  assert.ok(fwRun('BLOCK_ADDRESS', ar.ip).ok);
  assert.equal(sim.lastLog(), `${admin.name} blocked ${ar.ip} for ${sim.s.config.blockSec}s`);
  assert.match(arView().message, /Your workstation is blocked by the firewall for \d+s/);
  assert.ok(fwRun('UNBLOCK_ADDRESS', ar.ip).ok);
  assert.ok(arView().ok, 'unblocked early');

  // A system: nobody gets through; the block expires on its own.
  assert.ok(fwRun('BLOCK_ADDRESS', '10.0.0.30').ok);
  assert.match(arView().message, /blocked by the firewall/);
  sim.at(2 + sim.s.config.blockSec + 1);
  assert.ok(arView().ok, 'blocks expire');
  assert.match(fwRun('UNBLOCK_ADDRESS', '10.0.0.30').message, /is not blocked/);

  // The hidden host can be blocked too, which cuts the operatives off Blacknet.
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  assert.ok(fwRun('BLOCK_ADDRESS', sim.s.hiddenHost).ok);
  assert.match(sim.run(black.id, sim.code(black.id, 'HIDDEN_HOST', 'BLACKNET'), 'HIDDEN_HOST', 'BLACKNET', 'READ_MESSAGES').message, /No route to host/);
});

test('revoking all access to a bank system shuts the bank down: everybody loses', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  sim.at(2);
  sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: '10.0.0.30' });
  sim.at(sim.sec + sim.s.config.revokeCountdownSec + 1);
  assert.equal(sim.s.status, 'ENDED');
  assert.equal(sim.s.winner, null);
  assert.equal(sim.s.endKind, 'SHUTDOWN');
  assert.match(sim.s.endReason!, /Transaction Processing was revoked .* Nobody wins/);
  assert.equal(getPlayerView(sim.s, admin.id).end!.headline, 'Everybody loses');
});

test('revoking all access to the unregistered host shuts it down: the bank wins', () => {
  const sim = new Sim();
  const admin = sim.byRole('IT_SPECIALIST').find((p) => p.allegiance === 'WHITE')!;
  sim.at(2);
  assert.ok(sim.run(admin.id, sim.code(admin.id, 'SECURITY', 'FIREWALL'), 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: sim.s.hiddenHost }).ok);
  sim.at(2 + sim.s.config.revokeCountdownSec - 1);
  assert.equal(sim.s.status, 'RUNNING', 'it can still be cancelled');
  sim.at(3 + sim.s.config.revokeCountdownSec);
  assert.equal(sim.s.status, 'ENDED');
  assert.equal(sim.s.winner, 'WHITE');
  assert.equal(sim.s.endKind, 'HOST_SHUT_DOWN');
  assert.match(sim.s.endReason!, /unregistered host at 10\.\d+\.\d+\.\d+ and shut it down/);
});

test('firewall: "revoke all access" counts down, can be cancelled only from the Firewall, and is permanent once done', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const [bystander] = sim.byRole('PERSONAL_BANKER');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const arCode = sim.code(ar.id, 'TRANSACTIONS', 'PAYMENT_QUEUE');
  sim.at(2);

  // Cancelled: nothing happens.
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: ar.ip }).ok);
  const r1 = sim.s.revocations.at(-1)!;
  assert.equal(r1.status, 'PENDING');
  // Only one revocation counts down at a time, whatever the address.
  assert.match(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: bystander.ip }).message, /Only one revocation can run at a time/);
  assert.equal(sim.s.revocations.length, 1);
  // Without Firewall access you cannot cancel it.
  const noFw = sim.run(bystander.id, sim.code(bystander.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'SECURITY', 'FIREWALL', 'CANCEL_REVOCATION', { revocationId: r1.id });
  assert.equal(noFw.message, 'Access denied.');
  const cancel = sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'CANCEL_REVOCATION', { revocationId: '1' });
  assert.ok(cancel.ok, cancel.message);
  assert.equal(sim.lastLog(), `${admin.name} cancelled ${r1.id} (revoke all access for ${ar.ip})`);
  sim.at(2 + sim.s.config.revokeCountdownSec + 1);
  assert.ok(sim.run(ar.id, arCode, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {}).ok);

  // Allowed to finish: permanent block and every credential of the owner revoked.
  sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: ar.ip });
  sim.at(sim.sec + sim.s.config.revokeCountdownSec + 1);
  assert.equal(sim.run(ar.id, arCode, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {}).message, 'ERROR: Your credentials are invalid.');
  assert.ok(Object.values(sim.s.credentials).filter((c) => c.owner === ar.id && c.system !== 'HIDDEN_HOST' && c.system !== 'WORKSTATION').every((c) => c.status === 'REVOKED'));
  assert.match(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'UNBLOCK_ADDRESS', { address: ar.ip }).message, /cannot be undone/);
  assert.ok(sim.s.logs.some((l) => l.message.startsWith(`Firewall: all access revoked for ${ar.ip}`)));
});

test('Employee Records show last activity, failed attempts, lockouts and blocks; alerts live in the Master Log', () => {
  const sim = new Sim();
  const [analyst] = sim.byRole('BANK_MANAGER');
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const used = new Set(Object.values(sim.s.credentials).map((c) => c.code));
  const bad = ['0000', '1111', '2222', '3333'].filter((c) => !used.has(c));
  sim.at(10);
  for (let i = 0; i < 3; i++) sim.run(pb.id, bad[i], 'SECURITY', 'MASTER_LOG', 'VIEW_LOG');
  const rows = sim.run(analyst.id, sim.code(analyst.id, 'SECURITY', 'EMPLOYEE_RECORDS'), 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES').lines!;
  const i = rows.findIndex((l) => l.startsWith(pb.name));
  assert.ok(rows[i].includes('[LOCKED OUT'), rows[i]);
  assert.ok(rows[i + 1].includes('failed attempts: 3') && rows[i + 1].includes('last activity: 00:10'), rows[i + 1]);
  const alerts = sim.run(analyst.id, sim.code(analyst.id, 'SECURITY', 'MASTER_LOG'), 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: 'ALERTS' }).lines!;
  assert.equal(alerts.filter((l) => l.includes('AUTH_FAIL')).length, 3);
  assert.ok(!SYSTEMS.find((s) => s.id === 'SECURITY')!.modules.some((m) => m.id === 'INTRUSION_DETECTION'));
});

/** Checks a relay trace against the truth: whichever of the four clue kinds it is, it must be correct. */
function clueIsTrue(sim: Sim, message: string, entry: { sourceIp: string | null; activity?: string }): boolean {
  const ip = entry.sourceIp!;
  const last = Number(ip.split('.').pop());
  let m = message.match(/The origin workstation is within 10\.1\.0\.(\d+)-(\d+)\./);
  if (m) {
    const [lo, hi] = [Number(m[1]), Number(m[2])];
    const inside = Object.values(sim.s.players).filter((p) => !p.fake && p.ip.startsWith('10.1.0.') && Number(p.ip.split('.')[3]) >= lo && Number(p.ip.split('.')[3]) <= hi);
    return inside.length === 4 && last >= lo && last <= hi;
  }
  m = message.match(/The origin is one of two workstations: ([\d.]+) or ([\d.]+)\./);
  if (m) return (m[1] === ip || m[2] === ip) && m[1] !== m[2];
  m = message.match(/The server's IP address is ([\dx.]+)\./);
  if (m) {
    const shown = m[1].split('.');
    const real = sim.s.hiddenHost.split('.');
    return shown.filter((p) => p !== 'x').length === 1 && shown.every((p, i) => p === 'x' || p === real[i]);
  }
  m = message.match(/Activity performed: (.+)\.$/);
  return Boolean(m && m[1] === entry.activity);
}

test('hidden host: failures are also "Unknown server activity", and traces give varied, always-true clues', () => {
  const sim = new Sim({ traceCooldownSec: 0 });
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const [analyst] = sim.byRole('BANK_MANAGER');
  const logCode = sim.code(analyst.id, 'SECURITY', 'MASTER_LOG');
  sim.at(5);

  // A failed code on the host names nobody, but still counts toward the lockout.
  const before = sim.s.players[black.id].failTotal;
  const wrongScope = sim.code(analyst.id, 'SECURITY', 'EMPLOYEE_RECORDS'); // a real code with the wrong access
  assert.equal(sim.run(black.id, wrongScope, 'HIDDEN_HOST', 'BLACKNET', 'READ_MESSAGES').message, 'Access denied.');
  const failEntry = sim.s.logs.at(-1)!;
  assert.equal(failEntry.message, 'Unknown server activity');
  assert.equal(failEntry.activity, 'failed login attempt');
  assert.ok(!sim.s.logs.some((l) => l.message.includes(analyst.name) && l.message.includes('denied')), 'the code owner is not named');
  assert.equal(sim.s.players[black.id].failTotal, before + 1);

  // Many traces: every kind of clue shows up, and every clue is true.
  const kinds = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const module = i % 2 ? 'TARGET_LEDGER' : 'BLACKNET';
    sim.run(black.id, sim.code(black.id, 'HIDDEN_HOST', module), 'HIDDEN_HOST', module, i % 2 ? 'VIEW_TARGETS' : 'READ_MESSAGES');
    const e = sim.s.logs.at(-1)!;
    const msg = sim.run(analyst.id, logCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: e.id }).message;
    assert.ok(clueIsTrue(sim, msg, e), msg);
    kinds.add(msg.includes('within') ? 'range' : msg.includes('one of two') ? 'pair' : msg.includes("server's IP") ? 'server' : 'activity');
  }
  assert.deepEqual([...kinds].sort(), ['activity', 'pair', 'range', 'server']);
});

test('hidden host kits: every operative gets the shared modules and exactly one kit; the rest go unused', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const sim = new Sim({}, seed);
    const blacks = Object.values(sim.s.players).filter((p) => p.allegiance === 'BLACK');
    const hostCreds = (pid: string) => Object.values(sim.s.credentials).filter((c) => c.owner === pid && c.system === 'HIDDEN_HOST');
    const dealt = new Set<string>();
    for (const b of blacks) {
      const modules = hostCreds(b.id).map((c) => c.module!);
      for (const m of HOST_SHARED_MODULES) assert.ok(modules.includes(m), `${b.name} can use ${m}`);
      const kits = modules.filter((m) => HOST_KITS.includes(m));
      assert.equal(kits.length, 1, `${b.name} has ${kits.length} kits`);
      assert.ok(hostCreds(b.id).every((c) => c.module !== null), 'no whole-host credentials');
      kits.forEach((k) => dealt.add(k));
    }
    assert.equal(dealt.size, Math.min(blacks.length, HOST_KITS.length), 'no kit dealt twice while some are unused');
  }
});

test('Host Log: activity on the host by credential owner, and alerts when the bank traces it', () => {
  const sim = new Sim({ traceCooldownSec: 0 });
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const [analyst] = sim.byRole('BANK_MANAGER');
  const host = (module: string) => sim.code(black.id, 'HIDDEN_HOST', module);
  const hostLog = (show: string) => sim.run(black.id, host('HOST_LOG'), 'HIDDEN_HOST', 'HOST_LOG', 'VIEW_HOST_LOG', { show }).lines!;
  sim.at(3);
  sim.run(black.id, host('BLACKNET'), 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: 'hello' });
  assert.ok(hostLog('ALL').some((l) => l.endsWith(`${black.name}: posted on Blacknet`)), 'named after the host credential owner');
  assert.deepEqual(hostLog('ALERTS'), ['Nothing here.']);

  // The bank traces the relay entry: the host log shows who traced it and what they learned.
  const relay = sim.s.logs.filter((l) => l.kind === 'HIDDEN_ACCESS').at(-1)!;
  const trace = sim.run(analyst.id, sim.code(analyst.id, 'SECURITY', 'MASTER_LOG'), 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: relay.id });
  const alerts = hostLog('ALERTS');
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes(`!! Relay entry ${relay.id} was traced by ${analyst.name}. The bank learned: `), alerts[0]);
  assert.ok(alerts[0].endsWith(trace.message.split('routed through a relay. ')[1]), 'same clue the bank got');
});

test('Infiltration / Create proxy and Reroute IP: reroutes only through a proxy, and a trace follows the proxy', () => {
  const sim = new Sim({ traceCooldownSec: 0 });
  const [black, other] = Object.values(sim.s.players).filter((p) => p.allegiance === 'BLACK');
  const victim = Object.values(sim.s.players).find((p) => p.allegiance === 'WHITE')!;
  const [analyst] = sim.byRole('BANK_MANAGER');
  grantMasterAccess(sim.s, black.id);
  grantMasterAccess(sim.s, other.id);
  const secCode = sim.code(black.id, 'SECURITY', null);
  const traceCode = sim.code(analyst.id, 'SECURITY', 'MASTER_LOG');
  const proxy = (ip: string) => hostRun(sim, black.id, 'CREATE_PROXY', { ip });
  const cast = (pid: string, ip: string, seconds: string) => hostRun(sim, pid, 'REROUTE_IP', { proxy: ip, seconds });
  const lastAccess = () => sim.s.logs.filter((l) => l.kind === 'ACCESS').at(-1)!;

  // No proxy, no reroute. A proxy needs an unused address: no workstation, system or host.
  assert.match(cast(black.id, '10.9.0.77', '10').message, /No proxies yet/);
  assert.match(proxy('nope').message, /IP address/);
  for (const used of [black.ip, victim.ip, '10.0.0.30', sim.s.hiddenHost]) assert.match(proxy(used).message, /already in use/);
  assert.equal(sim.s.proxies.length, 0);

  // Setting one up is loud (tier 3).
  sim.at(5);
  assert.ok(proxy('10.9.0.77').ok);
  assert.match(proxy('10.9.0.77').message, /already in use/, 'no duplicates');
  const proxyAlert = sim.s.alerts.filter((a) => a.kind === 'UNAUTHORIZED_ACTION').at(-1)!;
  assert.equal(proxyAlert.tier, 3);
  const loud = sim.run(analyst.id, traceCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: proxyAlert.logId! });
  assert.ok(loud.message.includes(black.ip) || loud.message.includes(sim.s.hiddenHost), loud.message);
  assert.deepEqual(getPlayerView(sim.s, other.id).proxies, [{ ip: '10.9.0.77', unavailable: null }], 'shared by every operative');
  assert.deepEqual(getPlayerView(sim.s, victim.id).proxies, [], 'invisible without Infiltration access');

  // Reroute: a proxy from the list, 1-60 seconds (10 by default), always noisy (tier 2).
  assert.match(cast(black.id, victim.ip, '10').message, /Choose one of the proxies/);
  assert.match(cast(black.id, '10.9.0.77', '0').message, /1 to 60/);
  assert.match(cast(black.id, '10.9.0.77', '61').message, /1 to 60/);
  sim.at(10);
  assert.ok(cast(black.id, '10.9.0.77', '').ok);
  assert.ok(sim.s.reroutes.some((r) => r.fromIp === black.ip && r.toIp === '10.9.0.77' && r.until === 20));
  assert.equal(sim.s.alerts.filter((a) => a.kind === 'UNAUTHORIZED_ACTION').at(-1)!.tier, 2);

  // While it runs, nobody else can use that proxy; the operative running it can renew it.
  assert.match(cast(other.id, '10.9.0.77', '10').message, /unavailable: carrying a reroute/);
  assert.equal(getPlayerView(sim.s, other.id).proxies[0].unavailable, 'carrying a reroute');

  sim.at(15);
  assert.ok(sim.run(black.id, secCode, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG').ok);
  assert.equal(lastAccess().sourceIp, '10.9.0.77', 'the Master Log records the proxy');
  assert.equal(sim.s.players[black.id].lastActiveAt, 10, 'the real workstation looks idle');
  const traced = sim.run(analyst.id, traceCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: lastAccess().id });
  assert.ok(traced.message.includes('10.9.0.77') && !traced.message.includes(black.ip), traced.message);

  // Once it wears off, activity is the real workstation again.
  sim.at(25);
  assert.ok(sim.run(black.id, secCode, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG').ok);
  assert.equal(lastAccess().sourceIp, black.ip);

  // A Firewall block on the proxy's address makes it unavailable.
  const it = sim.byRole('IT_SPECIALIST').find((p) => p.id !== black.id && p.id !== other.id)!;
  assert.ok(sim.run(it.id, sim.code(it.id, 'SECURITY', 'FIREWALL'), 'SECURITY', 'FIREWALL', 'BLOCK_ADDRESS', { address: '10.9.0.77' }).ok);
  assert.match(cast(black.id, '10.9.0.77', '10').message, /unavailable: blocked by the firewall/);
});

test('Infiltration / Create user: plants a fake employee at a proxy; it shows in the records and can be issued credentials', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const [it] = sim.byRole('IT_SPECIALIST'); // holds Employee Records and Permissions write
  grantMasterAccess(sim.s, black.id);
  const create = (name: string, role: string, proxy: string) => hostRun(sim, black.id, 'CREATE_USER', { name, role, proxy });

  // Validation: a proxy must exist, then a name, a real role and one of the proxies. None of these plant anyone.
  assert.match(create('Dana', 'IT_SPECIALIST', '10.9.0.30').message, /No proxies yet/);
  assert.ok(hostRun(sim, black.id, 'CREATE_PROXY', { ip: '10.9.0.30' }).ok);
  assert.match(create('', 'IT_SPECIALIST', '10.9.0.30').message, /name/);
  assert.match(create('Dana', 'WIZARD', '10.9.0.30').message, /role/i);
  assert.match(create('Dana', 'IT_SPECIALIST', it.ip).message, /Choose one of the proxies/, 'never an existing workstation');
  const before = sim.s.playerOrder.length;

  sim.at(5);
  assert.ok(create('Dana Pruitt', 'IT_SPECIALIST', '10.9.0.30').ok);
  assert.equal(sim.s.playerOrder.length, before + 1, 'exactly one user planted');
  const fake = Object.values(sim.s.players).find((p) => p.fake)!;
  assert.equal(fake.name, 'Dana Pruitt');
  assert.equal(fake.ip, '10.9.0.30');
  assert.equal(fake.allegiance, 'WHITE', 'poses as bank staff');

  // The proxy is now taken: no second user there, and no reroute through it.
  assert.match(create('Other', 'IT_SPECIALIST', '10.9.0.30').message, /unavailable: used by a planted user/);
  assert.match(hostRun(sim, black.id, 'REROUTE_IP', { proxy: '10.9.0.30', seconds: '10' }).message, /used by a planted user/);

  // Shows up in Employee Records like any other employee.
  const records = sim.run(it.id, sim.code(it.id, 'SECURITY', 'EMPLOYEE_RECORDS'), 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES');
  assert.ok(records.lines!.some((l) => l.includes('Dana Pruitt') && l.includes('10.9.0.30')), 'the planted user is in the records');

  // And can be issued a credential from Permissions.
  const issue = sim.run(it.id, sim.code(it.id, 'SECURITY', 'PERMISSIONS'), 'SECURITY', 'PERMISSIONS', 'CREATE_CREDENTIAL', { owner: fake.id, scope: 'CLIENT_DATA.CUSTOMER_RECORDS', permission: 'WRITE' });
  assert.ok(issue.ok, issue.message);
  assert.ok(Object.values(sim.s.credentials).some((cr) => cr.owner === fake.id), 'the planted user owns a credential');

  // Exposure: planting is tier 2 (a partial clue), plus a Host Log warning.
  const alert = sim.s.alerts.filter((a) => a.kind === 'UNAUTHORIZED_ACTION').at(-1)!;
  assert.match(alert.message, /^Suspicious server activity$/);
  assert.ok(sim.s.hostLog.some((h) => h.alert));
});

test('Social / Spoofed message: lands in the recipient inbox but not the impersonated sender\'s history', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const recipient = Object.values(sim.s.players).find((p) => p.id !== black.id)!;
  const impersonated = Object.values(sim.s.players).find((p) => p.id !== black.id && p.id !== recipient.id)!;
  grantMasterAccess(sim.s, black.id);
  const hostCode = sim.code(black.id, 'HIDDEN_HOST', null);
  const spoof = (to: string, from: string, text: string) => sim.run(black.id, hostCode, 'HIDDEN_HOST', 'SOCIAL', 'SPOOFED_MESSAGE', { to, from, text });

  assert.match(spoof('Nobody', impersonated.name, 'hi').message, /No employee/);
  sim.at(5);
  assert.ok(spoof(recipient.name, impersonated.name, 'wire it now').ok);
  const inbox = sim.s.players[recipient.id].messages;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, impersonated.id, 'appears to come from the impersonated player');
  assert.equal(inbox[0].to, recipient.id);
  assert.equal(sim.s.players[impersonated.id].messages.length, 0, 'the impersonated sender has no such message: comparing notes exposes it');

  // A made-up name shows exactly as typed (no player owns it).
  assert.ok(spoof(recipient.name, 'Reginald Crest', 'urgent').ok);
  assert.equal(sim.s.players[recipient.id].messages.at(-1)!.from, 'Reginald Crest');

  // Tier-2 exposure, like the other Social tools.
  assert.match(sim.s.alerts.find((a) => a.kind === 'UNAUTHORIZED_ACTION')!.message, /^Suspicious server activity$/);
});

test('Social / Scam request: plants an open Client Request in the banker\'s queue, indistinguishable in the log', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  grantMasterAccess(sim.s, black.id);
  const hostCode = sim.code(black.id, 'HIDDEN_HOST', null);
  const cust = sim.s.customers[0];
  const banker = sim.s.players[cust.bankerId!];
  const scam = (customer: string, kind: string, account: string) => sim.run(black.id, hostCode, 'HIDDEN_HOST', 'SOCIAL', 'SCAM_REQUEST', { customer, kind, account });

  assert.match(scam('Nobody Inc', 'SET_PRIMARY', '18392').message, /No customer/);
  assert.match(scam(cust.name, 'SET_PRIMARY', 'nope').message, /account/);

  sim.at(5);
  const r = scam(cust.name, 'SET_PRIMARY', '18392');
  assert.ok(r.ok, r.message);
  const req = sim.s.requests.at(-1)!;
  assert.equal(req.customerId, cust.id);
  assert.equal(req.bankerId, banker.id);
  assert.equal(req.kind, 'SET_PRIMARY');
  assert.equal(req.account, 'ACC-18392');
  assert.equal(req.status, 'OPEN');
  // Worded from the same forms as real requests: the customer's name, the account, no tell-tale free text.
  assert.ok(req.text.includes('18392') && req.text.includes(cust.name), req.text);
  assert.ok(r.lines!.some((l) => l.includes(req.text)), 'the operative sees what was sent');

  // The banker sees it as an ordinary open request.
  const seen = sim.run(banker.id, sim.code(banker.id, 'CLIENT_DATA', 'CLIENT_REQUESTS'), 'CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS');
  assert.ok(seen.lines!.some((l) => l.includes(req.id)) && seen.lines!.some((l) => l.includes(req.text)), 'the scam request is in the queue');

  // Looks like a normal incoming request in the Master Log; the leak is the hidden-host tier-2 alert.
  assert.ok(sim.s.logs.some((l) => l.kind === 'CLIENT_REQUEST' && l.message.includes(req.id)));
  assert.match(sim.s.alerts.find((a) => a.kind === 'UNAUTHORIZED_ACTION')!.message, /^Suspicious server activity$/);
});

test('Access / Code crack: reveals a credential\'s digits over time, alerts each step, then hands over the code', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  grantMasterAccess(sim.s, black.id);
  const host = sim.code(black.id, 'HIDDEN_HOST', null);
  const reveal = sim.s.config.crackRevealSec;

  sim.at(2);
  assert.ok(sim.run(black.id, host, 'HIDDEN_HOST', 'ACCESS', 'CRACK_CODE', { target: 'SECURITY.MASTER_LOG' }).ok);
  const crackId = sim.s.cracks.at(-1)!.id;
  const credId = sim.s.cracks.at(-1)!.credentialId;
  const code = sim.s.credentials[credId].code;
  const crackNow = () => sim.s.cracks.find((k) => k.id === crackId)!;
  const crackAlerts = () => sim.s.alerts.filter((a) => a.kind === 'CODE_CRACK');
  assert.notEqual(sim.s.credentials[credId].owner, black.id, 'targets someone else\'s credential');
  assert.match(sim.run(black.id, host, 'HIDDEN_HOST', 'ACCESS', 'CRACK_CODE', { target: 'CLIENT_DATA.VERIFICATION' }).message, /Only one can run at a time/);
  assert.equal(sim.s.cracks.length, 1);

  sim.at(2 + reveal - 1);
  assert.equal(crackNow().revealed, 0, 'nothing revealed before the first interval');

  sim.at(2 + reveal + 1);
  assert.equal(crackNow().revealed, 1);
  assert.equal(crackAlerts().length, 1);
  assert.ok(crackAlerts()[0].message.includes(credId) && crackAlerts()[0].tier === 2);

  sim.at(2 + reveal * 4 + 1);
  assert.equal(crackNow().revealed, 4);
  assert.ok(crackNow().done);
  assert.equal(crackAlerts().length, 4);
  assert.ok(crackAlerts().at(-1)!.message.includes('compromised'));
  assert.ok(sim.s.players[black.id].heldCredentialIds.includes(credId), 'operative learns the cracked credential');
  assert.ok(sim.s.players[black.id].activity.some((a) => a.text.includes(code)), 'and their notes reveal the code');
});

test('Access / Code crack: revoking the target credential aborts the crack', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const [it] = sim.byRole('IT_SPECIALIST');
  grantMasterAccess(sim.s, black.id);
  const host = sim.code(black.id, 'HIDDEN_HOST', null);
  const reveal = sim.s.config.crackRevealSec;

  sim.at(2);
  sim.run(black.id, host, 'HIDDEN_HOST', 'ACCESS', 'CRACK_CODE', { target: 'SECURITY.MASTER_LOG' });
  const crackId = sim.s.cracks.at(-1)!.id;
  const credId = sim.s.cracks.at(-1)!.credentialId;

  sim.at(2 + reveal + 1);
  assert.equal(sim.s.cracks.find((k) => k.id === crackId)!.revealed, 1);
  assert.ok(sim.run(it.id, sim.code(it.id, 'SECURITY', 'PERMISSIONS'), 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: credId }).ok);

  sim.at(2 + reveal * 4 + 2);
  const k = sim.s.cracks.find((x) => x.id === crackId)!;
  assert.ok(k.done && k.revealed < 4, 'aborted before completion');
  assert.ok(!sim.s.players[black.id].heldCredentialIds.includes(credId), 'the operative never learns the code');
});

test('Access / Lockout bomb: locks the target out with failed attempts pinned on their own IP', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const target = Object.values(sim.s.players).find((p) => p.allegiance === 'WHITE' && p.id !== black.id)!;
  grantMasterAccess(sim.s, black.id);
  const host = sim.code(black.id, 'HIDDEN_HOST', null);

  sim.at(3);
  assert.match(sim.run(black.id, host, 'HIDDEN_HOST', 'ACCESS', 'LOCKOUT_BOMB', { target: 'nope' }).message, /No workstation/);
  const before = sim.s.players[target.id].failTotal;
  assert.ok(sim.run(black.id, host, 'HIDDEN_HOST', 'ACCESS', 'LOCKOUT_BOMB', { target: target.ip }).ok);

  assert.ok(sim.s.players[target.id].lockedUntil > 3, 'target is locked out');
  assert.equal(sim.s.players[target.id].failTotal, before + sim.s.config.lockoutAfterFails);
  const fails = sim.s.logs.filter((l) => l.kind === 'AUTH_FAIL' && l.sourceIp === target.ip);
  assert.equal(fails.length, sim.s.config.lockoutAfterFails, 'the failed attempts are pinned on the target\'s IP');
  assert.match(sim.s.alerts.find((a) => a.kind === 'UNAUTHORIZED_ACTION')!.message, /^Suspicious server activity$/);
  assert.match(sim.run(black.id, host, 'HIDDEN_HOST', 'ACCESS', 'LOCKOUT_BOMB', { target: target.ip }).message, /already locked out/);
});

test('Cleanup / Log wiper: hides a Master Log entry (id gap stays) but a Trace still reaches it', () => {
  const sim = new Sim({ traceCooldownSec: 0 });
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const [analyst] = sim.byRole('BANK_MANAGER');
  grantMasterAccess(sim.s, black.id);
  const host = sim.code(black.id, 'HIDDEN_HOST', null);
  const traceCode = sim.code(analyst.id, 'SECURITY', 'MASTER_LOG');
  const viewLog = () => sim.run(analyst.id, traceCode, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: 'ALL' }).lines!;

  sim.at(5);
  sim.run(black.id, sim.code(black.id, 'SECURITY', null), 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES'); // a normal, traceable entry
  const entry = sim.s.logs.filter((l) => l.kind === 'ACCESS').at(-1)!;
  assert.ok(viewLog().some((l) => l.includes(entry.id + ' ')), 'listed before the wipe');

  assert.ok(sim.run(black.id, host, 'HIDDEN_HOST', 'CLEANUP', 'LOG_WIPER', { logId: entry.id }).ok);
  assert.match(sim.run(black.id, host, 'HIDDEN_HOST', 'CLEANUP', 'LOG_WIPER', { logId: entry.id }).message, /already wiped/);

  assert.ok(!viewLog().some((l) => l.includes(entry.id + ' ')), 'gone from the log view');
  assert.equal(sim.s.logs.find((l) => l.id === entry.id)!.deleted, true, 'still in the log, flagged deleted (so the id gap shows)');

  const traced = sim.run(analyst.id, traceCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: entry.id });
  assert.ok(traced.ok && traced.message.includes(black.ip), traced.message);
  assert.match(sim.s.alerts.find((a) => a.kind === 'UNAUTHORIZED_ACTION')!.message, /^Suspicious server activity$/);
});

test('Cleanup / Alert mute: hides tier 1-2 alerts for 10s but never the loud tier 3-4 ones', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  grantMasterAccess(sim.s, black.id);
  const host = sim.code(black.id, 'HIDDEN_HOST', null);
  const reroute = () => sim.run(black.id, host, 'HIDDEN_HOST', 'INFILTRATION', 'REROUTE_IP', { proxy: '10.9.0.99', seconds: '10' });
  const spoofAlerts = () => sim.s.alerts.filter((a) => a.kind === 'UNAUTHORIZED_ACTION');

  sim.at(1);
  assert.ok(sim.run(black.id, host, 'HIDDEN_HOST', 'INFILTRATION', 'CREATE_PROXY', { ip: '10.9.0.99' }).ok);
  sim.s.alerts = []; // start counting from the mute

  sim.at(5);
  assert.ok(sim.run(black.id, host, 'HIDDEN_HOST', 'CLEANUP', 'ALERT_MUTE', {}).ok);
  assert.equal(spoofAlerts().length, 1, 'the mute raised its own alert');
  assert.equal(spoofAlerts()[0].tier, 3, 'and it is tier 3, so it is never muted');

  sim.at(8); // still inside the 10s window
  const warnings = () => sim.s.hostLog.filter((h) => h.alert).length;
  const warned = warnings();
  assert.ok(reroute().ok);
  assert.equal(spoofAlerts().length, 1, 'a tier-2 exposure is suppressed while muted');
  assert.equal(warnings(), warned, 'and the operatives are not warned about an alert the bank never got');
  assert.ok(sim.run(black.id, host, 'HIDDEN_HOST', 'INFILTRATION', 'CREATE_PROXY', { ip: '10.9.0.98' }).ok);
  assert.equal(spoofAlerts().length, 2, 'a tier-3 exposure still gets through');
  assert.equal(spoofAlerts().at(-1)!.tier, 3);

  sim.at(20); // past the window
  assert.ok(reroute().ok);
  assert.equal(spoofAlerts().length, 3, 'mute expired: tier-2 exposure fires again');
});



test('Employee Records: reset a lockout', () => {
  const sim = new Sim();
  const [analyst] = sim.byRole('IT_SPECIALIST'); // the only role with Employee Records write
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const used = new Set(Object.values(sim.s.credentials).map((c) => c.code));
  const bad = ['0000', '1111', '2222', '3333'].filter((c) => !used.has(c));
  const records = sim.code(analyst.id, 'SECURITY', 'EMPLOYEE_RECORDS');
  const reset = () => sim.run(analyst.id, records, 'SECURITY', 'EMPLOYEE_RECORDS', 'RESET_LOCKOUT', { address: pb.ip });
  sim.at(5);
  assert.match(reset().message, /is not locked out/);
  for (let i = 0; i < 3; i++) sim.run(pb.id, bad[i], 'SECURITY', 'MASTER_LOG', 'VIEW_LOG');
  assert.ok(sim.s.players[pb.id].lockedUntil > 5);
  const r = reset();
  assert.ok(r.ok, r.message);
  assert.equal(sim.lastLog(), `${analyst.name} reset the lockout on ${pb.ip} (${pb.name})`);
  assert.ok(sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS').ok, 'unlocked right away');
});

test('balances: fixed wealth split, every account funded, and only existing accounts can be added or pay', () => {
  const sim = new Sim();
  const s = sim.s;
  // 12 customers at 10 players: 20% wealthy, 30% mid, the rest small.
  const tiers = s.customers.map((c) => c.wealth);
  assert.deepEqual([tiers.filter((t) => t === 'WEALTHY').length, tiers.filter((t) => t === 'MID').length, tiers.filter((t) => t === 'SMALL').length], [2, 4, 6]);
  const total = (id: string) => s.customers.find((c) => c.id === id)!.accounts.reduce((a, acc) => a + s.balances[acc], 0);
  for (const c of s.customers) {
    const t = total(c.id);
    if (c.wealth === 'SMALL') assert.ok(t >= 240_000 && t <= 2_010_000, `${c.id} ${t}`);
    if (c.wealth === 'WEALTHY') assert.ok(t >= 29_990_000, `${c.id} ${t}`);
  }
  assert.ok(Object.values(s.balances).some((b) => b > 0 && b < 1_000_000), 'some accounts start under $1M');
  for (const tg of s.targets) assert.equal(s.balances[tg.account], 0, 'mule accounts start empty');
  for (const id of s.playerOrder) {
    const b = s.balances[s.players[id].bankAccount];
    assert.ok(b >= 1000 && b <= 100_000);
  }

  grantMasterAccess(s, 'p0');
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  const txc = sim.code('p0', 'TRANSACTIONS', null);
  const go = (module: string, fn: string, params: Record<string, string>) => sim.run('p0', txc, 'TRANSACTIONS', module, fn, params);
  sim.at(1);
  // A made-up number does not exist; a player's own account floats and can be added or pay.
  assert.equal(sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: 'CU1', account: '00001' }).message, 'There is no account ACC-00001.');
  const own = sim.s.players.p5.bankAccount;
  assert.ok(sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: 'CU1', account: own }).ok);

  // Settling moves the money at once; a payment the originator cannot cover FAILS at settlement.
  const payer = sim.s.customers.find((c) => c.wealth === 'SMALL')!;
  const payee = sim.s.customers.find((c) => c.id !== payer.id)!;
  const pay = (amount: number) => {
    go('PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: payer.primary, beneficiaryId: payee.id, amount: String(amount) });
    const id = sim.s.transactions.at(-1)!.id;
    go('RISK_CHECK', 'RUN_RISK_CHECK', { txId: id });
    go('AUTHORIZATION', 'APPROVE', { txId: id });
    return { id, r: go('SETTLEMENT', 'SETTLE', { txId: id }) };
  };
  const before = sim.s.balances[payer.primary];
  const into = sim.s.balances[payee.primary];
  const small = pay(10_000);
  assert.equal(sim.s.balances[payer.primary], before - 10_000);
  assert.equal(sim.s.balances[payee.primary], into + 10_000);
  assert.ok(small.r.ok);
  const big = pay(before);
  assert.match(big.r.message, /FAILED: insufficient funds/);
  const failed = sim.s.transactions.find((t) => t.id === big.id)!;
  assert.equal(failed.status, 'FAILED');
  assert.equal(sim.s.balances[payer.primary], before - 10_000, 'nothing moved');
  assert.ok(go('SETTLEMENT', 'VIEW_SETTLEMENT', { show: 'ALL' }).lines!.some((l) => l.startsWith(big.id) && l.includes('[FAILED]')));

  // A planted user's account number is made up: it does not exist.
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  grantMasterAccess(sim.s, black.id);
  assert.ok(plantAt(sim, black.id, 'Ghost', '10.9.0.99').ok);
  const fake = Object.values(sim.s.players).find((p) => p.fake)!;
  assert.match(fake.bankAccount, /^ACC-\d{5}$/);
  assert.equal(fake.bankAccount in sim.s.balances, false);
  assert.equal(getPlayerView(sim.s, 'p5').me.bankBalance, sim.s.balances[own]);
});

test('request deadlines: a follow-up halfway, then expiry, a complaint to the Bank Manager, and a walkout on the second', () => {
  // Only the two opening requests (both payments, not urgent), and no automatic traffic to get in the way.
  const sim = new Sim({ requestIntervalSec: 99999, npcIntervalSec: 99999, requestChangeShare: 0, urgentShare: 0 });
  const [r1, r2] = sim.s.requests;
  assert.equal(r1.dueAt, 120);
  assert.equal(r1.remindAt, 60);
  const [manager] = sim.byRole('BANK_MANAGER');
  const req = (id: string) => sim.s.requests.find((r) => r.id === id)!;
  const cust = () => sim.s.customers.find((c) => c.id === r1.customerId)!;
  const banker = () => sim.s.players[r1.bankerId!];

  // Archive the first; the halfway follow-up brings it back, on the same REQ id.
  grantMasterAccess(sim.s, 'p0');
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  sim.at(10);
  assert.ok(sim.run('p0', cd, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: r1.id, reason: 'looks odd' }).ok);
  assert.equal(req(r1.id).status, 'ARCHIVED');
  sim.at(61);
  assert.equal(req(r1.id).status, 'OPEN', 'the customer is still waiting: the request comes back');
  assert.equal(req(r1.id).reminders.length, 1);
  const inbox = banker().messages.at(-1)!;
  assert.equal(inbox.text, req(r1.id).reminders[0].text, 'the banker is pinged with the same follow-up');
  const who = cust().person ? cust().name : `${cust().contact} (${cust().name})`;
  assert.equal(getPlayerView(sim.s, banker().id).me.messages.at(-1)!.fromName, who);
  assert.ok(sim.s.logs.some((l) => l.message === `Client follow-up received on ${r1.id}`));
  const view = sim.run('p0', cd, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS', {}).lines!;
  assert.ok(view[0].startsWith(r1.id) && view[0].includes('REMINDER') && view[0].includes('due in 59s'), view[0]);
  assert.ok(view.some((l) => l.includes('follow-up:')) && view.some((l) => l.includes('archived earlier by') && l.includes('looks odd')), view.join('\n'));

  // Nobody acts: at the deadline it expires, the customer takes a strike and complains to the Bank Manager.
  sim.at(121);
  assert.equal(req(r1.id).status, 'EXPIRED');
  assert.equal(req(r1.id).outcome, 'MISSED');
  assert.equal(cust().strikes, 1);
  assert.equal(cust().suspended, false);
  const complaint = sim.s.players[manager.id].messages.find((m) => m.from === (cust().person ? cust().name : `${cust().contact} (${cust().name})`));
  assert.ok(complaint && complaint.text.includes(banker().name), 'the complaint names the banker');
  assert.ok(sim.s.logs.some((l) => l.message === `Customer complaint: ${r1.id} expired`));
  // An expired request can no longer be acted on.
  const txc = sim.code('p0', 'TRANSACTIONS', null);
  const late = sim.run('p0', txc, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: r1.originAccount!, beneficiaryId: r1.payeeId!, amount: String(r1.amount), requestId: r1.id });
  assert.equal(late.message, `${r1.id} has expired.`);

  // A second miss from the same customer: they stop doing business for the day.
  cust().strikes = 1;
  const again = { ...structuredClone(req(r2.id)), id: 'REQ-50', customerId: r1.customerId, bankerId: r1.bankerId, t: sim.sec, dueAt: sim.sec + 5, remindAt: sim.sec + 99, outcome: null, status: 'OPEN' as const, reminders: [] };
  sim.s.requests.push(again);
  sim.at(sim.sec + 6);
  assert.equal(cust().suspended, true);
  assert.equal(cust().strikes, 2);
  assert.ok(sim.s.logs.some((l) => l.message === `${cust().id} suspended business with the bank for today`));
  assert.ok(sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: 'ALL' }).lines!.some((l) => l.startsWith(cust().id) && l.includes('SUSPENDED')));
  // No new requests or automatic payments involve them from now on.
  sim.s.config.requestIntervalSec = 1;
  sim.s.config.npcIntervalSec = 1;
  const before = { req: sim.s.requests.length, tx: sim.s.transactions.length };
  sim.at(sim.sec + 60);
  const id = cust().id;
  assert.ok(sim.s.requests.length > before.req && sim.s.transactions.length > before.tx);
  assert.ok(!sim.s.requests.slice(before.req).some((r) => r.customerId === id || r.payeeId === id));
  assert.ok(!sim.s.transactions.slice(before.tx).some((t) => t.customerId === id || t.beneficiaryId === id));
});

test('request deadlines: paying as asked counts even when the request was archived instead of linked', () => {
  const sim = new Sim({ requestIntervalSec: 99999, npcIntervalSec: 99999, requestChangeShare: 0, urgentShare: 1 });
  const r = sim.s.requests[0];
  assert.equal(r.urgent, true);
  assert.equal(r.dueAt, 60, 'urgent requests have a minute');
  assert.ok(/urgent|time-critical|emergency|immediately|priority/i.test(r.text), r.text);
  grantMasterAccess(sim.s, 'p0');
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  const txc = sim.code('p0', 'TRANSACTIONS', null);
  const go = (module: string, fn: string, params: Record<string, string>) => sim.run('p0', txc, 'TRANSACTIONS', module, fn, params);
  sim.at(5);
  assert.ok(sim.run('p0', cd, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: r.id, reason: 'will pay it directly' }).ok);
  // The payment is made exactly as asked, without the request id.
  assert.ok(go('PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: r.originAccount!, beneficiaryId: r.payeeId!, amount: String(r.amount) }).ok);
  const tx = sim.s.transactions.at(-1)!;
  sim.at(31);
  const now = () => sim.s.requests.find((x) => x.id === r.id)!;
  assert.equal(now().reminders.length, 0, 'nothing to chase: the payment is on its way');
  assert.equal(now().status, 'DONE');
  assert.equal(now().txId, tx.id);
  go('RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  go('AUTHORIZATION', 'APPROVE', { txId: tx.id });
  const before = sim.s.totals.processed;
  assert.ok(go('SETTLEMENT', 'SETTLE', { txId: tx.id }).ok);
  assert.equal(sim.s.totals.processed - before, r.amount, 'it counts toward the bank target');
  sim.at(61);
  assert.equal(now().outcome, 'MET');
  assert.equal(sim.s.customers.find((c) => c.id === r.customerId)!.strikes, 0);
});

test('request deadlines: a scam request is never chased and expires without a complaint', () => {
  const sim = new Sim({ requestIntervalSec: 99999, npcIntervalSec: 99999 });
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  grantMasterAccess(sim.s, black.id);
  // A customer with no real request of their own, so no strike can come from elsewhere.
  const cust = sim.s.customers.find((c) => !sim.s.requests.some((r) => r.customerId === c.id))!;
  sim.at(1);
  const made = sim.run(black.id, sim.code(black.id, 'HIDDEN_HOST', null), 'HIDDEN_HOST', 'SOCIAL', 'SCAM_REQUEST', { customer: cust.id, kind: 'SET_PRIMARY', account: sim.s.targets[0].account });
  assert.ok(made.ok, made.message);
  const scam = sim.s.requests.at(-1)!;
  assert.equal(scam.dueAt, 121, 'it shows a deadline like any other request');
  const [manager] = sim.byRole('BANK_MANAGER');
  const managerMail = sim.s.players[manager.id].messages.length;
  sim.at(200);
  const now = sim.s.requests.find((r) => r.id === scam.id)!;
  assert.equal(now.reminders.length, 0);
  assert.equal(now.status, 'EXPIRED');
  assert.equal(sim.s.customers.find((c) => c.id === cust.id)!.strikes, 0);
  assert.ok(!sim.s.logs.some((l) => l.message === `Customer complaint: ${scam.id} expired`));
  assert.ok(sim.s.players[manager.id].messages.length >= managerMail);
});

test('phishing: every banker gets 1-5 obvious scam messages, from made-up customers, that stay open until archived', () => {
  const sim = new Sim({ requestIntervalSec: 99999, npcIntervalSec: 99999 });
  const bankers = sim.byRole('PERSONAL_BANKER').map((p) => p.id);
  for (const id of bankers) {
    const n = sim.s.phishSchedule.filter((x) => x.bankerId === id).length;
    assert.ok(n >= 1 && n <= 5, `${id}: ${n}`);
  }
  assert.ok(sim.s.phishSchedule.every((x) => bankers.includes(x.bankerId)), 'only Personal Bankers get them');
  const total = sim.s.phishSchedule.length;
  const [first] = sim.s.phishSchedule;
  sim.at(first.at);
  const p = sim.s.requests.find((r) => r.phish)!;
  assert.equal(p.bankerId, first.bankerId);
  assert.ok(!sim.s.customers.some((c) => c.id === p.customerId), `${p.customerId} is not a real customer`);
  assert.ok(p.text.includes(p.customerId), 'it claims the fake tag');
  const acct = p.text.match(/account (\d{5})/)![1];
  assert.equal(`ACC-${acct}` in sim.s.balances, false, 'the account it names does not exist');
  assert.equal(p.originAccount, null);
  assert.ok(sim.s.logs.some((l) => l.message === `Client request ${p.id} received`), 'logged like any request');

  // The banker sees it like any other request, from its made-up sender.
  const code = sim.code(p.bankerId!, 'CLIENT_DATA', 'CLIENT_REQUESTS');
  const view = sim.run(p.bankerId!, code, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS').lines!;
  assert.ok(view.some((l) => l.startsWith(p.id) && l.includes(`${p.sender} -> `)), view.join('\n'));
  assert.ok(!view.find((l) => l.startsWith(p.id))!.includes('due in'), 'no deadline');

  // Nobody chases it or complains, and it never expires.
  assert.ok(sim.run(p.bankerId!, code, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'ARCHIVE_REQUEST', { requestId: p.id, reason: 'obvious phishing' }).ok);
  const mail = Object.values(sim.s.players).reduce((n, x) => n + x.messages.length, 0);
  for (let t = sim.sec; t < sim.s.config.durationSec - 1; t += 10) sim.at(t);
  const now = sim.s.requests.find((r) => r.id === p.id)!;
  assert.equal(now.reminders.length, 0);
  assert.equal(now.outcome, null);
  assert.equal(now.status, 'ARCHIVED');
  assert.equal(Object.values(sim.s.players).reduce((n, x) => n + x.messages.length, 0) >= mail, true);
  assert.equal(sim.s.requests.filter((r) => r.phish).length, total, 'all of them arrived');
  const open = sim.s.requests.filter((r) => r.phish && r.id !== p.id);
  assert.ok(open.length > 0 && open.every((r) => r.status === 'OPEN' && r.outcome === null), 'the rest are still open at close of business');
  assert.ok(sim.s.customers.every((c) => c.strikes === 0 || !sim.s.requests.some((r) => r.phish && r.customerId === c.id)));
});

test('security alerts: firewall shutdowns and credential revocations raise alerts naming the credential owner', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const fwRun = (fn: string, q: Record<string, string>) => sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', fn, q);
  const last = () => sim.s.alerts.at(-1)!;
  sim.at(2);

  assert.ok(fwRun('BLOCK_ADDRESS', { address: ar.ip }).ok);
  assert.equal(last().kind, 'SECURITY_SUSPICIOUS');
  assert.equal(last().message, `Suspicious security activity: ${admin.name} blocked ${ar.ip} for ${sim.s.config.blockSec}s`);
  assert.equal(last().logId, sim.s.logs.at(-1)!.id);
  assert.ok(fwRun('SET_SECURITY', { target: 'TRANSACTIONS.SETTLEMENT', security: 'OFF' }).ok);
  assert.match(last().message, /switched security OFF for Settlement/);
  assert.ok(fwRun('SET_MODULE_STATUS', { target: 'TRANSACTIONS.RISK_CHECK', status: 'OFFLINE' }).ok);
  assert.match(last().message, /took .* offline/);

  // Restoring things is not suspicious.
  const n = sim.s.alerts.length;
  assert.ok(fwRun('UNBLOCK_ADDRESS', { address: ar.ip }).ok);
  assert.ok(fwRun('SET_SECURITY', { target: 'TRANSACTIONS.SETTLEMENT', security: 'ON' }).ok);
  assert.ok(fwRun('SET_MODULE_STATUS', { target: 'TRANSACTIONS.RISK_CHECK', status: 'ONLINE' }).ok);
  assert.equal(sim.s.alerts.length, n);

  // Status lists the modules first, then pending revocations and blocks.
  assert.ok(fwRun('BLOCK_ADDRESS', { address: ar.ip }).ok);
  assert.ok(fwRun('REVOKE_ALL_ACCESS', { address: ar.ip }).ok);
  assert.equal(last().kind, 'SECURITY_FATAL');
  assert.equal(last().tier, 3);
  const lines = fwRun('VIEW_STATUS', {}).lines!;
  const firstExtra = lines.findIndex((l) => /^(PENDING|BLOCKED)/.test(l));
  assert.ok(firstExtra > 0 && lines.slice(firstExtra).every((l) => /^(PENDING|BLOCKED)/.test(l)));

  // The revocation going through is fatal too, and says how many credentials it took.
  sim.at(sim.sec + sim.s.config.revokeCountdownSec + 1);
  assert.equal(last().kind, 'SECURITY_FATAL');
  const revoked = Object.values(sim.s.credentials).filter((cr) => cr.owner === ar.id && cr.system !== 'WORKSTATION').length;
  assert.equal(last().message, `Fatal security activity: Firewall: all access revoked for ${ar.ip} (R1), ${revoked} of ${ar.name}'s credentials revoked`);

  // Revoking a single credential.
  const [banker] = sim.byRole('PERSONAL_BANKER');
  const cred = Object.values(sim.s.credentials).find((cr) => cr.owner === banker.id)!;
  assert.ok(sim.run(admin.id, sim.code(admin.id, 'SECURITY', 'PERMISSIONS'), 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: cred.id }).ok);
  assert.equal(last().message, `Suspicious security activity: ${admin.name} revoked credential ${cred.id} (${banker.name})`);
});

test('permissions: security write credentials are revoked after a cancellable countdown; issuing one is fatal', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('IT_SPECIALIST');
  const [manager] = sim.byRole('BANK_MANAGER');
  const [banker] = sim.byRole('PERSONAL_BANKER');
  const perms = (pid: string) => sim.code(pid, 'SECURITY', 'PERMISSIONS');
  const run = (pid: string, fn: string, q: Record<string, string>) => sim.run(pid, perms(pid), 'SECURITY', 'PERMISSIONS', fn, q);
  const last = () => sim.s.alerts.at(-1)!;
  const mgrPerms = Object.values(sim.s.credentials).find((cr) => cr.owner === manager.id && cr.module === 'PERMISSIONS')!;
  sim.at(2);

  // Started, not done: the credential still works, the alert is fatal, and the owner is told.
  assert.ok(run(admin.id, 'REVOKE_CREDENTIAL', { credentialId: mgrPerms.id }).ok);
  assert.equal(sim.s.credentials[mgrPerms.id].status, 'ACTIVE');
  assert.equal(last().kind, 'SECURITY_FATAL');
  assert.ok(sim.s.players[manager.id].activity.some((a) => a.text.includes(`${mgrPerms.id}`) && a.text.includes('will be revoked')));
  assert.match(run(admin.id, 'REVOKE_CREDENTIAL', { credentialId: mgrPerms.id }).message, /already being revoked/);
  assert.ok(run(manager.id, 'VIEW_PERMISSIONS', {}).lines![0].startsWith(`PENDING  revoke ${mgrPerms.id}`));

  // The owner cancels it with the very credential under threat.
  assert.ok(run(manager.id, 'CANCEL_REVOKE', { credentialId: mgrPerms.id }).ok);
  sim.at(2 + sim.s.config.revokeCountdownSec + 1);
  assert.equal(sim.s.credentials[mgrPerms.id].status, 'ACTIVE');
  assert.match(run(manager.id, 'CANCEL_REVOKE', { credentialId: mgrPerms.id }).message, /not being revoked/);

  // Left alone, it goes through.
  assert.ok(run(admin.id, 'REVOKE_CREDENTIAL', { credentialId: mgrPerms.id }).ok);
  sim.at(sim.sec + sim.s.config.revokeCountdownSec + 1);
  assert.equal(sim.s.credentials[mgrPerms.id].status, 'REVOKED');
  assert.ok(last().message.endsWith(`Credential ${mgrPerms.id} (${manager.name}) revoked, as started by ${admin.name}`));

  // Other credentials go at once.
  const bankerCred = Object.values(sim.s.credentials).find((cr) => cr.owner === banker.id)!;
  assert.ok(run(admin.id, 'REVOKE_CREDENTIAL', { credentialId: bankerCred.id }).ok);
  assert.equal(sim.s.credentials[bankerCred.id].status, 'REVOKED');
  assert.equal(last().kind, 'SECURITY_SUSPICIOUS');

  // Issuing: any credential is suspicious, Firewall or Permissions write is fatal.
  assert.ok(run(admin.id, 'CREATE_CREDENTIAL', { owner: banker.id, scope: 'CLIENT_DATA.CUSTOMER_RECORDS', permission: 'READ' }).ok);
  assert.equal(last().kind, 'SECURITY_SUSPICIOUS');
  assert.match(last().message, new RegExp(`${admin.name} issued credential C[0-9]+ to ${banker.name}`));
  assert.ok(run(admin.id, 'CREATE_CREDENTIAL', { owner: banker.id, scope: 'SECURITY.PERMISSIONS', permission: 'WRITE' }).ok);
  assert.equal(last().kind, 'SECURITY_FATAL');
  assert.ok(run(admin.id, 'CREATE_CREDENTIAL', { owner: banker.id, scope: 'SECURITY.*', permission: 'WRITE' }).ok);
  assert.equal(last().kind, 'SECURITY_FATAL');
});

test('notifications: a page bell needs write access, and pops up only other people\'s activity', () => {
  const sim = new Sim();
  const [it1, it2] = sim.byRole('IT_SPECIALIST');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const [banker] = sim.byRole('PERSONAL_BANKER');
  const watch = (pid: string, system: SystemId, module: string, on = true) => sim.do({ type: 'SET_WATCH', playerId: pid, system, module, on });
  const notes = (pid: string) => sim.s.players[pid].notifications.map((n) => n.text);
  sim.at(2);

  // Write access only: A&R cannot watch the Firewall; pages without a bell are refused.
  assert.match(watch(ar.id, 'SECURITY', 'FIREWALL').message, /need write access/);
  assert.match(watch(ar.id, 'CLIENT_DATA', 'CLIENT_REQUESTS').message, /need write access/);
  assert.ok(watch(it1.id, 'SECURITY', 'FIREWALL').ok);
  assert.ok(watch(it1.id, 'SECURITY', 'PERMISSIONS').ok);
  assert.ok(watch(it1.id, 'SECURITY', 'MASTER_LOG').ok);
  assert.ok(watch(ar.id, 'TRANSACTIONS', 'RISK_CHECK').ok);
  assert.ok(watch(ar.id, 'TRANSACTIONS', 'SETTLEMENT').ok);
  assert.ok(watch(banker.id, 'CLIENT_DATA', 'CLIENT_REQUESTS').ok);

  // Someone else's Firewall activity notifies; your own does not.
  const fw2 = sim.code(it2.id, 'SECURITY', 'FIREWALL');
  assert.ok(sim.run(it2.id, fw2, 'SECURITY', 'FIREWALL', 'BLOCK_ADDRESS', { address: ar.ip }).ok);
  assert.ok(notes(it1.id).includes(`${it2.name} blocked ${ar.ip} for ${sim.s.config.blockSec}s`));
  assert.ok(notes(it1.id).some((n) => n.startsWith('Suspicious security activity')), 'the Master Log bell pops up the alert');
  const before = notes(it1.id).length;
  assert.ok(sim.run(it1.id, sim.code(it1.id, 'SECURITY', 'FIREWALL'), 'SECURITY', 'FIREWALL', 'UNBLOCK_ADDRESS', { address: ar.ip }).ok);
  assert.equal(notes(it1.id).length, before, 'own activity is not notified');

  // Using someone else's code counts as theirs: the owner of the code is notified of it.
  assert.ok(sim.run(it1.id, sim.code(it2.id, 'SECURITY', 'PERMISSIONS'), 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', {}).ok);
  assert.ok(notes(it1.id).some((n) => n.startsWith(`${it2.name} `)));

  // Payments: new ones wait for a score; the banker's own requests and follow-ups arrive.
  for (let t = 10; t <= 400; t += 10) sim.at(t);
  assert.ok(notes(ar.id).some((n) => n.includes('waiting for a risk score')));
  const mine = sim.s.requests.filter((r) => r.bankerId === banker.id).map((r) => r.id);
  const reqNotes = notes(banker.id).filter((n) => n.startsWith('New request') || n.startsWith('Follow-up'));
  assert.ok(reqNotes.length > 0);
  assert.ok(reqNotes.every((n) => mine.some((id) => n.includes(`${id} `))), 'only their own customers');

  // Losing write access silences the bell.
  for (const cr of Object.values(sim.s.credentials)) if (cr.owner === ar.id && cr.module === 'RISK_CHECK') cr.status = 'REVOKED';
  sim.s.players[ar.id].notifications = [];
  const txBefore = sim.s.transactions.length;
  for (let t = 410; t <= 600; t += 10) sim.at(t);
  assert.ok(sim.s.transactions.length > txBefore, 'payments kept arriving');
  assert.ok(!notes(ar.id).some((x) => x.includes('waiting for a risk score')));

  // Switching it off.
  assert.ok(watch(it1.id, 'SECURITY', 'FIREWALL', false).ok);
  assert.ok(!sim.s.players[it1.id].watching.includes('SECURITY.FIREWALL'));
});

test('notifications: each role starts with its usual bells on, all on pages it can write', () => {
  const sim = new Sim();
  const expected: Record<RoleId, string[]> = {
    IT_SPECIALIST: ['SECURITY.EMPLOYEE_RECORDS'],
    PERSONAL_BANKER: ['CLIENT_DATA.CLIENT_REQUESTS', 'TRANSACTIONS.AUTHORIZATION'],
    ACCOUNTS_RECEIVABLES: ['CLIENT_DATA.VERIFICATION', 'TRANSACTIONS.RISK_CHECK', 'TRANSACTIONS.SETTLEMENT'],
    BANK_MANAGER: ['SECURITY.MASTER_LOG'],
  };
  for (const p of Object.values(sim.s.players)) {
    // Operatives also start with the hidden host's bells: Host Log, Blacknet and their kit's, if it has one.
    const kit = Object.values(sim.s.credentials).filter((c) => c.owner === p.id && c.module === 'ACCESS').map(() => 'HIDDEN_HOST.ACCESS');
    const host = p.allegiance === 'BLACK' ? ['HIDDEN_HOST.HOST_LOG', 'HIDDEN_HOST.BLACKNET', ...kit] : [];
    assert.deepEqual(p.watching, [...expected[p.role], ...host], p.role);
    for (const key of p.watching) {
      const [system, module] = key.split('.');
      assert.ok(Object.values(sim.s.credentials).some((c) => c.owner === p.id && c.system === system && c.module === module && c.permission === 'WRITE'), `${p.role} can write ${key}`);
    }
  }
});

// ---- Termination and the end of the game ----------------------------------------------

const INVALID = 'ERROR: Your credentials are invalid.';
const whiteIt = (sim: Sim): Player => sim.byRole('IT_SPECIALIST').find((p) => p.allegiance === 'WHITE')!;

test('termination: losing every bank credential disables a player for good', () => {
  const sim = new Sim();
  const admin = whiteIt(sim);
  const pb = sim.byRole('PERSONAL_BANKER').find((p) => p.allegiance === 'WHITE')!;
  const perm = sim.code(admin.id, 'SECURITY', 'PERMISSIONS');
  const revoke = (id: string) => sim.run(admin.id, perm, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: id });
  const records = sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');
  sim.at(5);
  const ids = Object.values(sim.s.credentials).filter((c) => c.owner === pb.id && c.system !== 'WORKSTATION').map((c) => c.id);
  for (const id of ids.slice(0, -1)) assert.ok(revoke(id).ok);
  assert.equal(sim.s.players[pb.id].terminated, null, 'one credential left');
  assert.ok(revoke(ids.at(-1)!).ok);
  assert.deepEqual(sim.s.players[pb.id].terminated, { t: 5, reason: 'CREDENTIALS' });
  assert.ok(sim.s.logs.some((l) => l.kind === 'TERMINATED' && l.message.startsWith(`${pb.name} (${pb.ip}) terminated`)));
  assert.ok(getPlayerView(sim.s, pb.id).me.terminated);

  // Nothing on the bank works any more, not even with someone else's code.
  assert.equal(sim.run(pb.id, records, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS').message, INVALID);
  assert.equal(sim.run(pb.id, perm, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS').message, INVALID);
  assert.equal(sim.do({ type: 'CONNECT', playerId: pb.id, address: admin.ip }).message, INVALID);

  // No coming back, and Employee Records say so.
  const issue = sim.run(admin.id, perm, 'SECURITY', 'PERMISSIONS', 'CREATE_CREDENTIAL', { owner: pb.id, scope: 'CLIENT_DATA.*', permission: 'WRITE' });
  assert.match(issue.message, /terminated and cannot be issued credentials/);
  const rows = sim.run(admin.id, sim.code(admin.id, 'SECURITY', 'EMPLOYEE_RECORDS'), 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES').lines!;
  assert.ok(rows.find((l) => l.startsWith(pb.name))!.includes('[TERMINATED 00:05]'));
  assert.equal(sim.s.status, 'RUNNING');
});

test('termination: a revoked IP disables a Thief on the bank, but not on the unregistered host', () => {
  const sim = new Sim();
  const admin = whiteIt(sim);
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  sim.at(2);
  assert.ok(sim.run(admin.id, sim.code(admin.id, 'SECURITY', 'FIREWALL'), 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: black.ip }).ok);
  sim.at(3 + sim.s.config.revokeCountdownSec);
  assert.equal(sim.s.players[black.id].terminated?.reason, 'IP_REVOKED');
  assert.equal(sim.run(black.id, sim.code(black.id, 'SECURITY', 'EMPLOYEE_RECORDS'), 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES').message, INVALID);
  assert.equal(sim.do({ type: 'CONNECT', playerId: black.id, address: admin.ip }).message, INVALID);
  // The host is outside the bank's firewall: its credentials survive and it still answers.
  assert.ok(Object.values(sim.s.credentials).filter((c) => c.owner === black.id && c.system === 'HIDDEN_HOST').every((c) => c.status === 'ACTIVE'));
  assert.ok(sim.do({ type: 'CONNECT', playerId: black.id, address: sim.s.hiddenHost }).ok);
  const read = sim.run(black.id, sim.code(black.id, 'HIDDEN_HOST', 'BLACKNET'), 'HIDDEN_HOST', 'BLACKNET', 'READ_MESSAGES');
  assert.ok(read.ok, read.message);
});

test('the bank wins at once when every Thief is terminated; the end screen shows both teams', () => {
  const sim = new Sim();
  const admin = whiteIt(sim);
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const blacks = Object.values(sim.s.players).filter((p) => p.allegiance === 'BLACK');
  sim.at(2);
  // One revocation counts down at a time: revoke each Thief in turn.
  for (const b of blacks) {
    assert.equal(getPlayerView(sim.s, admin.id).end, null, 'no end screen while the game runs');
    assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: b.ip }).ok);
    sim.at(sim.sec + sim.s.config.revokeCountdownSec + 1);
  }
  assert.equal(sim.s.status, 'ENDED');
  assert.equal(sim.s.winner, 'WHITE');
  assert.equal(sim.s.endKind, 'THIEVES_TERMINATED');
  for (const b of blacks) assert.ok(sim.s.endReason!.includes(b.name));

  const end = getPlayerView(sim.s, blacks[0].id).end!;
  assert.equal(end.headline, 'The Bank wins');
  const [white, black] = end.teams;
  assert.equal(white.side, 'WHITE');
  assert.ok(white.won && !black.won);
  assert.equal(white.members.length, 7);
  assert.deepEqual(black.members.map((m) => m.name).sort(), blacks.map((b) => b.name).sort());
  assert.ok(black.members.every((m) => m.terminated));
  assert.equal(black.made, sim.s.totals.stolen);
});

test('embezzlement: payments settled into an employee account count toward no goal, and show on the end screen', () => {
  const sim = new Sim({ durationSec: 120 });
  grantMasterAccess(sim.s, 'p0');
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  const txc = sim.code('p0', 'TRANSACTIONS', null);
  const npc = sim.s.transactions[0]; // an automatic payment: it would normally count for the bank
  sim.at(1);
  const add = sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: npc.beneficiaryId, account: sim.s.players.p0.bankAccount, makePrimary: 'YES' });
  assert.ok(add.ok, add.message);
  const before = sim.s.totals;
  for (const [mod, fn] of [['RISK_CHECK', 'RUN_RISK_CHECK'], ['AUTHORIZATION', 'APPROVE'], ['SETTLEMENT', 'SETTLE']]) {
    const r = sim.run('p0', txc, 'TRANSACTIONS', mod, fn, { txId: npc.id });
    assert.ok(r.ok, r.message);
  }
  assert.deepEqual(sim.s.totals, before, 'neither the bank nor the Thieves are credited');

  sim.at(121);
  const members = getPlayerView(sim.s, 'p1').end!.teams.flatMap((t) => t.members);
  const me = members.find((m) => m.name === sim.s.players.p0.name)!;
  assert.equal(me.embezzled, npc.amount);
  assert.ok(members.filter((m) => m !== me).every((m) => m.embezzled === 0));
});

test('termination: a planted user with no credentials yet is not terminated, but is once its credentials are revoked', () => {
  const sim = new Sim();
  const admin = whiteIt(sim);
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  grantMasterAccess(sim.s, black.id);
  sim.at(2);
  assert.ok(plantAt(sim, black.id, 'Ghost', '10.9.0.99').ok);
  const fake = Object.values(sim.s.players).find((p) => p.fake)!;
  sim.at(10);
  assert.equal(sim.s.players[fake.id].terminated, null, 'nothing issued yet');

  const perm = sim.code(admin.id, 'SECURITY', 'PERMISSIONS');
  assert.ok(sim.run(admin.id, perm, 'SECURITY', 'PERMISSIONS', 'CREATE_CREDENTIAL', { owner: fake.id, scope: 'CLIENT_DATA.*', permission: 'READ' }).ok);
  const cred = Object.values(sim.s.credentials).find((c) => c.owner === fake.id)!;
  assert.equal(sim.s.players[fake.id].terminated, null);
  assert.ok(sim.run(admin.id, perm, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: cred.id }).ok);
  assert.equal(sim.s.players[fake.id].terminated?.reason, 'CREDENTIALS');
});

test('Social / Scam request can ask for a payment; paying it never counts for the bank', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  grantMasterAccess(sim.s, black.id);
  grantMasterAccess(sim.s, 'p0');
  const host = sim.code(black.id, 'HIDDEN_HOST', null);
  const [from, payee] = sim.s.customers;
  const scam = (params: Record<string, string>) => sim.run(black.id, host, 'HIDDEN_HOST', 'SOCIAL', 'SCAM_REQUEST', { customer: from.id, kind: 'PAYMENT', ...params });
  sim.at(2);
  assert.match(scam({ payee: from.name, amount: '400000' }).message, /cannot ask to pay themselves/);
  assert.match(scam({ payee: payee.id, amount: String(sim.s.config.maxManualAmount + 1) }).message, /cannot pay more than/);
  assert.match(scam({ payee: 'Nobody Ltd', amount: '400000' }).message, /No payee/);

  const planted = scam({ payee: payee.name, amount: '$400,000', urgent: 'YES' });
  assert.ok(planted.ok, planted.message);
  const req = sim.s.requests.at(-1)!;
  assert.equal(req.kind, 'PAYMENT');
  assert.ok(req.scam && req.urgent);
  assert.equal(req.payeeId, payee.id);
  assert.equal(req.amount, 400_000);
  assert.equal(req.dueAt - req.t, sim.s.config.urgentDeadlineSec);
  assert.ok(req.text.includes(payee.name) && req.text.includes('$400,000'), req.text);
  assert.ok(sim.s.logs.some((l) => l.message === `Client request ${req.id} received`), 'arrives like any other request');

  // The banker falls for it: the request is done, the money moves, the bank gains nothing.
  const txc = sim.code('p0', 'TRANSACTIONS', null);
  const made = sim.run('p0', txc, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: from.primary, beneficiaryId: payee.id, amount: '400000', requestId: req.id });
  assert.ok(made.ok, made.message);
  assert.equal(sim.s.requests.find((r) => r.id === req.id)!.status, 'DONE');
  const id = sim.s.transactions.at(-1)!.id;
  const before = sim.s.totals.processed;
  for (const [mod, fn] of [['RISK_CHECK', 'RUN_RISK_CHECK'], ['AUTHORIZATION', 'APPROVE'], ['SETTLEMENT', 'SETTLE']]) {
    const r = sim.run('p0', txc, 'TRANSACTIONS', mod, fn, { txId: id });
    assert.ok(r.ok, r.message);
  }
  assert.equal(sim.s.transactions.at(-1)!.status, 'SETTLED');
  assert.equal(sim.s.totals.processed, before);
});

test('Infiltration / Reroute IP: any workstation or the server itself can be rerouted, and every clue shows the proxy', () => {
  const sim = new Sim({ traceCooldownSec: 0 });
  const [black, mate] = Object.values(sim.s.players).filter((p) => p.allegiance === 'BLACK');
  const [analyst] = sim.byRole('BANK_MANAGER');
  grantMasterAccess(sim.s, black.id);
  const traceCode = sim.code(analyst.id, 'SECURITY', 'MASTER_LOG');
  const trace = (logId: string) => sim.run(analyst.id, traceCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId }).message;
  sim.at(1);
  for (const ip of ['10.9.0.77', '10.9.0.78']) assert.ok(hostRun(sim, black.id, 'CREATE_PROXY', { ip }).ok);
  const reroute = (source: string, proxy: string) => hostRun(sim, black.id, 'REROUTE_IP', { source, proxy, seconds: '30' });

  // Only a workstation or the server can be rerouted.
  assert.match(reroute('10.0.0.30', '10.9.0.77').message, /workstation's IP or the server's address/);

  // Another operative's workstation: their records show the proxy.
  sim.at(5);
  assert.ok(reroute(mate.ip, '10.9.0.77').ok);
  assert.ok(sim.run(mate.id, sim.code(mate.id, 'SECURITY', 'EMPLOYEE_RECORDS'), 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES').ok);
  assert.equal(sim.s.logs.filter((l) => l.kind === 'ACCESS').at(-1)!.sourceIp, '10.9.0.77');

  // The operative's own workstation and the server: now even a loud (tier 3) exposure leaks only proxies.
  assert.ok(reroute('', '10.9.0.78').ok);
  assert.match(reroute(sim.s.hiddenHost, '10.9.0.77').message, /carrying a reroute/, 'one reroute per proxy');
  assert.ok(hostRun(sim, black.id, 'CREATE_PROXY', { ip: '10.9.0.79' }).ok);
  assert.ok(reroute(sim.s.hiddenHost, '10.9.0.79').ok);
  assert.ok(hostRun(sim, black.id, 'CREATE_PROXY', { ip: '10.9.0.80' }).ok); // tier 3
  const loudEntry = sim.s.alerts.filter((a) => a.kind === 'UNAUTHORIZED_ACTION').at(-1)!.logId!;
  for (let i = 0; i < 12; i++) {
    const clue = trace(loudEntry);
    assert.ok(clue.includes('10.9.0.78') || clue.includes('10.9.0.79'), clue);
    assert.ok(!clue.includes(black.ip) && !clue.includes(sim.s.hiddenHost), clue);
  }
  // Vague clues about the server give away numbers of the proxy, never the real address.
  const entry = sim.s.logs.find((l) => l.id === loudEntry)!;
  assert.equal(entry.server, '10.9.0.79');

  // Once the reroutes wear off, new records show the real addresses again.
  sim.at(40);
  assert.ok(hostRun(sim, black.id, 'CREATE_PROXY', { ip: '10.9.0.81' }).ok);
  const later = sim.s.logs.filter((l) => l.kind === 'HIDDEN_ACCESS').at(-1)!;
  assert.equal(later.sourceIp, black.ip);
  assert.equal(later.server, sim.s.hiddenHost);
});

test('typing a proxy address into the network finds a relay, and shows whether traffic goes through it now', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const white = Object.values(sim.s.players).find((p) => p.allegiance === 'WHITE')!;
  grantMasterAccess(sim.s, black.id);
  const connect = () => sim.do({ type: 'CONNECT', playerId: white.id, address: '10.9.0.77' });
  sim.at(2);
  assert.equal(connect().message, 'No route to host.', 'not a proxy yet');
  assert.ok(hostRun(sim, black.id, 'CREATE_PROXY', { ip: '10.9.0.77' }).ok);
  assert.deepEqual(connect().proxy, { ip: '10.9.0.77', relaying: false });
  assert.ok(hostRun(sim, black.id, 'REROUTE_IP', { proxy: '10.9.0.77', seconds: '10' }).ok);
  assert.deepEqual(connect().proxy, { ip: '10.9.0.77', relaying: true });
  sim.at(13);
  assert.equal(connect().proxy!.relaying, false, 'the reroute ended');
});

test('nothing in the starting order gives anyone away: no C gaps in Permissions, Employee Records by address', () => {
  const sim = new Sim();
  const admin = whiteIt(sim);
  const perm = sim.run(admin.id, sim.code(admin.id, 'SECURITY', 'PERMISSIONS'), 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', { show: 'ALL' }).lines!;
  const ids = perm.map((l) => Number(/^C(\d+)\s/.exec(l)![1]));
  assert.deepEqual(ids, ids.map((_, i) => i + 1), 'C1..Cn with no gaps');
  assert.ok(Object.values(sim.s.credentials).filter((c) => c.system === 'HIDDEN_HOST').every((c) => /^X\d+$/.test(c.id)));

  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  grantMasterAccess(sim.s, black.id);
  assert.ok(plantAt(sim, black.id, 'Ghost', '10.1.0.1').ok);
  const rec = sim.run(admin.id, sim.code(admin.id, 'SECURITY', 'EMPLOYEE_RECORDS'), 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES').lines!;
  const ips = rec.filter((_, i) => i % 2 === 0).map((l) => /(10\.\d+\.\d+\.\d+)/.exec(l)![1]);
  assert.equal(ips[0], '10.1.0.1', 'the planted user sorts by address, not last');
  const key = (ip: string) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
  assert.deepEqual(ips, [...ips].sort((a, b) => key(a) - key(b)));
});

test('two-player test: one Personal Banker and one A&R, no Thieves, a 3-player economy', () => {
  const s = createGame({ seed: 3, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], now: T0, scenario: 'DUO' });
  assert.deepEqual(Object.values(s.players).map((p) => p.role).sort(), ['ACCOUNTS_RECEIVABLES', 'PERSONAL_BANKER']);
  assert.ok(Object.values(s.players).every((p) => p.allegiance === 'WHITE'));
  assert.equal(s.config.whiteTarget, 15_000_000 * 3);
  assert.equal(s.customers.length, 3);
  assert.equal(s.config.requestIntervalSec, 90);
  // With no Thieves there is no heist to win or stop: the game runs to close of business.
  assert.equal(tick(s, T0 + 60_000).status, 'RUNNING');
  assert.throws(() => createGame({ seed: 1, players: [{ id: 'a', name: 'A' }], now: T0, scenario: 'DUO' }), /exactly 2/);
});

test('solo test: scripted regular employees work the bank, and the IT bot traces the human the moment it can', () => {
  let s = createGame({ seed: 5, players: [{ id: 'me', name: 'Me' }], now: T0, scenario: 'SOLO' });
  const me = s.players.me;
  assert.equal(me.allegiance, 'BLACK');
  assert.equal(me.role, 'ACCOUNTS_RECEIVABLES');
  assert.equal(Object.values(s.players).filter((p) => p.bot && p.allegiance === 'WHITE').length, 5);
  assert.equal(s.config.whiteTarget, 15_000_000 * 6);
  // A wrong code raises an alert; the IT bot traces it and finds the human's workstation.
  const r = applyAction(s, { type: 'EXECUTE', playerId: 'me', code: '0000', system: 'CLIENT_DATA', module: 'CUSTOMER_RECORDS', fn: 'VIEW_CUSTOMERS' }, T0 + 1000);
  s = tick(r.state, T0 + 2000);
  const sc = s.scenario!;
  assert.equal(sc.traceLog.length, 1);
  assert.deepEqual(sc.traceLog[0].exposes, ['IP']);
  assert.equal(sc.exposedIpAt, 2);
  assert.equal(sc.exposedHostAt, null);
  // The bots act on requests and move payments through to settlement.
  for (let t = 3; t <= 300; t++) s = tick(s, T0 + t * 1000); // the host ticks often; bots act on each tick
  assert.ok(s.requests.some((q) => q.status === 'DONE' && s.players[q.closedBy!]?.bot), 'a banker bot did a request');
  assert.ok(s.transactions.some((tx) => tx.status === 'SETTLED' && tx.origin === 'PLAYER'), 'a requested payment was settled');
});

test('client requests arrive at uneven gaps around the average, the first one sooner', () => {
  const s0 = createGame({ seed: 8, players: PLAYERS, now: T0, config: { strikesToSuspend: 999 } }); // nobody walks out
  // Two requests wait at the start; the next comes after half a gap (jittered), bent by the slow morning.
  assert.equal(s0.requests.filter((r) => !r.phish).length, 2);
  assert.ok(s0.nextRequestAt < nextArrival(s0.config.durationSec, 0, s0.config.requestIntervalSec * 0.75 + 1e-9), `first at ${s0.nextRequestAt}`);
  let s = s0;
  for (let t = 1; t <= s.config.durationSec; t++) s = tick(s, T0 + t * 1000);
  const times = s.requests.filter((r) => !r.phish && r.t > 0 && !r.scam).map((r) => r.t);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(new Set(gaps.map((g) => g.toFixed(2))).size > gaps.length / 2, 'gaps vary');
  const expected = s.config.durationSec / s.config.requestIntervalSec;
  assert.ok(Math.abs(times.length - expected) < expected * 0.3, `${times.length} requests, ~${expected} expected`);
});

test('customers go by the accounts they believe they have: unasked changes to their file are invisible to them', () => {
  const sim = new Sim({ automation: EVERYTHING, strikesToSuspend: 999, blackTarget: 1e12 });
  grantMasterAccess(sim.s, 'p0');
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  // The richest customer: a mule becomes their primary, and their real primary is taken off the file.
  const x = [...sim.s.customers].sort((a, b) => sim.s.balances[b.primary] - sim.s.balances[a.primary])[0];
  const realPrimary = x.primary;
  const mule = sim.s.targets[0].account;
  assert.ok(sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: x.id, account: mule, makePrimary: 'YES' }).ok);
  assert.ok(sim.run('p0', cd, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'REMOVE_ACCOUNT', { customerId: x.id, account: realPrimary }).ok);
  sim.s.balances[mule] = 50_000_000; // tempting, but they don't know it is theirs
  const cust = () => sim.s.customers.find((c) => c.id === x.id)!;
  assert.equal(cust().known.primary, realPrimary);
  assert.ok(!cust().known.accounts.includes(mule));
  for (let t = 1; t <= 900; t += 1) sim.at(t);
  const fromMule = sim.s.transactions.filter((tx) => tx.originAccount === mule);
  assert.equal(fromMule.length, 0, 'nobody pays from an account they do not know about');
  assert.ok(!sim.s.requests.some((r) => r.originAccount === mule), 'no request names the mule');
  assert.ok(sim.s.transactions.some((tx) => tx.origin === 'NPC' && tx.originAccount === realPrimary), 'they still pay from their real (now floating) account');
  // Requested changes are believed the moment they are asked for, done or not.
  for (const c of sim.s.customers) {
    let primary = c.id === x.id ? realPrimary : c.originalPrimary;
    for (const r of sim.s.requests.filter((q) => q.customerId === c.id && !q.phish && !q.scam)) {
      if (r.kind === 'SET_PRIMARY' || r.kind === 'ADD_AND_PRIMARY') primary = r.account!;
    }
    assert.equal(c.known.primary, primary, `${c.id} believes its last requested primary`);
  }
});

test('a payment linked to a request it does not answer marks it done, but the customer is not fooled', () => {
  const sim = new Sim({ requestChangeShare: 0, strikesToSuspend: 999 });
  grantMasterAccess(sim.s, 'p0');
  const code = sim.code('p0', 'TRANSACTIONS', null);
  const create = (params: Record<string, string>) => sim.run('p0', code, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', params);
  sim.at(1);
  const r = sim.s.requests.find((q) => q.kind === 'PAYMENT' && !q.phish)!;
  const req = () => sim.s.requests.find((q) => q.id === r.id)!;
  const other = sim.s.customers.find((c) => c.id !== r.payeeId && c.id !== r.customerId)!;
  // Wrong payee, linked anyway: the action goes through and the request shows done...
  assert.ok(create({ originAccount: r.originAccount!, beneficiaryId: other.id, amount: String(r.amount), requestId: r.id }).ok);
  assert.equal(req().status, 'DONE');
  // ...but halfway the customer chases it, and it reopens.
  sim.at(r.remindAt + 1);
  assert.equal(req().reminders.length, 1);
  assert.equal(req().status, 'OPEN');
  // The right payment, made afterwards without the link, is matched and answers it: no strike.
  assert.ok(create({ originAccount: r.originAccount!, beneficiaryId: r.payeeId!, amount: String(r.amount) }).ok);
  sim.at(r.dueAt + 1);
  assert.equal(req().outcome, 'MET');
  assert.equal(sim.s.customers.find((c) => c.id === r.customerId)!.strikes, 0);
});

test('hidden host bells: Blacknet posts reach the other operatives, the Target Ledger (off by default) hears about mule money', () => {
  const sim = new Sim({ automation: EVERYTHING });
  const [a, b] = Object.values(sim.s.players).filter((p) => p.allegiance === 'BLACK');
  const white = Object.values(sim.s.players).find((p) => p.allegiance === 'WHITE')!;
  const notes = (id: string) => sim.s.players[id].notifications.map((n) => `${n.page}: ${n.text}`);
  assert.ok(!a.watching.includes('HIDDEN_HOST.TARGET_LEDGER'), 'the ledger bell starts off');
  assert.ok(sim.run(a.id, sim.code(a.id, 'HIDDEN_HOST', 'BLACKNET'), 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: 'hold CU4' }).ok);
  assert.ok(notes(b.id).some((n) => n === `Blacknet: ${a.alias}: hold CU4`));
  assert.ok(!notes(a.id).some((n) => n.startsWith('Blacknet')), 'not the one who posted');
  assert.ok(!notes(white.id).some((n) => n.startsWith('Blacknet')));
  // The ledger bell, switched on: a mule made primary, then a payment settling into it.
  assert.ok(sim.do({ type: 'SET_WATCH', playerId: b.id, system: 'HIDDEN_HOST', module: 'TARGET_LEDGER', on: true }).ok);
  assert.ok(!sim.do({ type: 'SET_WATCH', playerId: white.id, system: 'HIDDEN_HOST', module: 'TARGET_LEDGER', on: true }).ok, 'regular employees cannot');
  grantMasterAccess(sim.s, 'p0');
  const mule = sim.s.targets[0].account;
  const victim = sim.s.customers[1];
  assert.ok(sim.run('p0', sim.code('p0', 'CLIENT_DATA', null), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: victim.id, account: mule, makePrimary: 'YES' }).ok);
  assert.ok(notes(b.id).some((n) => n.startsWith(`Target Ledger: ${mule} made the primary of ${victim.id}`)));
  const payer = sim.s.customers.find((c) => c.id !== victim.id && sim.s.balances[c.primary] > 2_000_000)!;
  assert.ok(sim.run('p0', sim.code('p0', 'TRANSACTIONS', null), 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: payer.primary, beneficiaryId: victim.id, amount: '500000' }).ok);
  sim.at(5);
  assert.ok(notes(b.id).some((n) => n.startsWith(`Target Ledger: $500,000 landed in ${mule}`)), notes(b.id).join('\n'));
});

test('tracing a Blacknet entry leaks a message: the one posted, or the newest on the board when it was read', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const it = sim.byRole('IT_SPECIALIST').find((p) => p.allegiance === 'WHITE')!;
  const bn = sim.code(black.id, 'HIDDEN_HOST', 'BLACKNET');
  const trace = (logId: string) => sim.run(it.id, sim.code(it.id, 'SECURITY', 'MASTER_LOG'), 'SECURITY', 'MASTER_LOG', 'TRACE', { logId }).message;
  sim.at(1);
  assert.ok(sim.run(black.id, bn, 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: 'CU4 primary swap at 5:00' }).ok);
  const posted = sim.s.logs.at(-1)!;
  sim.at(2);
  assert.ok(sim.run(black.id, bn, 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: 'second' }).ok);
  sim.at(3);
  assert.ok(sim.run(black.id, bn, 'HIDDEN_HOST', 'BLACKNET', 'READ_MESSAGES', {}).ok);
  const read = sim.s.logs.at(-1)!;
  sim.at(4);
  assert.match(trace(posted.id), new RegExp(`The message posted by ${black.alias}: "CU4 primary swap at 5:00"`));
  sim.at(4 + sim.s.config.traceCooldownSec);
  assert.match(trace(read.id), new RegExp(`The newest message on the board then, by ${black.alias}: "second"`));
  assert.ok(sim.s.hostLog.some((h) => h.alert && h.message.includes('"second"')), 'the operatives see what leaked');
});
