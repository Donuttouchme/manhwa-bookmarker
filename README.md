# Manhwa Bookmarker

Multi-user web app for tracking unread chapters of mangas/manhwas across multiple source sites.

This repo is **Plan 1: Foundation** — the auth + scaffolding shell. Series, sources, polling, and deployment land in later plans. See `docs/superpowers/plans/`.

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

This installs the extensions matching the sources in `packages/sources/src/source-registry.ts` (Bbato, AsuraScans, ReaperScans, MangaBuddy, Flame Comics). You can also install extensions manually via the Suwayomi web UI at http://localhost:4567.

To verify resolution for a specific URL without going through the UI:

```bash
pnpm worker:probe https://bato.to/title/<slug>
```

## Daily workflow

```bash
pnpm compose:up        # if not already running
pnpm dev               # in one terminal
pnpm worker:dev        # in another (stub for now)
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
- `apps/worker` — Background worker (stub; pg-boss polling lands in Plan 3)
- `packages/db` — Prisma schema + client; the source of truth for the data model

## Security notes

- `.env.local` is gitignored. Never commit it.
- Pre-commit hooks run gitleaks; secret-shaped strings will be blocked.
- Auth-touching code is reviewed by a human, not rubber-stamped from agents.

## License

To be decided by the project owner.
