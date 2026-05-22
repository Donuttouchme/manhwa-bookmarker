# Polling & Read Tracking Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the snapshot library from Plan 2 into a live one. The worker polls every `SeriesSource` on an adaptive cadence (more often when chapters drop frequently, less often when they don't), persists discovered chapters in a new `Chapter` table, and updates `latestChapter` / `latestChapterAt`. The library page gains a `+1 read` button per series with a 5-second undo toast so the user can advance the per-source cursor as they read.

**Architecture:** A `Chapter` model is added under `SeriesSource` to hold the per-chapter rows discovered by polls. A new `pollSeriesSource(id)` domain function lives in `packages/sources` — it fetches chapters from Suwayomi, upserts `Chapter` rows, recomputes `latestChapter`, and writes the next `nextPollAt` using an adaptive cadence formula. The worker (`apps/worker`) runs `pg-boss` (a Postgres-backed durable job queue): a 30-second scheduler loop selects `SeriesSource`s with `nextPollAt <= now` and enqueues one job per source; a worker handler then drains the queue, gated by an in-memory per-source-extension token bucket so we never fan-out hundreds of parallel requests to one upstream site. The UI gets two new server actions — `advanceCursor(seriesId, by)` and `setCursor(seriesId, snapshot)` — wired to a `+1 read` button on each `SeriesCard` with a Sonner undo toast.

**Tech Stack (additions on top of Plans 1 + 2):** `pg-boss@^10` (durable Postgres-backed job queue — uses the existing Postgres instance, no new container). Everything else (Suwayomi client, Prisma, shadcn, Sonner) is already in place.

**Out of scope for this plan (intentional):**

- Cross-source chapter matching (B-strict from grilling) → still never.
- Email digest / RSS / push notifications → Plan 4 or later.
- Manual "refresh now" button → could fit if you have time, but not required.
- Per-source advance buttons / per-source cursor editing UI → Plan 4 polish.
- Per-user polling preferences (faster cadence on favourites) → out of scope; cadence is purely chapter-frequency-driven.
- Worker horizontal scaling → Plan 4 (Fly deployment); for now one worker process is enough.
- Deployment / staging / Fly / Neon → Plan 4.
- Chapter list view UI (browse individual chapters, link to source) → Plan 4 or later.

**State at start (verified from Plan 2):**

- 38 commits on `main`, HEAD at `a5047d5`.
- All 4 Docker containers up: `postgres`, `mailpit`, `suwayomi`, plus pg-boss tables live in the same `manhwa` Postgres DB once Plan 3's worker starts.
- `Series` + `SeriesSource` tables exist with `nextPollAt` already in the schema (populated by Plan 3 polls).
- `SuwayomiClient` and `SuwayomiSource` already work; `Bbato`, `Asura Scans`, `MangaBuddy`, `Flame Comics` extensions installed.
- `pnpm test && pnpm typecheck` is green (47 tests).
- Library page renders real series with snapshot unread badges; the badge currently never decreases because there's no advance flow yet.

---

## File Structure (new and modified)

```
Manhwa_bookmarker/
├── README.md                                                # MODIFIED in Task 11
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── app/
│   │       │   ├── library/
│   │       │   │   ├── actions.ts                            # MODIFIED: + advanceCursor + setCursor
│   │       │   │   ├── actions.test.ts                       # MODIFIED: + 5 new tests
│   │       │   │   └── _components/
│   │       │   │       ├── series-card.tsx                   # MODIFIED: + advance button + undo wiring
│   │       │   │       └── series-card-actions.tsx           # NEW: client wrapper for the +1 button + toast
│   │       │   └── lib/
│   │       │       └── series-cursor-snapshot.ts             # NEW: shape of cursor snapshot used by undo
│   └── worker/
│       ├── package.json                                      # MODIFIED: + pg-boss dep + worker:start-poll script
│       └── src/
│           ├── index.ts                                      # REPLACED: real long-running worker entrypoint
│           ├── boss.ts                                       # NEW: pg-boss singleton + start/stop
│           ├── poll-handler.ts                               # NEW: pg-boss job handler (wraps pollSeriesSource)
│           └── scheduler.ts                                  # NEW: 30s loop that enqueues due SeriesSources
└── packages/
    ├── db/
    │   └── prisma/
    │       ├── schema.prisma                                 # MODIFIED: + Chapter model + new SeriesSource fields
    │       └── migrations/<ts>_chapters_and_poll_state/      # NEW
    └── sources/
        └── src/
            ├── index.ts                                      # MODIFIED: + new exports
            ├── token-bucket.ts                               # NEW: per-key rate limiter
            ├── token-bucket.test.ts                          # NEW
            ├── adaptive-cadence.ts                           # NEW: nextPollAt formula
            ├── adaptive-cadence.test.ts                      # NEW
            ├── poll-series-source.ts                         # NEW: poll + persist for one SeriesSource
            └── poll-series-source.test.ts                    # NEW: integration test (real Suwayomi + DB)
```

**Decomposition rationale:** `token-bucket` and `adaptive-cadence` are pure functions and live next to `packages/sources` because they describe how we politely treat sources (the bucket key is the source extension name; cadence depends on chapter history that the sources package already knows about). `pollSeriesSource` lives in `packages/sources` too because it's the domain transaction "fetch from Suwayomi + persist to DB"; both the worker and (later) any manual refresh UI can call it. The worker package itself stays thin: just plumbing (boss singleton, scheduler loop, job handler). On the UI side, the `+1 read` interaction needs client state for the optimistic undo, so the button + toast lift into their own `series-card-actions.tsx` client component, keeping `series-card.tsx` as a mostly-server-rendered display.

---

