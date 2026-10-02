// What a single player is allowed to see. The server never sends anything else to that player.

import { ROLES, SYSTEMS } from './catalog';
import type { SystemDef } from './catalog';
import { accountExists, activeBlock, balanceOf, fmtClock, gameTime, nameOf, systemAddress, tableSize } from './core';
import { ALERT_MUTE_SEC, allChanges, credScopeText, maskedCode, proxyUnavailable } from './handlers';
import { jobDescription } from './jobs';
import { endSummary } from './ending';
import type { EndSummary } from './ending';
import { dayPhaseAt } from './pacing';
import { heistView, tutorialView } from './tutorial';
import type { HeistView, TutorialView } from './tutorial';
import type { Pace } from './pacing';
import type { JobDescription } from './jobs';
import type { Allegiance, Automation, GameState, Notice, Player, PlayerId, RoleId, SystemId, Winner } from './types';

/** Everything on one workstation: the owner's own screen, or someone else's once logged in to it. */
export interface WorkstationView {
  id: PlayerId;
  name: string;
  role: RoleId;
  roleLabel: string;
  /**
   * Which side, the objective and the personal motivation: the owner's eyes only (null to a visitor). A visitor
   * also never sees a Thief's alias, operative handbook or hidden host credentials (its activity log is left as is).
   */
  allegiance: Allegiance | null;
  /** Blacknet alias: only a Thief's, and only on their own screen. */
  alias: string | null;
  objective: string | null;
  motivation: string | null;
  ip: string;
  bankAccount: string;
  bankBalance: number | null; // null: the account does not exist (a planted user's made-up number)
  lockedForSec: number;
  /** Terminated: the bank's systems refuse this workstation for good. */
  terminated: boolean;
  resigned: boolean; // terminated because they quit
  job: JobDescription;
  knownSystems: SystemId[];
  credentials: {
    id: string;
    code: string;
    ownerName: string;
    own: boolean;
    scope: string;
    status: string;
    system: SystemId;
    module: string | null;
    fn: string | null;
    permission: 'READ' | 'WRITE';
  }[];
  activity: { time: string; text: string }[];
  messages: { time: string; fromName: string; toName: string; text: string; incoming: boolean }[];
}

export interface PlayerView {
  gameId: string;
  clock: string;
  t: number;
  /** Time of day ("Lunch Rush") and how busy it is: the rate new work arrives at (see pacing.ts). */
  dayPhase: string;
  pace: Pace;
  durationSec: number;
  status: 'RUNNING' | 'ENDED';
  winner: Winner | null;
  endReason: string | null;
  /** The end screen: both teams, who was on them and what they made. Null while the game runs. */
  end: EndSummary | null;
  /** Every payment settled today, however it counts (legitimate, diverted or embezzled): the bank's real progress stays hidden. */
  settled: number;
  me: WorkstationView;
  /** Other workstations this player is logged in to (only while the credential used is still active). */
  remote: Record<PlayerId, WorkstationView>;
  /** Every employee on record, planted users included (they can be messaged and issued credentials). */
  players: { id: PlayerId; name: string; roleLabel: string }[];
  /** The real people at the table (everyone on the call knows who they are), and who has been terminated. */
  table: { id: PlayerId; name: string; roleLabel: string; terminated: boolean; resigned: boolean; lock: Countdown | null; block: Countdown | null }[];
  /**
   * Countdowns for the status bar's gauges: a pending "revoke all access" (Firewall readers), an alert mute (every
   * Thief), and a reroute of this player's own workstation IP (its owner, whoever set it up).
   */
  timers: (Countdown & { id: string; kind: 'REVOKE' | 'MUTE' | 'REROUTE'; label: string })[];
  /** The operative's own Code cracks, Workstation unlocks and proxy setups, finished ones too (the screen prints how each ended). */
  kitJobs: KitJob[];
  /** The whole bank's workload, the same for everyone: what is waiting at each step, and settlements still reversible. */
  workload: WorkloadItem[];
  /** This player's Trace cooldown while it runs (Master Log). */
  traceCooldown: Countdown | null;
  /** Rule numbers the screens quote. */
  settings: { blockSec: number; revokeCountdownSec: number };
  systems: SystemDef[]; // only systems this player knows about
  /** Modules whose security is off (SYSTEM.MODULE): usable without a code. */
  openModules: string[];
  /** Pages (SYSTEM.MODULE) with the notification bell on. */
  watching: string[];
  /** Recent pop-up notifications, newest last. The screen shows each one once. */
  notifications: Notice[];
  /** Infiltration proxies (only for a player holding Infiltration access), with why each is unavailable. */
  proxies: { ip: string; unavailable: string | null }[];
  /** Their job's tutorial checklist. */
  tutorial: TutorialView | null;
  /** A Thief's heist checklist (personal tasks and the crew's heist); null for everyone else. */
  heist: HeistView | null;
  /** Each payment stage's automation (its page's badge), only for stages this player can read. */
  automation: StageAutomation;
}

