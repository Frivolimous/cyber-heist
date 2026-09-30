// How a game ends: terminated (disabled) players, the end conditions, and the end-screen summary.

import { ROLES } from './catalog';
import { activeBlock, addLog, fmtClock, gameTime, money, note } from './core';
import type { Allegiance, EndKind, GameState, Player, TerminationReason, Winner } from './types';

/** What a terminated player sees on any bank system. */
export const TERMINATED_TEXT = 'ERROR: Your credentials are invalid.';

/** A player's bank credentials: everything except the unregistered host's and workstation logins. */
const bankCredentials = (s: GameState, p: Player) =>
  Object.values(s.credentials).filter((cr) => cr.owner === p.id && cr.system !== 'HIDDEN_HOST' && cr.system !== 'WORKSTATION');

function terminationReason(s: GameState, p: Player): TerminationReason | null {
  if (activeBlock(s, p.ip)?.until === null) return 'IP_REVOKED';
  const creds = bankCredentials(s, p);
  // A planted user with nothing issued yet is not terminated; everyone real starts with credentials.
  if (creds.length > 0 && creds.every((cr) => cr.status === 'REVOKED')) return 'CREDENTIALS';
  return null;
}

/** Mutating: disables for good every player who has lost all their bank credentials or had their IP revoked. */
export function checkTerminations(s: GameState): void {
  const t = gameTime(s);
  for (const id of s.playerOrder) {
    const p = s.players[id];
    if (p.terminated) continue;
    const reason = terminationReason(s, p);
    if (!reason) continue;
    p.terminated = { t, reason };
    for (const cr of bankCredentials(s, p)) {
      cr.status = 'REVOKED';
      cr.pendingRevoke = null;
    }
    p.watching = p.watching.filter((k) => k.startsWith('HIDDEN_HOST.')); // the hidden host still answers them
    p.remoteAccess = [];
    const why = reason === 'IP_REVOKED' ? `the firewall revoked all access for ${p.ip}` : 'all their credentials were revoked';
    addLog(s, { actor: 'SYSTEM', kind: 'TERMINATED', message: `${p.name} (${p.ip}) terminated: ${why}`, sourceIp: null, actualPlayerId: null });
    note(p, t, `You have been terminated: ${reason === 'IP_REVOKED' ? `the firewall revoked all access for your workstation` : 'all your credentials were revoked'}. The bank's systems no longer accept you.`);
  }
}

export function endGame(s: GameState, kind: EndKind, winner: Winner | null, reason: string): void {
  if (s.status !== 'RUNNING') return;
  s.status = 'ENDED';
  s.endKind = kind;
  s.winner = winner;
  s.endReason = reason;
  s.endedAt = gameTime(s);
}

/** The real people on a side (planted users are records, not players). */
const team = (s: GameState, side: Allegiance): Player[] => s.playerOrder.map((id) => s.players[id]).filter((p) => !p.fake && p.allegiance === side);

/** Mutating: the instant end conditions. The Thieves' goal first, then every Thief terminated. */
export function checkEnd(s: GameState): void {
  if (s.status !== 'RUNNING') return;
  checkTerminations(s);
  const { stolen, processed } = s.totals;
  const { blackTarget, whiteTarget } = s.config;
  if (blackTarget > 0 && stolen >= blackTarget) {
    endGame(s, 'BLACK_TARGET', 'BLACK', `The Thieves diverted ${money(stolen)} into their Target Ledger accounts, reaching their ${money(blackTarget)} goal. The bank had settled ${money(processed)} of its ${money(whiteTarget)} target.`);
    return;
  }
  const blacks = team(s, 'BLACK');
  if (blacks.length > 0 && blacks.every((p) => p.terminated)) {
    const names = blacks.map((p) => p.name).join(', ');
    endGame(s, 'THIEVES_TERMINATED', 'WHITE', `Every Thief was terminated (${names}). With nobody left on the inside, the heist is over. They had diverted ${money(stolen)} of their ${money(blackTarget)} goal.`);
  }
}

/** Mutating: the clock ran out. The bank wins only if it met its target; otherwise neither side made its goal, and both lose. */
export function closeOfBusiness(s: GameState): void {
  const { stolen, processed } = s.totals;
  const { blackTarget, whiteTarget } = s.config;
  if (processed >= whiteTarget) {
    endGame(s, 'WHITE_TARGET', 'WHITE', `The bank reached close of business with ${money(processed)} of legitimate payments settled, clearing its ${money(whiteTarget)} target. The Thieves diverted only ${money(stolen)} of their ${money(blackTarget)} goal.`);
  } else {
    endGame(s, 'BANK_SHORT', null, `Close of business, and neither side made its goal: the bank settled only ${money(processed)} of its ${money(whiteTarget)} target, and the Thieves diverted ${money(stolen)} of their ${money(blackTarget)}. Both sides lose.`);
  }
}

// ---- End screen -------------------------------------------------------------------

export interface EndMember {
  name: string;
  roleLabel: string;
  terminated: boolean;
  /** Payments settled into this person's own account: shown as an aside, it counts toward no goal. */
  embezzled: number;
}

export interface EndTeam {
  side: Allegiance;
  label: string; // "The Bank", "Thieves"
  won: boolean;
  made: number; // the bank: legitimate money settled; the thieves: money in the Target Ledger
  target: number;
  members: EndMember[];
}

export interface EndSummary {
  kind: EndKind;
  winner: Winner | null;
  headline: string; // "The Bank wins"
  text: string; // who won and how
  clock: string; // the in-game time it ended
  teams: EndTeam[];
}

/** Money settled into a player's own account (and not reversed). */
export function embezzledBy(s: GameState, p: Player): number {
  return s.transactions.filter((tx) => tx.status === 'SETTLED' && tx.settledTo === p.bankAccount).reduce((sum, tx) => sum + tx.amount, 0);
}

/** Everything the end screen shows. Allegiances are public once the game is over. Null while it runs. */
export function endSummary(s: GameState): EndSummary | null {
  if (s.status !== 'ENDED' || !s.endKind) return null;
  const members = (side: Allegiance): EndMember[] =>
    team(s, side).map((p) => ({ name: p.name, roleLabel: ROLES[p.role].label, terminated: !!p.terminated, embezzled: embezzledBy(s, p) }));
  return {
    kind: s.endKind,
    winner: s.winner,
    headline: s.winner === 'WHITE' ? 'The Bank wins' : s.winner === 'BLACK' ? 'The Thieves win' : 'Everybody loses',
    text: s.endReason ?? '',
    clock: fmtClock(s.endedAt ?? gameTime(s)),
    teams: [
      { side: 'WHITE', label: 'The Bank', won: s.winner === 'WHITE', made: s.totals.processed, target: s.config.whiteTarget, members: members('WHITE') },
      { side: 'BLACK', label: 'Thieves', won: s.winner === 'BLACK', made: s.totals.stolen, target: s.config.blackTarget, members: members('BLACK') },
    ],
  };
}
