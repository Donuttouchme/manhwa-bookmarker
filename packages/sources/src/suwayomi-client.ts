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

export interface SuwayomiSourceInfo {
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

/**
 * Heuristic: given a source URL, extract a search-friendly title string.
 * Strips digit prefixes ("95390-foo" → "foo") and hash suffixes ("foo-aabb1" → "foo"
 * when the trailing token looks like a short alphanumeric hash). Hyphens/underscores
 * become spaces.
 */
function extractTitleSlug(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return '';
  }
  // last non-empty segment
  const segments = path.split('/').filter((s) => s.length > 0);
  let slug = segments[segments.length - 1] ?? '';
  // strip leading "<digits>-"
  slug = slug.replace(/^\d+-/, '');
  // strip trailing "-<short alphanumeric hash>" — only if the trailing token is 4–10 chars
  // and contains at least one digit (heuristic to avoid stripping a real title word)
  slug = slug.replace(/-([a-z0-9]{4,10})$/i, (m, tail) => (/\d/.test(tail) ? '' : m));
  return slug.replace(/[-_]+/g, ' ').trim();
}

/**
 * Canonicalize a URL for host+path matching (strips query, trailing slash, lowercases host).
 * Avoids importing url-canonicalize.ts to prevent circular dependencies.
 */
function canonicalizeForMatch(url: string): string {
  try {
    const u = new URL(url);
    let p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return `${u.hostname.toLowerCase()}${p}`;
  } catch {
    return url.toLowerCase();
  }
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
  async listSources(): Promise<SuwayomiSourceInfo[]> {
    const data = await this.gql<{ sources: { nodes: SuwayomiSourceInfo[] } }>(`
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
  async findSourceByName(name: string): Promise<SuwayomiSourceInfo | null> {
    const sources = await this.listSources();
    return sources.find((s) => s.name === name) ?? null;
  }

  /**
   * Given a source ID and a URL, resolves the manga metadata.
   *
   * Strategy (three-phase):
   *  1. URL-as-SEARCH: pass the full URL as the SEARCH query to the source.
   *     Many extensions recognise a URL string as a direct title lookup (e.g. MangaDex).
   *  2. Internal DB lookup: if phase 1 returns no results (e.g. Bbato only accepts
   *     text title queries), look in Suwayomi's manga database for a manga from this
   *     source whose stored `url` path appears in the requested URL. This succeeds
   *     when the manga was previously browsed/fetched through Suwayomi (e.g. via LATEST
   *     or POPULAR) — Suwayomi caches the full manga record, so we can retrieve it
   *     without hitting the source again.
   *  3. Slug-based title search: if phases 1 and 2 both miss (e.g. the manga has never
   *     been browsed through Suwayomi), extract a human-readable query from the URL slug
   *     (stripping numeric prefixes and hash suffixes), search the source by that text,
   *     and filter results by matching `realUrl`. This handles "fresh" URLs that the user
   *     pastes for the first time.
   *
   * Throws if no phase finds a match.
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

    const firstManga = searchData.fetchSourceManga.mangas[0];
    if (firstManga) {
      return firstManga;
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

    // Phase 3: slug-based title search with URL filter.
    // Extract a human-readable query from the URL slug, search the source by that text,
    // then filter results using two match strategies:
    //   a) realUrl match: some extensions populate realUrl in search results (e.g. when
    //      the manga was previously cached). Match canonical host+path.
    //   b) Internal url slug match: extensions like Bbato return results with a `url`
    //      field like "/manga/the-beginning-after-the-end". The slug of this path
    //      must equal the slug we extracted from the input URL.
    // This handles "fresh" URLs that have never been browsed through Suwayomi before.
    const titleQuery = extractTitleSlug(url);
    const inputSlug = slugSuffix(urlPath);

    if (titleQuery.length > 0) {
      interface SearchWithUrlPayload {
        fetchSourceManga: {
          mangas: Array<RawManga & { url: string }>;
        };
      }

      const phase3Data = await this.gql<SearchWithUrlPayload>(
        `mutation TitleSearch($input: FetchSourceMangaInput!) {
          fetchSourceManga(input: $input) {
            mangas {
              id
              title
              thumbnailUrl
              realUrl
              url
            }
          }
        }`,
        { input: { source: sourceId, type: 'SEARCH', query: titleQuery, page: 1 } },
      );

      const target = canonicalizeForMatch(url);

      const phase3Match = phase3Data.fetchSourceManga.mangas.find((m) => {
        // Strategy a: realUrl match (canonical host+path comparison).
        if (m.realUrl && canonicalizeForMatch(m.realUrl) === target) return true;
        // Strategy b: internal url slug match.
        // e.g. input slug "the-beginning-after-the-end" vs
        //      m.url "/manga/the-beginning-after-the-end" → last segment matches.
        if (m.url && slugSuffix(m.url) === inputSlug) return true;
        return false;
      });

      if (phase3Match) return phase3Match;

      throw new Error(
        `No manga found at URL ${url} via search "${titleQuery}". Got ${phase3Data.fetchSourceManga.mangas.length} search result(s) but none matched the URL.`,
      );
    }

    throw new Error(`Could not resolve URL ${url} via Suwayomi (no usable strategy).`);
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
