/** Inputs needed to schedule the next poll. */
export interface CadenceInput {
  /** When the latest known chapter was released, or null if unknown. */
  latestChapterAt: Date | null;
  /** How many polls have failed in a row. 0 means the last attempt succeeded (or none yet). */
  consecutiveFailures: number;
  /** "Now" — pass `new Date()` in production. Injected for tests. */
  now: Date;
  /** Optional override for the random jitter, in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number;
}

export const HOT_INTERVAL_MS = 2 * 60 * 60 * 1_000; // 2 hours
export const COLD_INTERVAL_MS = 3 * 24 * 60 * 60 * 1_000; // 3 days
export const HOT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days
export const JITTER_FRACTION = 0.1; // ±10%
export const FAILURE_BASE_INTERVAL_MS = HOT_INTERVAL_MS; // 2h, doubled per failure
export const MAX_FAILURE_BACKOFF_EXP = 5; // cap at 2h * 32 = ~2.7d

function applyJitter(base: number, random: number): number {
  const factor = 1 - JITTER_FRACTION + 2 * JITTER_FRACTION * random;
  return base * factor;
}

export function adaptiveCadence(input: CadenceInput): Date {
  const random = input.random ?? Math.random;

  let base: number;
  if (input.consecutiveFailures > 0) {
    const exp = Math.min(input.consecutiveFailures, MAX_FAILURE_BACKOFF_EXP);
    base = FAILURE_BASE_INTERVAL_MS * 2 ** exp;
  } else if (input.latestChapterAt === null) {
    base = COLD_INTERVAL_MS;
  } else {
    const ageMs = input.now.getTime() - input.latestChapterAt.getTime();
    base = ageMs <= HOT_THRESHOLD_MS ? HOT_INTERVAL_MS : COLD_INTERVAL_MS;
  }

  const jittered = applyJitter(base, random());
  return new Date(input.now.getTime() + Math.round(jittered));
}
