import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, ENCRYPTION_ENABLED, getPlayerView, grantMasterAccess, SYSTEMS, tick } from './index';
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
  const idsCode = sim.code(analyst2.id, 'SECURITY', 'INTRUSION_DETECTION');
  const tr = sim.run(analyst2.id, idsCode, 'SECURITY', 'INTRUSION_DETECTION', 'TRACE', { logId: entry.id });
  assert.ok(tr.ok, tr.message);
  assert.ok(tr.message.includes(thief.ip), tr.message);
  const again = sim.run(analyst2.id, idsCode, 'SECURITY', 'INTRUSION_DETECTION', 'TRACE', { logId: entry.id });
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

test('fraud pipeline: a beneficiary edit diverts a payment at settlement, and reversal claws it back', () => {
  const sim = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000 });
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const [admin] = sim.byRole('SYSTEMS_ADMIN');
  const tx = sim.s.transactions[0];
  const ben = sim.s.beneficiaries[tx.beneficiaryId];
  const originalAccount = ben.account;
  const mule = sim.s.targets[0].account;

  const arCode = (m: string): string => sim.code(ar.id, 'TRANSACTIONS', m);
  sim.at(30);
  assert.ok(sim.run(ar.id, arCode('RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id }).ok);
  assert.equal(sim.s.transactions[0].riskResult, 'LOW');
  assert.ok(sim.run(ar.id, arCode('AUTHORIZATION'), 'TRANSACTIONS', 'AUTHORIZATION', 'APPROVE', { txId: tx.id }).ok);

  // Diverted AFTER approval: settlement still pays whatever account the beneficiary has now.
  sim.at(40);
  assert.ok(sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'BENEFICIARY_DATABASE'), 'CLIENT_DATA', 'BENEFICIARY_DATABASE', 'MODIFY_BENEFICIARY', { beneficiaryId: ben.id, newAccount: mule.slice(4) }).ok);
  const inv = sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'BENEFICIARY_DATABASE'), 'CLIENT_DATA', 'BENEFICIARY_DATABASE', 'INVESTIGATE_CHANGES', { beneficiaryId: ben.id });
  assert.ok(inv.lines![0].includes(`${originalAccount} -> ${mule}`));
  assert.ok(inv.lines![0].includes(`by ${pb.name}`));

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

test('risk check flags recent edits; verifying clears only the unverified flag', () => {
  const sim = new Sim({ npcMinAmount: 1_000_000, npcMaxAmount: 1_000_000 });
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const tx = sim.s.transactions[0];
  const ben = tx.beneficiaryId;
  const bd = sim.code(pb.id, 'CLIENT_DATA', 'BENEFICIARY_DATABASE');
  sim.at(20);
  sim.run(pb.id, bd, 'CLIENT_DATA', 'BENEFICIARY_DATABASE', 'MODIFY_BENEFICIARY', { beneficiaryId: ben, newAccount: '12345' });
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.equal(sim.s.transactions[0].riskResult, 'HIGH');
  sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'VERIFICATION'), 'CLIENT_DATA', 'VERIFICATION', 'VERIFY_BENEFICIARY', { beneficiaryId: ben });
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.deepEqual(sim.s.transactions[0].riskFlags, ['RECENTLY_MODIFIED_BENEFICIARY']);
  assert.equal(sim.s.transactions[0].riskResult, 'MEDIUM');
  sim.at(20 + sim.s.config.recentModifySec + 1);
  sim.run(ar.id, sim.code(ar.id, 'TRANSACTIONS', 'RISK_CHECK'), 'TRANSACTIONS', 'RISK_CHECK', 'RUN_RISK_CHECK', { txId: tx.id });
  assert.equal(sim.s.transactions[0].riskResult, 'LOW');
});