/**
 * A countdown the screen draws as a gauge: it ends at game second `until` (null: never, a permanent block)
 * and lasts `total` seconds in all. End times, not seconds left, so a view does not change every second.
 */
export interface Countdown {
  until: number | null;
  total: number;
}

/**
 * One step's queue in the status bar. `level` is how many are waiting per person who works that step (Personal
 * Bankers: requests and approvals; Accounts & Receivables: verification, risk and settlement): calm under 2 each,
 * busy under 4, swamped beyond. Clawback (settled, still inside the reversal window) has no level.
 */
export interface WorkloadItem {
  label: string;
  count: number;
  level: 'calm' | 'busy' | 'swamped' | null;
}

/** A Code crack, Workstation unlock or Create proxy: its card shows a progress bar while it runs. */
export interface KitJob extends Countdown {
  id: string;
  kind: 'CRACK' | 'UNLOCK' | 'PROXY';
  label: string;
  detail: string; // a crack's digits so far
  done: boolean;
  result: string | null; // how it ended
}

/** The automation settings by stage page; a stage is missing when the player cannot read it. */
export interface StageAutomation {
  RISK_CHECK?: { maxAmount: number; source: Automation['scoreSource']; origin: Automation['scoreOrigin']; payee: Automation['scorePayee'] };
  AUTHORIZATION?: { upTo: Automation['approveUpTo'] };
  SETTLEMENT?: { maxAmount: number };
}

/** `visitor`: someone else logged in to this workstation, who sees nothing that gives its side away (see WorkstationView). */
function workstationView(s: GameState, p: Player, visitor = false): WorkstationView {
  const t = gameTime(s);
  const time = (x: number): string => fmtClock(x);
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    roleLabel: ROLES[p.role].label,
    allegiance: visitor ? null : p.allegiance,
    alias: p.allegiance === 'BLACK' && !visitor ? p.alias : null,
    objective: visitor ? null : p.objective,
    motivation: visitor ? null : p.motivation,
    ip: p.ip,
    bankAccount: p.bankAccount,
    bankBalance: accountExists(s, p.bankAccount) ? balanceOf(s, p.bankAccount) : null,
    lockedForSec: Math.max(0, Math.ceil(p.lockedUntil - t)),
    terminated: !!p.terminated,
    resigned: p.terminated?.reason === 'RESIGNED',
    job: jobDescription(p.role, visitor ? 'WHITE' : p.allegiance, s.config, tableSize(s)), // a visitor gets no handbook
    knownSystems: visitor ? p.knownSystems.filter((id) => id !== 'HIDDEN_HOST') : p.knownSystems,
    credentials: p.heldCredentialIds.filter((id) => !visitor || s.credentials[id].system !== 'HIDDEN_HOST').map((id) => {
      const cr = s.credentials[id];
      return {
        id,
        code: cr.code,
        ownerName: nameOf(s, cr.owner),
        own: cr.owner === p.id,
        scope: credScopeText(cr),
        status: cr.status,
        system: cr.system,
        module: cr.module,
        fn: cr.fn,
        permission: cr.permission,
      };
    }),
    activity: p.activity.map((a) => ({ time: time(a.t), text: a.text })),
    messages: p.messages.map((m) => ({
      time: time(m.t),
      fromName: nameOf(s, m.from),
      toName: nameOf(s, m.to),
      text: m.text,
      incoming: m.to === p.id,
    })),
  };
}

