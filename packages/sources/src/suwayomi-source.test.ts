import { describe, expect, it } from 'vitest';
import { SuwayomiClient } from './suwayomi-client.js';
import { SuwayomiSource } from './suwayomi-source.js';

const SUWAYOMI_URL = process.env.SUWAYOMI_URL ?? 'http://localhost:4567';
const client = new SuwayomiClient(SUWAYOMI_URL);
const source = new SuwayomiSource(client);

describe('SuwayomiSource', () => {
  describe('matches', () => {
    it('returns true for a known host', () => {
      expect(source.matches('https://bato.to/title/12345-foo')).toBe(true);
    });

    it('returns true for an Asura rebrand host', () => {
      expect(source.matches('https://asuracomic.net/series/foo-abc123')).toBe(true);
    });

    it('returns false for an unknown host', () => {
      expect(source.matches('https://example.com/anything')).toBe(false);
    });

    it('returns false for invalid URLs without throwing', () => {
      expect(source.matches('not a url')).toBe(false);
      expect(source.matches('javascript:alert(1)')).toBe(false);
    });
  });

  describe('resolve', () => {
    it('throws UnknownSourceError on a URL no extension handles', async () => {
      await expect(source.resolve('https://example.com/whatever')).rejects.toThrow();
    });

    // This test makes a real network call. It requires Suwayomi up + Bbato
    // (Bato.To) extension installed (verified in Task 5).
    it('resolves a Bato.to manga URL to a ResolvedSeries', async () => {
      // A reasonably stable, popular manga URL.
      // If this URL 404s when the test runs, substitute any current Bato.to manga URL.
      const url = 'https://bato.to/title/95390-the-beginning-after-the-end';

      const result = await source.resolve(url);
      expect(result.sourceId).toBe('suwayomi');
      expect(result.externalMangaId).toMatch(/^\d+$/);
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.sourceUrl).toMatch(/^https:\/\//);
      expect(result.latestChapter).not.toBeNull();
      expect(Number(result.latestChapter)).toBeGreaterThan(0);
    }, 30_000);

    // Phase-3 test: verifies slug-based title search works end-to-end.
    // Phase 3 extracts the slug from the URL, searches the extension by title text,
    // and matches search results by slug — bypassing the need for a realUrl on search
    // results. The numeric ID in the bato.to URL is not validated by Suwayomi/Bbato;
    // only the slug matters for matching.
    //
    // Note: if the slug is already in Suwayomi's DB cache from a prior browse/search,
    // Phase 2 (DB slug lookup) handles it instead of Phase 3 — both paths converge on
    // the same correct result. Phase 3 is the critical path for truly fresh installs.
    it('resolves a Bato.to URL via slug search (Phase-3 path)', async () => {
      // "Nano Machine" exists in Bbato's catalog (slug: nano-machine).
      // Any plausible numeric ID works — Bbato/Suwayomi match by slug, not bato.to ID.
      const url = 'https://bato.to/title/74789-nano-machine';
      const result = await source.resolve(url);
      expect(result.sourceId).toBe('suwayomi');
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.title).toMatch(/nano machine/i);
      expect(result.latestChapter).not.toBeNull();
      expect(Number(result.latestChapter)).toBeGreaterThan(0);
    }, 45_000);
  });
});
