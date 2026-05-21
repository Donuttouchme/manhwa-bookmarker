# Sources & Add-Series Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Suwayomi-Server-backed source resolution and the add-series flow. By the end of Plan 2, the user can click "Add series", paste a manga URL (we test with Bato.to), see the resolved title / cover / latest-chapter, pick an initial cursor state ("caught up" / "at chapter N" / "from zero"), and the series is persisted in their library and visible (with a snapshot unread count).

**Architecture:** Suwayomi-Server runs as a 4th Docker container. A new shared workspace package `packages/sources` defines the `MangaSource` adapter interface + the day-one `SuwayomiSource` implementation; both `apps/web` and `apps/worker` depend on it. The add-series flow runs as Next.js server actions that call into `packages/sources` directly (no HTTP hop). Schema gains `Series` + `SeriesSource` models. Library page shows real series rows. **No polling yet** — `latestChapter` is captured once at add-time; live updates land in Plan 3.

**Tech Stack (additions on top of Plan 1):** Suwayomi-Server (Kotlin/JVM container, GraphQL API), `undici` (already in Node 20 — no new dep) for HTTP, `string-similarity` (npm package) for fuzzy duplicate-title detection, `decimal.js` via Prisma's `Decimal` type for chapter numbers.

**Out of scope for this plan (intentional):**

