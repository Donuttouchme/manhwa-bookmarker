import type { Job } from 'pg-boss';
import { pollSeriesSource, TokenBucket, findRegistryEntry, canonicalizeUrl } from '@manhwa/sources';
import { prisma } from '@manhwa/db';

const SOURCE_MIN_GAP_MS = 5_000; // be polite — at most 1 request / 5s per source extension

export interface PollJobData {
  seriesSourceId: string;
}

/** Returns the per-extension bucket key for a SeriesSource (registry-driven). */
async function bucketKeyFor(seriesSourceId: string): Promise<string> {
  const src = await prisma.seriesSource.findUnique({
    where: { id: seriesSourceId },
    select: { sourceUrl: true },
  });
  if (!src) return 'unknown';
  try {
    const { host } = canonicalizeUrl(src.sourceUrl);
    const entry = findRegistryEntry(host);
    return entry?.extensionName ?? `host:${host}`;
  } catch {
    return 'unknown';
  }
}

export function makePollHandler(
  bucket: TokenBucket = new TokenBucket({ minGapMs: SOURCE_MIN_GAP_MS }),
) {
  return async function pollHandler(jobs: Job<PollJobData>[]): Promise<void> {
    // pg-boss v10 calls handlers with an array of jobs (batchSize: 1 by default).
    for (const job of jobs) {
      const { seriesSourceId } = job.data;
      const key = await bucketKeyFor(seriesSourceId);
      await bucket.acquire(key);
      try {
        const result = await pollSeriesSource(seriesSourceId);
        console.log(
          `[poll] ${seriesSourceId} (${key}) → new=${result.newChapterCount} total=${result.totalChapterCount} nextPollAt=${result.nextPollAt.toISOString()}`,
        );
      } catch (err) {
        console.error(`[poll] ${seriesSourceId} (${key}) → FATAL`, err);
        throw err; // let pg-boss retry per its policy
      }
    }
  };
}
