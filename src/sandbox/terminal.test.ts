import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, getPlayerView } from '../engine';
import type { GameState, PlayerView, SystemId } from '../engine';
import { amountOf, forHistory, interpret, promptText, tokenize } from './terminal';
import type { TermStep } from './terminal';

const PLAYERS = ['Jeremy', 'Sarah', 'Mike', 'David', 'Lisa', 'Anna', 'Omar', 'Priya', 'Chen', 'Rosa'].map((name, i) => ({ id: `p${i}`, name }));
const T0 = 1_000_000;
const game = (): GameState => createGame({ seed: 42, players: PLAYERS, now: T0, config: { securityDelayScale: 0 } });
const seatOf = (s: GameState, pred: (p: GameState['players'][string]) => boolean): string => Object.values(s.players).find((p) => !p.fake && pred(p))!.id;
const BANK: SystemId[] = ['SECURITY', 'CLIENT_DATA', 'TRANSACTIONS'];

function exec(step: TermStep): Extract<TermStep, { kind: 'execute' }> {
  assert.equal(step.kind, 'execute', step.kind === 'print' ? step.lines.map((l) => l.text).join(' / ') : step.kind);
  return step as Extract<TermStep, { kind: 'execute' }>;
}
const said = (step: TermStep): string => (step.kind === 'print' ? step.lines.map((l) => l.text).join('\n') : '');

test('console: words, quotes and amounts', () => {
  assert.deepEqual(tokenize(`reject 14 "looks off" reason='a b' -c 1234`), ['reject', '14', 'looks off', 'reason=a b', '-c', '1234']);
  assert.deepEqual(tokenize('  view_queue   --all '), ['view_queue', '--all']);
  assert.equal(amountOf('400k'), '400000');
  assert.equal(amountOf('$1,500,000'), '1500000');
  assert.equal(amountOf('1.5m'), '1500000');
  assert.equal(amountOf('abc'), 'abc');
  assert.equal(forHistory('settle 4 -c 1234'), 'settle 4 -c');
  assert.equal(forHistory('settle 4 --code=1234 --all'), 'settle 4 --code= --all');
  assert.equal(promptText(BANK), 'bank>');
  assert.equal(promptText([...BANK, 'HIDDEN_HOST']), 'bank+host>');
  assert.equal(promptText(['TRANSACTIONS']), 'transactions>');
});

test('console: load all loads the bank, never the unregistered host', () => {
  const s = game();
  const thief = seatOf(s, (p) => p.allegiance === 'BLACK');
  const v = getPlayerView(s, thief);
  assert.ok(v.systems.some((x) => x.id === 'HIDDEN_HOST'), 'the Thief knows the host');
  const step = interpret(v, [], 'load all');
  assert.equal(step.kind, 'load');
  assert.deepEqual(step.kind === 'load' && step.ids, BANK);
  // By its address it loads like any other system; an unknown address goes to the network.
  const host = v.systems.find((x) => x.id === 'HIDDEN_HOST')!.address;
  const byAddress = interpret(v, [], `load ${host} 10.9.9.9`);
  assert.deepEqual(byAddress.kind === 'load' && [byAddress.ids, byAddress.unknown], [['HIDDEN_HOST'], ['10.9.9.9']]);
  // A host command while only the bank is loaded: told to load it, without its address on screen.
  const told = said(interpret(v, BANK, 'read_messages'));
  assert.match(told, /unregistered host: load it by its address/);
  assert.ok(!told.includes(host));
});

test('console: the keyring picks your own credential, and the command runs in the engine', () => {
  let s = game();
  const pb = seatOf(s, (p) => p.role === 'PERSONAL_BANKER');
  const v = getPlayerView(s, pb);
  const step = exec(interpret(v, BANK, 'view_customers --all'));
  assert.deepEqual([step.system, step.module, step.fn, step.params], ['CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', { show: 'ALL' }]);
  const key = v.me.credentials.find((c) => c.code === step.code)!;
  assert.ok(key.own && key.module === 'CUSTOMER_RECORDS', 'the narrowest credential of their own');
  assert.match(step.header, new RegExp(`\\(${key.id}, yours\\)`));
  const r = applyAction(s, { type: 'EXECUTE', playerId: pb, code: step.code, system: step.system, module: step.module, fn: step.fn, params: step.params, encCodes: step.encCodes }, T0);
  s = r.state;
  assert.ok(r.result.ok, r.result.message);
  // Nothing of theirs covers the Firewall: refused here, so no failed attempt is logged.
  assert.match(said(interpret(v, BANK, 'view_status')), /No credential of yours covers/);
  // -c always wins: the code is sent as typed.
  assert.equal(exec(interpret(v, BANK, 'view_status -c 0042')).code, '0042');
});

