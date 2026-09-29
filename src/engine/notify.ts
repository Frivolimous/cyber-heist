// Notifications: a player switches the bell on for a page (a bank module) and gets short pop-ups about what
// other people do there. Nothing is kept: the engine holds only the last few, for the screen to pop up once.
// A player is notified only from modules they hold an active WRITE credential for (their own or one they know),
// and never about activity recorded under their own name.

import { findModule } from './catalog';
import { gameTime, keyOf, nextId } from './core';
import type { GameState, Player } from './types';

/** How many recent notifications a player's state keeps for the screen to pick up. */
const KEEP = 20;

/** The pages with a bell, and what each one notifies about. */
export const WATCHABLE: Record<string, string> = {
  'SECURITY.FIREWALL': 'any Firewall activity',
  'SECURITY.MASTER_LOG': 'every alert',
  'SECURITY.EMPLOYEE_RECORDS': 'workstation lockouts',
  'SECURITY.PERMISSIONS': 'any Permissions activity',
  'CLIENT_DATA.CUSTOMER_RECORDS': 'account changes on customers you manage',
  'CLIENT_DATA.VERIFICATION': 'changes waiting for verification',
  'CLIENT_DATA.CLIENT_REQUESTS': 'new requests and follow-ups from customers you manage',
  'TRANSACTIONS.PAYMENT_QUEUE': 'new payments',
  'TRANSACTIONS.RISK_CHECK': 'payments waiting for a risk score',
  'TRANSACTIONS.AUTHORIZATION': 'payments waiting for approval',
  'TRANSACTIONS.SETTLEMENT': 'payments ready to settle',
};

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
    if (!canWriteModule(s, p, system, module)) continue;
    p.notifications.push({ id: nextId(s, 'notice', 'N'), t: gameTime(s), page, text });
    if (p.notifications.length > KEEP) p.notifications.splice(0, p.notifications.length - KEEP);
  }
}