## Task 1: Prisma schema — `Chapter` model + poll-state fields on `SeriesSource`

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\packages\db\prisma\schema.prisma`
- Generate: `D:\Projects\Claude\Manhwa_bookmarker\packages\db\prisma\migrations\<ts>_chapters_and_poll_state\migration.sql`

- [ ] **Step 1.1: Add the `Chapter` model and three new poll-state fields on `SeriesSource`**

Append to `packages/db/prisma/schema.prisma` (after the existing `SeriesSource` model):

```prisma
model Chapter {
  id               String   @id @default(cuid())
  seriesSourceId   String
  /// Chapter number as reported by the source (e.g. 0.5 for prologue, 12 for ch. 12).
  chapterNumber    Decimal  @db.Decimal(10, 2)
  /// Title from the source, may be empty/blank in some catalogs.
  title            String
  /// Direct URL to the chapter on the source site (when the source provides one).
  sourceChapterUrl String?
  /// When the source says this chapter was released, if known.
  releasedAt       DateTime?
  /// First time our poller observed this chapter.
  firstSeenAt      DateTime @default(now())

  source SeriesSource @relation(fields: [seriesSourceId], references: [id], onDelete: Cascade)

  /// Two rows can't claim the same chapter number for the same source attachment.
  @@unique([seriesSourceId, chapterNumber])
  @@index([seriesSourceId, chapterNumber])
}
```

Then **modify the existing `SeriesSource` model** to add three new fields (insert these just before the existing `createdAt` line):

```prisma
  /// When the last poll attempt finished (success or failure).
  lastPolledAt    DateTime?
  /// Last successful poll's outcome message (e.g. "polled 3 new chapters" or "no change"). For debugging.
  lastPollNote    String?
  /// Count of consecutive failed polls. Reset to 0 on any success. Used to back off after errors.
  consecutiveFailures Int @default(0)
```

Also add the `chapters` back-relation in `SeriesSource`. The existing model already declares a `series` relation — add this line in the relations block (after `series Series @relation(...)`):

```prisma
  chapters Chapter[]
```

The final `SeriesSource` model relations + back-relation section should read:

```prisma
  series   Series   @relation(fields: [seriesId], references: [id], onDelete: Cascade)
  chapters Chapter[]
```

- [ ] **Step 1.2: Run the migration**

From `D:\Projects\Claude\Manhwa_bookmarker`:

```
pnpm db:migrate -- --name chapters_and_poll_state
```

Expected: creates `packages/db/prisma/migrations/<timestamp>_chapters_and_poll_state/migration.sql`, applies cleanly. If the prompt-driven `pnpm db:migrate` script hangs (it did on Plan 2 Task 7 in the prior session), fall back to:

```
dotenv -e .env.local -- pnpm --filter @manhwa/db exec prisma migrate dev --name chapters_and_poll_state
```

- [ ] **Step 1.3: Verify the schema in Postgres**

```
docker exec manhwa-postgres psql -U manhwa -d manhwa -c "\dt"
```

Expected: now lists `Chapter` in addition to the prior tables.

```
docker exec manhwa-postgres psql -U manhwa -d manhwa -c "\d \"Chapter\""
```

Expected: shows `chapterNumber numeric(10,2)`, `firstSeenAt timestamp` (with a default of `CURRENT_TIMESTAMP` or `now()`), and a unique constraint on `(seriesSourceId, chapterNumber)`.

```
docker exec manhwa-postgres psql -U manhwa -d manhwa -c "\d \"SeriesSource\""
```

Expected: now also includes `lastPolledAt timestamp`, `lastPollNote text`, `consecutiveFailures integer DEFAULT 0`.

- [ ] **Step 1.4: Typecheck**

Run: `pnpm typecheck` from project root. Expected: 0 errors. The Prisma client regenerates as part of `migrate dev`, so the new `Chapter` model is available to `@manhwa/db` consumers.

- [ ] **Step 1.5: Commit**

```
git add packages/db
git commit -m "feat(db): Chapter model + poll-state fields on SeriesSource"
```

---

## Task 2: `TokenBucket` — per-key in-process rate limiter (TDD)

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\packages\sources\src\token-bucket.ts`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\packages\sources\src\token-bucket.test.ts`

Why this exists: when the worker discovers 20 due `SeriesSource`s that all live on Bato.to, we don't want to fire 20 parallel HTTP requests at Suwayomi which then fans them out to Bato.to. Even though Suwayomi itself caches, hammering it is rude. A token bucket keyed by `extensionName` enforces a minimum gap between requests per source.

- [ ] **Step 2.1: Write the implementation stub**

`packages/sources/src/token-bucket.ts`:

```ts
/**
 * Per-key minimum-gap rate limiter. Single-process, in-memory.
 *
 * Use one instance per logical scope (e.g. one for the polling worker).
 * Calls to `acquire(key)` resolve immediately if the gap since the last
 * `acquire(key)` is already long enough, otherwise they wait.
 *
 * Not durable: resets on process restart. That's fine for politeness limits —
 * after a crash you can briefly burst again, no worse than a fresh deploy.
 */
export interface TokenBucketOptions {
  /** Minimum milliseconds between acquires for the same key. */
  minGapMs: number;
  /** Override for tests: returns "now" in millis. Defaults to `Date.now`. */
  now?: () => number;
  /** Override for tests: schedules a delay in millis. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export class TokenBucket {
  private readonly lastAcquireAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minGapMs: number;

  constructor(options: TokenBucketOptions) {
    throw new Error('not implemented');
  }

  /** Wait (if needed) until the per-key cooldown has elapsed, then record the acquire. */
  async acquire(key: string): Promise<void> {
    throw new Error('not implemented');
  }
}
```

- [ ] **Step 2.2: Write failing tests**

`packages/sources/src/token-bucket.test.ts`:

```ts
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
```

- [ ] **Step 2.3: Run tests — expect RED**

Run: `pnpm --filter @manhwa/sources test`
Expected: the 5 new `TokenBucket` tests fail with "not implemented" (existing 23 still pass).

- [ ] **Step 2.4: Implement `TokenBucket`**

Replace `packages/sources/src/token-bucket.ts`:

```ts
export interface TokenBucketOptions {
  minGapMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TokenBucket {
  private readonly lastAcquireAt = new Map<string, number>();
  /** Per-key chain so concurrent acquires for the same key serialize. */
  private readonly pending = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minGapMs: number;

  constructor(options: TokenBucketOptions) {
    this.minGapMs = options.minGapMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async acquire(key: string): Promise<void> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.acquireUnchained(key));
    // Swallow rejections in the chain so one failure doesn't kill subsequent acquires.
    this.pending.set(
      key,
      next.catch(() => undefined),
    );
    await next;
  }

