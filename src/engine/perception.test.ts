// Bot perception (perception.ts, senses.ts): every bank page's data says what its text says, no more, no less.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, money, tick } from './index';
import type { ActionResult, GameState, Player, SystemId } from './index';
import { parseTrace } from './perception';
import type { PageData } from './perception';
import { codeFor, look } from './senses';

const T0 = 1_000_000;

/** Ground truth that must never reach a bot through a page. */
const FORBIDDEN = ['actualPlayerId', 'closedByActual', 'phish', 'scam', 'known', 'riskFlags', 'sourceIp', 'allegiance', 'outcome', 'fraud', 'wealth', 'settledTo', 'debitedFrom', 'payeeId', 'originAccountAsked', 'code'];

function forbiddenKeys(x: unknown, path = ''): string[] {
  if (Array.isArray(x)) return x.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (x && typeof x === 'object') {
    return Object.entries(x).flatMap(([k, v]) => [...(FORBIDDEN.includes(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)]);
  }
  return [];
}

/** A SOLO game four minutes in, with a stolen-code primary swap, host traffic, a block and a pending revocation. */
function busyGame(): GameState {
  let s = createGame({ seed: 11, players: [{ id: 'me', name: 'Me' }], now: T0, scenario: 'SOLO' });
  const act = (pid: string, system: SystemId, module: string, fn: string, params: Record<string, string>, code?: string): ActionResult => {
    const p = s.players[pid];
    const r = applyAction(s, { type: 'EXECUTE', playerId: pid, code: code ?? codeFor(s, p, system, module, fn) ?? '', system, module, fn, params }, T0 + 200_000);
    s = r.state;
    return r.result;
  };
  for (let t = 1; t <= 200; t++) s = tick(s, T0 + t * 1000);
  const bot = (role: string): Player => Object.values(s.players).find((p) => p.bot && p.role === role)!;
  const banker = bot('PERSONAL_BANKER');
  const cust = s.customers.find((x) => x.bankerId === banker.id)!;
  const mule = s.targets[0].account;
  // The human swaps a primary to a mule with the banker's code, and posts on Blacknet.
  const bankerCode = codeFor(s, banker, 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT')!;
  assert.ok(act('me', 'CLIENT_DATA', 'CUSTOMER_RECORDS', 'ADD_ACCOUNT', { customerId: cust.id, account: mule.slice(4), makePrimary: 'YES' }, bankerCode).ok);
  assert.ok(act('me', 'HIDDEN_HOST', 'BLACKNET', 'POST_MESSAGE', { text: 'hello "crew"' }).ok);
  // The IT bot blocks an address; the Manager starts revoking the IT bot's Firewall credential.
  const it = bot('IT_SPECIALIST');
  assert.ok(act(it.id, 'SECURITY', 'FIREWALL', 'BLOCK_ADDRESS', { address: s.players.me.ip }).ok);
  const fw = Object.values(s.credentials).find((c) => c.owner === it.id && c.module === 'FIREWALL')!;
  assert.ok(act(bot('BANK_MANAGER').id, 'SECURITY', 'PERMISSIONS', 'REVOKE_CREDENTIAL', { credentialId: fw.id }).ok);
  for (let t = 201; t <= 240; t++) s = tick(s, T0 + t * 1000);
  return s;
}

/** Ids at the start of a page's row lines, in order. */
function lineIds(lines: string[], re: RegExp): string[] {
  return lines.map((l) => re.exec(l)?.[1]).filter((x): x is string => !!x);
}

function checkPage(d: PageData, text: string, lines: string[], where: string): void {
  const has = (part: string, what: string): void => assert.ok(text.includes(part), `${where}: ${what} "${part}" is not on the page`);
  switch (d.page) {
    case 'REQUESTS':
      assert.deepEqual(d.rows.map((r) => r.id), lineIds(lines, /^(REQ-\d+)\s/), where);
      for (const r of d.rows) {
        has(r.from, 'sender');
        has(r.to, 'banker');
        has(r.text, 'text');
        for (const f of r.followUps) has(f.text, 'follow-up');
        if (r.dueInSec !== null) has(`due in ${r.dueInSec}s`, 'deadline');
        if (r.closedBy) has(`by ${r.closedBy}`, 'closed by');
        if (r.txId) has(r.txId, 'payment');
        if (r.archiveReason) has(r.archiveReason, 'archive reason');
      }
      break;
    case 'CUSTOMERS':
      assert.deepEqual(d.rows.map((r) => r.id), lineIds(lines, /^(CU\d+)\s/), where);
      for (const r of d.rows) {
        has(r.name, 'name');
        if (r.banker) has(`banker: ${r.banker}`, 'banker');
        for (const a of [r.primary, ...r.others]) has(`${a.account} ${money(a.balance)}${a.verified ? '' : ' (unverified)'}`, 'account');
        if (r.suspended) has('SUSPENDED', 'suspended');
      }
      break;
    case 'CHANGES':
    case 'INVESTIGATE':
      assert.deepEqual(d.rows.map((r) => r.id), lineIds(lines, /^(CH-\d+)\s/), where);
      for (const r of d.rows) {
        has(r.customerId, 'customer');
        has(r.account, 'account');
        has(`by ${r.by}`, 'by');
        if (r.previousPrimary) has(`primary ${r.previousPrimary} -> ${r.account}`, 'previous primary');
        if (r.requestId) has(`for ${r.requestId}`, 'request');
        has(r.verified ? `VERIFIED by ${r.verifiedBy}` : 'UNVERIFIED', 'verified');
      }
      if (d.page === 'INVESTIGATE' && d.account) has(money(d.account.balance), 'balance');
      if (d.page === 'INVESTIGATE' && d.customer) has(`Opened with primary ${d.customer.originalPrimary}; primary now ${d.customer.primary}`, 'primaries');
      break;
    case 'PAYMENTS':
      assert.deepEqual(d.rows.map((r) => r.id), lineIds(lines, /^(TX-\d+)\s/), where);
      for (const r of d.rows) {
        const head = lines.find((l) => l.startsWith(r.id + ' '))!;
        const sub = d.stage === 'QUEUE' ? '' : lines[lines.indexOf(head) + 1];
        const row = head + '\n' + sub;
        const in_ = (part: string, what: string): void => assert.ok(row.includes(part), `${where} ${r.id}: ${what} "${part}" not shown`);
        in_(money(r.amount), 'amount');
        in_(`${r.originCustomer ?? 'UNKNOWN'} ${r.originAccount} -> ${r.beneficiaryId} ${r.beneficiaryPrimary ?? '?'}`, 'route');
        in_(`[${r.status}`, 'status');
        if (r.risk) in_(`risk ${r.risk}`, 'risk');
        if (r.requestId) in_(`for ${r.requestId}`, 'request');
        if (r.unverified?.length) in_(`!! UNVERIFIED: ${r.unverified.join(', ')}`, 'unverified');
        if (r.created) in_(`by ${r.created.by}`, 'creator');
        if (r.checked) in_(`risk ${r.risk} by ${r.checked.by}`, 'checker');
        if (r.approved) in_(`approved by ${r.approved.by}`, 'approver');
        if (r.last) in_(`by ${r.last.by}`, 'last step');
        if (r.reversibleSec) in_(`reversible for ${r.reversibleSec}s`, 'reversal');
      }
      break;
    case 'LOG':
      assert.deepEqual(d.rows.map((r) => r.id), lineIds(lines, /^\[[^\]]+\] (L\d+)\s/), where);
      for (const r of d.rows) {
        has(r.message, 'message');
        if (r.by) assert.ok(r.message.includes(r.by), `${where}: ${r.id} is recorded under ${r.by} but its message does not say so`);
      }
      break;
    case 'ALERTS':
      assert.deepEqual(d.rows.map((r) => r.id), lineIds(lines, /^\[[^\]]+\] (A\d+)\s/), where);
      for (const r of d.rows) {
        has(`${r.kind}: ${r.message}`, 'alert');
        if (r.logId) has(`(log ${r.logId})`, 'log id');
      }
      break;
    case 'EMPLOYEES':
      assert.deepEqual(d.rows.map((r) => r.ip), lineIds(lines, /^\S.* (\d+\.\d+\.\d+\.\d+)/), where);
      for (const r of d.rows) {
        has(r.name, 'name');
        has(r.role, 'role');
        if (r.lockedSec) has(`LOCKED OUT ${r.lockedSec}s`, 'lockout');
        if (r.blockedSec) has(r.blockedSec < 0 ? 'BLOCKED permanently' : `BLOCKED for ${r.blockedSec}s`, 'block');
        if (r.terminated) has(r.terminated.resigned ? 'RESIGNED' : 'TERMINATED', 'terminated');
      }
      assert.deepEqual(d.rows.map((r) => r.failedAttempts), lineIds(lines, /failed attempts: (\d+)/).map(Number), where);
      break;
    case 'CREDENTIALS':
      assert.deepEqual(d.rows.map((r) => r.id), lineIds(lines, /^(C\d+)\s/), where);
      assert.deepEqual(d.pending.map((r) => r.credentialId), lineIds(lines, /^PENDING {2}revoke (C\d+)/), where);
      for (const r of d.rows) {
        const line = lines.find((l) => l.startsWith(r.id + ' '))!;
        assert.ok(line.includes(r.owner) && line.includes(r.status), `${where}: ${r.id}`);
        assert.ok(line.includes(r.issuedBy ?? 'start of shift'), `${where}: ${r.id} issuer`);
      }
      for (const p of d.pending) has(`in ${p.inSec}s  (started by ${p.startedBy}`, 'pending revocation');
      break;
    case 'FIREWALL':
      assert.deepEqual(d.revocations.map((r) => r.id), lineIds(lines, /^PENDING {2}(R\d+)/), where);
      assert.deepEqual(d.blocks.map((b) => b.address), lineIds(lines, /^BLOCKED {2}(\S+)/), where);
      assert.equal(d.modules.length, lines.filter((l) => !/^(PENDING|BLOCKED) /.test(l)).length, where);
      for (const m of d.modules) assert.ok(m.online || text.includes('OFFLINE'), where);
      for (const b of d.blocks) has(`by ${b.by}`, 'blocker');
      break;
    case 'TRACE':
      has(d.logId, 'entry');
      for (const v of [d.clue.ip, d.clue.server, d.clue.activity, d.clue.hostCode, ...(d.clue.pair ?? [])]) if (v) has(v, 'clue');
      if (d.clue.range) has(`${d.clue.range.prefix}.${d.clue.range.lo}-${d.clue.range.hi}`, 'range');
      if (d.clue.leak) has(d.clue.leak.text, 'leak');
      break;
  }
}