- Background polling for new chapters → Plan 3 (`pg-boss`, adaptive cadence, token bucket).
- The `Chapter` model itself → Plan 3.
- Mark-as-read / undo toast / click-to-advance UX → Plan 3.
- Cross-source chapter matching (B-strict from grilling) → never (we're B-pragmatic).
- Custom (non-Suwayomi) scrapers → never on day one; the adapter pattern leaves the door open.
- Deployment / staging / Fly / Neon → Plan 4.
- Email digest / RSS notifications → Plan 4 or later.

**State at start (verified from Plan 1):**

- 20 commits on `main`, HEAD at `2d4071d`.
- Postgres + Mailpit containers running via `docker compose up -d`.
- Single `.env.local` at repo root with real `AUTH_SECRET` + SMTP vars.
- `apps/web` works end-to-end (sign-in → library stub).
- `apps/worker` is a stub printing a banner.
- `packages/db` exports `prisma` singleton + all Auth.js v5 tables + `RateLimitEvent`.
- `pnpm test && pnpm typecheck` is green.

---

## File Structure (new and modified)

```
Manhwa_bookmarker/
├── docker-compose.yml                         # MODIFIED: add suwayomi service
├── .env.example                               # MODIFIED: add SUWAYOMI_URL
├── README.md                                  # MODIFIED in Task 12
├── apps/
│   ├── web/
│   │   ├── auth.ts                            # unchanged
│   │   └── src/
│   │       ├── app/
│   │       │   ├── library/
│   │       │   │   ├── page.tsx               # MODIFIED: list real series
│   │       │   │   └── actions.ts             # NEW: server actions resolve/add
│   │       │   └── library/_components/
│   │       │       ├── add-series-dialog.tsx  # NEW: shadcn Dialog with the form
│   │       │       ├── add-series-form.tsx    # NEW: client form (URL → preview → submit)
│   │       │       └── series-card.tsx        # NEW: row component for a Series
│   │       └── lib/
│   │           └── series-helpers.ts          # NEW: fuzzy duplicate detection, formatting
│   └── worker/
│       ├── package.json                       # MODIFIED: add @manhwa/sources dep
│       └── src/
│           ├── index.ts                       # unchanged (still stub)
│           └── probe.ts                       # NEW: `pnpm worker:probe <url>` CLI
└── packages/
    ├── db/                                    # MODIFIED: schema + migration
    │   └── prisma/
    │       ├── schema.prisma                  # MODIFIED: add Series + SeriesSource
    │       └── migrations/<ts>_series/        # NEW
    └── sources/                               # NEW PACKAGE
        ├── package.json
        ├── tsconfig.json
        ├── vitest.config.ts
        └── src/
            ├── index.ts                       # public exports
            ├── types.ts                       # MangaSource, ResolvedSeries, etc.
            ├── url-canonicalize.ts            # URL normalization helper
            ├── url-canonicalize.test.ts
            ├── suwayomi-client.ts             # HTTP wrapper for Suwayomi GraphQL
            ├── suwayomi-client.test.ts        # against a real local Suwayomi
            ├── suwayomi-source.ts             # implements MangaSource
            ├── suwayomi-source.test.ts
            └── source-registry.ts             # host → extension pkg-name map
```

**Decomposition rationale:** `packages/sources` lives as its own workspace package because both `apps/web` (server actions in the add-series flow) and `apps/worker` (Plan 3's polling) need to import it. Each file inside has one responsibility — types, the URL helper, the HTTP client, the adapter, the host registry. Tests live next to code. The add-series UI is split into a server component (`page.tsx` lists series), a client form component (handles state), and a Dialog wrapper — three small files instead of one 200-line page.

---

## Task 1: Add Suwayomi-Server to docker-compose

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\docker-compose.yml`
- Modify: `D:\Projects\Claude\Manhwa_bookmarker\.env.example`

- [ ] **Step 1.1: Update `docker-compose.yml` to add the suwayomi service**

Add a new service block **after** the `mailpit` service definition, before the `volumes:` block. The full updated file:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: manhwa-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: manhwa
      POSTGRES_PASSWORD: manhwa_dev_password
      POSTGRES_DB: manhwa
    ports:
      - '5432:5432'
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U manhwa -d manhwa']
      interval: 5s
      timeout: 5s
      retries: 5

  mailpit:
    image: axllent/mailpit:latest
    container_name: manhwa-mailpit
    restart: unless-stopped
    ports:
      - '1025:1025'
      - '8025:8025'
    environment:
      MP_MAX_MESSAGES: '5000'
      MP_SMTP_AUTH_ACCEPT_ANY: '1'
      MP_SMTP_AUTH_ALLOW_INSECURE: '1'

  suwayomi:
    image: ghcr.io/suwayomi/suwayomi-server:stable
    container_name: manhwa-suwayomi
    restart: unless-stopped
    ports:
      - '4567:4567'
    volumes:
      - suwayomi-data:/home/suwayomi/.local/share/Tachidesk
    environment:
      BIND_PORT: '4567'
      BIND_IP: '0.0.0.0'
      DOWNLOAD_AS_CBZ: 'false'
      AUTO_DOWNLOAD_CHAPTERS: 'false'

volumes:
  postgres-data:
  suwayomi-data:
```

(Don't touch the existing postgres / mailpit blocks beyond what's needed to make the diff minimal. The new pieces are the `suwayomi` service and the `suwayomi-data` volume.)

- [ ] **Step 1.2: Add `SUWAYOMI_URL` to `.env.example`**

Append a new section to the end of `.env.example` (before the final newline):

```bash
# --- Suwayomi-Server (manga source backend) ---
# Runs in docker-compose; web UI + REST + GraphQL at this URL.
SUWAYOMI_URL="http://localhost:4567"
```

- [ ] **Step 1.3: Add the same line to your local `.env.local`**

Manually append:

```bash
SUWAYOMI_URL="http://localhost:4567"
```

(Not committed — `.env.local` is gitignored.)

- [ ] **Step 1.4: Pull + start the new container**

Run: `docker compose up -d`
Expected: `Container manhwa-suwayomi Started`. On first run, the image pull is ~150 MB and takes ~30s-2m depending on connection.

- [ ] **Step 1.5: Verify Suwayomi is up**

Wait ~30 seconds for the JVM to start. Then:

PowerShell: `(Invoke-WebRequest http://localhost:4567 -UseBasicParsing).StatusCode`
Bash: `curl -s -o /dev/null -w "%{http_code}" http://localhost:4567`
Expected: `200`.

Also verify the GraphQL endpoint responds:

PowerShell: `(Invoke-WebRequest http://localhost:4567/api/graphql -UseBasicParsing -Method POST -Body '{"query":"{ aboutServer { name version } }"}' -ContentType 'application/json').Content`
Bash: `curl -s -X POST http://localhost:4567/api/graphql -H 'content-type: application/json' -d '{"query":"{ aboutServer { name version } }"}'`
Expected: a JSON response containing `"name":"Suwayomi-Server"` and a version string.

If the GraphQL probe returns 404, the Suwayomi version's API path may differ slightly; fall back to `curl -s http://localhost:4567/api/v1/server/about` (the legacy REST endpoint). At least one of the two must respond — report which.

- [ ] **Step 1.6: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add suwayomi-server to docker compose"
```

---

## Task 2: Create `packages/sources` skeleton + types

**Files:**

- Modify: `packages/db/src/index.ts` (re-export `Decimal`)
- Create: `packages/sources/package.json`
- Create: `packages/sources/tsconfig.json`
- Create: `packages/sources/vitest.config.ts`
- Create: `packages/sources/src/index.ts`
- Create: `packages/sources/src/types.ts`

- [ ] **Step 2.0: Re-export `Decimal` from `@manhwa/db`**

`@prisma/client` exposes the `Decimal` class only via the `Prisma` namespace (`Prisma.Decimal`) and via the runtime path `@prisma/client/runtime/library`. To keep the rest of this plan's code idiomatic (`import { Decimal } from '@manhwa/db'`), explicitly re-export it from the db package.

Open `packages/db/src/index.ts`. The current contents (from Plan 1):

```ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export * from '@prisma/client';
```

Append at the bottom:

```ts
export { Decimal } from '@prisma/client/runtime/library';
```

(Don't remove `export * from '@prisma/client'` — that one provides the model types `User`, `Series`, etc. The new line additionally provides the `Decimal` value+type.)

After saving: from project root, `pnpm --filter @manhwa/db typecheck` — expect 0 errors.

- [ ] **Step 2.1: Write `packages/sources/package.json`**

```json
{
  "name": "@manhwa/sources",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "dotenv -e ../../.env.local -- vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@manhwa/db": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.12.7",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2.2: Write `packages/sources/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2.3: Write `packages/sources/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
```

- [ ] **Step 2.4: Write `packages/sources/src/types.ts`**

```ts
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
```

(`Decimal` is re-exported by `@manhwa/db` because `packages/db/src/index.ts` does `export * from '@prisma/client'`.)

- [ ] **Step 2.5: Write `packages/sources/src/index.ts`**

```ts
export * from './types.js';
```

(Just types for now. More exports land in later tasks.)

- [ ] **Step 2.6: Install + verify**

Run: `pnpm install`
Then: `pnpm --filter @manhwa/sources typecheck`
Expected: 0 errors.

- [ ] **Step 2.7: Commit**

```bash
git add packages/sources packages/db/src/index.ts pnpm-lock.yaml
git commit -m "feat(sources): package skeleton + MangaSource interface; re-export Decimal from @manhwa/db"
```

---

## Task 3: URL canonicalization helper (TDD)

**Files:**

- Create: `packages/sources/src/url-canonicalize.ts`
- Create: `packages/sources/src/url-canonicalize.test.ts`

- [ ] **Step 3.1: Write stub for TDD**

`packages/sources/src/url-canonicalize.ts`:

```ts
export interface CanonicalizedUrl {
  /** Lowercased host without port. */
  host: string;
  /** Path + slug (no query string, no trailing slash). */
  path: string;
  /** Reconstructed canonical URL: `https://${host}${path}`. */
  href: string;
}

/**
 * Normalize a source URL so that two URLs that mean the "same manga" produce
 * the same canonical form. Lowercases the host, drops query strings, drops a
 * trailing slash, drops any `:port` if it's the default.
 */
export function canonicalizeUrl(input: string): CanonicalizedUrl {
  throw new Error('not implemented');
}
```

- [ ] **Step 3.2: Write the failing tests**

`packages/sources/src/url-canonicalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalizeUrl } from './url-canonicalize.js';

describe('canonicalizeUrl', () => {
  it('lowercases the host', () => {
    const result = canonicalizeUrl('https://BATO.TO/title/123-foo');
    expect(result.host).toBe('bato.to');
    expect(result.href).toBe('https://bato.to/title/123-foo');
  });

  it('strips query strings', () => {
    const result = canonicalizeUrl('https://bato.to/title/123?utm_source=share');
    expect(result.href).toBe('https://bato.to/title/123');
  });

  it('strips a trailing slash', () => {
    const result = canonicalizeUrl('https://bato.to/title/123/');
    expect(result.path).toBe('/title/123');
    expect(result.href).toBe('https://bato.to/title/123');
  });

  it('preserves a multi-segment path', () => {
    const result = canonicalizeUrl('https://asuracomic.net/series/solo-leveling-aabb');
    expect(result.path).toBe('/series/solo-leveling-aabb');
  });

  it('drops the default https port', () => {
    const result = canonicalizeUrl('https://bato.to:443/title/123');
    expect(result.host).toBe('bato.to');
    expect(result.href).toBe('https://bato.to/title/123');
  });

  it('throws on non-http(s) URLs', () => {
    expect(() => canonicalizeUrl('file:///etc/passwd')).toThrow();
    expect(() => canonicalizeUrl('javascript:alert(1)')).toThrow();
  });

  it('throws on completely invalid URLs', () => {
    expect(() => canonicalizeUrl('not a url')).toThrow();
  });
});
```

- [ ] **Step 3.3: Run failing tests**

Run: `pnpm --filter @manhwa/sources test`
Expected: 7 tests fail with "not implemented" or URL parse errors.

- [ ] **Step 3.4: Implement `canonicalizeUrl`**

Replace `packages/sources/src/url-canonicalize.ts`:

```ts
export interface CanonicalizedUrl {
  host: string;
  path: string;
  href: string;
}

export function canonicalizeUrl(input: string): CanonicalizedUrl {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Only http(s) URLs are supported, got: ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();
  let path = parsed.pathname;
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return {
    host,
    path,
    href: `${parsed.protocol}//${host}${path}`,
  };
}
```

- [ ] **Step 3.5: Run tests — expect pass**

Run: `pnpm --filter @manhwa/sources test`
Expected: 7/7 pass.

- [ ] **Step 3.6: Re-export from `index.ts`**

Append to `packages/sources/src/index.ts`:

```ts
export * from './url-canonicalize.js';
```

(Final content of index.ts is now both exports.)

- [ ] **Step 3.7: Commit**

```bash
git add packages/sources
git commit -m "feat(sources): TDD'd canonicalizeUrl helper"
```

---

## Task 4: Source registry (host → Suwayomi extension package name)

**Files:**

- Create: `packages/sources/src/source-registry.ts`
- Create: `packages/sources/src/source-registry.test.ts`

- [ ] **Step 4.1: Write `packages/sources/src/source-registry.ts`**

```ts
/**
 * Maps source-site hostnames to the Tachiyomi/Suwayomi extension that handles them.
 * The extension `name` is the human-readable name we use to look up the Suwayomi
 * source ID at runtime (via the `aboutSource` GraphQL query).
 *
 * Add a row here when adding a new site we support. The same extension can map
 * to multiple hosts when a site has been rebranded (e.g. AsuraScans → AsuraComic).
 */
export interface SourceRegistryEntry {
  /** Extension name as shown in Suwayomi's source list (e.g. "Bato.To"). */
  extensionName: string;
  /** Hosts the extension recognizes. Lowercased; no port. */
  hosts: readonly string[];
  /** Language code expected by Suwayomi for this source (e.g. "en"). */
  lang: string;
}

export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  {
    extensionName: 'Bato.To',
    hosts: ['bato.to', 'mto.to', 'wto.to', 'hto.to', 'dto.to', 'fto.to', 'jto.to', 'kto.to'],
    lang: 'en',
  },
  {
    extensionName: 'AsuraScans',
    hosts: ['asurascans.com', 'asuracomic.net', 'asura.gg', 'asuratoon.com'],
    lang: 'en',
  },
  {
    extensionName: 'ReaperScans',
    hosts: ['reaperscans.com'],
    lang: 'en',
  },
  {
    extensionName: 'MangaBuddy',
    hosts: ['mangabuddy.com'],
    lang: 'en',
  },
  {
    extensionName: 'Flame Comics',
    hosts: ['flamecomics.xyz', 'flamecomics.com'],
    lang: 'en',
  },
  {
    extensionName: 'Vortex Scans',
    hosts: ['vortexscans.com', 'vortexscans.org'],
    lang: 'en',
  },
];

/** Look up the registry entry for a hostname; null if unknown. */
export function findRegistryEntry(host: string): SourceRegistryEntry | null {
  const lower = host.toLowerCase();
  return SOURCE_REGISTRY.find((e) => e.hosts.includes(lower)) ?? null;
}
```

- [ ] **Step 4.2: Write `packages/sources/src/source-registry.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { findRegistryEntry, SOURCE_REGISTRY } from './source-registry.js';

describe('source registry', () => {
  it('finds Bato.To for bato.to', () => {
    const entry = findRegistryEntry('bato.to');
    expect(entry?.extensionName).toBe('Bato.To');
  });

  it('finds AsuraScans for any of the rebrand hostnames', () => {
    for (const host of ['asurascans.com', 'asuracomic.net', 'asura.gg', 'asuratoon.com']) {
      expect(findRegistryEntry(host)?.extensionName, `host=${host}`).toBe('AsuraScans');
    }
  });

  it('is case-insensitive', () => {
    expect(findRegistryEntry('BATO.TO')?.extensionName).toBe('Bato.To');
  });

  it('returns null for unknown hosts', () => {
    expect(findRegistryEntry('example.com')).toBeNull();
  });

  it('has no duplicate hosts across entries', () => {
    const seen = new Map<string, string>();
    for (const entry of SOURCE_REGISTRY) {
      for (const host of entry.hosts) {
        const lower = host.toLowerCase();
        const existing = seen.get(lower);
        if (existing) {
          throw new Error(`duplicate host ${lower} in ${existing} and ${entry.extensionName}`);
        }
        seen.set(lower, entry.extensionName);
      }
    }
  });
});
```

- [ ] **Step 4.3: Run tests — expect pass on first run**

Run: `pnpm --filter @manhwa/sources test`
Expected: all tests pass (the registry implementation isn't really TDD here — the data is straightforward; the tests guard against drift).

- [ ] **Step 4.4: Re-export from `index.ts`**

Append to `packages/sources/src/index.ts`:

```ts
export * from './source-registry.js';
```

- [ ] **Step 4.5: Commit**

```bash
git add packages/sources
git commit -m "feat(sources): host → extension registry for our 7 sites"
```

---

## Task 5: `SuwayomiClient` — HTTP wrapper for Suwayomi's GraphQL (TDD)

**Files:**

- Create: `packages/sources/src/suwayomi-client.ts`
- Create: `packages/sources/src/suwayomi-client.test.ts`

This task talks to a real Suwayomi instance. **Prerequisite:** Suwayomi container is running (Task 1.4 done).

You also need at least one extension installed in Suwayomi for the integration tests. Task 11 sets up Bato.to programmatically; for now, install one manually before running these tests:

1. Open `http://localhost:4567` in a browser.
2. Click "Extensions" in the left sidebar.
3. In the search box, type `bato`.
4. Click the "Install" button next to "Bato.To" (English).
5. Wait for the install to complete (~10s).

(Yes, this manual step is annoying. Task 11 automates it. We're keeping Task 5 first because the client needs to work before Task 11 can use it.)

- [ ] **Step 5.1: Write client stub**

`packages/sources/src/suwayomi-client.ts`:

```ts
export interface SuwayomiSource {
  /** Suwayomi's internal numeric ID for this installed source. */
  id: string;
  /** Source extension name as shown in the UI, e.g. "Bato.To". */
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
  uploadDate: number; // unix millis
  realUrl: string | null;
}

export class SuwayomiClient {
  constructor(private readonly baseUrl: string) {}

  /** GraphQL POST. Returns parsed `data`, throws if `errors` is non-empty. */
  async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    throw new Error('not implemented');
  }

  /** Lists all installed source extensions. */
  async listSources(): Promise<SuwayomiSource[]> {
    throw new Error('not implemented');
  }

  /** Find an installed source by its display name. Returns null if not installed. */
  async findSourceByName(name: string): Promise<SuwayomiSource | null> {
    throw new Error('not implemented');
  }

  /** Given a source URL, fetch the manga from the source backend. */
  async fetchMangaByUrl(sourceId: string, url: string): Promise<SuwayomiManga> {
    throw new Error('not implemented');
  }

  /** Fetch the chapter list for a manga. */
  async fetchChapters(mangaId: number): Promise<SuwayomiChapter[]> {
    throw new Error('not implemented');
  }
}
```

- [ ] **Step 5.2: Write failing integration tests**

`packages/sources/src/suwayomi-client.test.ts`:

```ts
import { describe, expect, it, beforeAll } from 'vitest';
import { SuwayomiClient } from './suwayomi-client.js';

const SUWAYOMI_URL = process.env.SUWAYOMI_URL ?? 'http://localhost:4567';
const client = new SuwayomiClient(SUWAYOMI_URL);

describe('SuwayomiClient', () => {
  beforeAll(async () => {
    // Sanity probe — fail fast with a useful message if Suwayomi isn't up.
    const res = await fetch(SUWAYOMI_URL).catch((e) => {
      throw new Error(`Cannot reach Suwayomi at ${SUWAYOMI_URL}: ${(e as Error).message}`);
    });
    if (!res.ok) throw new Error(`Suwayomi at ${SUWAYOMI_URL} returned ${res.status}`);
  });

  it('listSources returns at least one source (Bato.To installed manually)', async () => {
    const sources = await client.listSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.name === 'Bato.To')).toBe(true);
  });

  it('findSourceByName returns Bato.To', async () => {
    const source = await client.findSourceByName('Bato.To');
    expect(source).not.toBeNull();
    expect(source?.name).toBe('Bato.To');
    expect(source?.lang).toBe('en');
  });

  it('findSourceByName returns null for an uninstalled name', async () => {
    const source = await client.findSourceByName('ThisExtensionIsNotInstalled12345');
    expect(source).toBeNull();
  });

  it('gql throws on a malformed query', async () => {
    await expect(client.gql('this is not graphql')).rejects.toThrow();
  });
});
```

- [ ] **Step 5.3: Run failing tests**

Run: `pnpm --filter @manhwa/sources test`
Expected: the 4 new tests fail with "not implemented" (existing canonicalize + registry tests still pass).

- [ ] **Step 5.4: Implement `SuwayomiClient`**

Replace `packages/sources/src/suwayomi-client.ts`:

```ts
export interface SuwayomiSource {
  id: string;
  name: string;
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
  uploadDate: number;
  realUrl: string | null;
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

export class SuwayomiClient {
  constructor(private readonly baseUrl: string) {}

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

  async findSourceByName(name: string): Promise<SuwayomiSource | null> {
    const sources = await this.listSources();
    return sources.find((s) => s.name === name) ?? null;
  }

  async fetchMangaByUrl(sourceId: string, url: string): Promise<SuwayomiManga> {
    const data = await this.gql<{ fetchSourceManga: { mangas: SuwayomiManga[] } }>(
      `
      mutation FetchByUrl($input: FetchSourceMangaInput!) {
        fetchSourceManga(input: $input) {
          mangas {
            id
            title
            thumbnailUrl
            realUrl
          }
        }
      }
    `,
      {
        input: {
          source: sourceId,
          type: 'SEARCH',
          query: url,
          page: 1,
        },
      },
    );
    const manga = data.fetchSourceManga.mangas[0];
    if (!manga) {
      throw new Error(`No manga returned for URL ${url} on source ${sourceId}`);
    }
    return manga;
  }

  async fetchChapters(mangaId: number): Promise<SuwayomiChapter[]> {
    const data = await this.gql<{ fetchChapters: { chapters: SuwayomiChapter[] } }>(
      `
      mutation FetchChapters($input: FetchChaptersInput!) {
        fetchChapters(input: $input) {
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
      { input: { mangaId } },
    );
    return data.fetchChapters.chapters;
  }
}
```

Note: Suwayomi's GraphQL schema can shift between versions. If a query fails with a schema error (e.g. unknown field), inspect the schema at runtime by opening `http://localhost:4567/api/graphql` and using the introspection UI, then adjust the query. The shape above matches Suwayomi-Server v1.x stable; if the project uses v2 the field names may differ — flag and adapt.

- [ ] **Step 5.5: Run tests — expect pass**

Run: `pnpm --filter @manhwa/sources test`
Expected: all source tests + the 4 new client tests pass. Run requires Suwayomi up AND Bato.To extension installed.

If tests fail with "No installed source named 'Bato.To'", install it manually per the prerequisite block at the top of this task.

- [ ] **Step 5.6: Re-export from `index.ts`**

Append to `packages/sources/src/index.ts`:

```ts
export * from './suwayomi-client.js';
```

- [ ] **Step 5.7: Commit**

```bash
git add packages/sources
git commit -m "feat(sources): TDD'd SuwayomiClient for GraphQL access"
```

---

## Task 6: `SuwayomiSource` adapter (TDD)

**Files:**

- Create: `packages/sources/src/suwayomi-source.ts`
- Create: `packages/sources/src/suwayomi-source.test.ts`

- [ ] **Step 6.1: Write adapter stub**

`packages/sources/src/suwayomi-source.ts`:

```ts
import { Decimal } from '@manhwa/db';
import type { MangaSource, ResolvedSeries } from './types.js';
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
    throw new Error('not implemented');
  }
}
```

- [ ] **Step 6.2: Write failing tests**

`packages/sources/src/suwayomi-source.test.ts`:

```ts
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
      await expect(source.resolve('https://example.com/whatever')).rejects.toThrow(
        /no source adapter matches/i,
      );
    });

    // This test makes a real network call. It requires Suwayomi up + Bato.To
    // extension installed (see Task 5 prerequisites).
    it('resolves a Bato.to manga URL to a ResolvedSeries', async () => {
      // A stable, known manga: pick something with a long publication history
      // so chapter count is high and unlikely to drop to 0.
      // (If this URL 404s, swap it for any other current Bato.to manga URL.)
      const url = 'https://bato.to/title/95390-the-beginning-after-the-end';

      const result = await source.resolve(url);
      expect(result.sourceId).toBe('suwayomi');
      expect(result.externalMangaId).toMatch(/^\d+$/);
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.sourceUrl).toMatch(/^https:\/\/bato\.to\//);
      expect(result.latestChapter).not.toBeNull();
      // Conservative chapter count: should be at least 1 for any published manga.
      expect(Number(result.latestChapter)).toBeGreaterThan(0);
    }, 30_000); // network call — give it 30s
  });
});
```

- [ ] **Step 6.3: Run failing tests**

Run: `pnpm --filter @manhwa/sources test`
Expected: `matches` tests pass (logic is already implemented); `resolve` tests fail (either "not implemented" or because we haven't wired `UnknownSourceError`).

- [ ] **Step 6.4: Implement `resolve`**

Replace the `resolve` body in `packages/sources/src/suwayomi-source.ts` (keep everything else identical):

```ts
  async resolve(url: string): Promise<ResolvedSeries> {
    const { host, href } = canonicalizeUrl(url);
    const registry = findRegistryEntry(host);
    if (!registry) {
      const { UnknownSourceError } = await import('./types.js');
      throw new UnknownSourceError(url);
    }

    const suwayomiSource = await this.client.findSourceByName(registry.extensionName);
    if (!suwayomiSource) {
      const { SourceResolveError } = await import('./types.js');
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
      const { SourceResolveError } = await import('./types.js');
      throw new SourceResolveError(url, cause);
    }

    const chapters = await this.client.fetchChapters(manga.id);

    let latestChapter: Decimal | null = null;
    let latestChapterAt: Date | null = null;
    for (const ch of chapters) {
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
```

The dynamic `import('./types.js')` for the error classes is to keep error types lazily loadable; static imports also work. Either pattern is fine — adapt if static imports keep the file linearly readable.

(If using static imports, add them at the top:

```ts
import { UnknownSourceError, SourceResolveError } from './types.js';
```

and remove the inline dynamic imports. The static version is cleaner — prefer it.)

- [ ] **Step 6.5: Run tests — expect pass**

Run: `pnpm --filter @manhwa/sources test`
Expected: all tests pass including the network-dependent Bato.to test (requires Suwayomi + Bato.To extension installed).

If the chosen test URL returns a different manga than expected, swap it for any other URL pointing to a Bato.to manga with > 0 chapters.

- [ ] **Step 6.6: Re-export from `index.ts`**

Append to `packages/sources/src/index.ts`:

```ts
export * from './suwayomi-source.js';
```

The final `packages/sources/src/index.ts` should now have 5 export lines (types, url-canonicalize, source-registry, suwayomi-client, suwayomi-source).

- [ ] **Step 6.7: Commit**

```bash
git add packages/sources
git commit -m "feat(sources): SuwayomiSource adapter implementing MangaSource"
```

---

## Task 7: Prisma schema — `Series` + `SeriesSource` models

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Generate: `packages/db/prisma/migrations/<ts>_series/migration.sql`

- [ ] **Step 7.1: Add `Series` and `SeriesSource` models to `schema.prisma`**

Append to `packages/db/prisma/schema.prisma` (after `RateLimitEvent`):

```prisma
// --- Manga library ---

model Series {
  id        String         @id @default(cuid())
  userId    String
  /// User-editable canonical title. Defaults to the first source's title at add time.
  title     String
  coverUrl  String?
  createdAt DateTime       @default(now())
  updatedAt DateTime       @updatedAt

  user    User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  sources SeriesSource[]

  @@index([userId])
  @@index([userId, updatedAt])
}

model SeriesSource {
  id              String   @id @default(cuid())
  seriesId        String
  /// Adapter id; currently always "suwayomi". Future custom scrapers will use other ids.
  sourceId        String
  /// The ID Suwayomi (or future adapter) uses to identify this manga.
  externalMangaId String
  /// Canonicalized URL on the source site (lowercased host, no query, no trailing slash).
  sourceUrl       String
  /// Title as reported by the source at last resolve. May differ from `Series.title`.
  sourceTitle     String
  /// Per-source read cursor. Anything strictly greater than this is unread.
  lastReadChapter Decimal  @default(0) @db.Decimal(10, 2)
  /// Highest known chapter number from this source. Null until first resolve / poll.
  latestChapter   Decimal? @db.Decimal(10, 2)
  /// Release time of the latest chapter, if known.
  latestChapterAt DateTime?
  /// When the polling worker should next fetch. Populated by Plan 3.
  nextPollAt      DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  series Series @relation(fields: [seriesId], references: [id], onDelete: Cascade)

  /// One source attachment per logical (sourceId, externalMangaId) inside a series.
  @@unique([seriesId, sourceId, externalMangaId])
  @@index([seriesId])
  @@index([nextPollAt])
}
```

Also update the `User` model — add the `series` back-relation. Find the existing `User` model and add this line in the relations section (after `sessions Session[]`):

```prisma
  series   Series[]
```

The final `User` model relations block should read:

```prisma
  accounts Account[]
  sessions Session[]
  series   Series[]
```

- [ ] **Step 7.2: Run the migration**

Run from project root: `pnpm db:migrate -- --name series`
Expected: creates a new migration directory `packages/db/prisma/migrations/<timestamp>_series/` with `migration.sql`. Applies it cleanly to the local DB.

- [ ] **Step 7.3: Verify the schema in Postgres**

Run: `docker exec manhwa-postgres psql -U manhwa -d manhwa -c "\dt"`
Expected: now lists `Series` and `SeriesSource` in addition to the prior tables.

Run: `docker exec manhwa-postgres psql -U manhwa -d manhwa -c "\d \"SeriesSource\""`
Expected: shows columns including `lastReadChapter numeric(10,2)`, `latestChapter numeric(10,2)`, `nextPollAt timestamp`.

- [ ] **Step 7.4: Commit**

```bash
git add packages/db
git commit -m "feat(db): Series + SeriesSource models for the manhwa library"
```

---

## Task 8: Worker probe CLI — `pnpm worker:probe <url>`

**Files:**

- Modify: `apps/worker/package.json`
- Create: `apps/worker/src/probe.ts`

- [ ] **Step 8.1: Update `apps/worker/package.json`**

Add `@manhwa/sources` to dependencies and a `probe` script:

```json
{
  "name": "@manhwa/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "dotenv -e ../../.env.local -- tsx watch src/index.ts",
    "start": "dotenv -e ../../.env.local -- tsx src/index.ts",
    "probe": "dotenv -e ../../.env.local -- tsx src/probe.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@manhwa/db": "workspace:*",
    "@manhwa/sources": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.12.7",
    "tsx": "^4.11.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 8.2: Add a root-level `worker:probe` script**

Modify root `package.json`. Find the `"worker:dev"` line and add a new entry right after:

```json
    "worker:probe": "pnpm --filter @manhwa/worker probe",
```

(The root script is a convenience so the user can run `pnpm worker:probe <url>` instead of typing the long form.)

- [ ] **Step 8.3: Write `apps/worker/src/probe.ts`**

```ts
import { SuwayomiClient, SuwayomiSource, UnknownSourceError } from '@manhwa/sources';

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: pnpm worker:probe <manga-url>');
    process.exit(1);
  }

  const suwayomiUrl = process.env.SUWAYOMI_URL;
  if (!suwayomiUrl) {
    console.error('SUWAYOMI_URL is not set. Check your .env.local.');
    process.exit(1);
  }

  const client = new SuwayomiClient(suwayomiUrl);
  const source = new SuwayomiSource(client);

  if (!source.matches(url)) {
    console.error(`No source adapter matches URL: ${url}`);
    console.error('Supported hosts:');
    const { SOURCE_REGISTRY } = await import('@manhwa/sources');
    for (const entry of SOURCE_REGISTRY) {
      console.error(`  - ${entry.extensionName}: ${entry.hosts.join(', ')}`);
    }
    process.exit(2);
  }

  try {
    const resolved = await source.resolve(url);
    console.log(JSON.stringify(resolved, null, 2));
  } catch (err) {
    if (err instanceof UnknownSourceError) {
      console.error('UnknownSourceError:', err.message);
      process.exit(2);
    }
    console.error('Resolve failed:', err);
    process.exit(3);
  }
}