  private async acquireUnchained(key: string): Promise<void> {
    const last = this.lastAcquireAt.get(key);
    if (last !== undefined) {
      const gap = this.now() - last;
      const wait = this.minGapMs - gap;
      if (wait > 0) await this.sleep(wait);
    }
    this.lastAcquireAt.set(key, this.now());
  }
}
```

- [ ] **Step 2.5: Run tests — expect GREEN**

Run: `pnpm --filter @manhwa/sources test`
Expected: 28/28 pass (23 existing + 5 new).

- [ ] **Step 2.6: Re-export from `index.ts`**

Append to `packages/sources/src/index.ts`:

```ts
export * from './token-bucket.js';
```

- [ ] **Step 2.7: Commit**

```
git add packages/sources
git commit -m "feat(sources): TokenBucket — per-key minimum-gap rate limiter"
```

---

## Task 3: `adaptiveCadence` — compute `nextPollAt` from chapter history (TDD)

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\packages\sources\src\adaptive-cadence.ts`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\packages\sources\src\adaptive-cadence.test.ts`

Strategy: derive cadence from the freshness of the latest chapter, not from a fixed schedule.

- **Hot bucket (2h ±10%):** latest chapter released within 7 days. The series is actively updating; check often.
- **Cold bucket (3 days ±10%):** latest chapter older than 7 days, or `latestChapterAt` is unknown. Either stale or unreleased.
- **On failure:** schedule the next attempt at `2h * 2^min(consecutiveFailures, 5)` so a flaky source doesn't get hammered.

The `±10%` jitter spreads pollings out so 1000 series all added at minute 0 don't synchronously poll forever.

- [ ] **Step 3.1: Write the implementation stub**

`packages/sources/src/adaptive-cadence.ts`:

```ts
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

export function adaptiveCadence(input: CadenceInput): Date {
  throw new Error('not implemented');
}
```

- [ ] **Step 3.2: Write failing tests**

`packages/sources/src/adaptive-cadence.test.ts`:

```ts
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
      random: () => 0.9999, // approx upper bound
    });
    // expected ≈ 1.1 * HOT_INTERVAL_MS
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
    // 5 doublings = * 32
    expect(diffMs(next, NOW)).toBe(FAILURE_BASE_INTERVAL_MS * 32);
  });
});
```

- [ ] **Step 3.3: Run tests — expect RED**

Run: `pnpm --filter @manhwa/sources test`
Expected: the 7 cadence tests fail with "not implemented".

- [ ] **Step 3.4: Implement `adaptiveCadence`**

Replace `packages/sources/src/adaptive-cadence.ts`:

```ts
export interface CadenceInput {
  latestChapterAt: Date | null;
  consecutiveFailures: number;
  now: Date;
  random?: () => number;
}

export const HOT_INTERVAL_MS = 2 * 60 * 60 * 1_000;
export const COLD_INTERVAL_MS = 3 * 24 * 60 * 60 * 1_000;
export const HOT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000;
export const JITTER_FRACTION = 0.1;
export const FAILURE_BASE_INTERVAL_MS = HOT_INTERVAL_MS;
export const MAX_FAILURE_BACKOFF_EXP = 5;

function jitter(base: number, random: number): number {
  // random in [0, 1) → factor in [1 - JITTER_FRACTION, 1 + JITTER_FRACTION).
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

  const jittered = jitter(base, random());
  return new Date(input.now.getTime() + Math.round(jittered));
}
```

- [ ] **Step 3.5: Run tests — expect GREEN**

Run: `pnpm --filter @manhwa/sources test`
Expected: 35/35 pass (23 + 5 + 7).

- [ ] **Step 3.6: Re-export from `index.ts`**

Append to `packages/sources/src/index.ts`:

```ts
export * from './adaptive-cadence.js';
```

- [ ] **Step 3.7: Commit**

```
git add packages/sources
git commit -m "feat(sources): adaptiveCadence — hot/cold polling cadence with jitter + failure backoff"
```

---

## Task 4: `pollSeriesSource` — domain function that polls + persists one source (TDD)

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\packages\sources\src\poll-series-source.ts`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\packages\sources\src\poll-series-source.test.ts`

This is the single transaction that one poll job performs: load the `SeriesSource`, ask Suwayomi for fresh chapters, upsert each `Chapter` row, recompute `latestChapter` / `latestChapterAt`, and write the next `nextPollAt`. Used by Task 7 (the pg-boss handler) and by any future "refresh now" UI.

- [ ] **Step 4.1: Write the implementation stub**

`packages/sources/src/poll-series-source.ts`:

```ts
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
  throw new Error('not implemented');
}
```

- [ ] **Step 4.2: Write failing integration tests**

`packages/sources/src/poll-series-source.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@manhwa/db';
import { pollSeriesSource } from './poll-series-source.js';

const BATO_URL = 'https://bato.to/title/95390-the-beginning-after-the-end';
const TEST_USER_EMAIL = 'poll-test@example.com';

async function makeUserSeriesAndSource() {
  const user = await prisma.user.create({ data: { email: TEST_USER_EMAIL } });
  const series = await prisma.series.create({
    data: { userId: user.id, title: 'Placeholder' },
  });
  // Insert a minimal SeriesSource — the poll will fill in the rest.
  // The externalMangaId is the Bbato-side id "1" (verified in Plan 2 probe).
  const source = await prisma.seriesSource.create({
    data: {
      seriesId: series.id,
      sourceId: 'suwayomi',
      externalMangaId: '1',
      sourceUrl: BATO_URL,
      sourceTitle: 'The Beginning After the End',
    },
  });
  return { userId: user.id, seriesId: series.id, sourceId: source.id };
}