/** Every bank read, with the choices its page offers. */
const READS: [SystemId, string, string, Record<string, string>[]][] = [
  ['SECURITY', 'FIREWALL', 'VIEW_STATUS', [{}]],
  ['SECURITY', 'MASTER_LOG', 'VIEW_LOG', [{ show: 'PLAYERS', limit: '200' }, { show: 'ALL', limit: '200' }, { show: 'ALERTS', limit: '200' }, {}]],
  ['SECURITY', 'EMPLOYEE_RECORDS', 'VIEW_EMPLOYEES', [{}]],
  ['SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS', [{}, { show: 'ALL' }]],
  ['CLIENT_DATA', 'CUSTOMER_RECORDS', 'VIEW_CUSTOMERS', [{}, { show: 'MINE' }, { show: 'ALL' }]],
  ['CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS', [{}, { show: 'ALL' }]],
  ['CLIENT_DATA', 'VERIFICATION', 'VIEW_VERIFICATION', [{}, { show: 'ALL' }]],
  ['TRANSACTIONS', 'PAYMENT_QUEUE', 'VIEW_QUEUE', [{}, { show: 'ALL' }]],
  ['TRANSACTIONS', 'RISK_CHECK', 'VIEW_RISK_QUEUE', [{}, { show: 'ALL' }]],
  ['TRANSACTIONS', 'AUTHORIZATION', 'VIEW_AUTH_QUEUE', [{}, { show: 'ALL' }]],
  ['TRANSACTIONS', 'SETTLEMENT', 'VIEW_SETTLEMENT', [{}, { show: 'ALL' }]],
];