/** Holds an active host credential that reaches Infiltration (the proxy list is that kit's data). */
const holdsInfiltration = (s: GameState, p: Player): boolean =>
  p.heldCredentialIds.some((id) => {
    const cr = s.credentials[id];
    return cr.status === 'ACTIVE' && cr.system === 'HIDDEN_HOST' && (cr.module === null || cr.module === 'INFILTRATION');
  });

/** Can read this bank module: security off, or an active credential of theirs covers it. */
const canReadModule = (s: GameState, p: Player, system: SystemId, module: string): boolean =>
  !!s.modules[`${system}.${module}`]?.open ||
  p.heldCredentialIds.some((id) => {
    const cr = s.credentials[id];
    return cr.status === 'ACTIVE' && cr.system === system && (cr.module === null || cr.module === module) && cr.fn === null;
  });

function stageAutomation(s: GameState, p: Player): StageAutomation {
  const a = s.automation;
  const out: StageAutomation = {};
  if (canReadModule(s, p, 'TRANSACTIONS', 'RISK_CHECK')) out.RISK_CHECK = { maxAmount: a.scoreMax, source: a.scoreSource, origin: a.scoreOrigin, payee: a.scorePayee };
  if (canReadModule(s, p, 'TRANSACTIONS', 'AUTHORIZATION')) out.AUTHORIZATION = { upTo: a.approveUpTo };
  if (canReadModule(s, p, 'TRANSACTIONS', 'SETTLEMENT')) out.SETTLEMENT = { maxAmount: a.settleMax };
  return out;
}

/**
 * A pending "revoke all access", for whoever can read the Firewall; Cleanup / Alert mute while it lasts, for every
 * Thief; Infiltration / Reroute IP on this player's own workstation, for its owner (an innocent one included).
 */
function timersFor(s: GameState, p: Player): PlayerView['timers'] {
  const out: PlayerView['timers'] = [];
  if (canReadModule(s, p, 'SECURITY', 'FIREWALL')) {
    for (const r of s.revocations) {
      if (r.status === 'PENDING') out.push({ id: r.id, kind: 'REVOKE', label: `Revoke all: ${r.address}`, until: r.executeAt, total: s.config.revokeCountdownSec });
    }
  }
  if (p.allegiance === 'BLACK' && gameTime(s) < s.alertMuteUntil) {
    out.push({ id: 'MUTE', kind: 'MUTE', label: 'Alerts muted', until: s.alertMuteUntil, total: ALERT_MUTE_SEC });
  }
  const rr = s.reroutes.find((r) => r.fromIp === p.ip && r.until > gameTime(s));
  if (rr) out.push({ id: 'REROUTE', kind: 'REROUTE', label: 'IP rerouted', until: rr.until, total: rr.seconds ?? rr.until - gameTime(s) });
  return out;
}

function kitJobsFor(s: GameState, p: Player): KitJob[] {
  const c = s.config;
  const cracks = s.cracks
    .filter((k) => k.actorId === p.id)
    .map((k): KitJob => {
      const code = s.credentials[k.credentialId]?.code ?? '____';
      return { id: k.id, kind: 'CRACK', label: `${k.id} on ${k.credentialId}`, detail: maskedCode(code, k.revealed), until: k.nextRevealAt + (3 - k.revealed) * c.crackRevealSec, total: 4 * c.crackRevealSec, done: k.done, result: k.result ?? null };
    });
  const unlocks = s.unlocks
    .filter((u) => u.actorId === p.id)
    .map((u): KitJob => ({ id: u.id, kind: 'UNLOCK', label: `${u.id} on ${nameOf(s, u.targetId)}'s workstation`, detail: '', until: u.doneAt, total: c.unlockSec, done: u.done, result: u.result ?? null }));
  const proxies = s.proxies
    .filter((x) => x.createdBy === p.id)
    .map((x): KitJob => ({ id: `proxy:${x.ip}`, kind: 'PROXY', label: `Proxy ${x.ip}`, detail: '', until: x.readyAt, total: x.readyAt - x.t, done: x.ready, result: x.result ?? null }));
  return [...cracks, ...unlocks, ...proxies];
}

