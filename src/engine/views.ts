// What a single player is allowed to see. The server never sends anything else to that player.

import { ROLES, SYSTEMS } from './catalog';
import type { SystemDef } from './catalog';
import { fmtClock, gameTime, nameOf } from './core';
import { credScopeText } from './handlers';
import type { Allegiance, GameState, InfoPacket, PlayerId, RoleId, SystemId, Winner } from './types';

export interface PlayerView {
  gameId: string;
  clock: string;
  t: number;
  durationSec: number;
  status: 'RUNNING' | 'ENDED';
  winner: Winner | null;
  endReason: string | null;
  processedNpc: number;
  whiteTarget: number;
  me: {
    id: PlayerId;
    name: string;
    role: RoleId;
    roleLabel: string;
    allegiance: Allegiance;
    objective: string;
    motivation: string;
    ip: string;
    bankAccount: string;
    lockedForSec: number;
    packets: InfoPacket[];
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
  };
  players: { id: PlayerId; name: string; roleLabel: string }[];
  systems: SystemDef[]; // only systems this player knows about
}

export function getPlayerView(s: GameState, playerId: PlayerId): PlayerView {
  const p = s.players[playerId];
  const t = gameTime(s);
  const time = (x: number): string => fmtClock(s.config, x);
  return {
    gameId: s.id,
    clock: fmtClock(s.config, t),
    t,
    durationSec: s.config.durationSec,
    status: s.status,
    winner: s.winner,
    endReason: s.endReason,
    processedNpc: s.totals.processedNpc,
    whiteTarget: s.config.whiteTarget,
    me: {
      id: p.id,
      name: p.name,
      role: p.role,
      roleLabel: ROLES[p.role].label,
      allegiance: p.allegiance,
      objective: p.objective,
      motivation: p.motivation,
      ip: p.ip,
      bankAccount: p.bankAccount,
      lockedForSec: Math.max(0, Math.ceil(p.lockedUntil - t)),
      packets: p.packets,
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
    },
    players: s.playerOrder.map((id) => ({ id, name: s.players[id].name, roleLabel: ROLES[s.players[id].role].label })),
    systems: SYSTEMS.filter((sys) => p.knownSystems.includes(sys.id)),
  };
}
