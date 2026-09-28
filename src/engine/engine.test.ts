import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountVerified, applyAction, CHANNELS, createGame, ENCRYPTION_ENABLED, getPlayerView, grantMasterAccess, SYSTEMS, tick } from './index';
import type { Action, ActionResult, GameConfig, GameState, Player, RoleId, SystemId } from './index';

const NAMES = ['Jeremy', 'Sarah', 'Mike', 'David', 'Lisa', 'Anna', 'Omar', 'Priya', 'Chen', 'Rosa'];
const PLAYERS = NAMES.map((name, i) => ({ id: `p${i}`, name }));
const T0 = 1_000_000;

class Sim {
  s: GameState;
  sec = 0;
  constructor(config: Partial<GameConfig> = {}, seed = 42) {
    this.s = createGame({ seed, players: PLAYERS, now: T0, config });
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
  lastLog(): string {
    return this.s.logs[this.s.logs.length - 1].message;
  }
}

test('setup deals roles, allegiances, unique codes and one packet per system', () => {
  const { s } = new Sim();
  const ps = Object.values(s.players);
  assert.equal(ps.filter((p) => p.allegiance === 'BLACK').length, 3);
  for (const role of ['IT_SPECIALIST', 'PERSONAL_BANKER', 'ACCOUNTS_RECEIVABLES', 'SECURITY_ANALYST', 'SYSTEMS_ADMIN']) {
    assert.equal(ps.filter((p) => p.role === role).length, 2, role);
  }
  const codes = Object.values(s.credentials).map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const p of ps) {
    assert.deepEqual(p.packets.map((x) => x.system).sort(), ['BLACKHAT_DB', 'CLIENT_DATA', 'SECURITY', 'TRANSACTIONS']);
    assert.equal(p.knownSystems.includes('BLACKHAT_DB'), p.allegiance === 'BLACK');
    const hasDb = Object.values(s.credentials).some((c) => c.owner === p.id && c.system === 'BLACKHAT_DB');
    assert.equal(hasDb, p.allegiance === 'BLACK');
  }
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
  const [owner, analyst2] = sim.byRole('SECURITY_ANALYST');
  const [thief] = sim.byRole('PERSONAL_BANKER');
  const ownerCode = sim.code(owner.id, 'SECURITY', 'MASTER_LOG');

  sim.at(10);
  const r = sim.run(thief.id, ownerCode, 'SECURITY', 'MASTER_LOG', 'VIEW_LOG');
  assert.ok(r.ok, r.message);
  const entry = sim.s.logs[sim.s.logs.length - 1];
  assert.equal(entry.message, `${owner.name} accessed Master Log`);
  assert.equal(entry.actor, owner.id);
  assert.ok(sim.s.players[thief.id].heldCredentialIds.some((id) => sim.s.credentials[id].owner === owner.id), 'thief now holds the credential');
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
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
  sim.at(10);
  const r = sim.run(admin.id, sim.code(admin.id, 'SECURITY', 'FIREWALL'), 'SECURITY', 'FIREWALL', 'ADD_ENCRYPTION', { target: 'SECURITY.MASTER_LOG', code: '7777' });
  assert.equal(r.ok, false);
});

