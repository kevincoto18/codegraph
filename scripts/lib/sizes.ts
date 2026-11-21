/**
 * Size presets of the synthetic stress projects.
 */

/** Identifier of a size preset. */
export type SizeId = 'S' | 'M' | 'L' | 'XL';

/** A size preset. */
export interface StressSize {
  readonly id: SizeId;
  /** Number of source files to generate. */
  readonly files: number;
  /** What the size represents. */
  readonly description: string;
}

/** Every preset, smallest first. */
export const STRESS_SIZES: Readonly<Record<SizeId, StressSize>> = {
  S: { id: 'S', files: 500, description: 'typical medium project' },
  M: { id: 'M', files: 2_000, description: 'large project' },
  L: { id: 'L', files: 5_000, description: 'current file cap of the extension' },
  XL: { id: 'XL', files: 20_000, description: 'monorepo, beyond the cap' },
};

/**
 * Parses a comma-separated list of size ids.
 *
 * @param value - E.g. `S,M,L`; `undefined` returns the fallback.
 * @param fallback - Sizes used when no value is given.
 * @returns The selected presets.
 * @throws Error on an unknown size id.
 */
export function parseSizes(value: string | undefined, fallback: readonly SizeId[]): StressSize[] {
  const ids =
    value === undefined ? fallback : value.split(',').map((id) => id.trim().toUpperCase());
  return ids.map((id) => {
    if (!(id in STRESS_SIZES)) {
      throw new Error(`Unknown size "${id}". Use one of: ${Object.keys(STRESS_SIZES).join(', ')}.`);
    }
    return STRESS_SIZES[id as SizeId];
  });
}

/**
 * Reads the value of a `--name value` or `--name=value` CLI flag.
 *
 * @param args - Raw CLI arguments.
 * @param name - Flag name without dashes.
 * @returns The value, or `undefined` if the flag is absent.
 */
export function readFlag(args: readonly string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) {
    return inline.slice(name.length + 3);
  }
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}