test('every bank page\'s data says exactly what its text says, for every seat, and holds no ground truth', () => {
  const s = busyGame();
  const now = T0 + 240_000;
  // Investigate: one customer with changes, and the mule account that was swapped in.
  const swapped = s.customers.find((x) => x.history.some((h) => s.targets.some((tg) => tg.account === h.account)))!;
  const reads: [SystemId, string, string, Record<string, string>[]][] = [
    ...READS,
    ['CLIENT_DATA', 'VERIFICATION', 'INVESTIGATE_CHANGES', [{ target: swapped.id }, { target: s.targets[0].account.slice(4) }]],
  ];
  let checked = 0;
  const pages = new Set<string>();
  for (const pid of s.playerOrder) {
    const p = s.players[pid];
    for (const [system, module, fn, variants] of reads) {
      const code = codeFor(s, p, system, module, fn);
      if (!code) continue;
      for (const params of variants) {
        const where = `${p.name} ${module}.${fn} ${JSON.stringify(params)}`;
        const r: ActionResult = applyAction(s, { type: 'EXECUTE', playerId: pid, code, system, module, fn, params }, now).result;
        if (!r.ok) continue; // e.g. the human's workstation is blocked
        assert.ok(r.data, `${where}: no data`);
        assert.deepEqual(forbiddenKeys(r.data), [], `${where}: ground truth in the data`);
        checkPage(r.data, [r.message, ...(r.lines ?? [])].join('\n'), r.lines ?? [], where);
        pages.add(r.data.page);
        checked++;
      }
    }
  }
  // Traces: the Manager traces the Blacknet post (a relay clue with a leak) and a bank entry (an exact IP).
  const mgr = Object.values(s.players).find((p) => p.bot && p.role === 'BANK_MANAGER')!;
  const traceCode = codeFor(s, mgr, 'SECURITY', 'MASTER_LOG', 'TRACE')!;
  const post = [...s.logs].reverse().find((e) => e.kind === 'HIDDEN_ACCESS' && e.activity === 'posted on Blacknet')!;
  const bankEntry = [...s.logs].reverse().find((e) => e.actualPlayerId === 'me' && e.kind === 'ACCESS')!; // the swap, under the banker's name
  let at = now;
  for (const e of [post, bankEntry]) {
    const r: ActionResult = applyAction(s, { type: 'EXECUTE', playerId: mgr.id, code: traceCode, system: 'SECURITY', module: 'MASTER_LOG', fn: 'TRACE', params: { logId: e.id } }, at).result;
    assert.ok(r.ok && r.data?.page === 'TRACE', r.message);
    assert.deepEqual(forbiddenKeys(r.data), []);
    checkPage(r.data, r.message, [], `trace ${e.id}`);
    if (e === post) assert.ok(r.data.clue.relay && r.data.clue.leak?.text === 'hello "crew"', r.message);
    else assert.equal(r.data.clue.ip, s.players.me.ip, r.message);
    pages.add('TRACE');
    at += 31_000; // past the trace cooldown
  }
  assert.ok(pages.has('TRACE'));
  assert.ok(checked > 40, `only ${checked} pages checked`);
  for (const pg of ['REQUESTS', 'CUSTOMERS', 'CHANGES', 'INVESTIGATE', 'PAYMENTS', 'LOG', 'ALERTS', 'EMPLOYEES', 'CREDENTIALS', 'FIREWALL']) assert.ok(pages.has(pg), pg);
});