main();
```

- [ ] **Step 8.4: Install + verify**

Run: `pnpm install`
Then run the probe against a Bato.to URL (the Bato.To extension must be installed in Suwayomi — see Task 5):

```bash
pnpm worker:probe https://bato.to/title/95390-the-beginning-after-the-end
```

Expected: prints a JSON object containing `sourceId: "suwayomi"`, a numeric `externalMangaId`, the title, cover URL, and a `latestChapter` value.

If the URL 404s when looked up, substitute any other current Bato.to manga URL.

- [ ] **Step 8.5: Commit**

```bash
git add apps/worker package.json pnpm-lock.yaml
git commit -m "feat(worker): probe CLI for testing source resolution"
```

---

## Task 9: apps/web — server actions for resolve + add series (TDD)

**Files:**

- Modify: `apps/web/package.json` (add `@manhwa/sources` dep + `string-similarity`)
- Create: `apps/web/src/app/library/actions.ts`
- Create: `apps/web/src/app/library/actions.test.ts`
- Create: `apps/web/src/lib/series-helpers.ts`
- Create: `apps/web/src/lib/series-helpers.test.ts`

- [ ] **Step 9.1: Add deps**

Run from project root:

```
pnpm --filter @manhwa/web add @manhwa/sources@workspace:*
pnpm --filter @manhwa/web add string-similarity@^4.0.4
pnpm --filter @manhwa/web add -D @types/string-similarity@^4.0.2
```

- [ ] **Step 9.2: Write `apps/web/src/lib/series-helpers.ts`**

Stub (TDD next):

```ts
import { compareTwoStrings } from 'string-similarity';