async function cleanup() {
  await prisma.chapter.deleteMany({});
  await prisma.seriesSource.deleteMany({});
  await prisma.series.deleteMany({});
  await prisma.user.deleteMany({});
}

describe('pollSeriesSource', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('populates chapters, latestChapter, lastPolledAt on first poll', async () => {
    const { sourceId } = await makeUserSeriesAndSource();
    const result = await pollSeriesSource(sourceId);

    expect(result.newChapterCount).toBeGreaterThan(0);
    expect(result.totalChapterCount).toBe(result.newChapterCount);
    expect(result.latestChapterChanged).toBe(true);

    const after = await prisma.seriesSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(after.latestChapter).not.toBeNull();
    expect(after.lastPolledAt).not.toBeNull();
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastPollNote).toMatch(/polled \d+ new chapter/);
    expect(after.nextPollAt).not.toBeNull();
    expect(after.nextPollAt!.getTime()).toBeGreaterThan(Date.now());

    const chapters = await prisma.chapter.findMany({ where: { seriesSourceId: sourceId } });
    expect(chapters.length).toBe(result.totalChapterCount);
  }, 30_000);

  it('a second poll with no new chapters reports newChapterCount=0', async () => {
    const { sourceId } = await makeUserSeriesAndSource();
    await pollSeriesSource(sourceId);
    const second = await pollSeriesSource(sourceId);

    expect(second.newChapterCount).toBe(0);
    expect(second.latestChapterChanged).toBe(false);
    const after = await prisma.seriesSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(after.lastPollNote).toMatch(/no change|0 new chapter/);
    expect(after.consecutiveFailures).toBe(0);
  }, 60_000);

  it('records a failure and increments consecutiveFailures when Suwayomi rejects', async () => {
    // Create a SeriesSource pointing at an unknown externalMangaId; Suwayomi will fail to fetch chapters.
    const user = await prisma.user.create({ data: { email: TEST_USER_EMAIL } });
    const series = await prisma.series.create({ data: { userId: user.id, title: 'Bad' } });
    const source = await prisma.seriesSource.create({
      data: {
        seriesId: series.id,
        sourceId: 'suwayomi',
        externalMangaId: '999999999', // unlikely to exist
        sourceUrl: 'https://bato.to/title/999999999-fake',
        sourceTitle: 'Fake',
      },
    });

    const result = await pollSeriesSource(source.id);
    expect(result.newChapterCount).toBe(0);

    const after = await prisma.seriesSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastPollNote).toMatch(/error|fail/i);
    expect(after.nextPollAt).not.toBeNull();
  }, 30_000);

  it('throws when SeriesSource does not exist', async () => {
    await expect(pollSeriesSource('does-not-exist')).rejects.toThrow();
  });
});
```

- [ ] **Step 4.3: Run tests — expect RED**

Run: `pnpm --filter @manhwa/sources test`
Expected: the 4 new tests fail with "not implemented" (35 existing still pass).

- [ ] **Step 4.4: Implement `pollSeriesSource`**

Replace `packages/sources/src/poll-series-source.ts`:

```ts
import { prisma, Decimal, type PrismaClient } from '@manhwa/db';
import { SuwayomiClient } from './suwayomi-client.js';
import { adaptiveCadence } from './adaptive-cadence.js';

export interface PollResult {
  newChapterCount: number;
  totalChapterCount: number;
  nextPollAt: Date;
  latestChapterChanged: boolean;
}

export interface PollSeriesSourceOptions {
  db?: PrismaClient;
  client?: SuwayomiClient;
  now?: () => Date;
  random?: () => number;
}

function defaultClient(): SuwayomiClient {
  const url = process.env.SUWAYOMI_URL;
  if (!url) throw new Error('SUWAYOMI_URL is not set');
  return new SuwayomiClient(url);
}