test('the busy game has something on every page worth checking', () => {
  const s = busyGame();
  assert.ok(s.blocks.length && s.requests.length && s.transactions.some((tx) => tx.status === 'SETTLED'));
    assert.ok(s.customers.some((x) => x.history.some((h) => !h.verified)));
});

test('a trace\'s data is its sentence taken apart, for every kind of clue', () => {
  const cases: [string, object][] = [
    ['Trace L4: origin workstation 10.1.0.17', { ip: '10.1.0.17' }],
    ['Trace L4: system event, no workstation origin.', { system: true }],
    ['Trace L9: routed through a relay. The origin workstation is within 10.1.0.37-112.', { relay: true, range: { prefix: '10.1.0', lo: 37, hi: 112 } }],
    ['Trace L9: routed through a relay. The origin is one of two workstations: 10.1.0.5 or 10.1.0.90.', { relay: true, pair: ['10.1.0.5', '10.1.0.90'] }],
    ["Trace L9: routed through a relay. The server's IP address is x.143.x.x.", { relay: true, serverPart: { index: 1, value: 143 } }],
    ['Trace L9: routed through a relay. Activity performed: posted on Blacknet. The message posted by Z3r0: "go now."', { relay: true, activity: 'posted on Blacknet', leak: { alias: 'Z3r0', text: 'go now.' } }],
    ['Trace L9: routed through a relay. Activity performed: read the Blacknet board. The newest message on the board then, by Neo: "hi"', { relay: true, activity: 'read the Blacknet board', leak: { alias: 'Neo', text: 'hi' } }],
    ["Trace L9: routed through a relay. The relay leaked the server's address: 10.44.3.9.", { relay: true, server: '10.44.3.9' }],
    ['Trace L9: routed through a relay. The relay leaked the origin workstation: 10.1.0.8. Captured host access code: 4821.', { relay: true, ip: '10.1.0.8', hostCode: '4821' }],
  ];
  for (const [text, clue] of cases) assert.deepEqual(parseTrace(text), clue, text);
});