test('encryption locks a module until every layer code is supplied; bypass strips it and alerts', { skip: !ENCRYPTION_ENABLED && 'encryption disabled' }, () => {
  const sim = new Sim();
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
  const [analyst] = sim.byRole('SECURITY_ANALYST');
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
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
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
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
  const tx = sim.s.transactions[0];
  const payee = sim.s.customers.find((c) => c.id === tx.beneficiaryId)!;
  const originalPrimary = payee.primary;
  const mule = sim.s.targets[0].account;
  const cr = sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');

  const arCode = (m: string): string => sim.code(ar.id, 'TRANSACTIONS', m);
  sim.at(30);
  assert.ok(sim.run(ar.id, arCode('RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id }).ok);
  assert.equal(sim.s.transactions[0].riskResult, 'LOW');
  assert.ok(sim.run(ar.id, arCode('AUTHORIZATION'), 'TRANSACTIONS', 'AUTHORIZATION', 'APPROVE', { txId: tx.id }).ok);

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
  assert.equal(sim.s.totals.stolen, 2_000_000);
  assert.equal(sim.s.totals.processedNpc, 0);
  assert.equal(sim.s.status, 'RUNNING');

  // Reverse inside the window.
  sim.at(100);
  const rev = sim.run(admin.id, sim.code(admin.id, 'TRANSACTIONS', 'SETTLEMENT'), 'TRANSACTIONS', 'SETTLEMENT', 'REVERSE', { txId: tx.id });
  assert.ok(rev.ok, rev.message);
  assert.equal(sim.s.totals.stolen, 0);

  // A reversed payment cannot be reversed again; and the window closes.
  const tx2 = sim.s.transactions[1];
  sim.run(ar.id, arCode('RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx2.id });
  sim.run(ar.id, arCode('AUTHORIZATION'), 'TRANSACTIONS', 'AUTHORIZATION', 'APPROVE', { txId: tx2.id });
  sim.run(ar.id, arCode('SETTLEMENT'), 'TRANSACTIONS', 'SETTLEMENT', 'SETTLE', { txId: tx2.id });
  sim.at(100 + sim.s.config.reversalWindowSec + 5);
  const late = sim.run(admin.id, sim.code(admin.id, 'TRANSACTIONS', 'SETTLEMENT'), 'TRANSACTIONS', 'SETTLEMENT', 'REVERSE', { txId: tx2.id });
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
  const add = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: payee, account: '12345', makePrimary: 'YES' });
  assert.ok(add.ok, add.message);
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.deepEqual(sim.s.transactions[0].riskFlags, ['UNVERIFIED_PRIMARY', 'RECENTLY_CHANGED_PRIMARY']);
  for (const h of sim.s.customers.find((c) => c.id === payee)!.history) sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'VERIFICATION'), 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: h.id });
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.deepEqual(sim.s.transactions[0].riskFlags, ['RECENTLY_CHANGED_PRIMARY']);
  sim.at(20 + sim.s.config.recentModifySec + 1);
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.deepEqual(sim.s.transactions[0].riskFlags, []);
});

test('Black Hats win as soon as stolen money reaches the target', () => {
  const sim = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000 });
  const pb = sim.bankerOf(sim.s.transactions[0].beneficiaryId);
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const ben = sim.s.transactions[0].beneficiaryId;
  const mule = sim.s.targets[0].account;
  sim.at(10);
  const add = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: ben, account: mule, makePrimary: 'YES' });
  assert.ok(add.ok, add.message);
  const q = sim.code(ar.id, 'TRANSACTIONS', 'PAYMENT_QUEUE');
  const from = sim.s.customers.find((c) => c.id !== ben)!.primary;
  const created = sim.run(ar.id, q, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { originAccount: from, beneficiaryId: ben, amount: '3000000' });
  assert.ok(created.ok, created.message);
  const id = sim.s.transactions[sim.s.transactions.length - 1].id;
  for (const [mod, fn] of [['RISK_CHECK', 'RUN_RISK_CHECK'], ['AUTHORIZATION', 'APPROVE'], ['SETTLEMENT', 'SETTLE']]) {
    const r = sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', mod), 'TRANSACTIONS', mod, fn, { txId: id });
    assert.ok(r.ok, r.message);
  }
  assert.equal(sim.s.status, 'ENDED');
  assert.equal(sim.s.winner, 'BLACK');
  const after = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS');
  assert.equal(after.message, 'The game is over.');
});

test('NPC traffic arrives on a schedule and White Hats win once enough is settled', () => {
  const sim = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000 });
  assert.equal(sim.s.transactions.length, 3);
  sim.at(60);
  assert.equal(sim.s.transactions.length, 6);

  const win = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000, whiteTarget: 8_000_000, autoProcess: true });
  win.at(300);
  assert.equal(win.s.status, 'ENDED');
  assert.equal(win.s.winner, 'WHITE');
  assert.ok(win.s.totals.processedNpc >= 8_000_000);
});

test('when time runs out the configured side wins', () => {
  const sim = new Sim({ durationSec: 60 });
  sim.at(59);
  assert.equal(sim.s.status, 'RUNNING');
  sim.at(61);
  assert.equal(sim.s.status, 'ENDED');
  assert.equal(sim.s.winner, 'BLACK');
});