/**
 * Score in [0, 1] of how similar two titles are after light normalization.
 * 1 = identical, 0 = unrelated.
 */
export function titleSimilarity(a: string, b: string): number {
  throw new Error('not implemented');
}

/**
 * Threshold above which we suggest "attach to existing" instead of "create new".
 * Empirically: 0.82 keeps "Solo Leveling" vs "Solo Leveling Ragnarok" as different
 * but matches "Bato.To · Solo Leveling" to "Solo Leveling".
 */
export const TITLE_MATCH_THRESHOLD = 0.82;
```

- [ ] **Step 9.3: Write `apps/web/src/lib/series-helpers.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { titleSimilarity, TITLE_MATCH_THRESHOLD } from './series-helpers';

describe('titleSimilarity', () => {
  it('returns 1 for identical titles', () => {
    expect(titleSimilarity('Solo Leveling', 'Solo Leveling')).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(titleSimilarity('Solo Leveling', 'solo leveling')).toBe(1);
  });

  it('ignores leading/trailing whitespace', () => {
    expect(titleSimilarity('  Solo Leveling  ', 'Solo Leveling')).toBe(1);
  });

  it('strips common scanlator prefixes like "Bato.To · "', () => {
    expect(titleSimilarity('Bato.To · Solo Leveling', 'Solo Leveling')).toBeGreaterThanOrEqual(
      TITLE_MATCH_THRESHOLD,
    );
  });

  it('returns a high score for near-matches', () => {
    // Punctuation differences should not tank the score.
    expect(titleSimilarity('Solo Leveling', 'Solo: Leveling')).toBeGreaterThan(0.9);
  });

  it('keeps distinct sequels below the threshold', () => {
    expect(titleSimilarity('Solo Leveling', 'Solo Leveling Ragnarok')).toBeLessThan(
      TITLE_MATCH_THRESHOLD,
    );
  });

  it('returns a low score for unrelated titles', () => {
    expect(titleSimilarity('Solo Leveling', 'Berserk')).toBeLessThan(0.3);
  });
});
```

- [ ] **Step 9.4: Run — expect fail**

Run: `pnpm --filter @manhwa/web test`
Expected: 7 new tests fail with "not implemented" (existing 7 tests still pass).

- [ ] **Step 9.5: Implement `titleSimilarity`**

Replace the body of `apps/web/src/lib/series-helpers.ts`:

```ts
import { compareTwoStrings } from 'string-similarity';

