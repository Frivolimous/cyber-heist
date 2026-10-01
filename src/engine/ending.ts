// How a game ends: terminated (disabled) players, the end conditions, and the end-screen summary.

import { ROLES } from './catalog';
import { activeBlock, addLog, fmtClock, gameTime, money, nextId, note } from './core';
import { pick } from './rng';
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

/** Mutating: disables a player for good: every bank credential revoked. The hidden host still answers them. */
function disable(s: GameState, p: Player, reason: TerminationReason): void {
  p.terminated = { t: gameTime(s), reason };
  for (const cr of bankCredentials(s, p)) {
    cr.status = 'REVOKED';
    cr.pendingRevoke = null;
  }
  p.watching = p.watching.filter((k) => k.startsWith('HIDDEN_HOST.'));
  p.remoteAccess = [];
}

/** Mutating: disables for good every player who has lost all their bank credentials or had their IP revoked. */
export function checkTerminations(s: GameState): void {
  const t = gameTime(s);
  for (const id of s.playerOrder) {
    const p = s.players[id];
    if (p.terminated) continue;
    const reason = terminationReason(s, p);
    if (!reason) continue;
    disable(s, p, reason);
    const why = reason === 'IP_REVOKED' ? `the firewall revoked all access for ${p.ip}` : 'all their credentials were revoked';
    addLog(s, { actor: 'SYSTEM', kind: 'TERMINATED', message: `${p.name} (${p.ip}) terminated: ${why}`, sourceIp: null, actualPlayerId: null });
    note(p, t, `You have been terminated: ${reason === 'IP_REVOKED' ? `the firewall revoked all access for your workstation` : 'all your credentials were revoked'}. The bank's systems no longer accept you.`);
  }
}

/** What a Thief who quits tells everyone on the way out. */
export const THIEF_GOODBYES = [
  'So long, suckers! Enjoy the paperwork.',
  "It's been a pleasure robbing you. Don't bother looking for me.",
  'Check the books after I\'m gone. Bye!',
  "Thanks for all the money. I'm off somewhere sunny.",
];
/** What a regular employee who quits tells everyone on the way out. */
export const EMPLOYEE_GOODBYES = [
  "This job sucks. I'm outta here.",
  'I quit. Good luck keeping this place running.',
  "That's it, I'm done. Nobody pays me enough for this.",
  "Consider this my two seconds' notice. Bye.",
];

/**
 * Mutating: the player quits. They are terminated like a fired employee (so when the last Thief is out, the
 * game ends: see checkEnd), the log says they resigned, and they send everyone a parting message that gives
 * away which side they were on.
 */
