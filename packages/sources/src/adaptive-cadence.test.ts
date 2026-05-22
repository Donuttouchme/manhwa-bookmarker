import { describe, expect, it } from 'vitest';
import {
  adaptiveCadence,
  HOT_INTERVAL_MS,
  COLD_INTERVAL_MS,
  HOT_THRESHOLD_MS,
  FAILURE_BASE_INTERVAL_MS,
} from './adaptive-cadence.js';

const NOW = new Date('2026-05-22T12:00:00.000Z');

function diffMs(a: Date, b: Date): number {
  return a.getTime() - b.getTime();
}

describe('adaptiveCadence', () => {
  it('uses HOT interval when latest chapter is within the threshold', () => {
    const recent = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1_000); // 2 days ago
    const next = adaptiveCadence({
      latestChapterAt: recent,
      consecutiveFailures: 0,
      now: NOW,
      random: () => 0.5, // midpoint of the jitter window → no jitter
    });
    expect(diffMs(next, NOW)).toBe(HOT_INTERVAL_MS);
  });

  it('uses COLD interval when latest chapter is older than the threshold', () => {
    const stale = new Date(NOW.getTime() - (HOT_THRESHOLD_MS + 60_000));
    const next = adaptiveCadence({
      latestChapterAt: stale,
      consecutiveFailures: 0,
      now: NOW,
      random: () => 0.5,
    });
    expect(diffMs(next, NOW)).toBe(COLD_INTERVAL_MS);
  });

  it('uses COLD interval when latest chapter time is unknown', () => {
    const next = adaptiveCadence({
      latestChapterAt: null,
      consecutiveFailures: 0,
      now: NOW,
      random: () => 0.5,
    });
    expect(diffMs(next, NOW)).toBe(COLD_INTERVAL_MS);
  });

  it('applies +10% jitter at random()=1.0 minus epsilon', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const next = adaptiveCadence({
      latestChapterAt: recent,
      consecutiveFailures: 0,
      now: NOW,
      random: () => 0.9999,
    });
    const ratio = diffMs(next, NOW) / HOT_INTERVAL_MS;
    expect(ratio).toBeGreaterThan(1.09);
    expect(ratio).toBeLessThanOrEqual(1.1);
  });

  it('applies -10% jitter at random()=0', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const next = adaptiveCadence({
      latestChapterAt: recent,
      consecutiveFailures: 0,
      now: NOW,
      random: () => 0,
    });
    const ratio = diffMs(next, NOW) / HOT_INTERVAL_MS;
    expect(ratio).toBe(0.9);
  });

  it('backs off exponentially on consecutive failures', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const cases: Array<{ failures: number; expectedBaseMs: number }> = [
      { failures: 1, expectedBaseMs: FAILURE_BASE_INTERVAL_MS * 2 },
      { failures: 2, expectedBaseMs: FAILURE_BASE_INTERVAL_MS * 4 },
      { failures: 3, expectedBaseMs: FAILURE_BASE_INTERVAL_MS * 8 },
    ];
    for (const c of cases) {
      const next = adaptiveCadence({
        latestChapterAt: recent,
        consecutiveFailures: c.failures,
        now: NOW,
        random: () => 0.5,
      });
      expect(diffMs(next, NOW), `failures=${c.failures}`).toBe(c.expectedBaseMs);
    }
  });

  it('caps failure backoff at the configured maximum exponent', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const next = adaptiveCadence({
      latestChapterAt: recent,
      consecutiveFailures: 999,
      now: NOW,
      random: () => 0.5,
    });
    expect(diffMs(next, NOW)).toBe(FAILURE_BASE_INTERVAL_MS * 32);
  });
});