test('hidden host: guarded by credentials, discoverable through alerts, reachable once you know the address', () => {
  const sim = new Sim();
  const black = Object.values(sim.s.players).find((p) => p.allegiance === 'BLACK')!;
  const [analyst] = sim.byRole('SECURITY_ANALYST');
  const [it] = sim.byRole('IT_SPECIALIST');
  const white = Object.values(sim.s.players).find((p) => p.allegiance === 'WHITE' && p.id !== analyst.id && p.id !== it.id)!;
  const dbCode = sim.code(black.id, 'BLACKHAT_DB', null);

  sim.at(30);
  assert.ok(sim.run(black.id, dbCode, 'BLACKHAT_DB', 'BLACKNET', 'POST_MESSAGE', { text: 'target B3 is ready', alias: 'ghost' }).ok);
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

  // A White Hat without a code gets nothing.
  const denied = sim.run(white.id, '0000', 'BLACKHAT_DB', 'BLACKNET', 'READ_MESSAGES');
  assert.equal(denied.ok, false);

  // The Master Log's alerts report the traffic but not the address; the alert points at a traceable entry.
  const alerts = sim.run(analyst.id, sim.code(analyst.id, 'SECURITY', 'MASTER_LOG'), 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: 'ALERTS' });
  const alert = alerts.lines!.find((l) => l.includes('Traffic to an unregistered host detected'));
  assert.ok(alert && alert.includes(`(log ${entry.id})`), alerts.lines!.join('\n'));
  assert.ok(!alerts.lines!.some((l) => l.includes(sim.s.hiddenHost)), 'the address is not given away');

  // Knowing the address makes the system appear; a wrong address does not.
  if (!sim.s.players[it.id].knownSystems.includes('BLACKHAT_DB')) {
    assert.equal(getPlayerView(sim.s, it.id).systems.some((x) => x.id === 'BLACKHAT_DB'), false);
    assert.equal(sim.do({ type: 'CONNECT', playerId: it.id, address: '10.66.6.7' }).ok, false);
    assert.ok(sim.do({ type: 'CONNECT', playerId: it.id, address: sim.s.hiddenHost }).ok);
  }
  assert.equal(getPlayerView(sim.s, it.id).systems.some((x) => x.id === 'BLACKHAT_DB'), true);

  // The unregistered host is not the bank's: Permissions can neither issue nor list credentials for it.
  const perms = sim.code(it.id, 'SECURITY', 'PERMISSIONS');
  const mint = sim.run(it.id, perms, 'SECURITY', 'PERMISSIONS', 'CREATE_CREDENTIAL', { owner: it.id, scope: 'BLACKHAT_DB.*', permission: 'READ' });
  assert.equal(mint.message, 'Unknown system.');
  const reg = sim.run(it.id, perms, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', { show: 'ALL' });
  assert.ok(!reg.lines!.some((l) => l.includes('Unregistered host')));
});

