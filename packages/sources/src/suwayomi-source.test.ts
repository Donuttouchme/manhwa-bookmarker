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
  });
});
