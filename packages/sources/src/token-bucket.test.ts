import { describe, expect, it } from 'vitest';
import { TokenBucket } from './token-bucket.js';

function fakeTimeline() {
  let nowMs = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    sleeps,
  };
}

describe('TokenBucket', () => {
  it('first acquire for a key never sleeps', async () => {
    const t = fakeTimeline();
    const bucket = new TokenBucket({ minGapMs: 5_000, now: t.now, sleep: t.sleep });
    await bucket.acquire('bato');
    expect(t.sleeps).toEqual([]);
  });

  it('second acquire within the gap sleeps the remaining time', async () => {
    const t = fakeTimeline();
    const bucket = new TokenBucket({ minGapMs: 5_000, now: t.now, sleep: t.sleep });
    await bucket.acquire('bato');
    t.advance(1_500);
    await bucket.acquire('bato');
    expect(t.sleeps).toEqual([3_500]);
  });

  it('second acquire after the gap does not sleep', async () => {
    const t = fakeTimeline();
    const bucket = new TokenBucket({ minGapMs: 5_000, now: t.now, sleep: t.sleep });
    await bucket.acquire('bato');
    t.advance(6_000);
    await bucket.acquire('bato');
    expect(t.sleeps).toEqual([]);
  });

  it('different keys never block each other', async () => {
    const t = fakeTimeline();
    const bucket = new TokenBucket({ minGapMs: 5_000, now: t.now, sleep: t.sleep });
    await bucket.acquire('bato');
    await bucket.acquire('asura');
    await bucket.acquire('flame');
    expect(t.sleeps).toEqual([]);
  });

  it('serializes concurrent acquires of the same key correctly', async () => {
    // Two concurrent acquires: the second must wait the full gap after the first.
    const t = fakeTimeline();
    const bucket = new TokenBucket({ minGapMs: 5_000, now: t.now, sleep: t.sleep });
    const first = bucket.acquire('bato');
    const second = bucket.acquire('bato');
    await first;
    await second;
    expect(t.sleeps).toEqual([5_000]);
  });
});
