/**
 * Deterministic pseudo-random helpers, so generated projects are identical
 * across runs and machines.
 */

/** Returns a float in `[0, 1)`. */
export type Random = () => number;

/**
 * Creates a seeded generator (mulberry32: fast, good enough for test data).
 *
 * @param seed - 32-bit integer seed.
 * @returns The generator.
 */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns an integer in `[min, max]`.
 *
 * @param random - Generator.
 * @param min - Lower bound (inclusive).
 * @param max - Upper bound (inclusive).
 * @returns The integer.
 */
export function randomInt(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Picks one element.
 *
 * @param random - Generator.
 * @param items - Non-empty list.
 * @returns A random element.
 * @throws Error if the list is empty.
 */
export function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error('Cannot pick from an empty list.');
  }
  return item;
}

/**
 * Picks up to `count` distinct elements.
 *
 * @param random - Generator.
 * @param items - Source list.
 * @param count - Number of elements wanted.
 * @returns Distinct elements (fewer if the list is shorter).
 */
export function sample<T>(random: Random, items: readonly T[], count: number): T[] {
  const chosen = new Set<T>();
  const target = Math.min(count, items.length);
  while (chosen.size < target) {
    chosen.add(pick(random, items));
  }
  return [...chosen];
}
