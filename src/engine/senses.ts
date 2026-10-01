// How a bot takes in the bank (bot mode, docs/BotMode.md): the "perceive" step, and nothing else yet.
//
// A bot learns a page's contents only by opening it, through the same EXECUTE action a person uses, with a
// code it holds: the read is logged and marks its workstation active, as anyone's would. What comes back
// is the page's data (perception.ts), the structured twin of its text. Everything else a bot may know is
// its own PlayerView (messages, notifications, its activity log, the employee list), which is what a
// person sees on their screen without opening anything.

import { findFn } from './catalog';
import type { PageData } from './perception';
import type { ActionResult, ExecuteAction, GameState, Player, SystemId } from './types';
import { getPlayerView } from './views';
import type { PlayerView } from './views';

export type Execute = (s: GameState, p: Player, a: ExecuteAction) => ActionResult;

/** A code this bot holds that can run `fn` (its own credentials only: a bot never borrows codes it was not given). */
export function codeFor(s: GameState, bot: Player, system: SystemId, module: string, fn: string): string | null {
  const need = findFn(system, module, fn)?.permission;
  if (!need) return null;
  const cr = Object.values(s.credentials).find(
    (c) =>
      c.owner === bot.id &&
      c.status === 'ACTIVE' &&
      c.system === system &&
      (c.module === null || c.module === module) &&
      (c.fn === null || c.fn === fn) &&
      (c.permission === 'WRITE' || need === 'READ'),
  );
  return cr?.code ?? null;
}

export interface Look {
  ok: boolean;
  /** The page's reply ("Access denied.", "Settlement is offline."...) when it did not open. */
  message: string;
  data: PageData | null;
}

/** Opens a bank page as this bot (mutating: the read is logged like anyone's). */
export function look(s: GameState, bot: Player, execute: Execute, system: SystemId, module: string, fn: string, params: Record<string, string> = {}): Look {
  const code = codeFor(s, bot, system, module, fn);
  if (!code) return { ok: false, message: 'No code for that page.', data: null };
  const r = execute(s, bot, { type: 'EXECUTE', playerId: bot.id, code, system, module, fn, params });
  return { ok: r.ok, message: r.message, data: r.ok ? (r.data ?? null) : null };
}

/** What is on the bot's screen without opening anything. */
export const glance = (s: GameState, bot: Player): PlayerView => getPlayerView(s, bot.id);
