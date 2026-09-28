// Seeded PRNG (mulberry32). The state lives inside GameState so every random
// decision is reproducible from the seed plus the ordered list of actions.

export interface RngHolder {
  rngState: number;
}

export function rand(h: RngHolder): number {
  h.rngState = (h.rngState + 0x6d2b79f5) | 0;
  let t = h.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(h: RngHolder, min: number, max: number): number {
  return min + Math.floor(rand(h) * (max - min + 1));
}

export function pick<T>(h: RngHolder, arr: readonly T[]): T {
  return arr[Math.floor(rand(h) * arr.length)];
}

export function shuffle<T>(h: RngHolder, arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(h) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
