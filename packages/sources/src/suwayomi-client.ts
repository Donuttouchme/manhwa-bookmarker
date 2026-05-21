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
   * Given a source ID and a URL, searches the source for that URL and returns
   * the first matching manga's metadata.
   *
   * Suwayomi v2 has no "fetch by URL" mutation; we use `fetchSourceManga` with
   * `type: SEARCH` and pass the URL as the query string, which extensions
   * typically recognise as a direct title lookup.
   *
   * Throws if no manga is returned by the source.
   */
  async fetchMangaByUrl(sourceId: string, url: string): Promise<SuwayomiManga> {
    interface RawManga {
      id: number;
      title: string;
      thumbnailUrl: string | null;
      realUrl: string | null;
    }
    interface Payload {
      fetchSourceManga: {
        mangas: RawManga[];
      };
    }

    const data = await this.gql<Payload>(
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

    const mangas = data.fetchSourceManga.mangas;
    if (mangas.length === 0) {
      throw new Error(`No manga found for URL "${url}" in source ${sourceId}`);
    }
    return mangas[0];
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