export async function pollSeriesSource(
  seriesSourceId: string,
  options: PollSeriesSourceOptions = {},
): Promise<PollResult> {
  const db = options.db ?? prisma;
  const client = options.client ?? defaultClient();
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;

  const source = await db.seriesSource.findUniqueOrThrow({
    where: { id: seriesSourceId },
  });

  const nowDate = now();
  let result: PollResult;
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

    // Upsert each remote chapter; track new vs existing.
    for (const ch of remote) {
      const chapterNumber = new Decimal(ch.chapterNumber);
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

    // Recompute latestChapter / latestChapterAt over the canonical Chapter table.
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

    result = {
      newChapterCount,
      totalChapterCount,
      nextPollAt,
      latestChapterChanged,
    };
  } catch (err) {
    consecutiveFailures = source.consecutiveFailures + 1;
    pollNote = `error: ${(err as Error).message}`;
    nextPollAt = adaptiveCadence({
      latestChapterAt,
      consecutiveFailures,
      now: nowDate,
      random,
    });
    result = {
      newChapterCount: 0,
      totalChapterCount: await db.chapter.count({ where: { seriesSourceId: source.id } }),
      nextPollAt,
      latestChapterChanged: false,
    };
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

  return result;
}
```

- [ ] **Step 4.5: Run tests — expect GREEN**

Run: `pnpm --filter @manhwa/sources test`
Expected: 39/39 pass (35 + 4 new).

- [ ] **Step 4.6: Re-export from `index.ts`**

Append to `packages/sources/src/index.ts`:

```ts
export * from './poll-series-source.js';
```

- [ ] **Step 4.7: Commit**

```
git add packages/sources
git commit -m "feat(sources): pollSeriesSource — fetch chapters, upsert, recompute latest + next poll"
```

---

## Task 5: Worker — add `pg-boss` dependency + boss singleton

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\package.json`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\src\boss.ts`

- [ ] **Step 5.1: Add `pg-boss` to the worker**

From `D:\Projects\Claude\Manhwa_bookmarker`:

```
pnpm --filter @manhwa/worker add pg-boss@^10
```

Expected: `pg-boss@^10.x.x` appears in `apps/worker/package.json` under `dependencies`. The lockfile updates.

- [ ] **Step 5.2: Write `boss.ts` — singleton + lifecycle**

`apps/worker/src/boss.ts`:

```ts
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
```

- [ ] **Step 5.3: Typecheck**

Run: `pnpm --filter @manhwa/worker typecheck`
Expected: 0 errors.

- [ ] **Step 5.4: Commit**

```
git add apps/worker pnpm-lock.yaml
git commit -m "feat(worker): pg-boss dependency + boss singleton"
```

---

## Task 6: Worker — poll-job handler

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\src\poll-handler.ts`

This is the function pg-boss invokes for each `poll-series-source` job. Thin wrapper: take the job data, run `pollSeriesSource`, log the outcome. The shared `TokenBucket` gates calls per source extension so concurrent jobs to the same upstream serialize politely.

- [ ] **Step 6.1: Write `poll-handler.ts`**

```ts
import type PgBoss from 'pg-boss';
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
  return async function pollHandler(jobs: PgBoss.Job<PollJobData>[]): Promise<void> {
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
```

- [ ] **Step 6.2: Typecheck**

Run: `pnpm --filter @manhwa/worker typecheck`
Expected: 0 errors.

(No tests for this file — it's a thin orchestrator. The behaviour it composes — `pollSeriesSource` + `TokenBucket` — is covered by their own tests. The integration smoke at Task 11 exercises the full flow.)

- [ ] **Step 6.3: Commit**

```
git add apps/worker
git commit -m "feat(worker): poll-job handler with per-source token-bucket gating"
```

---

## Task 7: Worker — scheduler loop

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\src\scheduler.ts`

Every 30 seconds, find SeriesSources whose `nextPollAt` is in the past (or null — first poll) and enqueue one job per source. pg-boss's `singletonKey` ensures we don't double-enqueue: if a job for the same `seriesSourceId` is already pending, the new enqueue is dropped.

- [ ] **Step 7.1: Write `scheduler.ts`**

```ts
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
```

- [ ] **Step 7.2: Typecheck**

Run: `pnpm --filter @manhwa/worker typecheck`
Expected: 0 errors.

- [ ] **Step 7.3: Commit**

```
git add apps/worker
git commit -m "feat(worker): 30s scheduler enqueues due SeriesSources via pg-boss singleton key"
```

---

## Task 8: Worker — wire everything in `index.ts`

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\src\index.ts`

Replace the stub with a real long-running process: start pg-boss, register the handler, start the scheduler, install graceful-shutdown handlers.

- [ ] **Step 8.1: Replace `apps/worker/src/index.ts`**

The current file contains only the Plan 1 stub. Overwrite it with:

```ts
import { getBoss, POLL_QUEUE, stopBoss } from './boss.js';
import { makePollHandler, type PollJobData } from './poll-handler.js';
import { startScheduler } from './scheduler.js';

async function main() {
  console.log('[worker] starting…');
  const boss = await getBoss();

  // pg-boss v10 work API: `work(queue, options, handler)`.
  await boss.work<PollJobData>(POLL_QUEUE, { batchSize: 1, teamSize: 4 }, makePollHandler());

  const stopScheduler = startScheduler(boss);
  console.log('[worker] up — scheduler tick every 30s, queue concurrency 4');

  async function shutdown(reason: string): Promise<void> {
    console.log(`[worker] shutting down (${reason})`);
    stopScheduler();
    await stopBoss();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 8.2: Smoke-run the worker for 60s**

From `D:\Projects\Claude\Manhwa_bookmarker`:

```
pnpm worker:dev
```

(`worker:dev` runs under `tsx watch`; for this smoke you don't need watch, but `pnpm worker:start` works too.)

Expected within ~5 seconds:

```
[worker] starting…
[worker] up — scheduler tick every 30s, queue concurrency 4
[scheduler] enqueued <N> poll job(s)
[poll] <id> (<key>) → new=<n> total=<m> nextPollAt=<iso>
…
```

(Replace `<N>`, `<id>` etc. with the values printed.) If the library currently has 0 SeriesSources, you'll just see `[scheduler] enqueued 0 poll job(s)` (no log line — see scheduler.ts: it only logs when count > 0).

If pg-boss complains about missing `pgcrypto` extension, run:

```
docker exec manhwa-postgres psql -U manhwa -d manhwa -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

then restart the worker. (pg-boss uses `gen_random_uuid()`.)

Stop the worker with `Ctrl+C` and confirm a clean `[worker] shutting down (SIGINT)` message appears, followed by process exit.

- [ ] **Step 8.3: Commit**

```
git add apps/worker
git commit -m "feat(worker): real entrypoint — boss + queue + scheduler + graceful shutdown"
```

---

## Task 9: Web — `advanceCursor` + `setCursor` server actions (TDD)

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\src\app\library\actions.ts`
- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\src\app\library\actions.test.ts`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\src\lib\series-cursor-snapshot.ts`

Two actions, both per-`Series`:

- `advanceCursor(seriesId, by)` → bumps every `SeriesSource.lastReadChapter` for that series by `by`, capped at `latestChapter`. Returns a `CursorSnapshot` of the **pre-advance** state so the client can pass it back to `setCursor` for undo.
- `setCursor(seriesId, snapshot)` → restores per-source cursors from a snapshot. Both functions auth-check the series owner.

- [ ] **Step 9.1: Write the snapshot helper type**

`apps/web/src/lib/series-cursor-snapshot.ts`:

```ts
/** A serializable snapshot of per-source cursor positions for one series. */
export interface CursorSnapshot {
  seriesId: string;
  /** Decimal values are serialized as strings so the snapshot survives JSON round-trips. */
  cursors: Array<{ seriesSourceId: string; lastReadChapter: string }>;
}
```

- [ ] **Step 9.2: Extend `actions.ts` with action stubs**

Append to `apps/web/src/app/library/actions.ts` (keep all existing code, including the existing `'use server'` directive at the top of the file):

```ts
import type { CursorSnapshot } from '@/lib/series-cursor-snapshot';

export interface AdvanceResult {
  ok: true;
  /** The pre-advance snapshot so the client can offer an undo. */
  snapshot: CursorSnapshot;
}

export async function advanceCursor(
  seriesId: string,
  by: number,
): Promise<AdvanceResult | ResolveError> {
  throw new Error('not implemented');
}

export interface SetCursorResult {
  ok: true;
}

export async function setCursor(snapshot: CursorSnapshot): Promise<SetCursorResult | ResolveError> {
  throw new Error('not implemented');
}
```

(`ResolveError` is already exported from `actions.ts` — re-use it.)

- [ ] **Step 9.3: Add failing tests to `actions.test.ts`**

Add `Decimal` to the existing `import { prisma } from '@manhwa/db';` line so it reads `import { prisma, Decimal } from '@manhwa/db';`. Then append to `apps/web/src/app/library/actions.test.ts` (before the closing `});` of the outer `describe`):

```ts
describe('advanceCursor + setCursor', () => {
  it('advanceCursor bumps every source cursor by N and returns the prior snapshot', async () => {
    const series = await prisma.series.create({
      data: { userId: TEST_USER_ID, title: 'Multi-source' },
    });
    await prisma.seriesSource.create({
      data: {
        seriesId: series.id,
        sourceId: 'suwayomi',
        externalMangaId: '1',
        sourceUrl: 'https://bato.to/title/1-foo',
        sourceTitle: 'Foo',
        lastReadChapter: new Decimal(10),
        latestChapter: new Decimal(100),
      },
    });
    await prisma.seriesSource.create({
      data: {
        seriesId: series.id,
        sourceId: 'suwayomi',
        externalMangaId: '2',
        sourceUrl: 'https://bato.to/title/2-bar',
        sourceTitle: 'Bar',
        lastReadChapter: new Decimal(5),
        latestChapter: new Decimal(30),
      },
    });

    const result = await advanceCursor(series.id, 1);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error}`);
    expect(result.snapshot.seriesId).toBe(series.id);
    expect(result.snapshot.cursors).toHaveLength(2);

    const after = await prisma.seriesSource.findMany({
      where: { seriesId: series.id },
      orderBy: { externalMangaId: 'asc' },
    });
    expect(after[0]!.lastReadChapter.toString()).toBe('11');
    expect(after[1]!.lastReadChapter.toString()).toBe('6');
  });

  it('advanceCursor caps each cursor at its source latestChapter', async () => {
    const series = await prisma.series.create({
      data: { userId: TEST_USER_ID, title: 'Cap-test' },
    });
    const src = await prisma.seriesSource.create({
      data: {
        seriesId: series.id,
        sourceId: 'suwayomi',
        externalMangaId: '1',
        sourceUrl: 'https://bato.to/title/1-foo',
        sourceTitle: 'Foo',
        lastReadChapter: new Decimal(99),
        latestChapter: new Decimal(100),
      },
    });

    const result = await advanceCursor(series.id, 5);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error}`);
    const after = await prisma.seriesSource.findUniqueOrThrow({ where: { id: src.id } });
    expect(after.lastReadChapter.toString()).toBe('100');
  });

  it('advanceCursor rejects a non-positive by', async () => {
    const series = await prisma.series.create({
      data: { userId: TEST_USER_ID, title: 'X' },
    });
    const r = await advanceCursor(series.id, 0);
    expect(r.ok).toBe(false);
  });

  it('advanceCursor rejects a series owned by someone else', async () => {
    const otherUser = await prisma.user.create({ data: { email: 'other@example.com' } });
    const series = await prisma.series.create({
      data: { userId: otherUser.id, title: 'Not yours' },
    });
    const r = await advanceCursor(series.id, 1);
    expect(r.ok).toBe(false);
  });

  it('setCursor restores per-source cursors from a snapshot', async () => {
    const series = await prisma.series.create({
      data: { userId: TEST_USER_ID, title: 'Round-trip' },
    });
    const src = await prisma.seriesSource.create({
      data: {
        seriesId: series.id,
        sourceId: 'suwayomi',
        externalMangaId: '1',
        sourceUrl: 'https://bato.to/title/1-foo',
        sourceTitle: 'Foo',
        lastReadChapter: new Decimal(50),
        latestChapter: new Decimal(100),
      },
    });

    const advance = await advanceCursor(series.id, 3);
    if (!advance.ok) throw new Error('Expected ok');
    const beforeUndo = await prisma.seriesSource.findUniqueOrThrow({ where: { id: src.id } });
    expect(beforeUndo.lastReadChapter.toString()).toBe('53');

    const undo = await setCursor(advance.snapshot);
    if (!undo.ok) throw new Error(`Expected ok, got: ${undo.error}`);
    const afterUndo = await prisma.seriesSource.findUniqueOrThrow({ where: { id: src.id } });
    expect(afterUndo.lastReadChapter.toString()).toBe('50');
  });
});
```

- [ ] **Step 9.4: Run tests — expect RED**

Run: `pnpm --filter @manhwa/web test`
Expected: the 5 new cursor tests fail with "not implemented" (existing 24 still pass).

- [ ] **Step 9.5: Implement `advanceCursor`**

Append to `apps/web/src/app/library/actions.ts`:

```ts
export async function advanceCursor(
  seriesId: string,
  by: number,
): Promise<AdvanceResult | ResolveError> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: 'Not signed in.' };
  if (!Number.isInteger(by) || by <= 0 || by > 1_000) {
    return { ok: false, error: 'Invalid advance step.' };
  }

  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { id: true, userId: true },
  });
  if (!series || series.userId !== session.user.id) {
    return { ok: false, error: 'Cannot advance that series.' };
  }

  const sources = await prisma.seriesSource.findMany({
    where: { seriesId },
    select: { id: true, lastReadChapter: true, latestChapter: true },
  });

  const snapshot: CursorSnapshot = {
    seriesId,
    cursors: sources.map((s) => ({
      seriesSourceId: s.id,
      lastReadChapter: s.lastReadChapter.toString(),
    })),
  };

  await prisma.$transaction(
    sources.map((s) => {
      const candidate = s.lastReadChapter.plus(by);
      const capped =
        s.latestChapter && candidate.greaterThan(s.latestChapter) ? s.latestChapter : candidate;
      return prisma.seriesSource.update({
        where: { id: s.id },
        data: { lastReadChapter: capped },
      });
    }),
  );

  revalidatePath('/library');
  return { ok: true, snapshot };
}
```

- [ ] **Step 9.6: Implement `setCursor`**

Append to `apps/web/src/app/library/actions.ts`:

```ts
export async function setCursor(snapshot: CursorSnapshot): Promise<SetCursorResult | ResolveError> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: 'Not signed in.' };

  const series = await prisma.series.findUnique({
    where: { id: snapshot.seriesId },
    select: { id: true, userId: true },
  });
  if (!series || series.userId !== session.user.id) {
    return { ok: false, error: 'Cannot restore that series.' };
  }

  // Verify every targeted source belongs to that series, to prevent crafted snapshots
  // from updating someone else's data.
  const sourceIds = snapshot.cursors.map((c) => c.seriesSourceId);
  const sources = await prisma.seriesSource.findMany({
    where: { id: { in: sourceIds }, seriesId: snapshot.seriesId },
    select: { id: true },
  });
  if (sources.length !== sourceIds.length) {
    return { ok: false, error: 'Snapshot references unknown sources.' };
  }

  await prisma.$transaction(
    snapshot.cursors.map((c) =>
      prisma.seriesSource.update({
        where: { id: c.seriesSourceId },
        data: { lastReadChapter: new Decimal(c.lastReadChapter) },
      }),
    ),
  );

  revalidatePath('/library');
  return { ok: true };
}
```

- [ ] **Step 9.7: Run tests — expect GREEN**

Run: `pnpm --filter @manhwa/web test`
Expected: 29/29 pass (24 + 5 new).

- [ ] **Step 9.8: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors across all packages.

- [ ] **Step 9.9: Commit**

```
git add apps/web
git commit -m "feat(web): advanceCursor + setCursor server actions with snapshot-based undo"
```

---

## Task 10: Web — `+1 read` button on `SeriesCard` with undo toast

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\src\app\library\_components\series-card.tsx`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\src\app\library\_components\series-card-actions.tsx`

The card itself stays a server component (no React state). The button + toast logic lifts into a small client component that the card renders.

- [ ] **Step 10.1: Write `series-card-actions.tsx`**

```tsx
'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { advanceCursor, setCursor } from '../actions';

