import { prisma, Decimal, type PrismaClient } from '@manhwa/db';
import { SuwayomiClient } from './suwayomi-client.js';
import { adaptiveCadence } from './adaptive-cadence.js';

export interface PollResult {
  /** Number of Chapter rows newly created by this poll. */
  newChapterCount: number;
  /** Total chapter count after the poll. */
  totalChapterCount: number;
  /** When the next poll for this source will be due. */
  nextPollAt: Date;
  /** Whether `latestChapter` changed during this poll. */
  latestChapterChanged: boolean;
}

export interface PollSeriesSourceOptions {
  /** Test/DI seam: defaults to the shared singleton `prisma`. */
  db?: PrismaClient;
  /** Test/DI seam: defaults to a `SuwayomiClient` built from `process.env.SUWAYOMI_URL`. */
  client?: SuwayomiClient;
  /** Test/DI seam for `adaptiveCadence`. */
  now?: () => Date;
  /** Test/DI seam for jitter. */
  random?: () => number;
}

function defaultClient(): SuwayomiClient {
  const url = process.env.SUWAYOMI_URL;
  if (!url) throw new Error('SUWAYOMI_URL is not set');
  return new SuwayomiClient(url);
}

/**
 * Poll a single `SeriesSource`, persist any new chapters, update `latestChapter*`
 * and `nextPollAt`. On success, `consecutiveFailures` resets to 0 and `lastPollNote`
 * is populated with a human-readable summary. On failure, `consecutiveFailures` is
 * incremented and `nextPollAt` is rescheduled with exponential backoff.
 *
 * Throws if the SeriesSource doesn't exist. Otherwise never throws — Suwayomi errors
 * are caught and recorded as failed polls.
 */
export async function pollSeriesSource(
  seriesSourceId: string,
  options: PollSeriesSourceOptions = {},
): Promise<PollResult> {
  const db = options.db ?? prisma;
  const client = options.client ?? defaultClient();
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;

  // Throws if not found — intentional per spec.
  const source = await db.seriesSource.findUniqueOrThrow({
    where: { id: seriesSourceId },
  });

  const nowDate = now();
  let pollNote: string;
  let consecutiveFailures: number;
  let latestChapter: Decimal | null = source.latestChapter;
  let latestChapterAt: Date | null = source.latestChapterAt;
  let nextPollAt: Date;
  let newChapterCount = 0;
  let totalChapterCount = 0;
  let latestChapterChanged = false;

  try {
    const remote = await client.fetchChapters(Number(source.externalMangaId));

    for (const ch of remote) {
      const chapterNumber = new Decimal(ch.chapterNumber);
      if (chapterNumber.lessThanOrEqualTo(0)) continue;
      const releasedAt = ch.uploadDate > 0 ? new Date(ch.uploadDate) : null;
      const existing = await db.chapter.findUnique({
        where: {
          seriesSourceId_chapterNumber: {
            seriesSourceId: source.id,
            chapterNumber,
          },
        },
      });
      if (existing === null) {
        await db.chapter.create({
          data: {
            seriesSourceId: source.id,
            chapterNumber,
            title: ch.name ?? '',
            sourceChapterUrl: ch.realUrl ?? null,
            releasedAt,
          },
        });
        newChapterCount += 1;
      }
    }

    totalChapterCount = await db.chapter.count({ where: { seriesSourceId: source.id } });

    const top = await db.chapter.findFirst({
      where: { seriesSourceId: source.id },
      orderBy: { chapterNumber: 'desc' },
    });
    const newLatest = top?.chapterNumber ?? null;

    if (
      (latestChapter === null && newLatest !== null) ||
      (latestChapter !== null && newLatest !== null && !newLatest.equals(latestChapter))
    ) {
      latestChapterChanged = true;
    }
    latestChapter = newLatest;
    latestChapterAt = top?.releasedAt ?? null;

    consecutiveFailures = 0;
    pollNote =
      newChapterCount === 0
        ? `no change (total ${totalChapterCount})`
        : `polled ${newChapterCount} new chapter${newChapterCount === 1 ? '' : 's'} (total ${totalChapterCount})`;

    nextPollAt = adaptiveCadence({
      latestChapterAt,
      consecutiveFailures: 0,
      now: nowDate,
      random,
    });
  } catch (err) {
    consecutiveFailures = source.consecutiveFailures + 1;
    pollNote = `error: ${(err as Error).message}`;
    nextPollAt = adaptiveCadence({
      latestChapterAt,
      consecutiveFailures,
      now: nowDate,
      random,
    });
    totalChapterCount = await db.chapter.count({ where: { seriesSourceId: source.id } });
  }

  await db.seriesSource.update({
    where: { id: source.id },
    data: {
      latestChapter,
      latestChapterAt,
      nextPollAt,
      lastPolledAt: nowDate,
      lastPollNote: pollNote,
      consecutiveFailures,
    },
  });

  return {
    newChapterCount,
    totalChapterCount,
    nextPollAt,
    latestChapterChanged,
  };
}
