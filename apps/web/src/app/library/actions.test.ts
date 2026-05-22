import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@manhwa/db';

const TEST_USER_EMAIL = 'actions-test@example.com';
let TEST_USER_ID: string;

vi.mock('../../../auth', () => ({
  auth: vi.fn(async () => ({
    user: { id: TEST_USER_ID, email: TEST_USER_EMAIL, isAdmin: false },
  })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { resolveSeriesByUrl, addSeries } from './actions';

const BATO_URL = 'https://bato.to/title/95390-the-beginning-after-the-end';

async function makeTestUser() {
  return prisma.user.create({ data: { email: TEST_USER_EMAIL } });
}

describe('library actions', () => {
  beforeEach(async () => {
    await prisma.seriesSource.deleteMany({});
    await prisma.series.deleteMany({});
    await prisma.user.deleteMany({});
    const user = await makeTestUser();
    TEST_USER_ID = user.id;
  });
  afterEach(async () => {
    await prisma.seriesSource.deleteMany({});
    await prisma.series.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('resolveSeriesByUrl', () => {
    it('returns ok with a resolved preview for a Bato.to URL', async () => {
      const result = await resolveSeriesByUrl(BATO_URL);
      if (!result.ok) throw new Error(`Expected ok, got error: ${result.error}`);
      expect(result.resolved.sourceId).toBe('suwayomi');
      expect(result.resolved.title.length).toBeGreaterThan(0);
      expect(result.candidateAttachTo).toBeNull();
    }, 30_000);

    it('returns an error result for an unsupported URL', async () => {
      const result = await resolveSeriesByUrl('https://example.com/foo');
      expect(result.ok).toBe(false);
    });

    it('detects a fuzzy-title attach candidate when one exists', async () => {
      const existing = await prisma.series.create({
        data: { userId: TEST_USER_ID, title: 'The Beginning After the End' },
      });
      const result = await resolveSeriesByUrl(BATO_URL);
      if (!result.ok) throw new Error(`Expected ok, got error: ${result.error}`);
      expect(result.candidateAttachTo).not.toBeNull();
      expect(result.candidateAttachTo?.id).toBe(existing.id);
    }, 30_000);
  });

  describe('addSeries', () => {
    it('creates a Series + SeriesSource with cursor=latest when caught-up', async () => {
      const result = await addSeries({ url: BATO_URL, cursorMode: 'caught-up' });
      if (!result.ok) throw new Error(`Expected ok, got error: ${result.error}`);

      const series = await prisma.series.findUniqueOrThrow({
        where: { id: result.seriesId },
        include: { sources: true },
      });
      expect(series.sources.length).toBe(1);
      const src = series.sources[0]!;
      expect(src.lastReadChapter.toString()).toBe(src.latestChapter?.toString());
    }, 30_000);

    it('creates with cursor=0 when from-zero', async () => {
      const result = await addSeries({ url: BATO_URL, cursorMode: 'from-zero' });
      if (!result.ok) throw new Error(`Expected ok, got error: ${result.error}`);
      const series = await prisma.series.findUniqueOrThrow({
        where: { id: result.seriesId },
        include: { sources: true },
      });
      expect(series.sources[0]!.lastReadChapter.toString()).toBe('0');
    }, 30_000);

    it('creates with cursor=N when at-chapter:N', async () => {
      const result = await addSeries({
        url: BATO_URL,
        cursorMode: 'at-chapter',
        atChapter: 42,
      });
      if (!result.ok) throw new Error(`Expected ok, got error: ${result.error}`);
      const series = await prisma.series.findUniqueOrThrow({
        where: { id: result.seriesId },
        include: { sources: true },
      });
      expect(series.sources[0]!.lastReadChapter.toString()).toBe('42');
    }, 30_000);

    it('attaches to an existing series when attachToSeriesId is set', async () => {
      const existing = await prisma.series.create({
        data: { userId: TEST_USER_ID, title: 'Existing series' },
      });
      const result = await addSeries({
        url: BATO_URL,
        cursorMode: 'caught-up',
        attachToSeriesId: existing.id,
      });
      if (!result.ok) throw new Error(`Expected ok, got error: ${result.error}`);
      expect(result.seriesId).toBe(existing.id);
      const sources = await prisma.seriesSource.findMany({ where: { seriesId: existing.id } });
      expect(sources.length).toBe(1);
    }, 30_000);

    it('rejects a NaN or negative atChapter', async () => {
      const naNResult = await addSeries({
        url: BATO_URL,
        cursorMode: 'at-chapter',
        atChapter: Number.NaN,
      });
      expect(naNResult.ok).toBe(false);

      const negResult = await addSeries({
        url: BATO_URL,
        cursorMode: 'at-chapter',
        atChapter: -1,
      });
      expect(negResult.ok).toBe(false);
    }, 30_000);

    it('caps cursor at latestChapter when atChapter overshoots', async () => {
      const result = await addSeries({
        url: BATO_URL,
        cursorMode: 'at-chapter',
        atChapter: 99_999_998, // very large but valid; should be capped
      });
      if (!result.ok) throw new Error(`Expected ok, got error: ${result.error}`);
      const series = await prisma.series.findUniqueOrThrow({
        where: { id: result.seriesId },
        include: { sources: true },
      });
      const src = series.sources[0]!;
      expect(src.lastReadChapter.toString()).toBe(src.latestChapter?.toString());
    }, 30_000);

    it('rejects an unsupported URL', async () => {
      const result = await addSeries({ url: 'https://example.com/foo', cursorMode: 'from-zero' });
      expect(result.ok).toBe(false);
    });
  });
});