test('sharing a credential is private; revoking one is visible and blocks its use', () => {
  const sim = new Sim();
  const [analyst] = sim.byRole('SECURITY_ANALYST');
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const [it] = sim.byRole('IT_SPECIALIST');
  const cred = Object.values(sim.s.credentials).find((c) => c.owner === analyst.id && c.module === 'MASTER_LOG')!;
  sim.at(10);
  const logsBefore = sim.s.logs.length;
  assert.equal(sim.do({ type: 'SHARE_CREDENTIAL', playerId: pb.id, credentialId: cred.id, toPlayerId: analyst.id }).ok, false);
  assert.ok(sim.do({ type: 'SHARE_CREDENTIAL', playerId: analyst.id, credentialId: cred.id, toPlayerId: pb.id }).ok);
  assert.equal(sim.s.logs.length, logsBefore, 'sharing writes nothing to the Master Log');
  assert.ok(sim.s.players[pb.id].activity.some((a) => a.text.includes(cred.code)));

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

test("another player's workstation unlocks only with one of their codes, and leaves a trace", () => {
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

  const targetCode = sim.code(target.id, ...firstCred(sim, target.id));
  assert.ok(sim.do({ type: 'ACCESS_WORKSTATION', playerId: visitor.id, targetId: target.id, code: targetCode }).ok);
  assert.equal(sim.lastLog(), `${target.name} logged in to their workstation (${target.ip})`);
  assert.ok(sim.s.players[target.id].activity.at(-1)!.text.includes(visitor.ip), 'owner sees where it came from');
  const remote = getPlayerView(sim.s, visitor.id).remote[target.id];
  assert.equal(remote.name, target.name);
  assert.ok(remote.credentials.some((c) => c.code === targetCode));

  // Revoking the credential that was used closes the session.
  const credId = Object.values(sim.s.credentials).find((c) => c.code === targetCode)!.id;
  sim.s.credentials[credId].status = 'REVOKED';
  assert.deepEqual(getPlayerView(sim.s, visitor.id).remote, {});
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

  assert.equal(create('00000').message, 'No customer account with that number.');
  assert.equal(create(sim.s.targets[0].account).message, 'No customer account with that number.', 'a floating account is not an originator');
  assert.ok(create(from.replace('ACC-', '')).ok, 'digits alone are accepted');

  const tx = sim.s.transactions.at(-1)!;
  assert.equal(tx.customerId, cust.id);
  assert.equal(tx.originAccount, from);
  const row = sim.run('p0', code, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {}).lines!.find((l) => l.startsWith(tx.id))!;
  assert.ok(row.includes(`${cust.id} ${from} -> CU2 ${ben.primary}`), row);
  assert.ok(!row.includes(cust.name) && !row.includes(ben.name), 'queue rows show codes, not names');
});

test('payment history records every step with the credential owner and the real actor', () => {
  const sim = new Sim();
  const [owner] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const [intruder] = sim.byRole('SECURITY_ANALYST');
  const code = (m: string) => sim.code(owner.id, 'TRANSACTIONS', m);
  sim.at(1);
  // The intruder works the whole pipeline with the owner's codes.
  for (const [m, fn] of [['RISK_CHECK', 'RUN_RISK_CHECK'], ['AUTHORIZATION', 'HOLD'], ['AUTHORIZATION', 'APPROVE'], ['SETTLEMENT', 'SETTLE'], ['SETTLEMENT', 'REVERSE']]) {
    const r = sim.run(intruder.id, code(m), 'TRANSACTIONS', m, fn, { txId: '1' });
    assert.ok(r.ok, `${fn}: ${r.message}`);
  }
  const tx = sim.s.transactions[0];
  assert.deepEqual(tx.history.map((e) => e.action), ['CREATED', 'RISK_CHECKED', 'HELD', 'APPROVED', 'SETTLED', 'REVERSED']);
  assert.equal(tx.history[0].by, 'SYSTEM');
  for (const e of tx.history.slice(1)) {
    assert.equal(e.by, owner.id, 'records name the credential owner');
    assert.equal(e.actualPlayerId, intruder.id, 'truth names who typed it');
  }
  assert.equal(tx.debitedFrom, tx.originAccount);
  assert.match(tx.history[1].detail!, /^risk (LOW|MEDIUM|HIGH)/);
});

test('the auto-processor signs its steps as SYSTEM', () => {
  const sim = new Sim({ autoProcess: true });
  sim.at(sim.s.config.autoProcessDelaySec + 1);
  const settled = sim.s.transactions.find((t) => t.status === 'SETTLED');
  assert.ok(settled, 'something was auto-settled');
  assert.deepEqual(settled.history.map((e) => `${e.action}:${e.by}`), ['CREATED:SYSTEM', 'RISK_CHECKED:SYSTEM', 'APPROVED:SYSTEM', 'SETTLED:SYSTEM']);
});

test('stage rows: both accounts, who handled it (credential owner or channel), and never the risk flags', () => {
  const sim = new Sim();
  const [owner] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const [intruder] = sim.byRole('SECURITY_ANALYST');
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
  assert.match(rowOf(mine.id), new RegExp(`created [0-9:]{8} by ${owner.name}`));
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

test('risk is scored by hand with a reason; hold and reject need a reason; reasons show in the stage views', () => {
  const sim = new Sim();
  grantMasterAccess(sim.s, 'p0');
  const code = sim.code('p0', 'TRANSACTIONS', null);
  const run = (module: string, fn: string, params: Record<string, string>) => sim.do({ type: 'EXECUTE', playerId: 'p0', code, system: 'TRANSACTIONS', module, fn, params });
  sim.at(1);

  assert.match(run('RISK_CHECK', 'RUN_RISK_CHECK', { txId: '1', reason: 'fine' }).message, /Pick a risk score/);
  assert.match(run('RISK_CHECK', 'RUN_RISK_CHECK', { txId: '1', score: 'HIGH', reason: '   ' }).message, /Type a reason/);
  assert.equal(sim.s.transactions[0].status, 'QUEUED', 'nothing changes without both');
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
  sim.at(sim.s.config.requestIntervalSec * 3 + 1);
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
  // A whole-system Client Data credential sees everyone's.
  grantMasterAccess(sim.s, 'p0');
  assert.equal(inbox(sim.s.players.p0, sim.code('p0', 'CLIENT_DATA', null)).length, sim.s.requests.length);
});

test('client requests close by linking a payment or an account change, or by archiving with a reason', () => {
  const sim = new Sim({ requestChangeShare: 0.5 });
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
  const theirs = sim.s.requests.find((r) => r.bankerId === b.id) ?? (sim.at(400), sim.s.requests.find((r) => r.bankerId === b.id))!;
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
  sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS'), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: 'CU2', account: '54321', makePrimary: 'YES' });
  // Adding an account as primary is two changes: the account, then the new primary. Each waits for verification.
  const pending = view('PENDING');
  assert.equal(pending.length, 2);
  assert.ok(pending[0].startsWith('CH-1 ') && pending[0].includes('CU2') && pending[0].includes('added ACC-54321') && pending[0].endsWith('[UNVERIFIED]'), pending[0]);
  assert.ok(pending[1].includes('-> ACC-54321') && pending[1].includes(`by ${pb.name}`), pending[1]);
  assert.match(sim.run(pb.id, ver, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: 'CH-9' }).message, /No such change/);
  sim.run(pb.id, ver, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: '1' });
  assert.equal(view('PENDING').length, 1);
  sim.run(pb.id, ver, 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_CHANGE', { changeId: 'CH-2' });
  assert.deepEqual(view('PENDING'), ['Nothing here.']);
  assert.ok(view('ALL').every((l) => l.endsWith(`[VERIFIED by ${pb.name}]`)));
});

test('customer accounts: 14 customers; add, set primary and remove, with their rules and history', () => {
  const sim = new Sim();
  assert.equal(sim.s.customers.length, 14);
  for (const c of sim.s.customers) {
    assert.ok(c.accounts.length >= 1 && c.accounts.length <= 3 && c.accounts.includes(c.primary));
  }
  const [pb, other] = sim.byRole('PERSONAL_BANKER');
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
});

test('Customer Records shows only your own customers unless you hold all of Client Data', () => {
  const sim = new Sim();
  const [a, b] = sim.byRole('PERSONAL_BANKER');
  const code = sim.code(a.id, 'CLIENT_DATA', 'CUSTOMER_RECORDS');
  const shown = (pid: string, c: string) =>
    sim.run(pid, c, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS').lines!.filter((l) => l.startsWith('CU')).map((l) => l.split(' ')[0]);
  const mine = sim.s.customers.filter((c) => c.bankerId === a.id).map((c) => c.id);
  assert.deepEqual(shown(a.id, code), mine);
  assert.deepEqual(shown(b.id, code), mine, "a borrowed code shows its owner's customers");
  grantMasterAccess(sim.s, 'p0');
  const master = sim.code('p0', 'CLIENT_DATA', null);
  assert.equal(shown('p0', master).length, sim.s.customers.filter((c) => c.bankerId === 'p0').length, '"My customers" is still yours');
  assert.equal(sim.run('p0', master, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: 'ALL' }).lines!.filter((l) => l.startsWith('CU')).length, 14);
  assert.match(sim.run(a.id, code, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: 'ALL' }).message, /needs a credential for all of Client Data/);
});

test('the risk queue flags unverified payee primaries and unverified originator accounts', () => {
  const sim = new Sim();
  grantMasterAccess(sim.s, 'p0');
  const cd = sim.code('p0', 'CLIENT_DATA', null);
  const tx = sim.code('p0', 'TRANSACTIONS', null);
  sim.at(1);
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
  assert.ok(add(mine.id, '31313').ok);
  assert.equal(add(theirs.id, '32323').message, `${theirs.id} is not one of ${a.name}'s customers.`);
  assert.match(sim.run(a.id, code, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'SET_PRIMARY', { customerId: theirs.id, account: theirs.accounts[0] }).message, /not one of/);
  grantMasterAccess(sim.s, 'p0');
  assert.ok(sim.run('p0', sim.code('p0', 'CLIENT_DATA', null), 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: theirs.id, account: '32323' }).ok);

  // IT sees every customer, but read-only.
  const [it] = sim.byRole('IT_SPECIALIST');
  const itCode = sim.code(it.id, 'CLIENT_DATA', null);
  const view = sim.run(it.id, itCode, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: 'ALL' });
  assert.equal(view.lines!.filter((l) => l.startsWith('CU')).length, 14);
  assert.equal(sim.run(it.id, itCode, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: 'CU1', account: '34343' }).message, 'Access denied.');
});

