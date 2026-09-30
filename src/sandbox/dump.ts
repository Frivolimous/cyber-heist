// Dev tooling: save the whole game state (config included) as a JSON file, at any point in a game.

import { fmtClock, gameTime } from '../engine';
import type { GameState } from '../engine';

export function downloadState(s: GameState, label: string): void {
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cyber-heist-${label}-${fmtClock(gameTime(s)).replace(':', 'm')}s.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