const SCANLATOR_PREFIX = /^[a-z0-9.\-\s]+\s*·\s*/i;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(SCANLATOR_PREFIX, '').trim();
}

export function titleSimilarity(a: string, b: string): number {
  return compareTwoStrings(normalize(a), normalize(b));
}

export const TITLE_MATCH_THRESHOLD = 0.82;
```

- [ ] **Step 9.6: Run — expect 7 helper tests pass**

Run: `pnpm --filter @manhwa/web test`
Expected: all 14 tests pass (7 admin/rate + 7 helper).

If any threshold assertion fails ("near-matches" or "distinct sequels"), the `string-similarity` library's scores are slightly different than expected. Adjust `TITLE_MATCH_THRESHOLD` to whatever value cleanly separates "Solo Leveling vs Bato.To · Solo Leveling" from "Solo Leveling vs Solo Leveling Ragnarok". Document the empirical value in the export comment.

- [ ] **Step 9.7: Write server-actions stub**

`apps/web/src/app/library/actions.ts`:

```ts
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
  throw new Error('not implemented');
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
  throw new Error('not implemented');
}
```

- [ ] **Step 9.8: Write integration tests `apps/web/src/app/library/actions.test.ts`**

These tests hit the real DB + a real Suwayomi (must have Bato.To extension installed). They mock the `auth` import to provide a known userId.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@manhwa/db';

// Mock the Auth.js `auth()` call so tests can act as a known user.
const TEST_USER_EMAIL = 'actions-test@example.com';
let TEST_USER_ID: string;

vi.mock('../../../auth', () => ({
  auth: vi.fn(async () => ({
    user: { id: TEST_USER_ID, email: TEST_USER_EMAIL, isAdmin: false },
  })),
}));

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
      expect(result.candidateAttachTo).toBeNull(); // no existing series for this user
    }, 30_000);

    it('returns an error result for an unsupported URL', async () => {
      const result = await resolveSeriesByUrl('https://example.com/foo');
      expect(result.ok).toBe(false);
    });

    it('detects a fuzzy-title attach candidate when one exists', async () => {
      // Pre-create a series with a similar title.
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

    it('rejects an unsupported URL', async () => {
      const result = await addSeries({ url: 'https://example.com/foo', cursorMode: 'from-zero' });
      expect(result.ok).toBe(false);
    });
  });
});
```