test('a bot sees a page only by opening it with its own code, and the read is logged under its name', () => {
  let s = createGame({ seed: 11, players: [{ id: 'me', name: 'Me' }], now: T0, scenario: 'SOLO' });
  for (let t = 1; t <= 60; t++) s = tick(s, T0 + t * 1000);
  const ar = Object.values(s.players).find((p) => p.bot && p.role === 'PERSONAL_BANKER')!;
  const before = s.logs.length;
  const execute = (st: GameState, p: Player, a: Parameters<typeof applyAction>[1]): ActionResult => {
    const r = applyAction(st, a, T0 + 60_000);
    Object.assign(st, r.state); // the engine's own execute mutates in place; this stands in for it
    return r.result;
  };
  const seen = look(s, ar, execute, 'CLIENT_DATA', 'CLIENT_REQUESTS', 'VIEW_REQUESTS');
  assert.ok(seen.ok && seen.data?.page === 'REQUESTS');
  assert.ok(seen.data.rows.every((r) => r.to === ar.name), 'a banker sees only their own requests');
  assert.equal(s.logs.length, before + 1);
  assert.match(s.logs.at(-1)!.message, new RegExp(`^${ar.name} `));
  // No code for a page it has no access to: nothing is opened, nothing is logged.
  const none = look(s, ar, execute, 'SECURITY', 'PERMISSIONS', 'VIEW_PERMISSIONS');
  assert.equal(none.ok, false);
  assert.equal(none.data, null);
  assert.equal(s.logs.length, before + 1);
});
