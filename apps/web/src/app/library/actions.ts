'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@manhwa/db';
import { Decimal } from '@manhwa/db';
import { SuwayomiClient, SuwayomiSource, type ResolvedSeries } from '@manhwa/sources';
import { auth } from '../../../auth';
import { titleSimilarity, TITLE_MATCH_THRESHOLD } from '@/lib/series-helpers';

const suwayomi = new SuwayomiSource(
  new SuwayomiClient(process.env.SUWAYOMI_URL ?? 'http://localhost:4567'),
);

export interface ResolveResult {
  ok: true;
  resolved: ResolvedSeries;
  /** Existing logical series in this user's library whose title is a strong fuzzy match. */
  candidateAttachTo: { id: string; title: string; similarity: number } | null;
}

export interface ResolveError {
  ok: false;
  error: string;
}

/**
 * Resolve a source URL via Suwayomi and return a preview (no DB writes).
 * Also detects whether the user already has a similarly-titled series.
 */
export async function resolveSeriesByUrl(url: string): Promise<ResolveResult | ResolveError> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: 'Not signed in.' };

  if (!suwayomi.matches(url)) {
    return { ok: false, error: "This source site isn't supported yet." };
  }

  let resolved: ResolvedSeries;
  try {
    resolved = await suwayomi.resolve(url);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Look for a fuzzy-title match in the user's existing library.
  const userSeries = await prisma.series.findMany({
    where: { userId: session.user.id },
    select: { id: true, title: true },
  });
  let best: { id: string; title: string; similarity: number } | null = null;
  for (const s of userSeries) {
    const sim = titleSimilarity(s.title, resolved.title);
    if (sim >= TITLE_MATCH_THRESHOLD && (best === null || sim > best.similarity)) {
      best = { id: s.id, title: s.title, similarity: sim };
    }
  }

  return { ok: true, resolved, candidateAttachTo: best };
}

export type CursorInitMode = 'caught-up' | 'at-chapter' | 'from-zero';

export interface AddSeriesInput {
  url: string;
  /** When 'at-chapter': the chapter the user is currently at. */
  cursorMode: CursorInitMode;
  atChapter?: number;
  /** Optional: attach to this existing series instead of creating a new one. */
  attachToSeriesId?: string;
}

export interface AddResult {
  ok: true;
  seriesId: string;
}

/**
 * Persist a resolved series (and its source) into the user's library.
 * Re-resolves the URL on the server so a malicious client can't inject fake data.
 */
export async function addSeries(input: AddSeriesInput): Promise<AddResult | ResolveError> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: 'Not signed in.' };

  if (!suwayomi.matches(input.url)) {
    return { ok: false, error: "This source site isn't supported yet." };
  }

  let resolved: ResolvedSeries;
  try {
    resolved = await suwayomi.resolve(input.url);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  let cursor: Decimal;
  switch (input.cursorMode) {
    case 'caught-up':
      cursor = resolved.latestChapter ?? new Decimal(0);
      break;
    case 'at-chapter':
      cursor = new Decimal(input.atChapter ?? 0);
      break;
    case 'from-zero':
      cursor = new Decimal(0);
      break;
  }

  if (input.attachToSeriesId) {
    const target = await prisma.series.findUnique({
      where: { id: input.attachToSeriesId },
      select: { id: true, userId: true },
    });
    if (!target || target.userId !== session.user.id) {
      return { ok: false, error: 'Cannot attach to that series.' };
    }
  }

  const seriesId = await prisma.$transaction(async (tx) => {
    let id = input.attachToSeriesId;
    if (!id) {
      const created = await tx.series.create({
        data: {
          userId: session.user.id,
          title: resolved.title,
          coverUrl: resolved.coverUrl,
        },
        select: { id: true },
      });
      id = created.id;
    }

    await tx.seriesSource.create({
      data: {
        seriesId: id,
        sourceId: resolved.sourceId,
        externalMangaId: resolved.externalMangaId,
        sourceUrl: resolved.sourceUrl,
        sourceTitle: resolved.title,
        lastReadChapter: cursor,
        latestChapter: resolved.latestChapter,
        latestChapterAt: resolved.latestChapterAt,
      },
    });

    return id;
  });

  revalidatePath('/library');
  return { ok: true, seriesId };
}