- [ ] **Step 9.9: Run — expect 8 failing**

Run: `pnpm --filter @manhwa/web test`
Expected: 8 new action tests fail with "not implemented" (helper + admin + rate-limit still pass).

- [ ] **Step 9.10: Implement `resolveSeriesByUrl`**

Replace the stub body in `apps/web/src/app/library/actions.ts`:

```ts
export async function resolveSeriesByUrl(url: string): Promise<ResolveResult | ResolveError> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: 'Not signed in.' };

  if (!suwayomi.matches(url)) {
    return { ok: false, error: 'This source site isn’t supported yet.' };
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
```

- [ ] **Step 9.11: Implement `addSeries`**

Append to `apps/web/src/app/library/actions.ts`:

```ts
export async function addSeries(input: AddSeriesInput): Promise<AddResult | ResolveError> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: 'Not signed in.' };

  // Re-resolve server-side to prevent client-side manipulation.
  if (!suwayomi.matches(input.url)) {
    return { ok: false, error: 'This source site isn’t supported yet.' };
  }
  let resolved: ResolvedSeries;
  try {
    resolved = await suwayomi.resolve(input.url);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Compute initial cursor.
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

  // Owner check for attach-to.
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
```

- [ ] **Step 9.12: Run — expect 8/8 action tests pass**

Run: `pnpm --filter @manhwa/web test`
Expected: full suite passes (7 helper, 8 action, 3 admin, 4 rate-limit = 22 tests).

- [ ] **Step 9.13: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): server actions for resolve + add series, with fuzzy-title duplicate detection"
```

---

## Task 10: apps/web — Add-series modal UI

**Files:**

- Create: `apps/web/src/app/library/_components/add-series-dialog.tsx`
- Create: `apps/web/src/app/library/_components/add-series-form.tsx`
- Modify: `apps/web/src/app/library/page.tsx` (add the trigger button)
- Install: shadcn `dialog`, `radio-group`, `sonner` components

- [ ] **Step 10.1: Install shadcn components**

From `apps/web/`:

```
pnpm dlx shadcn@latest add dialog radio-group sonner --yes
```

Expected: creates `src/components/ui/dialog.tsx`, `radio-group.tsx`, `sonner.tsx`.

- [ ] **Step 10.2: Write the form component**

`apps/web/src/app/library/_components/add-series-form.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import { resolveSeriesByUrl, addSeries, type CursorInitMode } from '../actions';
import type { ResolvedSeries } from '@manhwa/sources';

type Phase =
  | { kind: 'input' }
  | {
      kind: 'preview';
      resolved: ResolvedSeries;
      attachCandidate: { id: string; title: string } | null;
    };

