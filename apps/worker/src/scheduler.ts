import type PgBoss from 'pg-boss';
import { prisma } from '@manhwa/db';
import { POLL_QUEUE } from './boss.js';

const SCHEDULER_INTERVAL_MS = 30_000;
const BATCH_LIMIT = 50;

export interface SchedulerOptions {
  intervalMs?: number;
  /** Override for tests. Defaults to a real timer. */
  setIntervalFn?: typeof setInterval;
  /** Override for tests. Defaults to a real timer cleanup. */
  clearIntervalFn?: typeof clearInterval;
}

export function startScheduler(boss: PgBoss, options: SchedulerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? SCHEDULER_INTERVAL_MS;
  const setIntervalImpl = options.setIntervalFn ?? setInterval;
  const clearIntervalImpl = options.clearIntervalFn ?? clearInterval;

  let running = false;

  async function tick(): Promise<void> {
    if (running) return; // skip if a previous tick is still running
    running = true;
    try {
      const due = await prisma.seriesSource.findMany({
        where: {
          OR: [{ nextPollAt: null }, { nextPollAt: { lte: new Date() } }],
        },
        select: { id: true },
        take: BATCH_LIMIT,
      });
      for (const { id } of due) {
        await boss.send(POLL_QUEUE, { seriesSourceId: id }, { singletonKey: id });
      }
      if (due.length > 0) {
        console.log(`[scheduler] enqueued ${due.length} poll job(s)`);
      }
    } catch (err) {
      console.error('[scheduler] tick failed:', err);
    } finally {
      running = false;
    }
  }

  // Fire once immediately, then every intervalMs.
  void tick();
  const handle = setIntervalImpl(() => {
    void tick();
  }, intervalMs);

  return () => {
    clearIntervalImpl(handle);
  };
}
