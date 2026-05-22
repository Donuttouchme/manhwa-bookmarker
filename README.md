# Manhwa Bookmarker

Multi-user web app for tracking unread chapters of mangas/manhwas across multiple source sites.

This repo currently has the **Foundation** (Plan 1), **Sources & Add-Series** (Plan 2), and **Polling Worker** (Plan 3) shipped locally. Plan 4 (Fly + Neon deployment, CI/CD) is next. See `docs/superpowers/plans/`.

## Status

| Feature                                        | State |
| ---------------------------------------------- | ----- |
| Sign-in (magic link)                           | done  |
| Library page with series list                  | done  |
| Add-series flow (URL resolution + cursor init) | done  |
| Polling for new chapters                       | done  |
| Mark-as-read / advance cursor                  | done  |

## Prerequisites

- Node 20+ (see `.nvmrc`)
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker Desktop
- gitleaks on PATH (https://github.com/gitleaks/gitleaks/releases) — or Docker (the pre-commit hook falls back to a containerized gitleaks)

## First-time setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres + Mailpit
pnpm compose:up

# 3. Create your env file and fill in AUTH_SECRET
cp .env.example .env.local
# Edit .env.local and replace AUTH_SECRET with the output of:
#   openssl rand -base64 32
# (or, if openssl is not on PATH:)
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 4. Run the first migration
pnpm db:migrate

# 5. Start the web app (port 3000)
pnpm dev
```

Open http://localhost:3000. You'll be redirected to /signin. Enter your email, then open http://localhost:8025 (Mailpit) to grab the magic link. Click it; you're signed in.

The **first user to register on a fresh database is automatically flagged as admin**.

## Adding source extensions

Suwayomi needs a Tachiyomi extension installed for each source site you want to track from. Run once after `docker compose up -d`:

```bash
pnpm worker:install-extensions
```

This installs the extensions matching the sources in `packages/sources/src/source-registry.ts` (Bbato, Asura Scans, ReaperScans, MangaBuddy, Flame Comics). You can also install extensions manually via the Suwayomi web UI at http://localhost:4567.

To verify resolution for a specific URL without going through the UI:

```bash
pnpm worker:probe https://bato.to/title/<slug>
```

## Running the polling worker

Plan 3 adds a polling worker that fetches new chapters from Suwayomi on an adaptive cadence (2h for active series, 3 days for stale ones, with ±10% jitter) and persists them in the `Chapter` table.

Run alongside `pnpm dev` in a separate terminal:

```bash
pnpm worker:dev
```

Expected output (every 30 seconds):

```
[scheduler] enqueued <N> poll job(s)
[poll] <seriesSourceId> (<extension>) → new=<n> total=<m> nextPollAt=<iso>
```

The worker uses `pg-boss` to persist jobs in the existing Postgres database (in a `pgboss` schema it creates on first run). If you stop the worker mid-job, the job survives the restart.

If pg-boss fails to start on first run with a `pgcrypto` error, enable the extension once:

```bash
docker exec manhwa-postgres psql -U manhwa -d manhwa -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

## Daily workflow

```bash
pnpm compose:up        # if not already running
pnpm dev               # in one terminal
pnpm worker:dev        # in another
```

Reset the local DB to a clean slate:

```bash
pnpm compose:reset && pnpm db:migrate
```

## Testing

```bash
pnpm test         # all packages
pnpm typecheck    # all packages
```

## Project layout

- `apps/web` — Next.js 15 + Auth.js v5 + shadcn/ui
- `apps/worker` — Background worker (pg-boss scheduler + poll handler)
- `packages/db` — Prisma schema + client; the source of truth for the data model

## Security notes

- `.env.local` is gitignored. Never commit it.
- Pre-commit hooks run gitleaks; secret-shaped strings will be blocked.
- Auth-touching code is reviewed by a human, not rubber-stamped from agents.

## License

To be decided by the project owner.

<!-- ci smoke -->
