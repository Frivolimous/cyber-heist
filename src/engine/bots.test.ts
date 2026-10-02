// Bot mode: reading requests, and the bank's bots doing their jobs from what their pages show.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyAction, createGame, tick } from './index';
import type { GameState, SystemId } from './index';
import type { BotLevel } from './bots';
import { hear, notMeText, questionText, reportText } from './chatter';
import { readRequest } from './reading';
import { codeFor } from './senses';
import type { CustomerRow } from './perception';
import { spawnRequest } from './requests';

const T0 = 1_000_000;
const PLAYERS = ['Ann', 'Ben', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal', 'Ida', 'Joe'].map((name, i) => ({ id: `p${i}`, name }));

/** Customer Records as anyone sees them (balances do not matter to reading). */
const customerRows = (s: GameState): CustomerRow[] =>
  s.customers.map((c) => ({
    id: c.id,
    name: c.name,
    banker: null,
    suspended: c.suspended,
    primary: { account: c.primary, balance: 0, verified: true },
    others: c.accounts.filter((a) => a !== c.primary).map((a) => ({ account: a, balance: 0, verified: true })),
  }));

test('a bot reads every kind of request from its words: what is asked, of whom, how much, from which account', () => {
  let read = 0;
  const kinds = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    let s = createGame({ seed, players: PLAYERS, now: T0 });
    s = tick(s, T0 + 400_000); // first requests and some phishing have arrived
    for (let i = 0; i < 60; i++) spawnRequest(s);
    const rows = customerRows(s);
    for (const r of s.requests) {
      const ask = readRequest({ from: r.sender ?? s.customers.find((c) => c.id === r.customerId)!.name, text: r.text, urgent: r.urgent }, rows);
      const where = `${r.id} "${r.text}"`;
      if (r.phish) {
        assert.equal(ask.kind, 'PHISH', where);
        continue;
      }
      assert.equal(ask.kind, r.kind, where);
      assert.equal(ask.customerId, r.customerId, where);
      kinds.add(r.kind);
      if (r.kind === 'PAYMENT') {
        assert.equal(ask.amount, r.amount, where);
        assert.equal(ask.payeeId, r.payeeId, where);
        if (ask.from!.form === 'NUMBER') assert.equal(ask.from!.account, r.originAccount, where);
        // MAIN and OTHER are looked up in Customer Records when the banker acts (what the customer believed then).
      } else assert.equal(ask.account, r.account, where);
      read++;
    }
  }
  assert.ok(read > 300, `read ${read}`);
  assert.deepEqual([...kinds].sort(), ['ADD_ACCOUNT', 'ADD_AND_PRIMARY', 'PAYMENT', 'REMOVE_ACCOUNT', 'SET_PRIMARY']);
});

/** A single-player day with nobody stealing: the human does nothing, the five bots run the bank. */
function botDay(seed: number, level: BotLevel): GameState {
  let s = createGame({ seed, players: [{ id: 'me', name: 'Me' }], now: T0, scenario: 'SOLO', config: { botLevel: level } });
  for (let t = 1; t <= s.config.durationSec + 1 && s.status === 'RUNNING'; t++) s = tick(s, T0 + t * 1000);
  return s;
}

test('Standard bots run the bank on their own: the target met every day, requests answered, phishing archived, nobody walks out', () => {
  let won = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = botDay(seed, 'STANDARD');
    if (s.winner === 'WHITE') won++;
    else assert.ok(s.totals.processed > s.config.whiteTarget * 0.9, `seed ${seed}: settled only ${s.totals.processed} of ${s.config.whiteTarget}`);
    const real = s.requests.filter((r) => !r.phish);
    assert.ok(real.filter((r) => r.outcome === 'MISSED').length <= 2, `seed ${seed}: too many missed requests`);
    assert.ok(s.requests.filter((r) => r.phish).every((r) => r.status === 'ARCHIVED'), `seed ${seed}: phishing left open`);
    assert.equal(s.customers.filter((c) => c.suspended).length, 0, `seed ${seed}`);
    // Nobody stole anything: no alarms, no messages, nothing revoked.
    assert.equal(s.revocations.length, 0, `seed ${seed}`);
    assert.ok(Object.values(s.players).every((p) => p.messages.every((m) => !s.players[m.from]?.bot)), `seed ${seed}: a bot raised the alarm`);
    // Everything they did was done with their own codes, as themselves.
    for (const id of Object.keys(s.bots!.bots)) {
      assert.ok(s.logs.filter((e) => e.actualPlayerId === id && e.kind === 'ACCESS').every((e) => e.actor === id), `${id} borrowed a code`);
    }
  }
  assert.equal(won, 5, `the bank won ${won} of 5`);
});

