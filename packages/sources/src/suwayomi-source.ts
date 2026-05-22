import { Decimal } from '@manhwa/db';
import type { MangaSource, ResolvedSeries } from './types.js';
import { UnknownSourceError, SourceResolveError } from './types.js';
import { findRegistryEntry } from './source-registry.js';
import { canonicalizeUrl } from './url-canonicalize.js';
import { SuwayomiClient } from './suwayomi-client.js';

export class SuwayomiSource implements MangaSource {
  readonly id = 'suwayomi';

  constructor(private readonly client: SuwayomiClient) {}

  matches(url: string): boolean {
    try {
      const { host } = canonicalizeUrl(url);
      return findRegistryEntry(host) !== null;
    } catch {
      return false;
    }
  }

  async resolve(url: string): Promise<ResolvedSeries> {
    const { host, href } = canonicalizeUrl(url);
    const registry = findRegistryEntry(host);
    if (!registry) {
      throw new UnknownSourceError(url);
    }

    const suwayomiSource = await this.client.findSourceByName(registry.extensionName);
    if (!suwayomiSource) {
      throw new SourceResolveError(
        url,
        new Error(
          `Suwayomi extension "${registry.extensionName}" is not installed. Install it via the Suwayomi web UI at the SUWAYOMI_URL, or run \`pnpm worker:install-extensions\` once it's wired up.`,
        ),
      );
    }

    let manga;
    try {
      manga = await this.client.fetchMangaByUrl(suwayomiSource.id, href);
    } catch (cause) {
      throw new SourceResolveError(url, cause);
    }

    const chapters = await this.client.fetchChapters(manga.id);

    let latestChapter: Decimal | null = null;
    let latestChapterAt: Date | null = null;
    const candidates = chapters.filter((ch) => ch.chapterNumber > 0);
    for (const ch of candidates) {
      const dec = new Decimal(ch.chapterNumber);
      if (latestChapter === null || dec.gt(latestChapter)) {
        latestChapter = dec;
        latestChapterAt = ch.uploadDate > 0 ? new Date(ch.uploadDate) : null;
      }
    }

    return {
      sourceId: this.id,
      externalMangaId: manga.id.toString(),
      sourceUrl: manga.realUrl ?? href,
      title: manga.title,
      coverUrl: manga.thumbnailUrl,
      latestChapter,
      latestChapterAt,
    };
  }
}