test('Firewall shows every module and its status; the registry lists active credentials unless asked for all', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
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
  const victim = Object.values(sim.s.credentials).find((c) => c.owner === admin.id)!;
  sim.run(it.id, perms, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: victim.id });
  assert.ok(!reg('ACTIVE').some((l) => l.startsWith(victim.id + ' ')));
  assert.ok(reg('ALL').some((l) => l.startsWith(victim.id + ' ') && l.includes('REVOKED')));
  assert.ok(reg('ALL').some((l) => l.includes('Read & write · Firewall')), 'scopes read like the credential picker');
});

test('live monitors: opening one is logged, its quiet refreshes are not', () => {
  const sim = new Sim();
  const [analyst] = sim.byRole('SECURITY_ANALYST');
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
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
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
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
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
  assert.match(sim.run(black.id, sim.code(black.id, 'BLACKHAT_DB', null), 'BLACKHAT_DB', 'BLACKNET', 'READ_MESSAGES').message, /No route to host/);
});

test('revoking all access to a bank system shuts the bank down: everybody loses', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  sim.at(2);
  // The hidden host can be revoked without ending the game.
  sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: sim.s.hiddenHost });
  sim.at(2 + sim.s.config.revokeCountdownSec + 1);
  assert.equal(sim.s.status, 'RUNNING');
  sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: '10.0.0.30' });
  sim.at(sim.sec + sim.s.config.revokeCountdownSec + 1);
  assert.equal(sim.s.status, 'ENDED');
  assert.equal(sim.s.winner, null);
  assert.match(sim.s.endReason!, /Transaction Processing was revoked .* Nobody wins/);
});

