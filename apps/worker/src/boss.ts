import PgBoss from 'pg-boss';

export const POLL_QUEUE = 'poll-series-source';

let boss: PgBoss | null = null;

/**
 * Start (or return the existing) pg-boss instance. Idempotent. Reads connection
 * string from DATABASE_URL. Creates the `pgboss.*` tables on first start.
 */
export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  boss = new PgBoss(databaseUrl);
  boss.on('error', (err) => {
    console.error('[boss] error:', err);
  });
  await boss.start();
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss === null) return;
  await boss.stop({ graceful: true, timeout: 10_000 });
  boss = null;
}