function workloadOf(s: GameState): WorkloadItem[] {
  const t = gameTime(s);
  const staff = (role: RoleId): number => s.playerOrder.filter((id) => !s.players[id].fake && !s.players[id].terminated && s.players[id].role === role).length;
  const item = (label: string, count: number, role: RoleId): WorkloadItem => {
    const each = count / Math.max(1, staff(role));
    return { label, count, level: each < 2 ? 'calm' : each < 4 ? 'busy' : 'swamped' };
  };
  const txs = (...st: string[]): number => s.transactions.filter((tx) => st.includes(tx.status)).length;
  return [
    item('Requests', s.requests.filter((r) => r.status === 'OPEN').length, 'PERSONAL_BANKER'),
    item('Verify', allChanges(s).filter((h) => !h.verified).length, 'ACCOUNTS_RECEIVABLES'),
    item('Risk', txs('QUEUED'), 'ACCOUNTS_RECEIVABLES'),
    item('Approve', txs('RISK_CHECKED', 'HELD'), 'PERSONAL_BANKER'),
    item('Settle', txs('AUTHORIZED'), 'ACCOUNTS_RECEIVABLES'),
    { label: 'Clawback', count: s.transactions.filter((tx) => tx.status === 'SETTLED' && tx.settledAt !== null && t - tx.settledAt <= s.config.reversalWindowSec).length, level: null },
  ];
}

export function getPlayerView(s: GameState, playerId: PlayerId): PlayerView {
  const p = s.players[playerId];
  const t = gameTime(s);
  const remote: Record<PlayerId, WorkstationView> = {};
  for (const g of p.remoteAccess) {
    if (s.credentials[g.credentialId]?.status === 'ACTIVE') remote[g.playerId] = workstationView(s, s.players[g.playerId], true);
  }
  return {
    gameId: s.id,
    clock: fmtClock(t),
    dayPhase: dayPhaseAt(s.config.durationSec, t).label,
    pace: dayPhaseAt(s.config.durationSec, t).pace,
    t,
    durationSec: s.config.durationSec,
    status: s.status,
    winner: s.winner,
    endReason: s.endReason,
    end: endSummary(s),
    settled: s.transactions.reduce((sum, tx) => (tx.status === 'SETTLED' ? sum + tx.amount : sum), 0),
    me: workstationView(s, p),
    remote,
    players: s.playerOrder.map((id) => ({ id, name: s.players[id].name, roleLabel: ROLES[s.players[id].role].label })),
    table: s.playerOrder
      .filter((id) => !s.players[id].fake)
      .map((id) => {
        // What the whole table would know anyway: the person says so on the call. A block acts on the real address.
        const q = s.players[id];
        const block = q.terminated ? undefined : activeBlock(s, q.ip);
        return {
          id,
          name: q.name,
          roleLabel: ROLES[q.role].label,
          terminated: !!q.terminated,
          resigned: q.terminated?.reason === 'RESIGNED',
          lock: !q.terminated && q.lockedUntil > t ? { until: q.lockedUntil, total: s.config.lockoutSec } : null,
          block: block ? { until: block.until, total: s.config.blockSec } : null,
        };
      }),
    timers: timersFor(s, p),
    kitJobs: kitJobsFor(s, p),
    workload: workloadOf(s),
    traceCooldown: p.lastTraceAt + s.config.traceCooldownSec > t ? { until: p.lastTraceAt + s.config.traceCooldownSec, total: s.config.traceCooldownSec } : null,
    settings: { blockSec: s.config.blockSec, revokeCountdownSec: s.config.revokeCountdownSec },
    systems: SYSTEMS.filter((sys) => p.knownSystems.includes(sys.id)).map((sys) => ({ ...sys, address: systemAddress(s, sys.id) })),
    openModules: Object.entries(s.modules).filter(([, m]) => m.open).map(([k]) => k),
    watching: [...p.watching],
    notifications: p.notifications.map((n) => ({ ...n })),
    proxies: holdsInfiltration(s, p) ? s.proxies.map((x) => ({ ip: x.ip, unavailable: proxyUnavailable(s, x.ip, t, p.id) })) : [],
    automation: stageAutomation(s, p),
    tutorial: tutorialView(s, p),
    heist: heistView(s, p),
  };
}