test('Black Hats win as soon as stolen money reaches the target', () => {
  const sim = new Sim({ npcMinAmount: 2_000_000, npcMaxAmount: 2_000_000 });
  const [pb] = sim.byRole('PERSONAL_BANKER');
  const [ar] = sim.byRole('ACCOUNTS_RECEIVABLES');
  const ben = sim.s.transactions[0].beneficiaryId;
  const mule = sim.s.targets[0].account;
  sim.at(10);
  sim.run(pb.id, sim.code(pb.id, 'CLIENT_DATA', 'BENEFICIARY_DATABASE'), 'CLIENT_DATA', 'BENEFICIARY_DATABASE', 'MODIFY_BENEFICIARY', { beneficiaryId: ben, newAccount: mule });
  const q = sim.code(ar.id, 'TRANSACTIONS', 'PAYMENT_QUEUE');
  const created = sim.run(ar.id, q, 'TRANSACTIONS', 'PAYMENT_QUEUE', 'CREATE_TRANSACTION', { beneficiaryId: ben, amount: '3000000' });
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
  assert.equal(sim.lastLog(), `${black.name} connected to an unregistered host`);
  assert.ok(!sim.lastLog().includes(sim.s.hiddenHost), 'the log does not give the address away');

  // A White Hat without a code gets nothing.
  const denied = sim.run(white.id, '0000', 'BLACKHAT_DB', 'BLACKNET', 'READ_MESSAGES');
  assert.equal(denied.ok, false);

  // Intrusion Detection names the host.
  const alerts = sim.run(analyst.id, sim.code(analyst.id, 'SECURITY', 'INTRUSION_DETECTION'), 'SECURITY', 'INTRUSION_DETECTION', 'VIEW_ALERTS');
  assert.ok(alerts.lines!.some((l) => l.includes(sim.s.hiddenHost)));

  // Knowing the address makes the system appear; a wrong address does not.
  if (!sim.s.players[it.id].knownSystems.includes('BLACKHAT_DB')) {
    assert.equal(getPlayerView(sim.s, it.id).systems.some((x) => x.id === 'BLACKHAT_DB'), false);
    assert.equal(sim.do({ type: 'CONNECT', playerId: it.id, address: '10.66.6.7' }).ok, false);
    assert.ok(sim.do({ type: 'CONNECT', playerId: it.id, address: sim.s.hiddenHost }).ok);
  }
  assert.equal(getPlayerView(sim.s, it.id).systems.some((x) => x.id === 'BLACKHAT_DB'), true);

  // The IT Specialist can mint themselves a credential for the host and read Blacknet.
  const mint = sim.run(it.id, sim.code(it.id, 'CLIENT_DATA', 'PERMISSIONS'), 'CLIENT_DATA', 'PERMISSIONS', 'CREATE_CREDENTIAL', {
    owner: it.id,
    scope: 'BLACKHAT_DB.*',
    permission: 'READ',
  });
  assert.ok(mint.ok, mint.message);
  const newCode = mint.message.match(/Code: (\d{4})/)![1];
  const read = sim.run(it.id, newCode, 'BLACKHAT_DB', 'BLACKNET', 'READ_MESSAGES');
  assert.ok(read.ok, read.message);
  assert.ok(read.lines![0].includes('ghost: target B3 is ready'));
  // ...and that mint shows up in the permissions registry, naming who issued it.
  const reg = sim.run(it.id, sim.code(it.id, 'CLIENT_DATA', 'PERMISSIONS'), 'CLIENT_DATA', 'PERMISSIONS', 'VIEW_PERMISSIONS');
  assert.ok(reg.lines!.some((l) => l.includes('BLACKHAT_DB.*')));
  assert.ok(!reg.lines!.some((l) => l.includes('BLACKHAT_DB') && l.includes('start of shift')), 'start-of-shift hidden credentials are not in the registry');
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

  assert.ok(sim.run(it.id, sim.code(it.id, 'CLIENT_DATA', 'PERMISSIONS'), 'CLIENT_DATA', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: cred.id }).ok);
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
