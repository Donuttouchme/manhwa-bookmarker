/**
 * HTTP wrapper around Suwayomi's GraphQL API.
 *
 * Verified against Suwayomi v2.2.2100. Key v2 schema notes:
 *  - `sources` uses Relay-style connection: `{ nodes: [...] }`
 *  - Source IDs are LongString (serialised as string even though numeric).
 *  - Chapter `uploadDate` is LongString (string of unix millis), not an Int.
 *  - `fetchMangaByUrl` uses `fetchSourceManga` with `type: SEARCH` — v2 has
 *    no direct "fetch by URL" mutation; we search the source for the URL string
 *    and take the first match.
 */

export interface SuwayomiSource {
  /** Suwayomi's internal numeric ID for this installed source. */
  id: string;
  /** Source extension name as shown in the UI, e.g. "MangaDex". */
  name: string;
  /** Language code, e.g. "en". */
  lang: string;
}

export interface SuwayomiManga {
  id: number;
  title: string;
  thumbnailUrl: string | null;
  realUrl: string | null;
}

export interface SuwayomiChapter {
  id: number;
  chapterNumber: number;
  name: string;
  /** Unix milliseconds (parsed from Suwayomi's LongString). */
  uploadDate: number;
  realUrl: string | null;
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

export class SuwayomiClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * Low-level GraphQL POST.
   * Returns the parsed `data` object, or throws if:
   *  - the HTTP response is not 2xx
   *  - the response contains GraphQL `errors`
   *  - the response has no `data`
   */
  async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`Suwayomi GraphQL HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as GqlResponse<T>;
    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join('; ');
      throw new Error(`Suwayomi GraphQL error: ${msg}`);
    }
    if (!json.data) {
      throw new Error('Suwayomi GraphQL returned no data');
    }
    return json.data;
  }

  /**
   * Lists all installed source extensions.
   * Uses the v2 Relay connection: `sources { nodes { id name lang } }`.
   * The "Local source" (id="0") is included.
   */
  async listSources(): Promise<SuwayomiSource[]> {
    const data = await this.gql<{ sources: { nodes: SuwayomiSource[] } }>(`
      query {
        sources {
          nodes {
            id
            name
            lang
          }
        }
      }
    `);
    return data.sources.nodes;
  }

  /**
   * Find an installed source by its display name.
   * Returns null if no source with that name is installed.
   * If multiple sources share the same name (e.g. MangaDex has one per language),
   * returns the first match.
   */
  async findSourceByName(name: string): Promise<SuwayomiSource | null> {
    const sources = await this.listSources();
    return sources.find((s) => s.name === name) ?? null;
  }

  /**
   * Given a source ID and a URL, resolves the manga metadata.
   *
   * Strategy (two-phase):
   *  1. URL-as-SEARCH: pass the full URL as the SEARCH query to the source.
   *     Many extensions recognise a URL string as a direct title lookup (e.g. MangaDex).
   *  2. Internal DB lookup: if phase 1 returns no results (e.g. Bbato only accepts
   *     text title queries), look in Suwayomi's manga database for a manga from this
   *     source whose stored `url` path appears in the requested URL. This succeeds
   *     when the manga was previously browsed/fetched through Suwayomi (e.g. via LATEST
   *     or POPULAR) — Suwayomi caches the full manga record, so we can retrieve it
   *     without hitting the source again.
   *
   * Throws if neither phase finds a match.
   */
  async fetchMangaByUrl(sourceId: string, url: string): Promise<SuwayomiManga> {
    interface RawManga {
      id: number;
      title: string;
      thumbnailUrl: string | null;
      realUrl: string | null;
    }

    // Phase 1: URL-as-SEARCH (works for extensions that recognise URL queries).
    interface SearchPayload {
      fetchSourceManga: {
        mangas: RawManga[];
      };
    }

    const searchData = await this.gql<SearchPayload>(
      `
      mutation FetchByUrl($source: LongString!, $query: String!) {
        fetchSourceManga(input: {
          source: $source
          type: SEARCH
          query: $query
          page: 1
        }) {
          mangas {
            id
            title
            thumbnailUrl
            realUrl
          }
        }
      }
    `,
      { source: sourceId, query: url },
    );

    if (searchData.fetchSourceManga.mangas.length > 0) {
      return searchData.fetchSourceManga.mangas[0];
    }

    // Phase 2: internal DB lookup.
    // Some extensions (e.g. Bbato) use their own slug-based URL format and do not
    // accept full external URLs as search queries.  When Suwayomi has previously
    // fetched a manga from this source (via LATEST/POPULAR/browse), its record is
    // stored in the DB with the extension's own `url` path.  We match that path
    // against the path component of the requested URL.
    const urlPath = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })();

    interface DbPayload {
      mangas: {
        nodes: RawManga[];
      };
    }

    const dbData = await this.gql<DbPayload>(
      `
      query FindMangaBySourceUrl($sourceId: LongString!) {
        mangas(condition: { sourceId: $sourceId }) {
          nodes {
            id
            title
            thumbnailUrl
            realUrl
          }
        }
      }
    `,
      { sourceId },
    );

    // Find a manga whose stored URL path is a suffix of the requested URL path.
    // e.g. stored "/manga/the-beginning-after-the-end" is a suffix of
    // "/title/95390-the-beginning-after-the-end" — both end with the same slug.
    const slugSuffix = (path: string) => {
      // Extract the trailing slug segment (everything after the last hyphen-free prefix).
      // "/title/95390-the-beginning-after-the-end" → "the-beginning-after-the-end"
      // "/manga/the-beginning-after-the-end" → "the-beginning-after-the-end"
      const parts = path.replace(/\/$/, '').split('/');
      const last = parts[parts.length - 1] ?? '';
      // Strip a leading "<digits>-" prefix if present (bato.to /title/ format).
      return last.replace(/^\d+-/, '');
    };

    const requestedSlug = slugSuffix(urlPath);
    const match = dbData.mangas.nodes.find((m) => {
      if (!m.realUrl) {
        // m has no realUrl; it only has the extension-internal url stored in DB.
        // We can't access the `url` field from this query directly — re-query below.
        return false;
      }
      try {
        return slugSuffix(new URL(m.realUrl).pathname) === requestedSlug;
      } catch {
        return false;
      }
    });

    if (match) return match;

    // The DB nodes don't expose `url` in the above query; re-query with url field.
    interface DbPayloadWithUrl {
      mangas: {
        nodes: Array<RawManga & { url: string }>;
      };
    }

    const dbDataWithUrl = await this.gql<DbPayloadWithUrl>(
      `
      query FindMangaBySourceUrlWithPath($sourceId: LongString!) {
        mangas(condition: { sourceId: $sourceId }) {
          nodes {
            id
            title
            thumbnailUrl
            realUrl
            url
          }
        }
      }
    `,
      { sourceId },
    );

    const matchByPath = dbDataWithUrl.mangas.nodes.find((m) => {
      return slugSuffix(m.url) === requestedSlug;
    });

    if (matchByPath) return matchByPath;

    throw new Error(`No manga found for URL "${url}" in source ${sourceId}`);
  }

  /**
   * Fetch the full chapter list for a manga already known to Suwayomi (by its
   * internal integer ID).
   *
   * Suwayomi v2: `fetchChapters(input: { mangaId: Int! })` returns
   * `{ chapters: ChapterType[] }`.  `ChapterType.uploadDate` is a LongString
   * (string representation of unix millis).
   */
  async fetchChapters(mangaId: number): Promise<SuwayomiChapter[]> {
    interface RawChapter {
      id: number;
      chapterNumber: number;
      name: string;
      uploadDate: string; // LongString in v2 (unix millis as string)
      realUrl: string | null;
    }
    interface Payload {
      fetchChapters: {
        chapters: RawChapter[];
      };
    }

    const data = await this.gql<Payload>(
      `
      mutation FetchChapters($mangaId: Int!) {
        fetchChapters(input: { mangaId: $mangaId }) {
          chapters {
            id
            chapterNumber
            name
            uploadDate
            realUrl
          }
        }
      }
    `,
      { mangaId },
    );

    return data.fetchChapters.chapters.map((c) => ({
      id: c.id,
      chapterNumber: c.chapterNumber,
      name: c.name,
      uploadDate: Number(c.uploadDate),
      realUrl: c.realUrl,
    }));
  }
}