test('firewall: "revoke all access" counts down, can be cancelled only from the Firewall, and is permanent once done', () => {
  const sim = new Sim();
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const [bystander] = sim.byRole('PERSONAL_BANKER');
  const fw = sim.code(admin.id, 'SECURITY', 'FIREWALL');
  const arCode = sim.code(ar.id, 'TRANSACTIONS', 'PAYMENT_QUEUE');
  sim.at(2);

  // Cancelled: nothing happens.
  assert.ok(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', { address: ar.ip }).ok);
  const r1 = sim.s.revocations.at(-1)!;
  assert.equal(r1.status, 'PENDING');
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
  assert.match(sim.run(ar.id, arCode, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', {}).message, /blocked by the firewall permanently/);
  assert.ok(Object.values(sim.s.credentials).filter((c) => c.owner === ar.id).every((c) => c.status === 'REVOKED'));
  assert.match(sim.run(admin.id, fw, 'SECURITY', 'FIREWALL', 'UNBLOCK_ADDRESS', { address: ar.ip }).message, /cannot be undone/);
  assert.ok(sim.s.logs.some((l) => l.message.startsWith(`Firewall: all access revoked for ${ar.ip}`)));
});

test('Employee Records show last activity, failed attempts, lockouts and blocks; alerts live in the Master Log', () => {
  const sim = new Sim();
  const [analyst] = sim.byRole('SECURITY_ANALYST');
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const used = new Set(Object.values(sim.s.credentials).map((c) => c.code));
  const bad = ['0000', '1111', '2222', '3333'].filter((c) => !used.has(c));
  sim.at(10);
  for (let i = 0; i < 3; i++) sim.run(pb.id, bad[i], 'SECURITY', 'MASTER_LOG', 'VIEW_LOG');
  const rows = sim.run(analyst.id, sim.code(analyst.id, 'SECURITY', 'EMPLOYEE_RECORDS'), 'SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES').lines!;
  const i = rows.findIndex((l) => l.startsWith(pb.name));
  assert.ok(rows[i].includes('[LOCKED OUT'), rows[i]);
  assert.ok(rows[i + 1].includes('failed attempts: 3') && rows[i + 1].includes('last activity: 08:30:10'), rows[i + 1]);
  const alerts = sim.run(analyst.id, sim.code(analyst.id, 'SECURITY', 'MASTER_LOG'), 'SECURITY', 'MASTER_LOG', 'VIEW_LOG', { show: 'ALERTS' }).lines!;
  assert.equal(alerts.filter((l) => l.includes('AUTH_FAIL')).length, 3);
  assert.ok(!SYSTEMS.find((s) => s.id === 'SECURITY')!.modules.some((m) => m.id === 'INTRUSION_DETECTION'));
});

/** Checks a relay trace against the truth: whichever of the four clue kinds it is, it must be correct. */
function clueIsTrue(sim: Sim, message: string, entry: { sourceIp: string | null; activity?: string }): boolean {
  const ip = entry.sourceIp!;
  const last = Number(ip.split('.').pop());
  let m = message.match(/The origin workstation is within 10\.1\.0\.(\d+)-(\d+)\./);
  if (m) return Number(m[2]) - Number(m[1]) === 3 && last >= Number(m[1]) && last <= Number(m[2]);
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
  const [analyst] = sim.byRole('SECURITY_ANALYST');
  const logCode = sim.code(analyst.id, 'SECURITY', 'MASTER_LOG');
  const dbCode = sim.code(black.id, 'BLACKHAT_DB', null);
  sim.at(5);

  // A failed code on the host names nobody, but still counts toward the lockout.
  const before = sim.s.players[black.id].failTotal;
  const wrongScope = sim.code(analyst.id, 'SECURITY', 'EMPLOYEE_RECORDS'); // a real code with the wrong access
  assert.equal(sim.run(black.id, wrongScope, 'BLACKHAT_DB', 'BLACKNET', 'READ_MESSAGES').message, 'Access denied.');
  const failEntry = sim.s.logs.at(-1)!;
  assert.equal(failEntry.message, 'Unknown server activity');
  assert.equal(failEntry.activity, 'failed login attempt');
  assert.ok(!sim.s.logs.some((l) => l.message.includes(analyst.name) && l.message.includes('denied')), 'the code owner is not named');
  assert.equal(sim.s.players[black.id].failTotal, before + 1);

  // Many traces: every kind of clue shows up, and every clue is true.
  const kinds = new Set<string>();
  for (let i = 0; i < 40; i++) {
    sim.run(black.id, dbCode, 'BLACKHAT_DB', i % 2 ? 'TARGET_LEDGER' : 'BLACKNET', i % 2 ? 'VIEW_TARGETS' : 'READ_MESSAGES');
    const e = sim.s.logs.at(-1)!;
    const msg = sim.run(analyst.id, logCode, 'SECURITY', 'MASTER_LOG', 'TRACE', { logId: e.id }).message;
    assert.ok(clueIsTrue(sim, msg, e), msg);
    kinds.add(msg.includes('within') ? 'range' : msg.includes('one of two') ? 'pair' : msg.includes("server's IP") ? 'server' : 'activity');
  }
  assert.deepEqual([...kinds].sort(), ['activity', 'pair', 'range', 'server']);
});
