// Notifications: a player switches the bell on for a page (a bank module) and gets short pop-ups about what
// other people do there. Nothing is kept: the engine holds only the last few, for the screen to pop up once.
// A player is notified only from modules they hold an active WRITE credential for (their own or one they know),
// and never about activity recorded under their own name.

import { findModule } from './catalog';
import { gameTime, keyOf, nextId } from './core';
import type { GameState, Player } from './types';

/** How many recent notifications a player's state keeps for the screen to pick up. */
const KEEP = 20;

/** The pages with a bell, and when each one notifies ("You will receive a notification when ..."). */
export const WATCHABLE: Record<string, string> = {
  'SECURITY.FIREWALL': 'someone else uses the Firewall, or a revocation completes',
  'SECURITY.MASTER_LOG': 'a security alert is raised (except about your own activity)',
  'SECURITY.EMPLOYEE_RECORDS': 'a workstation is locked out',
  'SECURITY.PERMISSIONS': 'someone else uses Permissions, or a credential revocation completes',
  'CLIENT_DATA.CUSTOMER_RECORDS': 'someone else changes or verifies the accounts of a customer you manage',
  'CLIENT_DATA.VERIFICATION': "an account change is waiting for verification (except your own)",
  'CLIENT_DATA.CLIENT_REQUESTS': 'a customer you manage sends a request or a follow-up',
  'TRANSACTIONS.PAYMENT_QUEUE': 'a new payment is queued',
  'TRANSACTIONS.RISK_CHECK': 'a payment is waiting for a risk score',
  'TRANSACTIONS.AUTHORIZATION': 'a payment is waiting for approval',
  'TRANSACTIONS.SETTLEMENT': 'a payment is ready to settle',
  // The unregistered host: only operatives hold its credentials, so only they can switch these on.
  'HIDDEN_HOST.HOST_LOG': 'the bank traces an entry from this host, or an operative\'s action raises an alert',
  'HIDDEN_HOST.BLACKNET': 'another operative posts',
  'HIDDEN_HOST.TARGET_LEDGER': 'money lands in a Target Ledger account, or one is added to a customer, removed, made primary or replaced as primary',
  // Kits with timed tools: the operative who started one hears when it finishes (the same words as their activity note).
  'HIDDEN_HOST.ACCESS': 'a code crack or workstation unlock you started finishes or is stopped',
};

/** The hidden host's bells that start on for every Thief (the Target Ledger's starts off). */
export const HOST_WATCH_DEFAULT = ['HIDDEN_HOST.HOST_LOG', 'HIDDEN_HOST.BLACKNET'];

/** Holds an active credential with write access to the whole module. */
export function canWriteModule(s: GameState, p: Player, system: string, module: string): boolean {
  return p.heldCredentialIds.some((id) => {
    const cr = s.credentials[id];
    return !!cr && cr.status === 'ACTIVE' && cr.permission === 'WRITE' && cr.system === system && (cr.module === null || cr.module === module) && cr.fn === null;
  });
}

export interface NotifyScope {
  /** Whose name the activity is recorded under: that player is not notified. */
  owner?: string | null;
  /** Only this banker is notified (customer-specific pages). */
  bankerId?: string | null;
  /** Only this player is notified (a kit tool's result goes to whoever started it). */
  to?: string;
}

/** Pops a notification up for every player watching this page who may receive it. */
export function notify(s: GameState, system: string, module: string, text: string, scope: NotifyScope = {}): void {
  const key = keyOf(system, module);
  const page = findModule(system, module)?.label ?? module;
  for (const id of s.playerOrder) {
    const p = s.players[id];
    if (!p.watching.includes(key)) continue;
    if (scope.owner && scope.owner === p.id) continue;
    if (scope.bankerId !== undefined && scope.bankerId !== p.id) continue;
    if (scope.to !== undefined && scope.to !== p.id) continue;
    if (!canWriteModule(s, p, system, module)) continue;
    p.notifications.push({ id: nextId(s, 'notice', 'N'), t: gameTime(s), page, text });
    if (p.notifications.length > KEEP) p.notifications.splice(0, p.notifications.length - KEEP);
  }
}
