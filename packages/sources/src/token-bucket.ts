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

  /** Wait (if needed) until the per-key cooldown has elapsed, then record the acquire. */
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
