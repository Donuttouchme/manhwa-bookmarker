import { prisma } from '@manhwa/db';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

export async function checkRateLimit({
  key,
  limit,
  windowMs,
}: RateLimitOptions): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = new Date(now - windowMs);

  return prisma.$transaction(async (tx) => {
    // Garbage-collect anything past the window for this key.
    await tx.rateLimitEvent.deleteMany({
      where: { key, occurredAt: { lt: windowStart } },
    });

    const count = await tx.rateLimitEvent.count({ where: { key } });

    if (count >= limit) {
      const oldest = await tx.rateLimitEvent.findFirst({
        where: { key },
        orderBy: { occurredAt: 'asc' },
      });
      const retryAfterMs = oldest
        ? Math.max(0, oldest.occurredAt.getTime() + windowMs - now)
        : windowMs;
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    await tx.rateLimitEvent.create({ data: { key } });
    return { allowed: true, remaining: limit - (count + 1), retryAfterMs: 0 };
  });
}
