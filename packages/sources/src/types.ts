import type { Decimal } from '@manhwa/db';

/**
 * Result of resolving a source URL to a manga.
 * Snapshot at resolve-time — not kept live.
 */
export interface ResolvedSeries {
  /** Adapter id, e.g. "suwayomi". */
  sourceId: string;
  /** The ID by which the source backend identifies this manga. */
  externalMangaId: string;
  /** Canonical URL on the source site (lowercased host, no query string). */
  sourceUrl: string;
  /** Title as reported by the source. */
  title: string;
  /** Cover image URL (may be null if the source doesn't provide one). */
  coverUrl: string | null;
  /** Highest chapter number observed in the source's chapter list. */
  latestChapter: Decimal | null;
  /** When the latest chapter was released, if known. */
  latestChapterAt: Date | null;
}

/**
 * Contract every source-backend implementation must fulfill.
 * Plan 2 ships exactly one implementation (`SuwayomiSource`); future custom
 * scrapers slot in without changing callers.
 */
export interface MangaSource {
  /** Stable, unique adapter id. */
  readonly id: string;

  /** Does this adapter know how to handle this URL? Pure, synchronous, no I/O. */
  matches(url: string): boolean;

  /** Resolve a source URL to a `ResolvedSeries`. May throw on network/parse errors. */
  resolve(url: string): Promise<ResolvedSeries>;
}

/** Thrown when a URL can't be matched by any registered source. */
export class UnknownSourceError extends Error {
  constructor(public readonly url: string) {
    super(`No source adapter matches URL: ${url}`);
    this.name = 'UnknownSourceError';
  }
}

/** Thrown when the source backend cannot find a manga at the given URL. */
export class SourceResolveError extends Error {
  constructor(
    public readonly url: string,
    cause?: unknown,
  ) {
    super(`Failed to resolve manga at URL: ${url}`);
    this.name = 'SourceResolveError';
    if (cause instanceof Error) this.cause = cause;
  }
}