export function resign(s: GameState, p: Player): void {
  const t = gameTime(s);
  disable(s, p, 'RESIGNED');
  addLog(s, { actor: 'SYSTEM', kind: 'TERMINATED', message: `${p.name} (${p.ip}) resigned`, sourceIp: null, actualPlayerId: null });
  note(p, t, "You quit. The bank's systems no longer accept you.");
  const text = pick(s, p.allegiance === 'BLACK' ? THIEF_GOODBYES : EMPLOYEE_GOODBYES);
  for (const to of s.playerOrder.map((id) => s.players[id]).filter((x) => !x.fake && x.id !== p.id)) {
    const m = { id: nextId(s, 'msg', 'M'), t, from: p.id, to: to.id, text };
    p.messages.push(m);
    to.messages.push(m);
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

/**
 * Whether the money sitting in the Target Ledger right now meets the Thieves' goal. Every ending checks this
 * first, at the instant it fires: while it holds, however the day ends, the Thieves win.
 */
export function thiefTargetMet(s: GameState): boolean {
  return s.config.blackTarget > 0 && s.totals.stolen >= s.config.blackTarget;
}

export const HEIST_SECURED_TEXT = (s: GameState): string =>
  `Heist secured: the Target Ledger holds ${money(s.totals.stolen)}, meeting your ${money(s.config.blackTarget)} goal. Hold it until close of business, or quit to escape with your prize: the day ends once every Thief is out.`;
export const HEIST_LOST_TEXT = (s: GameState): string =>
  `Heist no longer secured: the Target Ledger dropped to ${money(s.totals.stolen)}, under your ${money(s.config.blackTarget)} goal. Get it back over the goal before close of business.`;

/** Mutating: tells every Thief when their goal becomes met, or stops being met (a reversal). */
function checkHeistSecured(s: GameState): void {
  const met = thiefTargetMet(s);
  if (met === !!s.heistSecured) return;
  s.heistSecured = met;
  const t = gameTime(s);
  const text = met ? HEIST_SECURED_TEXT(s) : HEIST_LOST_TEXT(s);
  for (const p of team(s, 'BLACK')) {
    note(p, t, text);
    p.notifications.push({ id: nextId(s, 'notice', 'N'), t, page: 'Target Ledger', text });
  }
}

/** Mutating: the instant end condition (every Thief out: terminated or quit), after telling the Thieves if their goal changed. */
export function checkEnd(s: GameState): void {
  if (s.status !== 'RUNNING') return;
  checkTerminations(s);
  checkHeistSecured(s);
  const blacks = team(s, 'BLACK');
  if (blacks.length > 0 && blacks.every((p) => p.terminated)) {
    if (thiefTargetMet(s)) endGame(s, 'THIEVES_TERMINATED', 'BLACK', 'One by one they left the building, and the money left with them.');
    else endGame(s, 'THIEVES_TERMINATED', 'WHITE', 'One by one they left the building, with nothing to show for it.');
  }
}

/** Mutating: the clock ran out. The Thieves win if their goal is met; else the bank if it met its target; else both lose. */
export function closeOfBusiness(s: GameState): void {
  if (thiefTargetMet(s)) {
    if (s.totals.processed >= s.config.whiteTarget) {
      endGame(s, 'CLOSE_OF_BUSINESS', 'BLACK', 'They thought it was a good day, everything was in the green! But there was still some green missing.');
    } else {
      endGame(s, 'CLOSE_OF_BUSINESS', 'BLACK', 'The day ended like any other, until they checked the books.');
    }
  } else if (s.totals.processed >= s.config.whiteTarget) {
    endGame(s, 'CLOSE_OF_BUSINESS', 'WHITE', 'Every payment out on time, every account where it belongs.');
  } else {
    endGame(s, 'CLOSE_OF_BUSINESS', null, 'Close of business, and the books balance for nobody. The bank limps home; the Thieves go home empty-handed.');
  }
}

/** Mutating: a Firewall "revoke all access" completed on one of the bank's own systems: the bank shuts down. */
export function bankShutDown(s: GameState): void {
  if (thiefTargetMet(s)) endGame(s, 'SHUTDOWN', 'BLACK', 'Money safely out, they switched the bank off behind them. Nobody left to count what was missing.');
  else endGame(s, 'SHUTDOWN', null, 'Someone pulled the plug on the bank itself. Nobody gets paid today.');
}

/** Mutating: a Firewall "revoke all access" completed on the unregistered host: the heist is over, unless it already paid. */
export function hostShutDown(s: GameState): void {
  if (thiefTargetMet(s)) endGame(s, 'HOST_SHUT_DOWN', 'BLACK', 'The bank found the secret server, but it was just a diversion. The money had already left the building.');
  else endGame(s, 'HOST_SHUT_DOWN', 'WHITE', 'The bank found the secret server and pulled the plug. The heist died with it.');
}

// ---- End screen -------------------------------------------------------------------

export interface EndMember {
  name: string;
  roleLabel: string;
  terminated: boolean;
  resigned: boolean; // terminated because they quit
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
  text: string; // one line on how it ended, per trigger and winner
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
    team(s, side).map((p) => ({ name: p.name, roleLabel: ROLES[p.role].label, terminated: !!p.terminated, resigned: p.terminated?.reason === 'RESIGNED', embezzled: embezzledBy(s, p) }));
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