interface Props {
  seriesId: string;
  unread: number;
}

export function SeriesCardActions({ seriesId, unread }: Props) {
  const [pending, startTransition] = useTransition();

  function handleAdvance() {
    if (unread <= 0) return;
    startTransition(async () => {
      const result = await advanceCursor(seriesId, 1);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const snapshot = result.snapshot;
      toast.success('Marked 1 chapter read', {
        duration: 5_000,
        action: {
          label: 'Undo',
          onClick: () => {
            startTransition(async () => {
              const undo = await setCursor(snapshot);
              if (!undo.ok) toast.error(undo.error);
            });
          },
        },
      });
    });
  }

  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={handleAdvance}
      disabled={pending || unread <= 0}
      aria-label="Mark one chapter read"
    >
      <Plus className="mr-1 h-4 w-4" />
      Read 1
    </Button>
  );
}
```

- [ ] **Step 10.2: Wire it into `series-card.tsx`**

Replace `apps/web/src/app/library/_components/series-card.tsx`. The diff is: add an import for `SeriesCardActions` and render it next to the unread badge.

```tsx
import { Decimal } from '@manhwa/db';
import { Card, CardContent } from '@/components/ui/card';
import { SeriesCardActions } from './series-card-actions';

export interface SeriesCardData {
  id: string;
  title: string;
  coverUrl: string | null;
  sources: {
    id: string;
    sourceId: string;
    sourceUrl: string;
    lastReadChapter: Decimal;
    latestChapter: Decimal | null;
  }[];
}

