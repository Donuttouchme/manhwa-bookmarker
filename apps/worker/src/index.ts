import './sentry.js';
import { Sentry, sentryEnabled } from './sentry.js';
import { getBoss, POLL_QUEUE, stopBoss } from './boss.js';
import { makePollHandler, type PollJobData } from './poll-handler.js';
import { startScheduler } from './scheduler.js';

async function main() {
  console.log('[worker] starting…');
  const boss = await getBoss();

  // pg-boss v10 work API: `work(queue, options, handler)`.
  // teamSize is not in v10 types; batchSize=1 keeps each job atomic.
  await boss.work<PollJobData>(POLL_QUEUE, { batchSize: 1 }, makePollHandler());

  const stopScheduler = startScheduler(boss);
  console.log('[worker] up — scheduler tick every 30s, batchSize 1');

  async function shutdown(reason: string): Promise<void> {
    console.log(`[worker] shutting down (${reason})`);
    stopScheduler();
    await stopBoss();
    if (sentryEnabled) await Sentry.close(5_000);
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  if (sentryEnabled) {
    Sentry.captureException(err);
    void Sentry.flush(5_000).then(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