test('Rookie bots do the day job as well as Standard ones: the bank wins a quiet day', () => {
  for (const seed of [1, 2, 3]) {
    const s = botDay(seed, 'ROOKIE');
    assert.equal(s.winner, 'WHITE', `seed ${seed}: settled ${s.totals.processed} of ${s.config.whiteTarget}`);
    assert.equal(s.revocations.length, 0, `seed ${seed}`);
    assert.ok(Object.values(s.players).every((p) => p.messages.every((m) => !s.players[m.from]?.bot)), `seed ${seed}: a bot raised the alarm`);
  }
});

test('the levels differ: Ruthless bots settle more and miss less than Rookies', () => {
  for (const seed of [2, 3]) {
    const rookie = botDay(seed, 'ROOKIE');
    const ruthless = botDay(seed, 'RUTHLESS');
    const missed = (s: GameState): number => s.requests.filter((r) => !r.phish && r.outcome === 'MISSED').length;
    assert.ok(ruthless.totals.processed > rookie.totals.processed, `seed ${seed}`);
    assert.ok(missed(ruthless) <= missed(rookie), `seed ${seed}`);
  }
});

test('bots decide from their pages only: the bot code never reads the bank\'s raw records', () => {
  const src = ['./bots.ts', './botkit.ts', './detective.ts', './chatter.ts', './reading.ts'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join(' ');
  for (const raw of ['.requests', '.transactions', '.customers', '.credentials', '.phish', '.scam', '.known', 'riskFlags', 'balances', 'allegiance', '.targets']) {
    assert.ok(!src.includes(raw), `the bot code reads ${raw}`);
  }
});

/** The human swaps one of BankerBot1's customers' primary to a mule at 2:30, with BankerBot1's own code. */
function swapGame(level: BotLevel, seed = 4): { s: GameState; customerId: string; mule: string; before: string } {
  let s = createGame({ seed, players: [{ id: 'me', name: 'Me' }], now: T0, scenario: 'SOLO', config: { botLevel: level } });
  for (let t = 1; t <= 150; t++) s = tick(s, T0 + t * 1000);
  const cust = s.customers.find((c) => c.bankerId === 'bot1')!;
  const before = cust.primary;
  const mule = s.targets[0].account;
  const code = codeFor(s, s.players.bot1, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT')!;
  const r = applyAction(s, { type: 'EXECUTE', playerId: 'me', code, system: 'CLIENT_DATA', module: 'CUSTOMER_RECORDS', fn: 'ADD_ACCOUNT', params: { customerId: cust.id, account: mule.slice(4), makePrimary: 'YES' } }, T0 + 150_000);
  assert.ok(r.result.ok, r.result.message);
  return { s: r.state, customerId: cust.id, mule, before };
}
const bankerCreds = (s: GameState): { id: string; status: string }[] =>
  Object.values(s.credentials).filter((c) => c.owner === 'bot1' && c.module === 'CUSTOMER_RECORDS');

test('a primary swap with a stolen code, at Standard: put back, reported, the code replaced, the trace leads to the human, who loses all access', () => {
  let { s, customerId, mule, before } = swapGame('STANDARD');
  for (let t = 151; t <= 600 && s.status === 'RUNNING'; t++) s = tick(s, T0 + t * 1000);
  const cust = s.customers.find((c) => c.id === customerId)!;
  assert.equal(cust.primary, before, 'the old primary is back');
  assert.ok(!cust.accounts.includes(mule), 'the mule is off the file');
  const toIt = s.players.bot4.messages.filter((m) => m.to === 'bot4').map((m) => m.text);
  assert.ok(toIt.some((x) => x.startsWith(`Report: ${customerId}'s accounts were changed with no request (${mule}`)), 'reported to IT');
  const creds = bankerCreds(s);
  assert.ok(creds.some((c) => c.status === 'REVOKED') && creds.some((c) => c.status === 'ACTIVE'), 'the stolen code revoked, a new one issued');
  assert.ok(s.players.me.messages.some((m) => m.from === 'bot4' && /revoking all access for/.test(m.text)), 'told before the end');
  assert.equal(s.players.me.terminated?.reason, 'IP_REVOKED');
  assert.equal(s.winner, 'WHITE');
  assert.ok(s.endedAt! < 400, `caught at ${s.endedAt}`);
});

test('at Rookie the swap is put back and the code replaced, but nobody is chased, and the framed banker is cleared', () => {
  let { s, customerId, before } = swapGame('ROOKIE');
  for (let t = 151; t <= 600 && s.status === 'RUNNING'; t++) s = tick(s, T0 + t * 1000);
  assert.equal(s.customers.find((c) => c.id === customerId)!.primary, before);
  const creds = bankerCreds(s);
  assert.ok(creds.some((c) => c.status === 'ACTIVE'), 'the banker can still work');
  assert.equal(s.status, 'RUNNING');
  assert.equal(s.revocations.length, 0);
  assert.ok(!s.bots!.bots.bot4.evidence.some((e) => e.subject === 'emp:BankerBot1'), 'BankerBot1 said it was not them');
});

test('bot messages: the forms bots write are the forms they read', () => {
  assert.deepEqual(hear(reportText('CU4', 'ACC-12345', 'made primary', 'Sam', true)), { kind: 'REPORT', customerId: 'CU4', account: 'ACC-12345', what: 'made primary', by: 'Sam', stolen: false });
  assert.deepEqual(hear(reportText('CU4', 'ACC-12345', 'added', 'ME', false)), { kind: 'REPORT', customerId: 'CU4', account: 'ACC-12345', what: 'added', by: null, stolen: true });
  assert.deepEqual(hear(reportText('CU12', 'ACC-12345', 'removed', null, true)), { kind: 'REPORT', customerId: 'CU12', account: 'ACC-12345', what: 'removed', by: null, stolen: false });
  assert.deepEqual(hear(questionText('CU4', 'ACC-12345', 'added')), { kind: 'QUESTION', customerId: 'CU4', account: 'ACC-12345', what: 'added' });
  assert.deepEqual(hear(notMeText('CU4', 'ACC-12345')), { kind: 'NOT_ME', customerId: 'CU4', account: 'ACC-12345' });
  assert.equal(hear('hello there'), null);
});

/** A single-player game where the human makes one move at `at` seconds (with a code of theirs or one given). */
function moveGame(level: BotLevel, at: number, system: SystemId, module: string, fn: string, params: (s: GameState) => Record<string, string>, code?: (s: GameState) => string) {
  let s = createGame({ seed: 1, players: [{ id: 'me', name: 'Me' }], now: T0, scenario: 'SOLO', config: { botLevel: level } });
  for (let t = 1; t <= at; t++) s = tick(s, T0 + t * 1000);
  const c = code ? code(s) : codeFor(s, s.players.me, system, module, fn)!;
  const r = applyAction(s, { type: 'EXECUTE', playerId: 'me', code: c, system, module, fn, params: params(s) }, T0 + at * 1000);
  assert.ok(r.result.ok, r.result.message);
  s = r.state;
  return {
    get s() {
      return s;
    },
    until(sec: number): GameState {
      for (let t = at + 1; t <= sec && s.status === 'RUNNING'; t++) s = tick(s, T0 + t * 1000);
      return s;
    },
  };
}
const itFirewallCode = (s: GameState): string => Object.values(s.credentials).find((c) => c.owner === 'bot4' && c.module === 'FIREWALL' && c.status === 'ACTIVE')!.code;

test('the Master Log taken offline with IT\'s stolen code: put back online within a minute, and the trace leads to the human', () => {
  const g = moveGame('STANDARD', 120, 'SECURITY', 'FIREWALL', 'SET_MODULE_STATUS', () => ({ target: 'SECURITY.MASTER_LOG', status: 'OFFLINE' }), itFirewallCode);
  let s = g.until(180);
  assert.equal(s.modules['SECURITY.MASTER_LOG'].status, 'ONLINE');
  s = g.until(420);
  assert.equal(s.players.me.terminated?.reason, 'IP_REVOKED');
  assert.ok(Object.values(s.credentials).some((c) => c.owner === 'bot4' && c.module === 'FIREWALL' && c.status === 'REVOKED'), 'the stolen code replaced');
  assert.ok(Object.values(s.credentials).some((c) => c.owner === 'bot4' && c.module === 'FIREWALL' && c.status === 'ACTIVE'), 'and IT given a new one');
});

test('"revoke all access" on one of the bank\'s systems is cancelled before it goes through, even at Rookie', () => {
  for (const level of ['ROOKIE', 'STANDARD'] as BotLevel[]) {
    const s = moveGame(level, 120, 'SECURITY', 'FIREWALL', 'REVOKE_ALL_ACCESS', () => ({ address: '10.0.0.30' }), itFirewallCode).until(200);
    assert.equal(s.revocations[0].status, 'CANCELLED', level);
    assert.notEqual(s.endKind, 'SHUTDOWN', level);
  }
});

test('a code crack: security revokes the named credential (a Firewall one after its countdown) and gives its owner a new one', () => {
  const g = moveGame('STANDARD', 100, 'HIDDEN_HOST', 'ACCESS', 'CRACK_CODE', () => ({ target: 'SECURITY.FIREWALL' }));
  const cracked = g.s.cracks.at(-1)!.credentialId;
  const s = g.until(230);
  const cr = s.credentials[cracked];
  assert.equal(cr.status, 'REVOKED', 'the cracked code is dead');
  assert.ok(Object.values(s.credentials).some((c) => c.owner === cr.owner && c.id !== cracked && c.module === cr.module && c.status === 'ACTIVE'), 'reissued');
});

test('scam requests: Standard bankers fall for them; Sharp ones hold a request that came with a server alert and archive it when nobody follows up', () => {
  const scam = (level: BotLevel): GameState =>
    moveGame(level, 120, 'HIDDEN_HOST', 'SOCIAL', 'SCAM_REQUEST', (s) => ({ customer: s.customers.find((c) => c.bankerId === 'bot1')!.id, kind: 'ADD_AND_PRIMARY', account: s.targets[0].account.slice(4) })).until(400);
  const standard = scam('STANDARD');
  assert.equal(standard.requests.find((r) => r.scam)!.status, 'DONE');
  const sharp = scam('SHARP');
  const req = sharp.requests.find((r) => r.scam)!;
  assert.equal(req.status, 'ARCHIVED');
  assert.match(req.archiveReason!, /^Scam/);
  assert.ok(sharp.players.bot1.messages.some((m) => /^Hold REQ-\d+: it came in with a server alert/.test(m.text)), 'the Manager told the banker to hold it');
  assert.equal(sharp.totals.stolen, 0);
});

test('a scam payment already made when the hold comes is rejected, so only a real customer would chase it', () => {
  const s = moveGame('RUTHLESS', 120, 'HIDDEN_HOST', 'SOCIAL', 'SCAM_REQUEST', (st) => {
    const cust = st.customers.find((c) => c.bankerId === 'bot1')!;
    return { customer: cust.id, kind: 'PAYMENT', payee: st.customers.find((c) => c.id !== cust.id)!.id, amount: '300000', urgent: 'NO' };
  }).until(400);
  const req = s.requests.find((r) => r.scam)!;
  const tx = s.transactions.find((x) => x.requestId === req.id);
  assert.ok(!tx || tx.status === 'REJECTED', `the payment is ${tx?.status}`);
});

test('wary bots never take a real customer for a scammer on a quiet day', () => {
  for (const level of ['SHARP', 'RUTHLESS'] as BotLevel[]) {
    for (const seed of [1, 3]) {
      const s = botDay(seed, level);
      assert.ok(!s.requests.some((r) => !r.phish && /Scam/.test(r.archiveReason ?? '')), `${level} seed ${seed}`);
      assert.equal(s.requests.filter((r) => !r.phish && r.outcome === 'MISSED').length, 0, `${level} seed ${seed}`);
    }
  }
});

test('"make this account primary" for an account not on file is answered by adding it as primary, with the request id', () => {
  let s = createGame({ seed: 1, players: [{ id: 'me', name: 'Me' }], now: T0, scenario: 'SOLO' });
  delete s.bots; // nobody else acts
  s = tick(s, T0 + 100_000);
  const cust = s.customers.find((c) => c.bankerId === 'bot1')!;
  const mule = s.targets[0].account;
  const scamCode = codeFor(s, s.players.me, 'HIDDEN_HOST', 'SOCIAL', 'SCAM_REQUEST')!;
  let r = applyAction(s, { type: 'EXECUTE', playerId: 'me', code: scamCode, system: 'HIDDEN_HOST', module: 'SOCIAL', fn: 'SCAM_REQUEST', params: { customer: cust.id, kind: 'SET_PRIMARY', account: mule.slice(4) } }, T0 + 100_000);
  s = r.state;
  const req = s.requests.at(-1)!;
  const code = codeFor(s, s.players.bot1, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT')!;
  r = applyAction(s, { type: 'EXECUTE', playerId: 'bot1', code, system: 'CLIENT_DATA', module: 'CUSTOMER_RECORDS', fn: 'ADD_ACCOUNT', params: { requestId: req.id, customerId: cust.id, account: mule.slice(4), makePrimary: 'YES' } }, T0 + 101_000);
  assert.ok(r.result.ok, r.result.message);
  assert.equal(r.state.requests.find((x) => x.id === req.id)!.status, 'DONE');
  // Without "make it primary" it is still the wrong kind.
  const plain = applyAction(s, { type: 'EXECUTE', playerId: 'bot1', code, system: 'CLIENT_DATA', module: 'CUSTOMER_RECORDS', fn: 'ADD_ACCOUNT', params: { requestId: req.id, customerId: cust.id, account: mule.slice(4) } }, T0 + 101_000);
  assert.equal(plain.result.ok, false);
});
