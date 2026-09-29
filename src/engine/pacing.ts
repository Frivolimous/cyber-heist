// Time of day: the game runs through a working day, and new work (client requests and automatic payments)
// arrives faster or slower depending on the phase. Phases follow the share of the game elapsed, so they
// stay right if the game length changes. Pacing moves money around in time; the total is unchanged.

export type Pace = 'SLOW' | 'MEDIUM' | 'BUSY' | 'CLOSED';

/** How busy each pace is, relative to the others. Rescaled below so the game-wide average is 1. */
export const PACE_WEIGHT: Record<Pace, number> = { SLOW: 0.5, MEDIUM: 1, BUSY: 2, CLOSED: 0 };

export interface DayPhase {
  label: string;
  pace: Pace;
  /** Share of the game elapsed when the phase starts and ends (0..1). */
  from: number;
  to: number;
}

/**
 * Time remaining cutoffs 85% / 60% / 45% / 35% / 20% / 5%. With a 20-minute game: 20-17m left, 17-12m,
 * 12-9m, 9-7m, 7-4m, 4-1m, last minute.
 */
export const DAY_PHASES: DayPhase[] = [
  { label: 'Morning', pace: 'SLOW', from: 0, to: 0.15 },
  { label: 'Morning', pace: 'MEDIUM', from: 0.15, to: 0.4 },
  { label: 'Lunch Rush', pace: 'BUSY', from: 0.4, to: 0.55 },
  { label: 'Afternoon', pace: 'SLOW', from: 0.55, to: 0.65 },
  { label: 'Afternoon', pace: 'MEDIUM', from: 0.65, to: 0.8 },
  { label: 'End of Day', pace: 'BUSY', from: 0.8, to: 0.95 },
  { label: 'Close of Business', pace: 'CLOSED', from: 0.95, to: 1 },
];

/** The time-weighted average weight, so a rate multiplier of weight / MEAN averages 1 over the game. */
const MEAN_WEIGHT = DAY_PHASES.reduce((sum, p) => sum + PACE_WEIGHT[p.pace] * (p.to - p.from), 0);

/** How much faster than the base rate new work arrives during this phase (0 when closed). */
export const paceMultiplier = (p: DayPhase): number => PACE_WEIGHT[p.pace] / MEAN_WEIGHT;

/** The phase at game second `t` of a game lasting `durationSec`. */
export function dayPhaseAt(durationSec: number, t: number): DayPhase {
  const f = Math.min(Math.max(t / durationSec, 0), 1);
  return DAY_PHASES.find((p) => f < p.to) ?? DAY_PHASES[DAY_PHASES.length - 1];
}

/**
 * When the next arrival is due after one at `after`, for work that would arrive every `baseInterval`
 * seconds at the average rate. Walks the phases, spending the interval faster in busy phases and slower in
 * quiet ones. Infinity when the day closes first (no more arrivals).
 */
export function nextArrival(durationSec: number, after: number, baseInterval: number): number {
  let need = baseInterval; // in "average-rate seconds"
  for (const p of DAY_PHASES) {
    const start = Math.max(after, p.from * durationSec);
    const end = p.to * durationSec;
    if (end <= start) continue;
    const m = paceMultiplier(p);
    if (m <= 0) continue;
    const capacity = (end - start) * m;
    if (need <= capacity) return start + need / m;
    need -= capacity;
  }
  return Infinity;
}