function unreadFor(source: SeriesCardData['sources'][number]): number {
  if (!source.latestChapter) return 0;
  const diff = source.latestChapter.minus(source.lastReadChapter);
  return diff.greaterThan(0) ? diff.toNumber() : 0;
}

function maxUnread(series: SeriesCardData): number {
  return series.sources.reduce((max, s) => Math.max(max, unreadFor(s)), 0);
}

export function SeriesCard({ series }: { series: SeriesCardData }) {
  const unread = maxUnread(series);
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        {series.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={series.coverUrl}
            alt=""
            className="h-16 w-12 flex-shrink-0 rounded object-cover"
          />
        ) : (
          <div className="h-16 w-12 flex-shrink-0 rounded bg-muted" />
        )}
        <div className="flex-1 min-w-0">
          <h3 className="truncate font-medium">{series.title}</h3>
          <p className="text-xs text-muted-foreground">
            {series.sources.length} source{series.sources.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          {unread > 0 ? (
            <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-primary px-2 text-sm font-semibold text-primary-foreground">
              {unread}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">caught up</span>
          )}
          <SeriesCardActions seriesId={series.id} unread={unread} />
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 10.3: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 10.4: Manual smoke (optional but recommended)**

Start `pnpm dev` in the background. Sign in. If you have a series in your library, you should see a `+ Read 1` button on each card. Clicking it:

1. The unread badge decreases by 1 (or shows "caught up" at 0).
2. A toast appears: "Marked 1 chapter read · Undo" with a 5-second duration.
3. Clicking Undo restores the cursor; the badge returns to its previous value.

If no series exist, add one via the dialog first (Plan 2 flow). The badge will show `0` until the worker polls fresh chapters from Suwayomi — for the smoke test you can manually run `pnpm worker:dev` for ~30s in another terminal to populate `latestChapter`.

- [ ] **Step 10.5: Commit**

```
git add apps/web
git commit -m "feat(web): +1 read button on SeriesCard with 5s undo toast"
```

---

## Task 11: README + Plan 3 acceptance smoke

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\README.md`

- [ ] **Step 11.1: Update README to describe the running worker**

Open `README.md`. In the section that describes daily workflow (the "Daily workflow" or equivalent section established in Plan 2), add or extend with these subsections:

````md
## Running the polling worker

Plan 3 adds a polling worker that fetches new chapters from Suwayomi on an adaptive cadence (2h for active series, 3 days for stale ones, with ±10% jitter) and persists them in the `Chapter` table.

Run alongside `pnpm dev` in a separate terminal:

```bash
pnpm worker:dev
```

Expected output (every 30 seconds):

```
[scheduler] enqueued <N> poll job(s)
[poll] <seriesSourceId> (<extension>) → new=<n> total=<m> nextPollAt=<iso>
```

The worker uses `pg-boss` to persist jobs in the existing Postgres database (in a `pgboss` schema it creates on first run). If you stop the worker mid-job, the job survives the restart.

If pg-boss fails to start on first run with a `pgcrypto` error, enable the extension once:

```bash
docker exec manhwa-postgres psql -U manhwa -d manhwa -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```
````

Also extend the status section (added in Plan 2's README polish commit) to show Plan 3 as shipped — replace the row for Plan 3 with a ✅ and reword the next-milestone note to point at Plan 4 (deployment).

- [ ] **Step 11.2: End-to-end acceptance smoke**

Lightweight version (without a clean-DB reset):

1. Start the worker: `pnpm worker:dev` (leave it running). Observe scheduler ticks + poll lines for every existing SeriesSource.
2. Confirm `Chapter` rows exist: `docker exec manhwa-postgres psql -U manhwa -d manhwa -c "SELECT COUNT(*) FROM \"Chapter\";"`. Should be > 0.
3. Confirm `SeriesSource.lastPolledAt` is populated: `docker exec manhwa-postgres psql -U manhwa -d manhwa -c "SELECT \"sourceUrl\", \"lastPolledAt\", \"lastPollNote\", \"nextPollAt\" FROM \"SeriesSource\" LIMIT 5;"`.
4. Stop the worker (`Ctrl+C`). Confirm the `[worker] shutting down (SIGINT)` line.
5. Add a new SeriesSource via the dialog (Plan 2 flow). Restart the worker; within 30s you should see a `[scheduler] enqueued 1 poll job(s)` line followed by a poll log for the new source. The series card should then show an unread count if `latestChapter > lastReadChapter`.
6. Click `+ Read 1` on the card → unread count drops by 1 → toast appears → click Undo within 5s → unread returns. Don't click Undo on a second test → the toast vanishes after 5s and the advance sticks.
7. Run `pnpm test` → expect all tests pass (Plan 1 + 2 + 3's new tests).
8. Run `pnpm typecheck` → 0 errors.

- [ ] **Step 11.3: Commit**

```
git add README.md
git commit -m "docs: README covers Plan 3 polling worker + status update"
```

---

## Plan 3 acceptance checklist

Before declaring Plan 3 complete, verify each item.

- [ ] `pnpm db:migrate` applies the `chapters_and_poll_state` migration; `\dt` lists `Chapter`; `\d "SeriesSource"` shows `lastPolledAt`, `lastPollNote`, `consecutiveFailures`.
- [ ] `pnpm test` passes — all Plan 1 + Plan 2 + Plan 3 tests (sources package: 39+, web package: 29+).
- [ ] `pnpm typecheck` reports 0 errors across all 4 packages.
- [ ] `pnpm worker:dev` starts cleanly, prints the boot lines, and logs scheduler ticks every 30s.
- [ ] After at least one tick, `SELECT COUNT(*) FROM "Chapter"` is > 0 (assuming there is at least one `SeriesSource` in the library).
- [ ] `SeriesSource.lastPolledAt` is populated after the first poll; `consecutiveFailures` is 0 for a successful poll.
- [ ] Adding a brand-new series via the dialog gets it polled by the worker within ~30s; its unread count reflects real `latestChapter` data from Suwayomi.
- [ ] Pointing a SeriesSource at a non-existent `externalMangaId` (manual SQL or test setup) causes a single failed poll; `consecutiveFailures` increments to 1 and `nextPollAt` is rescheduled with exponential backoff.
- [ ] Two polls for the same series ≥ 30 seconds apart never run concurrently (pg-boss singletonKey or scheduler `running` guard).
- [ ] Concurrent polls for sources on the same extension are gated by `TokenBucket` so successive Suwayomi requests are at least 5 seconds apart.
- [ ] `+ Read 1` button on a card with `unread > 0` advances the cursor for every SeriesSource of that series by 1 (capped at `latestChapter`), and a 5s undo toast appears.
- [ ] Clicking Undo restores the per-source cursors exactly to the pre-advance state.
- [ ] `+ Read 1` is disabled when `unread == 0`.
- [ ] Cross-user advance fails: a user cannot advance the cursor of a series they don't own.
- [ ] The pre-commit hook still blocks fake-secret commits (no regression from Plans 1/2).

When all 14 boxes are ticked, Plan 3 is shippable. Move on to Plan 4 (Fly + Neon deployment, CI/CD, GitHub publishing).
