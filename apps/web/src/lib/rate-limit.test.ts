import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@manhwa/db';
import { checkRateLimit } from './rate-limit';

const TEST_KEY_PREFIX = 'ratelimit-test:';

async function clearKey(suffix: string) {
  await prisma.rateLimitEvent.deleteMany({
    where: { key: { startsWith: TEST_KEY_PREFIX + suffix } },
  });
}

describe('checkRateLimit', () => {
  beforeEach(async () => {
    await prisma.rateLimitEvent.deleteMany({
      where: { key: { startsWith: TEST_KEY_PREFIX } },
    });
  });
  afterEach(async () => {
    await prisma.rateLimitEvent.deleteMany({
      where: { key: { startsWith: TEST_KEY_PREFIX } },
    });
  });

  it('allows the first N attempts within the window', async () => {
    const key = TEST_KEY_PREFIX + 'allow';
    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimit({ key, limit: 5, windowMs: 60_000 });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - 1 - i);
    }
    await clearKey('allow');
  });

  it('blocks the (N+1)th attempt within the window', async () => {
    const key = TEST_KEY_PREFIX + 'block';
    for (let i = 0; i < 5; i++) {
      await checkRateLimit({ key, limit: 5, windowMs: 60_000 });
    }
    const result = await checkRateLimit({ key, limit: 5, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    await clearKey('block');
  });

  it('isolates by key', async () => {
    const keyA = TEST_KEY_PREFIX + 'iso-a';
    const keyB = TEST_KEY_PREFIX + 'iso-b';
    for (let i = 0; i < 5; i++) {
      await checkRateLimit({ key: keyA, limit: 5, windowMs: 60_000 });
    }
    const resultB = await checkRateLimit({ key: keyB, limit: 5, windowMs: 60_000 });
    expect(resultB.allowed).toBe(true);
    await clearKey('iso-a');
    await clearKey('iso-b');
  });

  it('forgets events older than the window', async () => {
    const key = TEST_KEY_PREFIX + 'window';
    // Simulate an old attempt by inserting one with a back-dated occurredAt.
    await prisma.rateLimitEvent.create({
      data: { key, occurredAt: new Date(Date.now() - 120_000) },
    });
    // Fresh attempts within the window should all succeed.
    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimit({ key, limit: 5, windowMs: 60_000 });
      expect(result.allowed).toBe(true);
    }
    await clearKey('window');
  });
});