test('console: someone else\'s credential is never used unless its code is typed', () => {
  const s = game();
  const pb = seatOf(s, (p) => p.role === 'PERSONAL_BANKER');
  const v: PlayerView = getPlayerView(s, pb);
  v.me.credentials = v.me.credentials.map((c) => ({ ...c, own: false, ownerName: 'Dana' }));
  assert.match(said(interpret(v, BANK, 'view_customers')), /Dana's\) might: the console only uses someone else's code if you type it/);
});

test('console: values fill in order, flags pick options, names set anything', () => {
  const s = game();
  const v = getPlayerView(s, seatOf(s, (p) => p.role === 'BANK_MANAGER'));
  const c = ' -c 1111';
  assert.deepEqual(exec(interpret(v, BANK, 'reject 14 duplicate payment' + c)).params, { txId: '14', reason: 'duplicate payment' });
  assert.deepEqual(exec(interpret(v, BANK, 'run_risk_check 3 high "too big"' + c)).params, { txId: '3', score: 'HIGH', reason: 'too big' });
  assert.deepEqual(exec(interpret(v, BANK, 'payment_queue create_transaction 12345 CU7 400k req-3' + c)).params, { originAccount: '12345', beneficiaryId: 'CU7', amount: '400000', requestId: 'req-3' });
  assert.deepEqual(exec(interpret(v, BANK, 'add_account CU3 12345 --make-primary' + c)).params, { customerId: 'CU3', account: '12345', makePrimary: 'YES' });
  assert.deepEqual(exec(interpret(v, BANK, 'set_auto_score 5m --all payee=verified origin=any' + c)).params, { maxAmount: '5000000', source: 'ALL', payee: 'VERIFIED', origin: 'ANY' });
  assert.match(said(interpret(v, BANK, 'set_auto_score 0 --all --any' + c)), /fits more than one value/);
  assert.match(said(interpret(v, BANK, 'run_risk_check 3 extreme' + c)), /score must be one of low, medium, high/);
  assert.match(said(interpret(v, BANK, 'settle' + c)), /Missing txId/);
  assert.deepEqual(exec(interpret(v, BANK, 'set_security settlement --off' + c)).params, { target: 'TRANSACTIONS.SETTLEMENT', security: 'OFF' });
  assert.deepEqual(exec(interpret(v, BANK, 'create_credential sarah client_data read' + c)).params, { owner: 'p1', scope: 'CLIENT_DATA.*', permission: 'READ' });
  assert.match(said(interpret(v, ['CLIENT_DATA'], 'view_queue')), /on Transaction Processing: load 10\.0\.0\.30/);
});

test('console: every function can be reached and given its values', () => {
  const s = game();
  const thief = seatOf(s, (p) => p.allegiance === 'BLACK');
  const v = getPlayerView(s, thief);
  const loaded = v.systems.map((x) => x.id);
  const sample = (kind: string, options?: string[], placeholder?: string): string =>
    kind === 'select' ? options![0] : kind === 'player' ? 'Sarah' : kind === 'module' ? 'transactions.settlement' : kind === 'scope' ? 'client_data' : kind === 'number' ? '10' : `"${placeholder ?? 'x'}"`;
  let count = 0;
  for (const sys of v.systems) {
    for (const mod of sys.modules) {
      for (const f of mod.fns) {
        assert.match(said(interpret(v, loaded, `help ${f.id.toLowerCase()}`)), new RegExp(f.label.replace(/[()]/g, '.')));
        const values = f.params.filter((p) => !p.optional).map((p) => `${p.name}=${sample(p.kind, p.options, p.placeholder)}`);
        const step = exec(interpret(v, loaded, [mod.id.toLowerCase(), f.id.toLowerCase(), ...values, '-c', '0000'].join(' ')));
        assert.deepEqual([step.system, step.module, step.fn], [sys.id, mod.id, f.id]);
        for (const p of f.params.filter((x) => !x.optional)) assert.ok(step.params[p.name], `${f.id}: ${p.name}`);
        count++;
      }
    }
  }
  assert.ok(count > 40, `${count} functions`);
});