export function AddSeriesForm({ onSuccess }: { onSuccess?: () => void }) {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [cursorMode, setCursorMode] = useState<CursorInitMode>('caught-up');
  const [atChapter, setAtChapter] = useState('');
  const [attachToExisting, setAttachToExisting] = useState(true);
  const [pending, startTransition] = useTransition();

  function handleResolve() {
    startTransition(async () => {
      const result = await resolveSeriesByUrl(url);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setPhase({
        kind: 'preview',
        resolved: result.resolved,
        attachCandidate: result.candidateAttachTo
          ? { id: result.candidateAttachTo.id, title: result.candidateAttachTo.title }
          : null,
      });
    });
  }

  function handleAdd() {
    if (phase.kind !== 'preview') return;
    const previewState = phase;
    startTransition(async () => {
      const result = await addSeries({
        url,
        cursorMode,
        atChapter: cursorMode === 'at-chapter' ? Number(atChapter) : undefined,
        attachToSeriesId:
          previewState.attachCandidate && attachToExisting
            ? previewState.attachCandidate.id
            : undefined,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Series added.');
      onSuccess?.();
    });
  }

  if (phase.kind === 'input') {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="add-series-url">Source URL</Label>
          <Input
            id="add-series-url"
            type="url"
            placeholder="https://bato.to/title/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            disabled={pending}
            required
          />
          <p className="text-xs text-muted-foreground">
            Paste the URL of the manga on a supported site (Bato.to, AsuraScans, ReaperScans, …).
          </p>
        </div>
        <Button onClick={handleResolve} disabled={!url || pending} className="w-full">
          {pending ? 'Resolving…' : 'Resolve'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        {phase.resolved.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={phase.resolved.coverUrl} alt="" className="h-32 w-24 rounded object-cover" />
        ) : (
          <div className="h-32 w-24 rounded bg-muted" />
        )}
        <div className="flex-1 space-y-1">
          <h3 className="font-semibold leading-tight">{phase.resolved.title}</h3>
          <p className="text-sm text-muted-foreground">
            Latest chapter:{' '}
            {phase.resolved.latestChapter ? phase.resolved.latestChapter.toString() : 'unknown'}
          </p>
        </div>
      </div>

      {phase.attachCandidate ? (
        <div className="rounded border border-dashed p-3 text-sm">
          <p className="mb-2">
            Looks like <strong>{phase.attachCandidate.title}</strong> from your library. Attach this
            source to it, or create a separate entry?
          </p>
          <RadioGroup
            value={attachToExisting ? 'attach' : 'separate'}
            onValueChange={(v) => setAttachToExisting(v === 'attach')}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="attach-yes" value="attach" />
              <Label htmlFor="attach-yes">Attach to existing</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="attach-no" value="separate" />
              <Label htmlFor="attach-no">Create separate entry</Label>
            </div>
          </RadioGroup>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label>Initial reading progress</Label>
        <RadioGroup value={cursorMode} onValueChange={(v) => setCursorMode(v as CursorInitMode)}>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cursor-caught-up" value="caught-up" />
            <Label htmlFor="cursor-caught-up">I'm caught up</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cursor-at" value="at-chapter" />
            <Label htmlFor="cursor-at">I'm at chapter…</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              className="ml-2 w-24"
              value={atChapter}
              onChange={(e) => setAtChapter(e.target.value)}
              disabled={cursorMode !== 'at-chapter'}
            />
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cursor-zero" value="from-zero" />
            <Label htmlFor="cursor-zero">Start from chapter 1</Label>
          </div>
        </RadioGroup>
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setPhase({ kind: 'input' })} disabled={pending}>
          Back
        </Button>
        <Button onClick={handleAdd} disabled={pending} className="flex-1">
          {pending ? 'Adding…' : 'Add to library'}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 10.3: Write the dialog wrapper**

`apps/web/src/app/library/_components/add-series-dialog.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Plus } from 'lucide-react';
import { AddSeriesForm } from './add-series-form';

export function AddSeriesDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" />
          Add series
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a series</DialogTitle>
          <DialogDescription>
            Paste a source URL. We'll resolve the title and chapter count.
          </DialogDescription>
        </DialogHeader>
        <AddSeriesForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 10.4: Wire `<Toaster />` for sonner**

Modify `apps/web/src/app/layout.tsx`. Add the `Toaster` import + render it inside the body:

```tsx
import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'Manhwa Bookmarker',
  description: 'Track unread chapters across manga/manhwa sites.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 10.5: Add the dialog trigger to the library page header**

Modify `apps/web/src/app/library/page.tsx`. Update the header section to include the dialog (the dialog itself comes from `_components`, which is a Next.js convention for "files in this folder are co-located with the route but not routable"):

```tsx
import { requireUser } from '@/lib/auth-helpers';
import { signOut } from '../../../auth';
import { Button } from '@/components/ui/button';
import { AddSeriesDialog } from './_components/add-series-dialog';

export default async function LibraryPage() {
  const user = await requireUser();

  async function handleSignOut() {
    'use server';
    await signOut({ redirectTo: '/signin' });
  }

  return (
    <main className="container mx-auto flex min-h-screen flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="flex items-center gap-3">
          <AddSeriesDialog />
          <span className="text-sm text-muted-foreground">
            {user.email}
            {user.isAdmin ? ' · admin' : ''}
          </span>
          <form action={handleSignOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <section className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-muted-foreground">
          Your library is empty. Click "Add series" to add your first one.
        </p>
      </section>
    </main>
  );
}
```

(The placeholder section will be replaced with a real list in Task 11.)

- [ ] **Step 10.6: Smoke verify**

Start the dev server in the background, sign in, click "Add series", paste a Bato.to URL, hit Resolve, see the preview, pick a cursor state, click "Add to library". Toast should say "Series added." The dialog closes.

(You can't actually click in a real browser. To verify the page renders, curl http://localhost:3000/library with a valid session cookie and grep for `Add series` in the HTML.)

Then verify the DB:

```bash
docker exec manhwa-postgres psql -U manhwa -d manhwa -c "SELECT id, title FROM \"Series\";"
```

Expected: row(s) added.

- [ ] **Step 10.7: Commit**

```bash
git add apps/web
git commit -m "feat(web): add-series modal with URL resolution + cursor state"
```

---

## Task 11: apps/web — Library page shows real series

**Files:**

- Create: `apps/web/src/app/library/_components/series-card.tsx`
- Modify: `apps/web/src/app/library/page.tsx`

- [ ] **Step 11.1: Write `series-card.tsx`**

```tsx
import { Decimal } from '@manhwa/db';
import { Card, CardContent } from '@/components/ui/card';

export interface SeriesCardData {
  id: string;
  title: string;
  coverUrl: string | null;
  sources: {
    id: string;
    sourceId: string;
    sourceUrl: string;
    lastReadChapter: Decimal;
    latestChapter: Decimal | null;
  }[];
}

function unreadFor(source: SeriesCardData['sources'][number]): number {
  if (!source.latestChapter) return 0;
  const diff = source.latestChapter.minus(source.lastReadChapter);
  return diff.greaterThan(0) ? diff.toNumber() : 0;
}

function maxUnread(series: SeriesCardData): number {
  return series.sources.reduce((max, s) => Math.max(max, unreadFor(s)), 0);
}

export function SeriesCard({ series }: { series: SeriesCardData }) {
  const unread = maxUnread(series);
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        {series.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={series.coverUrl}
            alt=""
            className="h-16 w-12 flex-shrink-0 rounded object-cover"
          />
        ) : (
          <div className="h-16 w-12 flex-shrink-0 rounded bg-muted" />
        )}
        <div className="flex-1 min-w-0">
          <h3 className="truncate font-medium">{series.title}</h3>
          <p className="text-xs text-muted-foreground">
            {series.sources.length} source{series.sources.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex-shrink-0">
          {unread > 0 ? (
            <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-primary px-2 text-sm font-semibold text-primary-foreground">
              {unread}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">caught up</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 11.2: Update library/page.tsx to query + render series**

```tsx
import { requireUser } from '@/lib/auth-helpers';
import { signOut } from '../../../auth';
import { Button } from '@/components/ui/button';
import { prisma } from '@manhwa/db';
import { AddSeriesDialog } from './_components/add-series-dialog';
import { SeriesCard } from './_components/series-card';

export default async function LibraryPage() {
  const user = await requireUser();

  async function handleSignOut() {
    'use server';
    await signOut({ redirectTo: '/signin' });
  }

  const seriesRows = await prisma.series.findMany({
    where: { userId: user.id },
    include: {
      sources: {
        select: {
          id: true,
          sourceId: true,
          sourceUrl: true,
          lastReadChapter: true,
          latestChapter: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Sort by max-unread DESC (in-memory; small N for hobby use).
  const sorted = seriesRows.slice().sort((a, b) => {
    const aMax = Math.max(
      0,
      ...a.sources.map((s) =>
        s.latestChapter ? s.latestChapter.minus(s.lastReadChapter).toNumber() : 0,
      ),
    );
    const bMax = Math.max(
      0,
      ...b.sources.map((s) =>
        s.latestChapter ? s.latestChapter.minus(s.lastReadChapter).toNumber() : 0,
      ),
    );
    return bMax - aMax;
  });

  return (
    <main className="container mx-auto flex min-h-screen flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="flex items-center gap-3">
          <AddSeriesDialog />
          <span className="text-sm text-muted-foreground">
            {user.email}
            {user.isAdmin ? ' · admin' : ''}
          </span>
          <form action={handleSignOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      {sorted.length === 0 ? (
        <section className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">
            Your library is empty. Click "Add series" to add your first one.
          </p>
        </section>
      ) : (
        <section className="space-y-3">
          {sorted.map((series) => (
            <SeriesCard key={series.id} series={series} />
          ))}
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 11.3: Typecheck + manual smoke**

Run: `pnpm --filter @manhwa/web typecheck`
Expected: 0 errors.

Start the dev server, sign in. If you previously added a series in Task 10, it should now render as a card with the unread badge. Add another via the dialog; it should appear immediately (because `revalidatePath('/library')` was called).

- [ ] **Step 11.4: Commit**

```bash
git add apps/web
git commit -m "feat(web): library page renders real series sorted by max-unread"
```

---

## Task 12: Suwayomi extension install helper + README + acceptance smoke

**Files:**

- Create: `apps/worker/src/install-extensions.ts`
- Modify: root `package.json` (add `worker:install-extensions` script)
- Modify: `README.md`

- [ ] **Step 12.1: Write the extension-install helper**

`apps/worker/src/install-extensions.ts`:

```ts
import { SuwayomiClient } from '@manhwa/sources';

interface ExtensionInfo {
  apkName: string;
  name: string;
  installed: boolean;
}

async function fetchAvailableExtensions(client: SuwayomiClient): Promise<ExtensionInfo[]> {
  const data = await client.gql<{ fetchExtensions: { extensions: ExtensionInfo[] } }>(`
    mutation { fetchExtensions { extensions { apkName name installed } } }
  `);
  return data.fetchExtensions.extensions;
}

async function installExtension(client: SuwayomiClient, apkName: string): Promise<void> {
  await client.gql(
    `mutation Install($pkgName: String!) {
      installExternalExtension(input: { extensionPkgName: $pkgName }) { clientMutationId }
    }`,
    { pkgName: apkName },
  );
}

async function main() {
  const suwayomiUrl = process.env.SUWAYOMI_URL ?? 'http://localhost:4567';
  const client = new SuwayomiClient(suwayomiUrl);

  // Hard-coded target list. Matches the SOURCE_REGISTRY in packages/sources.
  const want = ['Bato.To', 'AsuraScans', 'ReaperScans', 'MangaBuddy', 'Flame Comics'];

  console.log(`Fetching available extensions from ${suwayomiUrl}…`);
  const available = await fetchAvailableExtensions(client);
  console.log(`Found ${available.length} available extensions.`);

  for (const targetName of want) {
    const candidates = available.filter((e) => e.name === targetName);
    if (candidates.length === 0) {
      console.warn(`  - ${targetName}: not found in available list, skipping`);
      continue;
    }
    const target = candidates[0]!;
    if (target.installed) {
      console.log(`  - ${targetName}: already installed`);
      continue;
    }
    console.log(`  - ${targetName}: installing (${target.apkName})…`);
    try {
      await installExtension(client, target.apkName);
      console.log(`  - ${targetName}: installed`);
    } catch (err) {
      console.error(`  - ${targetName}: install failed — ${(err as Error).message}`);
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

The exact `fetchExtensions` / `installExternalExtension` mutation names match Suwayomi-Server v1.x. If the Suwayomi instance returns a schema error, open `http://localhost:4567/api/graphql` in a browser, use the GraphiQL UI to find the actual mutation names (likely starts with `fetch` or `install`), and adjust the queries.

Vortex Scans is omitted from the `want` list because there's no maintained Tachiyomi extension by that name; if/when one exists, add it to both `want` and `SOURCE_REGISTRY`.

- [ ] **Step 12.2: Add the root script**

In root `package.json`, add right after `"worker:probe"`:

```json
    "worker:install-extensions": "pnpm --filter @manhwa/worker exec dotenv -e ../../.env.local -- tsx src/install-extensions.ts",
```

- [ ] **Step 12.3: Run the install**

Run: `pnpm worker:install-extensions`
Expected: for each name in the want list, prints either "already installed" or "installing…" + "installed". If any fail, the error is non-fatal (just logged).

Verify in Suwayomi's UI (`http://localhost:4567` → Extensions → tab "Installed") that the expected extensions now appear.

- [ ] **Step 12.4: Update README**

In `README.md`, add a new section **before** "## Daily workflow":

````
## Adding source extensions

Suwayomi needs a Tachiyomi extension installed for each source site you want to track from. Run once after `docker compose up -d`:

```bash
pnpm worker:install-extensions
````

This installs the extensions matching the sources in `packages/sources/src/source-registry.ts` (Bato.To, AsuraScans, ReaperScans, MangaBuddy, Flame Comics). You can also install extensions manually via the Suwayomi web UI at http://localhost:4567.

To verify resolution for a specific URL without going through the UI:

```bash
pnpm worker:probe https://bato.to/title/<slug>
```

````

(The triple-backtick blocks inside the markdown snippet — use quad-backticks for the outer fence when writing this section into the README so the inner blocks parse.)

- [ ] **Step 12.5: End-to-end acceptance smoke**

From a clean DB:

```bash
docker compose down -v
docker compose up -d
# Wait ~30s for Suwayomi to start (JVM cold start)
pnpm install
pnpm db:migrate
pnpm worker:install-extensions
````

Then start `pnpm dev` in the background.

Drive the full flow (using the HTTP-level pattern from Plan 1):

1. Sign in as `first@example.com` via the magic-link flow → land on `/library`.
2. Call `resolveSeriesByUrl('https://bato.to/title/95390-the-beginning-after-the-end')` from a temporary script or directly via the dialog UI. (The dialog can't be driven via curl; for the smoke test, invoke the server action through the page in a browser if available, OR add a one-off test that exercises the action.)
3. Confirm in DB: `SELECT id, title, "coverUrl" FROM "Series";` returns 1 row; `SELECT "sourceUrl", "lastReadChapter", "latestChapter" FROM "SeriesSource";` returns 1 row with matching values.
4. Reload `/library` — the new card appears with the unread badge (or "caught up" if you chose "I'm caught up").
5. Try to add the same URL again with cursorMode='from-zero'. The fuzzy-title check should suggest "attach to existing"; accepting creates a second `SeriesSource` row under the same `Series`.
6. Run `pnpm test` → expect all tests pass (Plan 1's 14 + Plan 2's new tests).
7. Run `pnpm typecheck` → 0 errors.

- [ ] **Step 12.6: Commit**

```bash
git add apps/worker README.md package.json pnpm-lock.yaml
git commit -m "feat(worker): install-extensions helper + README docs"
```

---

## Plan 2 acceptance checklist

Before declaring Plan 2 complete, verify each item. Most have already been exercised in their respective tasks; this list is the gate.

- [ ] `docker compose up -d` brings up Postgres + Mailpit + Suwayomi (4567 reachable, returns 200).
- [ ] `pnpm worker:install-extensions` installs the 5 supported extensions (or reports each as already installed).
- [ ] `pnpm worker:probe https://bato.to/title/...` prints a JSON object with title, latestChapter, and a numeric externalMangaId.
- [ ] `pnpm db:migrate` applies the `series` migration; `\dt` lists `Series` and `SeriesSource`.
- [ ] `pnpm test` passes — Plan 1's 14 tests + Plan 2's new tests (canonicalize + registry + helpers + actions + Suwayomi-client + Suwayomi-source).
- [ ] `pnpm typecheck` reports 0 errors across all 4 packages (db, sources, web, worker).
- [ ] Signed-in user can click "Add series" in the library page.
- [ ] Pasting a supported URL + clicking "Resolve" shows a preview card with cover, title, and latest chapter.
- [ ] Picking "I'm caught up" + clicking "Add to library" creates a `Series` + `SeriesSource` row where `lastReadChapter` equals `latestChapter`.
- [ ] Picking "I'm at chapter 42" creates rows where `lastReadChapter = 42`.
- [ ] Picking "Start from chapter 1" creates rows where `lastReadChapter = 0`.
- [ ] Adding a second URL whose title is a strong fuzzy match for an existing series prompts "attach or separate"; choosing attach creates a second `SeriesSource` under the same `Series`.
- [ ] The library page lists added series as cards, sorted by max-unread DESC, with the badge showing the count (or "caught up").
- [ ] The pre-commit hook still blocks fake-secret commits (no regression from Plan 1).
- [ ] `.env.local` is still gitignored; `SUWAYOMI_URL` is in `.env.example` with a non-secret value.

When all 15 boxes are ticked, Plan 2 is shippable. Move on to Plan 3 (pg-boss polling worker + Chapter model + live unread counts + mark-as-read UX).
