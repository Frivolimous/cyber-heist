// What a single player is allowed to see. The server never sends anything else to that player.

import { ROLES, SYSTEMS } from './catalog';
import type { SystemDef } from './catalog';
import { accountExists, balanceOf, fmtClock, gameTime, nameOf } from './core';
import { credScopeText } from './handlers';
import { jobDescription } from './jobs';
import { dayPhaseAt } from './pacing';
import type { Pace } from './pacing';
import type { JobDescription } from './jobs';
import type { Allegiance, GameState, Player, PlayerId, RoleId, SystemId, Winner } from './types';

/** Everything on one workstation: the owner's own screen, or someone else's once logged in to it. */
export interface WorkstationView {
  id: PlayerId;
  name: string;
  role: RoleId;
  roleLabel: string;
  allegiance: Allegiance;
  objective: string;
  motivation: string;
  ip: string;
  bankAccount: string;
  bankBalance: number | null; // null: the account does not exist (a planted user's made-up number)
  lockedForSec: number;
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
  processed: number; // legitimate money settled toward the bank target
  whiteTarget: number;
  me: WorkstationView;
  /** Other workstations this player is logged in to (only while the credential used is still active). */
  remote: Record<PlayerId, WorkstationView>;
  players: { id: PlayerId; name: string; roleLabel: string }[];
  systems: SystemDef[]; // only systems this player knows about
  /** Modules whose security is off (SYSTEM.MODULE): usable without a code. */
  openModules: string[];
}

function workstationView(s: GameState, p: Player): WorkstationView {
  const t = gameTime(s);
  const time = (x: number): string => fmtClock(s.config, x);
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    roleLabel: ROLES[p.role].label,
    allegiance: p.allegiance,
    objective: p.objective,
    motivation: p.motivation,
    ip: p.ip,
    bankAccount: p.bankAccount,
    bankBalance: accountExists(s, p.bankAccount) ? balanceOf(s, p.bankAccount) : null,
    lockedForSec: Math.max(0, Math.ceil(p.lockedUntil - t)),
    job: jobDescription(p.role, p.allegiance, s.config),
    knownSystems: p.knownSystems,
    credentials: p.heldCredentialIds.map((id) => {
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

export function getPlayerView(s: GameState, playerId: PlayerId): PlayerView {
  const p = s.players[playerId];
  const t = gameTime(s);
  const remote: Record<PlayerId, WorkstationView> = {};
  for (const g of p.remoteAccess) {
    if (s.credentials[g.credentialId]?.status === 'ACTIVE') remote[g.playerId] = workstationView(s, s.players[g.playerId]);
  }
  return {
    gameId: s.id,
    clock: fmtClock(s.config, t),
    dayPhase: dayPhaseAt(s.config.durationSec, t).label,
    pace: dayPhaseAt(s.config.durationSec, t).pace,
    t,
    durationSec: s.config.durationSec,
    status: s.status,
    winner: s.winner,
    endReason: s.endReason,
    processed: s.totals.processed,
    whiteTarget: s.config.whiteTarget,
    me: workstationView(s, p),
    remote,
    players: s.playerOrder.map((id) => ({ id, name: s.players[id].name, roleLabel: ROLES[s.players[id].role].label })),
    systems: SYSTEMS.filter((sys) => p.knownSystems.includes(sys.id)),
    openModules: Object.entries(s.modules).filter(([, m]) => m.open).map(([k]) => k),
  };
}
