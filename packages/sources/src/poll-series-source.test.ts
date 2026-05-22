import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@manhwa/db';
import { pollSeriesSource } from './poll-series-source.js';
import { SuwayomiClient } from './suwayomi-client.js';
import { SuwayomiSource } from './suwayomi-source.js';

const BATO_URL = 'https://bato.to/title/95390-the-beginning-after-the-end';
const TEST_USER_EMAIL = 'poll-test@example.com';

/**
 * Resolve the Bato URL via Suwayomi to get the live internal manga ID.
 * This replaces the old hardcoded externalMangaId: '1' which was only valid
 * on the developer's local Suwayomi instance and breaks on fresh CI instances.
 */
async function resolveExternalMangaId(url: string): Promise<string> {
  const suwayomiUrl = process.env.SUWAYOMI_URL ?? 'http://localhost:4567';
  const client = new SuwayomiClient(suwayomiUrl);
  const source = new SuwayomiSource(client);
  const resolved = await source.resolve(url);
  return resolved.externalMangaId;
}

async function makeUserSeriesAndSource() {
  // Resolve the manga URL dynamically so externalMangaId is the actual Suwayomi
  // internal ID on this instance (not a hardcoded value that breaks on fresh DBs).
  const externalMangaId = await resolveExternalMangaId(BATO_URL);

  const user = await prisma.user.create({ data: { email: TEST_USER_EMAIL } });
  const series = await prisma.series.create({
    data: { userId: user.id, title: 'Placeholder' },
  });
  const source = await prisma.seriesSource.create({
    data: {
      seriesId: series.id,
      sourceId: 'suwayomi',
      externalMangaId,
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
    // Point at an unknown externalMangaId; Suwayomi will fail to fetch chapters.
    const user = await prisma.user.create({ data: { email: TEST_USER_EMAIL } });
    const series = await prisma.series.create({ data: { userId: user.id, title: 'Bad' } });
    const source = await prisma.seriesSource.create({
      data: {
        seriesId: series.id,
        sourceId: 'suwayomi',
        externalMangaId: '999999999',
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
