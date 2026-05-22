# Production Deployment Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the local-only Manhwa Bookmarker (Plans 1–3, 51 commits) and ship it as a real public, multi-user web app: code on GitHub with CI, web + worker + Suwayomi on Fly.io, Postgres on Neon, magic-link emails via Resend, Google OAuth as a second sign-in method, and Sentry for error reporting. Three-tier: local (Docker) → staging (Fly+Neon free tiers) → production (same Fly project, separate apps + database).

**Architecture:** The repo is published to GitHub; CI runs tests, typecheck, and gitleaks on every PR. Three Fly apps per environment: `manhwa-web-<env>` (Next.js standalone), `manhwa-worker-<env>` (pg-boss worker), `manhwa-suwayomi-<env>` (Suwayomi-Server with a persistent volume for its chapter cache). The web + worker connect to a Neon Postgres branch; the worker connects to Suwayomi over Fly's private 6PN network (no public Suwayomi port). Auth.js v5 keeps magic-link auth (via Resend SMTP) and adds Google OAuth as a parallel provider. Sentry SDKs in both web + worker capture unhandled errors. Deployment is `git push` on `main` → GitHub Actions runs migrations + deploys to **production**; PRs to `main` auto-deploy to **staging** (so you can click through changes before merging).

**Tech Stack (additions on top of Plans 1+2+3):** Fly.io (`flyctl` CLI), Neon (managed Postgres + branching), Resend (transactional email), Google Cloud (OAuth client), Sentry (`@sentry/nextjs` + `@sentry/node`), Docker (multi-stage builds for the two Node images and the Suwayomi reuse), GitHub Actions (CI + CD). Reuses everything from Plans 1–3: Next.js 15, Prisma, pg-boss, Suwayomi-Server (the official image, not a fork).

**Out of scope for this plan (intentional):**

- Horizontal scaling (multiple worker instances or web replicas): single-instance for both. Plan 5+ if traffic warrants.
- Database read replicas: single Neon branch per env.
- Email digest / RSS / push notifications: still deferred — only the magic-link transactional email lands here.
- Per-user OAuth provider config UI (e.g. "connect Discord"): hard-coded Google in this plan.
- Custom domain: using `fly.dev` subdomains; bring-your-own-domain documented as a future task in the README.
- Cross-region failover: single Fly region per app (closest to user).
- Backup orchestration: relying on Neon's built-in PITR (7-day retention on the free tier).
- Stripe / billing: this is a free hobby app for the user and friends.

**State at start (verified from Plan 3):**

- 51 commits on local `main`, HEAD at `fb8b939` (Plan 3 polish #2).
- `pnpm test && pnpm typecheck` is green (69 tests, 0 type errors).
- Worker, web, sources, db packages all build cleanly.
- Suwayomi extensions (Bbato, Asura Scans, MangaBuddy, Flame Comics) installed in the local Docker Suwayomi; the worker can poll them.
- No remote git remote yet; repo is local-only.

**Three-tier definition for this plan:**

| Tier        | Where          | Database                    | Suwayomi                                | Auth callbacks                         |
| ----------- | -------------- | --------------------------- | --------------------------------------- | -------------------------------------- |
| **local**   | Docker Compose | `manhwa-postgres` container | `manhwa-suwayomi` container             | `http://localhost:3000/*`              |
| **staging** | Fly.io         | Neon `staging` branch       | `manhwa-suwayomi-staging.internal:4567` | `https://manhwa-web-staging.fly.dev/*` |
| **prod**    | Fly.io         | Neon `main` branch          | `manhwa-suwayomi-prod.internal:4567`    | `https://manhwa-web-prod.fly.dev/*`    |

The staging tier is wired up so PRs auto-deploy a preview of the full stack (good for catching env-specific bugs); prod deploys only on merges to `main`.

---

## File Structure (new and modified)

```
Manhwa_bookmarker/
├── .github/                                          # NEW
│   ├── workflows/
│   │   ├── ci.yml                                    # NEW: tests + typecheck + gitleaks on PR + push
│   │   ├── deploy-staging.yml                        # NEW: PRs → fly deploy --app manhwa-*-staging
│   │   └── deploy-prod.yml                           # NEW: push to main → fly deploy --app manhwa-*-prod
│   └── dependabot.yml                                # NEW: npm + github-actions updates weekly
├── .dockerignore                                     # NEW
├── apps/
│   ├── web/
│   │   ├── Dockerfile                                # NEW: multi-stage Next.js standalone build
│   │   ├── fly.staging.toml                          # NEW
│   │   ├── fly.prod.toml                             # NEW
│   │   ├── auth.ts                                   # MODIFIED: + Google provider
│   │   ├── instrumentation.ts                        # NEW: Next.js 15 Sentry init hook
│   │   ├── sentry.client.config.ts                   # NEW
│   │   ├── sentry.server.config.ts                   # NEW
│   │   ├── sentry.edge.config.ts                     # NEW
│   │   ├── next.config.mjs                           # MODIFIED: standalone output + withSentryConfig
│   │   └── package.json                              # MODIFIED: + @sentry/nextjs
│   └── worker/
│       ├── Dockerfile                                # NEW: multi-stage worker build
│       ├── fly.staging.toml                          # NEW
│       ├── fly.prod.toml                             # NEW
│       ├── src/
│       │   ├── sentry.ts                             # NEW: Sentry init for worker
│       │   └── index.ts                              # MODIFIED: + Sentry init + capture
│       └── package.json                              # MODIFIED: + @sentry/node
├── infra/                                            # NEW
│   ├── suwayomi/
│   │   ├── fly.staging.toml                          # NEW: Suwayomi Fly app (staging)
│   │   └── fly.prod.toml                             # NEW
│   └── scripts/
│       └── migrate-prod.sh                           # NEW: prisma migrate deploy wrapper
├── docs/
│   ├── deployment.md                                 # NEW: ops runbook for ongoing operations
│   └── superpowers/plans/2026-05-23-production-deployment.md  # this file
├── README.md                                         # MODIFIED in Task 22
├── LICENSE                                           # NEW: MIT
├── CONTRIBUTING.md                                   # NEW: short contributor guide
└── .env.example                                      # MODIFIED: add Resend + Google + Sentry vars
```

**Decomposition rationale:** Each subsystem gets its own directory (`infra/suwayomi` for the upstream image we just configure, `.github/` for CI/CD, app-specific Dockerfile + fly.toml next to each app). The two Fly toml files per app (`fly.staging.toml`, `fly.prod.toml`) keep config DRY without conditional templating — Fly's CLI accepts `--config <file>` so the per-env file ships verbatim. Auth, Sentry, and Dockerfile changes live inside each app's directory so the web and worker stay independently deployable. The `infra/scripts` directory exists because some operations (running migrations against the prod DB) deserve a single hand-written script rather than inlining into the GitHub Action.

---

## Task 1: Prep repo for public — LICENSE + CONTRIBUTING + .env.example audit

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\LICENSE`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\CONTRIBUTING.md`
- Modify: `D:\Projects\Claude\Manhwa_bookmarker\.env.example`

- [ ] **Step 1.1: Add MIT LICENSE**

`LICENSE`:

```
MIT License

Copyright (c) 2026 Donát Polgár

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 1.2: Add CONTRIBUTING.md**

`CONTRIBUTING.md`:

```md
# Contributing

This is a personal learning project that I happen to develop in public. PRs and issues are welcome but I make no SLA about turnaround.

## Setup

See README.md for the full setup (Docker Compose, pnpm, Suwayomi extensions, etc.).

## Workflow

1. Branch from `main`.
2. Make changes.
3. `pnpm test && pnpm typecheck` must pass locally.
4. Open a PR. CI runs the same checks. PRs auto-deploy to staging — click through your change in the preview before requesting review.
5. Squash-merge to `main` triggers the production deploy.

## Pre-commit

A husky pre-commit hook runs gitleaks (dockerized) + Prettier. Don't bypass with `--no-verify`.
```

- [ ] **Step 1.3: Audit `.env.example` for the new variables**

Open `.env.example`. Append a new section (before the final newline):

```
# --- Magic-link email (production) ---
# Resend SMTP. Sign up at https://resend.com → API Keys → create a key with "Sending access".
# The user portion of EMAIL_FROM must be on a domain you've verified in Resend.
EMAIL_SERVER_HOST="smtp.resend.com"
EMAIL_SERVER_PORT="465"
EMAIL_SERVER_USER="resend"
EMAIL_SERVER_PASSWORD="re_xxxxxxxxxxxxxxxxxxxxxxxx"
EMAIL_FROM="noreply@yourdomain.com"

# --- Google OAuth (production sign-in) ---
# Cloud Console → APIs & Services → Credentials → Create OAuth client → Web application.
# Redirect URI: https://manhwa-web-prod.fly.dev/api/auth/callback/google (+ staging mirror)
AUTH_GOOGLE_ID=""
AUTH_GOOGLE_SECRET=""

# --- Sentry (error reporting) ---
# Get DSN from sentry.io → Settings → Projects → manhwa-web-prod → Client Keys (DSN).
# SENTRY_AUTH_TOKEN is needed only at build time for source-map upload (skip in dev).
NEXT_PUBLIC_SENTRY_DSN=""
SENTRY_DSN=""
SENTRY_AUTH_TOKEN=""
SENTRY_ORG=""
SENTRY_PROJECT=""
```

(Existing `EMAIL_*` block from Plan 1 was a Mailpit reference. Leave Plan 1's block as-is — Mailpit is still used locally. The new block above is the production override and lives in Fly secrets, not in `.env.local`.)

- [ ] **Step 1.4: Commit**

```
git add LICENSE CONTRIBUTING.md .env.example
git commit -m "chore: MIT LICENSE + CONTRIBUTING + env vars for prod"
```

---

## Task 2: Create GitHub repository + initial push

**Files:** None (manual GitHub web + CLI steps)

You'll need a GitHub account (the user has one — `Donuttouchme` per Plan 1's git config).

- [ ] **Step 2.1: Create the repo via `gh` CLI**

```
gh repo create Donuttouchme/manhwa-bookmarker \
  --public \
  --description "Track unread chapters across manga/manhwa aggregator sites. Built with Next.js, Prisma, Suwayomi-Server, pg-boss, Fly.io, Neon." \
  --source=. \
  --remote=origin \
  --push=false
```

Expected: prints `https://github.com/Donuttouchme/manhwa-bookmarker.git`. If `gh` isn't installed, install via `winget install GitHub.cli` (Windows) or follow https://cli.github.com.

If you don't want to use `gh`, create the repo via https://github.com/new (Owner: Donuttouchme, Name: `manhwa-bookmarker`, Public, no README/license/gitignore — we have ours), then locally:

```
git remote add origin git@github.com:Donuttouchme/manhwa-bookmarker.git
```

- [ ] **Step 2.2: Sanity-check the staged commits before pushing**

```
git log --oneline | head -20
```

Confirm 52 commits (51 prior + Task 1's "MIT LICENSE…").

Run `git status` — working tree must be clean.

**Sanity-check gitleaks one more time before pushing publicly:**

```
docker run --rm -v "/d/Projects/Claude/Manhwa_bookmarker:/repo" zricethezav/gitleaks:latest detect --source /repo --no-banner
```

Expected: `no leaks found`. If anything fails, FIX before pushing — once a secret is on a public GitHub remote, even force-pushing later doesn't guarantee removal from forks/caches.

- [ ] **Step 2.3: Push**

```
git push -u origin main
```

Expected: full 52-commit history pushed.

- [ ] **Step 2.4: Verify on GitHub**

Open https://github.com/Donuttouchme/manhwa-bookmarker in a browser. Confirm:

- README renders.
- LICENSE shows "MIT License" in the right sidebar.
- Commit count matches local (`git log --oneline | wc -l`).
- No `.env.local` file is committed (visit the repo file tree).

No commit is needed for Task 2 — the work was setup + push.

---

## Task 3: GitHub Actions CI workflow — tests + typecheck

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\.github\workflows\ci.yml`

This workflow runs on every PR to `main` and every push to any branch except `main` (push to `main` runs the production deploy, which already implies tests passed via the PR check).

- [ ] **Step 3.1: Write the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches-ignore: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: manhwa
          POSTGRES_PASSWORD: manhwa_dev_password
          POSTGRES_DB: manhwa
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U manhwa -d manhwa"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
      suwayomi:
        image: ghcr.io/suwayomi/suwayomi-server:stable
        ports:
          - 4567:4567
        env:
          BIND_PORT: '4567'
          BIND_IP: '0.0.0.0'
          DOWNLOAD_AS_CBZ: 'false'
          AUTO_DOWNLOAD_CHAPTERS: 'false'

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Wait for Suwayomi to boot
        run: |
          for i in $(seq 1 30); do
            if curl -sf http://localhost:4567 > /dev/null; then
              echo "Suwayomi up after ${i}s"
              exit 0
            fi
            sleep 2
          done
          echo "Suwayomi never started" >&2
          exit 1

      - name: Install Suwayomi extensions
        env:
          SUWAYOMI_URL: http://localhost:4567
          DATABASE_URL: postgresql://manhwa:manhwa_dev_password@localhost:5432/manhwa
        run: pnpm worker:install-extensions

      - name: Prisma migrate
        env:
          DATABASE_URL: postgresql://manhwa:manhwa_dev_password@localhost:5432/manhwa
        run: pnpm --filter @manhwa/db exec prisma migrate deploy

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        env:
          DATABASE_URL: postgresql://manhwa:manhwa_dev_password@localhost:5432/manhwa
          SUWAYOMI_URL: http://localhost:4567
          AUTH_SECRET: ci-fake-secret-for-deterministic-tests
          AUTH_URL: http://localhost:3000
          EMAIL_SERVER_HOST: localhost
          EMAIL_SERVER_PORT: '1025'
          EMAIL_SERVER_USER: ci
          EMAIL_SERVER_PASSWORD: ci
          EMAIL_FROM: noreply@ci.invalid
        run: pnpm test
```

The CI runs Postgres + Suwayomi as service containers, installs extensions, applies migrations, then runs typecheck + tests. The `AUTH_SECRET` here is for tests only and is deliberately not secret — tests should not rely on it being unguessable.

- [ ] **Step 3.2: Commit and push**

```
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions for tests + typecheck on PR/push"
git push
```

- [ ] **Step 3.3: Verify CI runs**

Open https://github.com/Donuttouchme/manhwa-bookmarker/actions in a browser. A workflow run should be in progress (or already completed). If it fails:

- **Suwayomi extension install fails:** the CI runs against a fresh Suwayomi every time, so extensions get re-installed. If the Keiyoushi catalog rate-limits or the install action returns a transient error, retry the workflow. If failure is consistent, capture the log and adjust `worker:install-extensions` to be more retry-friendly (out of scope here — open an issue and skip the step temporarily with a Suwayomi extension preinstalled into a custom image, but this is rarely needed).
- **Tests time out:** the network-dependent tests (Bato.to URL resolution) need Suwayomi + extension installed. Verify the boot probe succeeded.
- **Prisma migrate fails:** confirm the schema file is committed and the migration directories are present.

When green, move on.

---

## Task 4: GitHub Actions — gitleaks scan on PR

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\.github\workflows\ci.yml`

- [ ] **Step 4.1: Add a `gitleaks` job to the CI workflow**

Open `.github/workflows/ci.yml`. Add a second job alongside `test:`:

```yaml
gitleaks:
  runs-on: ubuntu-latest
  timeout-minutes: 5
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - name: Gitleaks
      uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The `fetch-depth: 0` is required so gitleaks can scan the full history (not just the PR diff). The action exits non-zero on a leak detection, failing the PR.

The pre-existing local pre-commit hook still runs gitleaks against the staged-only diff (faster, blocks at commit time). CI is the second line of defense.

- [ ] **Step 4.2: Commit + push**

```
git add .github/workflows/ci.yml
git commit -m "ci: add gitleaks scan job"
git push
```

- [ ] **Step 4.3: Verify both jobs run**

In GitHub Actions, the workflow now has two jobs: `test` and `gitleaks`. Both should complete green.

---

## Task 5: Dependabot — npm + github-actions weekly updates

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\.github\dependabot.yml`

- [ ] **Step 5.1: Write the Dependabot config**

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  # npm — root workspace; grouped so we don't get 50 PRs at once
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: '06:00'
      timezone: Europe/Budapest
    open-pull-requests-limit: 5
    groups:
      next:
        patterns: ['next', 'react', 'react-dom', '@types/react*']
      prisma:
        patterns: ['prisma', '@prisma/*']
      auth:
        patterns: ['next-auth', '@auth/*']
      sentry:
        patterns: ['@sentry/*']
      dev-tools:
        patterns: ['typescript', 'tsx', 'vitest', 'prettier', 'lint-staged', 'husky', 'dotenv-cli']

  # GitHub Actions — pinned to SHAs via Renovate later if needed
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
```

The groupings reduce PR churn. Adjust patterns as the dependency tree changes; the goal is "one PR per logically coupled bundle" not "every package separately".

- [ ] **Step 5.2: Commit + push**

```
git add .github/dependabot.yml
git commit -m "ci: dependabot weekly groups for npm + actions"
git push
```

- [ ] **Step 5.3: Verify**

Open https://github.com/Donuttouchme/manhwa-bookmarker/network/updates. Dependabot should report the config as loaded. The first PRs may show up within an hour.

---

## Task 6: Branch protection on `main` (manual GitHub UI)

**Files:** None (web UI configuration; document in deployment.md later)

- [ ] **Step 6.1: Enable branch protection**

Open https://github.com/Donuttouchme/manhwa-bookmarker/settings/branches and click **Add branch ruleset** (or "Add classic branch protection rule" — both work; classic is simpler for a solo repo).

Settings to enable for `main`:

- **Require a pull request before merging** — yes.
  - Required approvals: 0 (you're the sole reviewer; allow self-merge for personal projects).
  - Dismiss stale reviews on new commits: yes.
- **Require status checks to pass** — yes.
  - Add `test` and `gitleaks` to the required-checks list.
  - Require branches to be up to date before merging: yes (forces a rebase on stale PRs).
- **Require conversation resolution** — yes.
- **Do not allow bypassing the above settings** — yes (this prevents accidental direct-pushes to `main` even for the repo owner).

Click **Save** / **Create**.

- [ ] **Step 6.2: Verify by attempting a direct push**

```
echo "# test" >> README.md
git add README.md
git commit -m "test: should be blocked"
git push
```

Expected: rejected with `remote: error: GH006: Protected branch update failed`.

Undo:

```
git reset --hard HEAD~1
```

(Now all changes to `main` must go through a PR.)

No commit is needed for Task 6.

---

## Task 7: Neon Postgres — staging + prod branches

**Files:** None (account setup; document in deployment.md)

Sign up: https://console.neon.tech. Free tier gives 1 project with 10 branches and 0.5 GB storage — enough for staging + prod.

- [ ] **Step 7.1: Create a Neon project**

In the Neon console, click **New Project**.

- Name: `manhwa-bookmarker`
- Postgres version: 16
- Region: pick the closest one to where you'll deploy Fly (e.g. `aws-eu-central-1` if you're in Europe).
- Default branch: `main` — this will be the **prod** DB.

Click **Create project**. Neon shows the connection string for the default branch. Copy it; this is `DATABASE_URL_PROD`. Save it temporarily in a password manager (never in the repo).

- [ ] **Step 7.2: Create a `staging` branch**

In the Neon console, click **Branches** → **Create branch**.

- Branch name: `staging`
- Parent branch: `main` (so staging starts as a snapshot of prod; useful for "did this migration break prod data?" testing).
- Compute size: smallest available (free tier).

Click **Create**. Copy the connection string from the `staging` branch's compute endpoint. This is `DATABASE_URL_STAGING`.

- [ ] **Step 7.3: Test connectivity from local**

```
psql "<DATABASE_URL_STAGING>"
```

Expected: drops into the psql prompt against the staging DB. Type `\q` to exit. Repeat with prod URL to verify.

If `psql` isn't installed locally, use Docker:

```
docker run --rm -it postgres:16-alpine psql "<DATABASE_URL_STAGING>"
```

- [ ] **Step 7.4: Apply migrations to both branches**

The Neon branches are empty Postgres databases. Apply the existing Prisma migrations:

```
DATABASE_URL="<DATABASE_URL_STAGING>" pnpm --filter @manhwa/db exec prisma migrate deploy
DATABASE_URL="<DATABASE_URL_PROD>" pnpm --filter @manhwa/db exec prisma migrate deploy
```

Expected: both runs print `4 migrations applied` (or however many there are; Plans 1+2+3 added 4: initial, series, chapters_and_poll_state, plus any others).

- [ ] **Step 7.5: Add the `pgcrypto` extension to both branches (pg-boss requirement)**

```
psql "<DATABASE_URL_STAGING>" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
psql "<DATABASE_URL_PROD>" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

Expected: `CREATE EXTENSION` (or no-op if already exists).

No commit is needed for Task 7 (account setup + DB migrations only).

---

## Task 8: Resend — domain verification + API key + Auth.js wiring

**Files:** None for the wiring (already done in Plan 1) — but Auth.js uses `EMAIL_SERVER_*` vars that production needs.

Sign up: https://resend.com.

- [ ] **Step 8.1: Verify a sending domain**

Free tier allows sending from `onboarding@resend.dev` immediately, but you cannot send to arbitrary inboxes from that domain (deliverability is bad and Resend rate-limits to your own email). For real magic-link emails to all users, verify a domain you own.

If you don't have a domain yet, use `onboarding@resend.dev` for staging only (you can sign in with your own email). For prod, register a domain (Cloudflare/Porkbun ~$10/yr) — pick a name like `polgar.mail` or whatever you prefer.

To verify a domain:

1. Resend console → **Domains** → **Add Domain** → enter `yourdomain.com`.
2. Resend shows 3 DNS records (SPF, DKIM, optional DMARC). Add them in your DNS host.
3. Wait 5–60 min, then click **Verify**.

If you're sticking with `onboarding@resend.dev` for now, skip this step and set `EMAIL_FROM=onboarding@resend.dev`. Document this as a follow-up task in the README.

- [ ] **Step 8.2: Create an API key**

Resend console → **API Keys** → **Create API Key** → name `manhwa-bookmarker-prod`, permission `Sending access`, domain restriction `Full access` (or restrict to your verified domain). Copy the key — it starts with `re_` and is shown only once. Save in a password manager.

Repeat for staging (create a separate key named `manhwa-bookmarker-staging`).

These keys become `EMAIL_SERVER_PASSWORD` in each environment.

- [ ] **Step 8.3: Verify Auth.js can send via Resend SMTP from local**

(Optional but useful for catching config bugs before deployment.)

In a scratch `.env.local.resend-test` (gitignored):

```
EMAIL_SERVER_HOST=smtp.resend.com
EMAIL_SERVER_PORT=465
EMAIL_SERVER_USER=resend
EMAIL_SERVER_PASSWORD=<your prod key>
EMAIL_FROM=noreply@yourdomain.com
```

Then run a one-shot Node script to test:

```ts
// test-resend.ts (place in repo root, delete after)
import nodemailer from 'nodemailer';
const t = nodemailer.createTransport({
  host: process.env.EMAIL_SERVER_HOST,
  port: Number(process.env.EMAIL_SERVER_PORT),
  secure: true,
  auth: { user: process.env.EMAIL_SERVER_USER, pass: process.env.EMAIL_SERVER_PASSWORD },
});
await t.sendMail({
  from: process.env.EMAIL_FROM,
  to: 'polgar.donat@gmail.com',
  subject: 'Resend probe',
  text: 'If this lands, Resend SMTP is wired correctly.',
});
console.log('sent');
```

```
dotenv -e .env.local.resend-test -- tsx test-resend.ts
```

Expected: `sent`, and the email lands in your inbox within ~30s. Delete `test-resend.ts` and `.env.local.resend-test` after the probe succeeds.

No commit needed for Task 8 (config-only; secrets get added in Fly via Task 17).

---

## Task 9: Google OAuth — Cloud Console client + Auth.js Google provider

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\auth.ts`
- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\auth.config.ts`
- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\src\app\signin\page.tsx`

- [ ] **Step 9.1: Create the OAuth client in Google Cloud Console**

1. Open https://console.cloud.google.com → create a new project named `manhwa-bookmarker` (or reuse an existing personal project).
2. Navigate to **APIs & Services** → **OAuth consent screen** → configure with:
   - User type: **External** (allows any Google user).
   - App name: `Manhwa Bookmarker`.
   - Support email: your email.
   - Add scopes: `openid`, `email`, `profile` (only).
   - Test users: add your own email for "Testing" mode. (Skip publishing for a hobby app — Test mode is fine.)
3. Navigate to **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**:
   - Application type: **Web application**.
   - Name: `manhwa-web-prod`.
   - Authorized redirect URIs:
     - `http://localhost:3000/api/auth/callback/google`
     - `https://manhwa-web-staging.fly.dev/api/auth/callback/google`
     - `https://manhwa-web-prod.fly.dev/api/auth/callback/google`
4. Click **Create**. Copy the **Client ID** and **Client Secret**. Save in a password manager.

These become `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` in each environment.

- [ ] **Step 9.2: Add Google provider to `auth.config.ts`**

Open `apps/web/auth.config.ts`. The current file (from Plan 1) registers Nodemailer. Modify it to add Google.

The Plan 1 file has roughly:

```ts
import type { NextAuthConfig } from 'next-auth';
import Nodemailer from 'next-auth/providers/nodemailer';

export const authConfig: NextAuthConfig = {
  providers: [
    Nodemailer({ ... }),
  ],
  // ... other config
};
```

Add `Google` to the providers:

```ts
import type { NextAuthConfig } from 'next-auth';
import Nodemailer from 'next-auth/providers/nodemailer';
import Google from 'next-auth/providers/google';

export const authConfig: NextAuthConfig = {
  providers: [
    Nodemailer({
      server: {
        host: process.env.EMAIL_SERVER_HOST!,
        port: Number(process.env.EMAIL_SERVER_PORT!),
        auth: {
          user: process.env.EMAIL_SERVER_USER!,
          pass: process.env.EMAIL_SERVER_PASSWORD!,
        },
      },
      from: process.env.EMAIL_FROM!,
    }),
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  pages: { signIn: '/signin' },
  // ... rest of existing config
};
```

(Adapt to whatever the existing structure of your `authConfig` is — only add the `Google({})` block. Don't remove anything from Plan 1.)

- [ ] **Step 9.3: Add the Google button to the sign-in page**

Open `apps/web/src/app/signin/page.tsx`. It currently has a magic-link form. Add a Google button **above** the form.

Read the file first to confirm structure. Then insert (before the existing magic-link form):

```tsx
import { signIn } from '../../../auth';
import { Button } from '@/components/ui/button';

async function googleSignIn() {
  'use server';
  await signIn('google', { redirectTo: '/library' });
}

// inside the JSX, above the magic-link form:
<form action={googleSignIn} className="mb-4">
  <Button type="submit" variant="outline" className="w-full">
    Sign in with Google
  </Button>
</form>
<div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
  <span className="h-px flex-1 bg-border" />
  or
  <span className="h-px flex-1 bg-border" />
</div>
```

(Adapt the JSX placement to where the magic-link form currently lives.)

- [ ] **Step 9.4: Update `.env.local` for local Google testing**

Append to `.env.local` (gitignored):

```
AUTH_GOOGLE_ID="<from Step 9.1>"
AUTH_GOOGLE_SECRET="<from Step 9.1>"
```

- [ ] **Step 9.5: Smoke test locally**

```
pnpm dev
```

Open http://localhost:3000/signin → click "Sign in with Google" → land on Google's consent screen → authorise → redirect back to `/library` signed in. The User row in the DB should have the Google account linked (visible in `Account` table — Auth.js's adapter creates one).

If the Google consent screen errors with `redirect_uri_mismatch`, double-check the Authorized redirect URIs in the Cloud Console match exactly (no trailing slash).

- [ ] **Step 9.6: Typecheck + tests**

```
pnpm typecheck
pnpm test
```

Both must be green (the existing tests don't depend on the Google provider).

- [ ] **Step 9.7: Commit + push (via PR)**

```
git checkout -b oauth-google
git add apps/web
git commit -m "feat(web): Google OAuth provider as a second sign-in option"
git push -u origin oauth-google
```

Open a PR. CI runs. Wait for green. Squash-merge to `main`.

(Subsequent tasks follow this same PR flow but the prompts here will just say "commit" for brevity — you'll push via PRs.)

---

## Task 10: Sentry — web SDK install + config

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\package.json`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\sentry.client.config.ts`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\sentry.server.config.ts`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\sentry.edge.config.ts`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\instrumentation.ts`
- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\next.config.mjs` (or `.ts` / `.js` — whichever exists)

- [ ] **Step 10.1: Create Sentry projects (manual)**

Sign up at https://sentry.io (free tier: 5k errors / mo).

Create an **Organization** if you don't have one (e.g. `donat-polgar-personal`).

Create two projects under that org:

- Platform: **Next.js**, name: `manhwa-web-prod`
- Platform: **Next.js**, name: `manhwa-web-staging`

Sentry shows the DSN for each project — save both. They look like `https://<key>@o<org>.ingest.sentry.io/<project>`.

Also create an **Auth Token** (org-level): https://<org>.sentry.io/settings/auth-tokens → Create New Token → scope `project:releases`, `org:read`. Save the token.

Note the org slug + project slugs (visible in URL).

- [ ] **Step 10.2: Add `@sentry/nextjs`**

From `D:\Projects\Claude\Manhwa_bookmarker`:

```
pnpm --filter @manhwa/web add @sentry/nextjs@^8
```

- [ ] **Step 10.3: Write the three Sentry config files**

`apps/web/sentry.client.config.ts`:

```ts
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  enabled: process.env.NODE_ENV === 'production',
});
```

`apps/web/sentry.server.config.ts`:

```ts
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  enabled: process.env.NODE_ENV === 'production',
});
```

`apps/web/sentry.edge.config.ts`:

```ts
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  enabled: process.env.NODE_ENV === 'production',
});
```

`apps/web/instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export async function onRequestError(
  err: unknown,
  request: {
    path: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
  },
  context: {
    routerKind: 'Pages Router' | 'App Router';
    routePath: string;
    routeType: 'render' | 'route' | 'action' | 'middleware';
  },
): Promise<void> {
  const { captureRequestError } = await import('@sentry/nextjs');
  return captureRequestError(err, request, context);
}
```

- [ ] **Step 10.4: Wrap `next.config.*` with `withSentryConfig`**

Find the existing `apps/web/next.config.mjs` (or `.ts` / `.js`). The current export probably looks like:

```js
const nextConfig = {
  // ... existing config
};
export default nextConfig;
```

Replace with:

```js
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig = {
  output: 'standalone',
  // ... existing config (preserve all of it)
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
});
```

The `output: 'standalone'` is the Next.js standalone build (Task 12 needs this for the Docker image).

- [ ] **Step 10.5: Typecheck**

```
pnpm typecheck
```

If `@sentry/nextjs` types complain about `instrumentation.ts`'s `onRequestError` signature, your @sentry/nextjs version may have a slightly different signature — adapt to whatever the Sentry types say. The captureRequestError import path is `@sentry/nextjs`.

- [ ] **Step 10.6: Smoke test (optional, requires Sentry DSN in `.env.local`)**

Add to `.env.local`:

```
NEXT_PUBLIC_SENTRY_DSN="<staging DSN from Step 10.1>"
SENTRY_DSN="<same as above>"
```

Start dev, deliberately throw in a page:

```tsx
// in some page.tsx, temporarily
throw new Error('Sentry smoke test');
```

Visit the page. Sentry doesn't fire in dev (we gated on `NODE_ENV === 'production'`), so this is just to confirm no compile errors. Remove the throw before committing.

- [ ] **Step 10.7: Commit (via PR)**

```
git checkout -b sentry-web
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): Sentry SDK + instrumentation hooks"
git push -u origin sentry-web
```

PR → CI green → merge.

---

## Task 11: Sentry — worker SDK install + config

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\package.json`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\src\sentry.ts`
- Modify: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\src\index.ts`

- [ ] **Step 11.1: Create the Sentry projects for the worker**

Same flow as Step 10.1: two new Sentry projects:

- Platform: **Node.js**, name: `manhwa-worker-prod`
- Platform: **Node.js**, name: `manhwa-worker-staging`

Save both DSNs.

- [ ] **Step 11.2: Add `@sentry/node`**

```
pnpm --filter @manhwa/worker add @sentry/node@^8
```

- [ ] **Step 11.3: Write `apps/worker/src/sentry.ts`**

```ts
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
const enabled = process.env.NODE_ENV === 'production' && Boolean(dsn);

if (enabled) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.FLY_APP_NAME ?? 'unknown',
  });
}

export { Sentry, enabled as sentryEnabled };
```

(`FLY_APP_NAME` is set automatically by Fly inside each running machine, so Sentry tags errors as `manhwa-worker-staging` or `manhwa-worker-prod` without us threading the env name through.)

- [ ] **Step 11.4: Wire Sentry into `apps/worker/src/index.ts`**

The current Plan 3 entrypoint (after Plan 3 Task 8):

```ts
import { getBoss, POLL_QUEUE, stopBoss } from './boss.js';
import { makePollHandler, type PollJobData } from './poll-handler.js';
import { startScheduler } from './scheduler.js';

async function main() {
  console.log('[worker] starting…');
  // ...
}
main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
```

Modify to capture errors with Sentry:

```ts
import './sentry.js'; // init Sentry before anything else
import { Sentry, sentryEnabled } from './sentry.js';
import { getBoss, POLL_QUEUE, stopBoss } from './boss.js';
import { makePollHandler, type PollJobData } from './poll-handler.js';
import { startScheduler } from './scheduler.js';

async function main() {
  console.log('[worker] starting…');
  const boss = await getBoss();

  await boss.work<PollJobData>(POLL_QUEUE, { batchSize: 1 }, makePollHandler());

  const stopScheduler = startScheduler(boss);
  console.log('[worker] up — scheduler tick every 30s, batchSize 1');

  async function shutdown(reason: string): Promise<void> {
    console.log(`[worker] shutting down (${reason})`);
    stopScheduler();
    await stopBoss();
    if (sentryEnabled) await Sentry.close(5_000);
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  if (sentryEnabled) {
    Sentry.captureException(err);
    void Sentry.flush(5_000).then(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
```

The poll-handler also captures errors. Modify `apps/worker/src/poll-handler.ts` — read the file first; in the existing `catch (err)` block (currently `console.error(...)` + `throw err`), add a Sentry capture line just before the throw:

```ts
} catch (err) {
  console.error(`[poll] ${seriesSourceId} (${key}) → FATAL`, err);
  Sentry.captureException(err, { tags: { seriesSourceId, bucketKey: key } });
  throw err;
}
```

(Import Sentry at the top of poll-handler.ts: `import { Sentry } from './sentry.js';`.)

- [ ] **Step 11.5: Typecheck**

```
pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 11.6: Commit (via PR)**

```
git checkout -b sentry-worker
git add apps/worker pnpm-lock.yaml
git commit -m "feat(worker): Sentry SDK init + capture in entrypoint and poll-handler"
git push -u origin sentry-worker
```

PR → CI green → merge.

---

## Task 12: Web app Dockerfile (multi-stage Next.js standalone)

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\Dockerfile`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\.dockerignore`

The Web image runs the Next.js standalone build under Node 20. Multi-stage to keep the final image small.

- [ ] **Step 12.1: Write `.dockerignore`**

`.dockerignore` (repo root):

```
**/node_modules
**/.next
**/dist
**/.env*
.git
.github
docs
*.md
docker-compose.yml
.husky
.lintstagedrc.json
.gitleaks.toml
```

(Notably we exclude `.env*` so no local secrets leak into images. The image gets all secrets via Fly's runtime injection.)

- [ ] **Step 12.2: Write `apps/web/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20-alpine

# ── Stage 1: deps ────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/sources/package.json packages/sources/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: builder ────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=deps /app /app
COPY . .
# Generate Prisma client (needed at build time for typecheck inside Next)
RUN pnpm --filter @manhwa/db exec prisma generate
# Build the standalone Next.js output
ARG NEXT_PUBLIC_SENTRY_DSN
ARG SENTRY_DSN
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    SENTRY_DSN=$SENTRY_DSN \
    SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN \
    SENTRY_ORG=$SENTRY_ORG \
    SENTRY_PROJECT=$SENTRY_PROJECT \
    CI=true
RUN pnpm --filter @manhwa/web build

# ── Stage 3: runner ────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini && \
    addgroup -S nodejs && adduser -S nextjs -G nodejs
# Standalone build output bundles its own minimal node_modules
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
```

Notes:

- Next.js `output: 'standalone'` (set in Task 10) emits `apps/web/.next/standalone/` which contains a self-sufficient server. The runner stage copies just that + static assets + public.
- `tini` is a tiny init that reaps zombie processes correctly when Node crashes — important for Fly's container lifecycle.
- The `nextjs` user is unprivileged.
- Sentry args are baked at build time so source maps upload during `pnpm build`. Runtime variables are passed by Fly via secrets (Task 17).

- [ ] **Step 12.3: Build locally**

From `D:\Projects\Claude\Manhwa_bookmarker`:

```
docker build -f apps/web/Dockerfile -t manhwa-web:test .
```

Expected: builds successfully in ~3-5 minutes (first time; later builds are faster due to layer cache). Final image size around 200 MB.

- [ ] **Step 12.4: Smoke-run the image**

```
docker run --rm -p 3001:3000 \
  -e DATABASE_URL="<DATABASE_URL_STAGING>" \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e AUTH_URL="http://localhost:3001" \
  -e EMAIL_SERVER_HOST=localhost \
  -e EMAIL_SERVER_PORT=1025 \
  -e EMAIL_SERVER_USER=ci \
  -e EMAIL_SERVER_PASSWORD=ci \
  -e EMAIL_FROM=noreply@invalid \
  manhwa-web:test
```

Open http://localhost:3001 in a browser. The sign-in page should render (you can't actually sign in because the email server is fake — but the app boots).

Stop with Ctrl+C.

- [ ] **Step 12.5: Commit (via PR)**

```
git checkout -b web-dockerfile
git add apps/web/Dockerfile .dockerignore
git commit -m "build(web): multi-stage Dockerfile for Next.js standalone"
git push -u origin web-dockerfile
```

PR → CI green → merge.

---

## Task 13: Worker Dockerfile

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\Dockerfile`

The Worker image runs the tsx-based worker directly (no compile step — the worker is small enough that tsx-runtime is fine).

- [ ] **Step 13.1: Write `apps/worker/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20-alpine

# ── Stage 1: deps ────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/sources/package.json packages/sources/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @manhwa/worker... --filter @manhwa/db --filter @manhwa/sources

# ── Stage 2: prisma client generation ────────────────────────────
FROM deps AS prisma
COPY packages/db/prisma/ packages/db/prisma/
RUN pnpm --filter @manhwa/db exec prisma generate

# ── Stage 3: runner ─────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini && \
    addgroup -S nodejs && adduser -S worker -G nodejs
COPY --from=prisma --chown=worker:nodejs /app /app
COPY --chown=worker:nodejs apps/worker apps/worker
COPY --chown=worker:nodejs packages packages
USER worker
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]
```

The worker has no public port — Fly will run it without exposing a port, and the scheduler/handler reach Postgres + Suwayomi via outbound connections only.

- [ ] **Step 13.2: Build locally**

```
docker build -f apps/worker/Dockerfile -t manhwa-worker:test .
```

Expected: builds in 1-2 minutes.

- [ ] **Step 13.3: Smoke-run the image**

```
docker run --rm \
  -e DATABASE_URL="<DATABASE_URL_STAGING>" \
  -e SUWAYOMI_URL="http://host.docker.internal:4567" \
  manhwa-worker:test
```

Expected output within 5 seconds:

```
[worker] starting…
[worker] up — scheduler tick every 30s, batchSize 1
```

Then it sits idle (or logs scheduler ticks if SeriesSources exist). Stop with Ctrl+C.

- [ ] **Step 13.4: Commit (via PR)**

```
git checkout -b worker-dockerfile
git add apps/worker/Dockerfile
git commit -m "build(worker): multi-stage Dockerfile"
git push -u origin worker-dockerfile
```

PR → CI green → merge.

---

## Task 14: Install flyctl + Fly.io account setup

**Files:** None (CLI install + manual account setup)

- [ ] **Step 14.1: Install flyctl**

Windows (PowerShell):

```
iwr https://fly.io/install.ps1 -useb | iex
```

Linux/Mac (or WSL):

```
curl -L https://fly.io/install.sh | sh
```

Verify:

```
fly version
```

Expected: prints version.

- [ ] **Step 14.2: Create a Fly account + add a payment method**

```
fly auth signup
```

Or, if you already have an account:

```
fly auth login
```

Fly's free tier was discontinued in 2024 — there's no free hobby tier any more. The cheapest viable config is a single `shared-cpu-1x@256MB` machine per Fly app at ~$2/mo. For three apps × two environments = 6 machines × ~$2 = ~$12/mo. Add a credit card to your Fly account.

(If you have a Fly account from before they had usage-based billing, your old credits may still apply. Otherwise: ~$12-15/mo is the real cost of running this stack.)

- [ ] **Step 14.3: Pick a region**

```
fly platform regions
```

Pick the closest to where your DB lives (Neon's region you chose in Task 7). E.g. `fra` if you're in Europe with a Neon EU-Central database.

Save the region code; you'll use it in all fly.toml files.

No commit for Task 14.

---

## Task 15: Suwayomi Fly app (with persistent volume) — staging + prod

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\infra\suwayomi\fly.staging.toml`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\infra\suwayomi\fly.prod.toml`

Suwayomi is deployed as its own Fly app per environment. We use the upstream `ghcr.io/suwayomi/suwayomi-server:stable` image directly (no fork). A persistent Fly volume stores the chapter cache and extension files so they survive restarts.

- [ ] **Step 15.1: Write `infra/suwayomi/fly.staging.toml`**

```toml
app = 'manhwa-suwayomi-staging'
primary_region = 'fra'

[build]
image = 'ghcr.io/suwayomi/suwayomi-server:stable'

[env]
BIND_PORT = '4567'
BIND_IP = '0.0.0.0'
DOWNLOAD_AS_CBZ = 'false'
AUTO_DOWNLOAD_CHAPTERS = 'false'

[[mounts]]
source = 'suwayomi_data'
destination = '/home/suwayomi/.local/share/Tachidesk'

[[services]]
protocol = 'tcp'
internal_port = 4567
auto_stop_machines = 'stop'
auto_start_machines = true
min_machines_running = 0

# No public ports — Suwayomi is only reachable via Fly's private 6PN.
# Worker calls it at http://manhwa-suwayomi-staging.internal:4567

[[vm]]
size = 'shared-cpu-1x'
memory = '512mb'  # JVM needs more headroom than 256mb
```

- [ ] **Step 15.2: Write `infra/suwayomi/fly.prod.toml`**

Same shape, with prod identifiers:

```toml
app = 'manhwa-suwayomi-prod'
primary_region = 'fra'

[build]
image = 'ghcr.io/suwayomi/suwayomi-server:stable'

[env]
BIND_PORT = '4567'
BIND_IP = '0.0.0.0'
DOWNLOAD_AS_CBZ = 'false'
AUTO_DOWNLOAD_CHAPTERS = 'false'

[[mounts]]
source = 'suwayomi_data'
destination = '/home/suwayomi/.local/share/Tachidesk'

[[services]]
protocol = 'tcp'
internal_port = 4567
auto_stop_machines = 'stop'
auto_start_machines = true
min_machines_running = 0

[[vm]]
size = 'shared-cpu-1x'
memory = '512mb'
```

- [ ] **Step 15.3: Create the Fly apps**

```
fly apps create manhwa-suwayomi-staging --org personal
fly apps create manhwa-suwayomi-prod --org personal
```

(`--org personal` is the default org for solo accounts; substitute if you set up an org with a different name.)

- [ ] **Step 15.4: Create the volumes**

```
fly volumes create suwayomi_data --app manhwa-suwayomi-staging --region fra --size 3 --yes
fly volumes create suwayomi_data --app manhwa-suwayomi-prod --region fra --size 3 --yes
```

`--size 3` = 3 GB. Suwayomi's cache grows over time; you can resize later with `fly volumes extend`.

- [ ] **Step 15.5: Deploy staging Suwayomi**

```
fly deploy --config infra/suwayomi/fly.staging.toml
```

Expected: pulls the image, attaches the volume, starts the machine. ~2 minutes.

- [ ] **Step 15.6: Verify staging Suwayomi from another Fly app context**

Suwayomi has no public IP. To verify it's responding, use the Fly CLI to connect to its private network:

```
fly ssh console --app manhwa-suwayomi-staging
```

Once inside:

```
wget -qO- http://localhost:4567 | head -c 200
exit
```

Expected: HTML response from Suwayomi's UI.

- [ ] **Step 15.7: Install extensions in staging Suwayomi**

The worker normally installs extensions via `pnpm worker:install-extensions`. We need to run that once against the deployed Suwayomi. Easiest: use `fly proxy` to expose the deployed Suwayomi to localhost temporarily:

```
fly proxy 4568:4567 --app manhwa-suwayomi-staging
```

In another terminal:

```
SUWAYOMI_URL=http://localhost:4568 pnpm worker:install-extensions
```

Expected: installs Bbato, Asura Scans, MangaBuddy, Flame Comics. Stop the proxy with Ctrl+C when done.

- [ ] **Step 15.8: Repeat for prod**

```
fly deploy --config infra/suwayomi/fly.prod.toml
fly proxy 4569:4567 --app manhwa-suwayomi-prod
# in another terminal:
SUWAYOMI_URL=http://localhost:4569 pnpm worker:install-extensions
```

- [ ] **Step 15.9: Commit (via PR)**

```
git checkout -b suwayomi-fly
git add infra/suwayomi
git commit -m "infra: Suwayomi Fly app configs for staging + prod with persistent volumes"
git push -u origin suwayomi-fly
```

PR → merge.

---

## Task 16: Web Fly app — fly.toml configs

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\fly.staging.toml`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\web\fly.prod.toml`

- [ ] **Step 16.1: Write `apps/web/fly.staging.toml`**

```toml
app = 'manhwa-web-staging'
primary_region = 'fra'

[build]
dockerfile = 'apps/web/Dockerfile'

[env]
NODE_ENV = 'production'
AUTH_URL = 'https://manhwa-web-staging.fly.dev'
SUWAYOMI_URL = 'http://manhwa-suwayomi-staging.internal:4567'

[http_service]
internal_port = 3000
force_https = true
auto_stop_machines = 'stop'
auto_start_machines = true
min_machines_running = 0

[[http_service.checks]]
interval = '15s'
timeout = '4s'
grace_period = '10s'
method = 'GET'
path = '/'

[[vm]]
size = 'shared-cpu-1x'
memory = '512mb'
```

- [ ] **Step 16.2: Write `apps/web/fly.prod.toml`**

```toml
app = 'manhwa-web-prod'
primary_region = 'fra'

[build]
dockerfile = 'apps/web/Dockerfile'

[env]
NODE_ENV = 'production'
AUTH_URL = 'https://manhwa-web-prod.fly.dev'
SUWAYOMI_URL = 'http://manhwa-suwayomi-prod.internal:4567'

[http_service]
internal_port = 3000
force_https = true
auto_stop_machines = 'stop'
auto_start_machines = true
min_machines_running = 0

[[http_service.checks]]
interval = '15s'
timeout = '4s'
grace_period = '10s'
method = 'GET'
path = '/'

[[vm]]
size = 'shared-cpu-1x'
memory = '512mb'
```

- [ ] **Step 16.3: Create the Fly apps**

```
fly apps create manhwa-web-staging --org personal
fly apps create manhwa-web-prod --org personal
```

- [ ] **Step 16.4: Set secrets (staging)**

```
fly secrets set --app manhwa-web-staging \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  DATABASE_URL="<DATABASE_URL_STAGING>" \
  EMAIL_SERVER_HOST="smtp.resend.com" \
  EMAIL_SERVER_PORT="465" \
  EMAIL_SERVER_USER="resend" \
  EMAIL_SERVER_PASSWORD="<staging Resend key>" \
  EMAIL_FROM="<your sender address>" \
  AUTH_GOOGLE_ID="<from Task 9>" \
  AUTH_GOOGLE_SECRET="<from Task 9>" \
  NEXT_PUBLIC_SENTRY_DSN="<staging web DSN from Task 10>" \
  SENTRY_DSN="<staging web DSN from Task 10>"
```

- [ ] **Step 16.5: Set secrets (prod)**

```
fly secrets set --app manhwa-web-prod \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  DATABASE_URL="<DATABASE_URL_PROD>" \
  EMAIL_SERVER_HOST="smtp.resend.com" \
  EMAIL_SERVER_PORT="465" \
  EMAIL_SERVER_USER="resend" \
  EMAIL_SERVER_PASSWORD="<prod Resend key>" \
  EMAIL_FROM="<your sender address>" \
  AUTH_GOOGLE_ID="<from Task 9>" \
  AUTH_GOOGLE_SECRET="<from Task 9>" \
  NEXT_PUBLIC_SENTRY_DSN="<prod web DSN from Task 10>" \
  SENTRY_DSN="<prod web DSN from Task 10>"
```

(Same Google OAuth client serves both envs because the consent screen has all three redirect URIs registered.)

- [ ] **Step 16.6: Deploy staging web**

```
fly deploy --config apps/web/fly.staging.toml \
  --build-arg NEXT_PUBLIC_SENTRY_DSN="<staging DSN>" \
  --build-arg SENTRY_DSN="<staging DSN>" \
  --build-arg SENTRY_AUTH_TOKEN="<auth token from Task 10>" \
  --build-arg SENTRY_ORG="<sentry org slug>" \
  --build-arg SENTRY_PROJECT="manhwa-web-staging"
```

The build-args are needed for Sentry source-map upload at build time.

Expected: builds + deploys in ~5-7 minutes. The final log line includes `monitoring app at https://manhwa-web-staging.fly.dev`.

- [ ] **Step 16.7: Smoke-test staging**

Visit https://manhwa-web-staging.fly.dev → sign-in page renders. Try signing in with Google (it should redirect to the staging callback URL successfully). Try the magic link (should land in your inbox via Resend).

If anything fails:

- 500 on landing → `fly logs --app manhwa-web-staging` shows the stack. Common: missing env var.
- OAuth redirect_uri_mismatch → confirm Step 9.1's authorized redirect URIs include the staging URL.
- Email not arriving → check Resend dashboard for delivery status; verify `EMAIL_FROM` domain is verified.

- [ ] **Step 16.8: Deploy prod web (same flow with prod values)**

```
fly deploy --config apps/web/fly.prod.toml \
  --build-arg NEXT_PUBLIC_SENTRY_DSN="<prod DSN>" \
  --build-arg SENTRY_DSN="<prod DSN>" \
  --build-arg SENTRY_AUTH_TOKEN="<auth token>" \
  --build-arg SENTRY_ORG="<sentry org slug>" \
  --build-arg SENTRY_PROJECT="manhwa-web-prod"
```

Smoke-test: https://manhwa-web-prod.fly.dev.

- [ ] **Step 16.9: Commit**

```
git checkout -b web-fly
git add apps/web/fly.staging.toml apps/web/fly.prod.toml
git commit -m "infra: Fly app configs for web (staging + prod)"
git push -u origin web-fly
```

PR → merge.

---

## Task 17: Worker Fly app — fly.toml configs

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\fly.staging.toml`
- Create: `D:\Projects\Claude\Manhwa_bookmarker\apps\worker\fly.prod.toml`

- [ ] **Step 17.1: Write `apps/worker/fly.staging.toml`**

```toml
app = 'manhwa-worker-staging'
primary_region = 'fra'

[build]
dockerfile = 'apps/worker/Dockerfile'

[env]
NODE_ENV = 'production'
SUWAYOMI_URL = 'http://manhwa-suwayomi-staging.internal:4567'

# No [http_service] block — the worker has no HTTP server.
# Fly treats this as a process-app: keep one machine running always.

[[vm]]
size = 'shared-cpu-1x'
memory = '512mb'
auto_stop_machines = false
min_machines_running = 1
```

- [ ] **Step 17.2: Write `apps/worker/fly.prod.toml`**

```toml
app = 'manhwa-worker-prod'
primary_region = 'fra'

[build]
dockerfile = 'apps/worker/Dockerfile'

[env]
NODE_ENV = 'production'
SUWAYOMI_URL = 'http://manhwa-suwayomi-prod.internal:4567'

[[vm]]
size = 'shared-cpu-1x'
memory = '512mb'
auto_stop_machines = false
min_machines_running = 1
```

- [ ] **Step 17.3: Create the Fly apps**

```
fly apps create manhwa-worker-staging --org personal
fly apps create manhwa-worker-prod --org personal
```

- [ ] **Step 17.4: Set secrets**

```
fly secrets set --app manhwa-worker-staging \
  DATABASE_URL="<DATABASE_URL_STAGING>" \
  SENTRY_DSN="<staging worker DSN from Task 11>"

fly secrets set --app manhwa-worker-prod \
  DATABASE_URL="<DATABASE_URL_PROD>" \
  SENTRY_DSN="<prod worker DSN from Task 11>"
```

- [ ] **Step 17.5: Deploy**

```
fly deploy --config apps/worker/fly.staging.toml
fly deploy --config apps/worker/fly.prod.toml
```

Expected: builds + deploys each in ~3-4 minutes.

- [ ] **Step 17.6: Verify the worker is logging**

```
fly logs --app manhwa-worker-staging
```

Expected within ~10 seconds:

```
[worker] starting…
[worker] up — scheduler tick every 30s, batchSize 1
```

If `SeriesSource`s exist in the staging DB, you'll also see `[scheduler] enqueued N poll job(s)` and `[poll] ... → new=... total=... nextPollAt=...`.

Repeat for prod.

- [ ] **Step 17.7: Commit**

```
git checkout -b worker-fly
git add apps/worker/fly.staging.toml apps/worker/fly.prod.toml
git commit -m "infra: Fly app configs for worker (staging + prod)"
git push -u origin worker-fly
```

PR → merge.

---

## Task 18: Migration runner script + run prod migrations

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\infra\scripts\migrate-prod.sh`

The CI/CD pipeline needs a single command to apply migrations to a target environment. Pull this out into a small script so the GitHub Actions workflow stays clean.

- [ ] **Step 18.1: Write the migration script**

`infra/scripts/migrate-prod.sh`:

```bash
#!/usr/bin/env bash
# Applies Prisma migrations to a target DATABASE_URL.
# Usage:
#   DATABASE_URL=<url> ./infra/scripts/migrate-prod.sh
# Or via Fly's run subcommand:
#   fly ssh console --app manhwa-web-prod --command "pnpm --filter @manhwa/db exec prisma migrate deploy"
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

cd "$(dirname "$0")/../.."

pnpm install --frozen-lockfile --filter @manhwa/db
pnpm --filter @manhwa/db exec prisma migrate deploy

echo "✓ migrations applied"
```

- [ ] **Step 18.2: Make it executable + commit (via PR)**

```
git checkout -b migrate-script
chmod +x infra/scripts/migrate-prod.sh
git add infra/scripts
git commit -m "infra: prisma migrate runner script"
git push -u origin migrate-script
```

PR → merge.

---

## Task 19: GitHub Actions — deploy to staging on PR open

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\.github\workflows\deploy-staging.yml`

- [ ] **Step 19.1: Generate a Fly API token**

```
fly tokens create deploy --name github-actions
```

Copy the token (starts with `FlyV1 fm2_`).

Add to GitHub repo secrets: https://github.com/Donuttouchme/manhwa-bookmarker/settings/secrets/actions → **New repository secret** → Name: `FLY_API_TOKEN`, value: the token.

Also add Sentry build-time secrets:

- `SENTRY_AUTH_TOKEN` (from Task 10.1)
- `SENTRY_ORG` (your sentry org slug)
- `STAGING_NEXT_PUBLIC_SENTRY_DSN`
- `STAGING_SENTRY_DSN`
- `PROD_NEXT_PUBLIC_SENTRY_DSN`
- `PROD_SENTRY_DSN`

- [ ] **Step 19.2: Write the staging deploy workflow**

`.github/workflows/deploy-staging.yml`:

```yaml
name: Deploy staging

on:
  pull_request:
    branches: [main]

concurrency:
  group: staging-deploy-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  migrate-and-deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - uses: superfly/flyctl-actions/setup-flyctl@master

      # ─── Migrations ────────────────────────────────────
      - name: Apply migrations to staging
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
        run: |
          npm install -g pnpm@9.15.0
          pnpm install --frozen-lockfile --filter @manhwa/db
          pnpm --filter @manhwa/db exec prisma migrate deploy

      # ─── Deploy web ────────────────────────────────────
      - name: Deploy web (staging)
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
        run: |
          fly deploy --config apps/web/fly.staging.toml --remote-only \
            --build-arg NEXT_PUBLIC_SENTRY_DSN="${{ secrets.STAGING_NEXT_PUBLIC_SENTRY_DSN }}" \
            --build-arg SENTRY_DSN="${{ secrets.STAGING_SENTRY_DSN }}" \
            --build-arg SENTRY_AUTH_TOKEN="${{ secrets.SENTRY_AUTH_TOKEN }}" \
            --build-arg SENTRY_ORG="${{ secrets.SENTRY_ORG }}" \
            --build-arg SENTRY_PROJECT="manhwa-web-staging"

      # ─── Deploy worker ────────────────────────────────
      - name: Deploy worker (staging)
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
        run: fly deploy --config apps/worker/fly.staging.toml --remote-only

      # ─── Comment on PR ────────────────────────────────
      - name: Comment deploy URL
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: '🚀 Deployed to staging: https://manhwa-web-staging.fly.dev'
            })
```

Also add `STAGING_DATABASE_URL` to GitHub secrets (the same Neon staging URL from Task 7).

- [ ] **Step 19.3: Commit + open a PR to verify**

```
git checkout -b ci-deploy-staging
git add .github/workflows/deploy-staging.yml
git commit -m "ci: auto-deploy PRs to Fly staging"
git push -u origin ci-deploy-staging
```

Open a PR. The `Deploy staging` workflow runs. Within ~7-8 minutes it should complete + comment the staging URL on the PR.

If the deploy fails, the comment step is skipped — investigate via `fly logs` or the GitHub Actions log. Common issues:

- `FLY_API_TOKEN` is wrong scope (must be `deploy`).
- `SENTRY_AUTH_TOKEN` is missing → source map upload fails non-fatally.
- DB migration fails → likely a Prisma schema drift. Repair locally first.

Once green, merge the PR.

---

## Task 20: GitHub Actions — deploy to prod on merge to main

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\.github\workflows\deploy-prod.yml`

- [ ] **Step 20.1: Write the prod deploy workflow**

`.github/workflows/deploy-prod.yml`:

```yaml
name: Deploy production

on:
  push:
    branches: [main]

concurrency:
  group: prod-deploy
  cancel-in-progress: false # never cancel a prod deploy mid-flight

jobs:
  migrate-and-deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    environment: production
    steps:
      - uses: actions/checkout@v4

      - uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Apply migrations to prod
        env:
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
        run: |
          npm install -g pnpm@9.15.0
          pnpm install --frozen-lockfile --filter @manhwa/db
          pnpm --filter @manhwa/db exec prisma migrate deploy

      - name: Deploy web (prod)
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
        run: |
          fly deploy --config apps/web/fly.prod.toml --remote-only \
            --build-arg NEXT_PUBLIC_SENTRY_DSN="${{ secrets.PROD_NEXT_PUBLIC_SENTRY_DSN }}" \
            --build-arg SENTRY_DSN="${{ secrets.PROD_SENTRY_DSN }}" \
            --build-arg SENTRY_AUTH_TOKEN="${{ secrets.SENTRY_AUTH_TOKEN }}" \
            --build-arg SENTRY_ORG="${{ secrets.SENTRY_ORG }}" \
            --build-arg SENTRY_PROJECT="manhwa-web-prod"

      - name: Deploy worker (prod)
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
        run: fly deploy --config apps/worker/fly.prod.toml --remote-only
```

The `environment: production` line gives you a chance to require manual approval in GitHub's environment settings — go to Settings → Environments → `production` → enable **Required reviewers** (yourself). The deploy will pause until you approve. (Optional but strongly recommended for prod.)

Also add to GitHub secrets:

- `PROD_DATABASE_URL` (Neon prod URL from Task 7).

- [ ] **Step 20.2: Commit + verify (via PR — yes, the prod deploy workflow itself ships via a PR)**

```
git checkout -b ci-deploy-prod
git add .github/workflows/deploy-prod.yml
git commit -m "ci: auto-deploy main to Fly prod"
git push -u origin ci-deploy-prod
```

Open a PR. The staging deploy runs (Task 19). After merging, the prod deploy workflow fires for the first time. Approve it. Watch the deploy complete. Verify https://manhwa-web-prod.fly.dev still works.

---

## Task 21: ops runbook — `docs/deployment.md`

**Files:**

- Create: `D:\Projects\Claude\Manhwa_bookmarker\docs\deployment.md`

A doc covering the ongoing-ops scenarios you'll hit when running the app.

- [ ] **Step 21.1: Write the runbook**

`docs/deployment.md`:

````md
# Deployment & Operations

## Environments

| Env     | Web                                | Worker                  | Suwayomi                                | DB                    |
| ------- | ---------------------------------- | ----------------------- | --------------------------------------- | --------------------- |
| local   | http://localhost:3000              | `pnpm worker:dev`       | `manhwa-suwayomi` container             | local Postgres        |
| staging | https://manhwa-web-staging.fly.dev | `manhwa-worker-staging` | `manhwa-suwayomi-staging.internal:4567` | Neon `staging` branch |
| prod    | https://manhwa-web-prod.fly.dev    | `manhwa-worker-prod`    | `manhwa-suwayomi-prod.internal:4567`    | Neon `main` branch    |

## Deploy pipeline

- PR opened → `Deploy staging` runs migrations on Neon `staging`, deploys web + worker.
- Merge to `main` → `Deploy production` (requires manual approval via the `production` environment in GitHub Settings) runs migrations on Neon `main`, deploys web + worker.

## Common operations

### View logs

```bash
fly logs --app manhwa-web-prod          # web
fly logs --app manhwa-worker-prod       # worker
fly logs --app manhwa-suwayomi-prod     # suwayomi
```
````

### Run a one-off command in a Fly app

```bash
fly ssh console --app manhwa-web-prod
```

### Connect to the prod DB

```bash
psql "<DATABASE_URL_PROD>"
```

Or via Neon's web SQL editor.

### Install a new Suwayomi extension in prod

```bash
fly proxy 4570:4567 --app manhwa-suwayomi-prod
# In another terminal:
SUWAYOMI_URL=http://localhost:4570 pnpm worker:install-extensions
```

Then update `packages/sources/src/source-registry.ts` if a new host is supported.

### Rotate a secret

```bash
fly secrets set AUTH_SECRET="$(openssl rand -base64 32)" --app manhwa-web-prod
# Web machines restart automatically on secret update.
```

Sign-ins in flight will be invalidated. Re-sign-in.

### Restore a DB to a point in time

1. Neon console → `manhwa-bookmarker` project → Branches → click `main` → **Restore**.
2. Pick a timestamp within the 7-day PITR window.
3. Neon creates a new branch from that point; promote it to `main` by deleting the old `main` and renaming.
4. Update the `PROD_DATABASE_URL` GitHub secret with the new connection string.
5. Restart Fly apps: `fly apps restart manhwa-web-prod manhwa-worker-prod`.

### Bring everything down (cost-saving)

```bash
for app in manhwa-web-prod manhwa-worker-prod manhwa-suwayomi-prod \
           manhwa-web-staging manhwa-worker-staging manhwa-suwayomi-staging; do
  fly scale count 0 --app "$app"
done
```

Bring back up with `fly scale count 1 --app "$app"`.

## Costs (approximate, 2026)

- Fly: ~$2/mo per `shared-cpu-1x@256MB` machine. 6 machines × $2 = ~$12/mo (often less because most are idle and auto-stop).
- Neon: free tier (0.5 GB storage, 1 project, 10 branches) — sufficient for hobby use.
- Resend: free tier (3k emails/mo, 100/day).
- Sentry: free tier (5k errors/mo).
- Domain (if you bought one): ~$10/yr.

Total: ~$12-15/mo + one-time domain.

## Disaster recovery

| Failure                                | Recovery                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Prod web app crashes                   | Auto-restart by Fly. If repeated: `fly logs` → debug → fix → deploy.                                          |
| Prod worker crashes                    | Same as web. pg-boss jobs survive restarts.                                                                   |
| Suwayomi data lost (volume corruption) | Re-run `pnpm worker:install-extensions` to reinstall extensions. Chapter cache rebuilds itself on next polls. |
| Prod DB corrupted                      | Neon PITR within 7 days. See "Restore a DB to a point in time".                                               |
| Repo deleted from GitHub               | `git push -u origin main` from local; you've got the full history.                                            |
| Fly account suspended                  | Migrate to Railway / Render / a $5 VPS. Same Docker images deploy elsewhere.                                  |

```

- [ ] **Step 21.2: Commit (via PR)**

```

git checkout -b ops-runbook
git add docs/deployment.md
git commit -m "docs: deployment + operations runbook"
git push -u origin ops-runbook

````

PR → merge.

---

## Task 22: README — update for production state + getting started

**Files:**

- Modify: `D:\Projects\Claude\Manhwa_bookmarker\README.md`

- [ ] **Step 22.1: Read the current README**

The README has gone through two polish rounds (end of Plan 2 + end of Plan 3). It currently describes local-only setup. Plan 4 makes it a real public app — update accordingly.

- [ ] **Step 22.2: Replace the opening section**

The opening paragraph (mentioning "Plans 1–3 shipped locally; Plan 4 deployment is next") should be replaced. Suggested new opening:

```md
# Manhwa Bookmarker

Track unread chapters across manga/manhwa aggregator sites (Bato.to, AsuraScans, MangaBuddy, Flame Comics, …). Multi-user, with adaptive polling, fuzzy duplicate detection, and a one-click "read + undo" UX.

🚀 **Live**: https://manhwa-web-prod.fly.dev

This is a personal learning project that I happen to develop in public — see [CONTRIBUTING.md](./CONTRIBUTING.md). The stack is intentionally a stretch into web development from my embedded-systems background, so expect rough edges.
````

- [ ] **Step 22.3: Update the status table to reflect Plan 4 done**

Find the existing status table (added in Plan 2 polish, updated in Plan 3 polish). Update the "Polling" / "Cursor advance" rows to `done` (they were done in Plan 3) and add new rows for Plan 4 milestones:

```md
| Feature                             | Status        |
| ----------------------------------- | ------------- |
| Sign-in (magic link)                | ✅            |
| Sign-in (Google OAuth)              | ✅            |
| Library page with series list       | ✅            |
| Add-series flow with URL resolution | ✅            |
| Cursor state on add                 | ✅            |
| Polling for new chapters            | ✅            |
| Mark-as-read / advance cursor       | ✅            |
| Production deployment (Fly + Neon)  | ✅            |
| CI/CD via GitHub Actions            | ✅            |
| Error reporting (Sentry)            | ✅            |
| Email digest                        | not planned   |
| Chapter list UI                     | not planned   |
| Custom domain                       | future polish |
```

(Adapt to whatever exact table structure exists.)

- [ ] **Step 22.4: Add a "Stack" section**

After the opening section, add:

```md
## Stack

- **Frontend:** Next.js 15 (App Router), shadcn/ui, Tailwind, dark mode by default
- **Auth:** Auth.js v5 (magic links via Resend + Google OAuth, DB sessions)
- **Backend:** Prisma 5 on Postgres (Neon for prod, Docker for local), server actions
- **Worker:** pg-boss for durable job queue, custom token-bucket + adaptive cadence
- **Scraping:** Suwayomi-Server (the upstream Tachiyomi-on-server image) — no custom scrapers
- **Hosting:** Fly.io (three apps per environment: web, worker, suwayomi)
- **Observability:** Sentry for errors, Fly logs for stdout
- **CI/CD:** GitHub Actions (test+typecheck+gitleaks on PR; auto-deploy staging on PR, prod on merge)
- **Local dev:** Docker Compose (postgres + mailpit + suwayomi)
```

- [ ] **Step 22.5: Add a "Running locally" section if not already present**

If the README's local-dev section is shipped (Plan 1+2 polish should have added it), confirm it's still accurate after Plan 4. Specifically: it should still say "use `.env.local` + Docker Compose for local dev; Fly secrets handle production". Add a one-line note pointing at `docs/deployment.md` for production operations.

- [ ] **Step 22.6: Commit (via PR)**

```
git checkout -b readme-prod
git add README.md
git commit -m "docs: README updated for production launch"
git push -u origin readme-prod
```

PR → merge.

---

## Task 23: Full production smoke test

**Files:** None (manual verification)

After Tasks 1-22, the system is live. Walk through the full user journey to confirm.

- [ ] **Step 23.1: Sign up via magic link in prod**

Visit https://manhwa-web-prod.fly.dev → click **Continue with email** → enter your email → check inbox → click the magic link → land on `/library`. Confirm the user row in the prod DB:

```bash
fly proxy 5433:5432 --app <neon-proxy-app-if-using>
# Or directly:
psql "<DATABASE_URL_PROD>" -c "SELECT id, email, \"isAdmin\" FROM \"User\";"
```

You should be the first user with `isAdmin = true` (per Plan 1's bootstrap logic).

- [ ] **Step 23.2: Sign in with Google in a separate browser**

Use an incognito window. Click **Sign in with Google** → consent → land on `/library`. Confirm a second User row in the DB.

- [ ] **Step 23.3: Add a series**

In the original session, click **Add series** → paste a Bato.to URL (`https://bato.to/title/95390-the-beginning-after-the-end`) → resolve → pick "I'm at chapter 5" → submit. Series appears in the library with an unread count.

- [ ] **Step 23.4: Wait for the worker to poll**

```bash
fly logs --app manhwa-worker-prod
```

Within ~30s you should see `[scheduler] enqueued 1 poll job(s)` followed by `[poll] <id> (Bbato) → new=... total=... nextPollAt=...`. The library page's unread count updates (refresh to see).

- [ ] **Step 23.5: Mark a chapter read + undo**

Click **+ Read 1** → unread decrements → toast appears → click **Undo** within 5s → unread restored.

- [ ] **Step 23.6: Trigger a Sentry error to verify reporting**

Temporarily add a throw to a page (e.g. `apps/web/src/app/library/page.tsx`):

```tsx
if (process.env.SENTRY_SMOKE === '1') throw new Error('Sentry smoke');
```

Deploy via PR. Set the env var via Fly:

```bash
fly secrets set SENTRY_SMOKE=1 --app manhwa-web-prod
```

Visit the page. Sentry should show the error within ~1 minute. Then revert the secret and the code via another PR:

```bash
fly secrets unset SENTRY_SMOKE --app manhwa-web-prod
```

(This is a deliberate smoke test that proves Sentry is wired correctly. Skip if you're confident in the wiring; rely on real errors to surface.)

- [ ] **Step 23.7: Verify cost dashboard**

Visit https://fly.io/dashboard/usage. Confirm machines are spending most of their time stopped (auto-stop on idle web/suwayomi) and the projected monthly cost is in line with expectations.

No commit for Task 23.

---

## Task 24: Save what you learned — close out the plan

- [ ] **Step 24.1: Update memory with deployment-tier facts**

Save a new memory file at `C:\Users\polga\.claude\projects\D--Projects-Claude-Manhwa-bookmarker\memory\project_plan4_complete.md`:

```md
---
name: project-plan4-complete
description: Plan 4 (production deployment) shipped — Manhwa Bookmarker is live on Fly+Neon+Resend+Sentry as of 2026-05-23.
metadata:
  type: project
---

Plan 4 shipped 2026-05-23. The app is live at https://manhwa-web-prod.fly.dev.

**Hosting topology:**

- Web (Next.js standalone) + Worker (pg-boss) + Suwayomi (upstream image) — 3 Fly apps × 2 environments = 6 apps.
- Postgres on Neon (free tier, EU-Central), with branches `main` (prod) + `staging`.
- Suwayomi reaches via Fly 6PN private network: `http://manhwa-suwayomi-<env>.internal:4567`.

**Auth:** magic-link (Resend) + Google OAuth. Three callback URLs registered.

**CI/CD:**

- PR → `Deploy staging` workflow (auto).
- Merge to `main` → `Deploy production` workflow (manual approval via GitHub environments).
- Tests + typecheck + gitleaks on PR via separate `CI` workflow.

**Observability:** Sentry (5k errors/mo free tier), Fly logs for stdout.

**Cost:** ~$12-15/mo on Fly + free everything else.

**Open follow-ups (not Plan 4 scope):**

- Custom domain.
- Horizontal scaling (currently single instance per env).
- Replace Test-mode Google OAuth with Published consent screen if user base grows beyond test list (~100 users).
- Backup orchestration beyond Neon's PITR.

See `docs/deployment.md` for ops runbook.

Related: [[project-plan1-complete]], [[project-plan3-complete]] (if exists).
```

Then add a line to `C:\Users\polga\.claude\projects\D--Projects-Claude-Manhwa-bookmarker\memory\MEMORY.md`:

```md
- [Plan 4 complete](project_plan4_complete.md) — production deployment 2026-05-23; live on Fly+Neon+Resend+Sentry, ~$12/mo
```

(No git commit needed for memory files — they're in your home directory.)

- [ ] **Step 24.2: Commit the plan acceptance**

Add a final commit to the repo marking Plan 4 done:

```
git checkout -b plan4-acceptance
git add docs/superpowers/plans/2026-05-23-production-deployment.md  # if this plan file wasn't committed yet
git commit --allow-empty -m "chore: Plan 4 (production deployment) accepted"
git push -u origin plan4-acceptance
```

PR → merge.

---

## Plan 4 acceptance checklist

Before declaring Plan 4 complete, verify each item.

- [ ] Repo is public on GitHub with a green CI badge.
- [ ] Branch protection on `main` blocks direct pushes; PR + status checks required.
- [ ] Dependabot is creating weekly PRs.
- [ ] Neon project exists with `main` + `staging` branches; both have all Prisma migrations applied and `pgcrypto` enabled.
- [ ] Resend domain (or `onboarding@resend.dev` fallback) sends magic-link emails reliably.
- [ ] Google OAuth client has all three redirect URIs and you can sign in with Google from local + staging + prod.
- [ ] Two Sentry projects per app type (web + worker × staging + prod) exist; SDKs initialised in both apps.
- [ ] `apps/web/Dockerfile` builds locally; standalone image runs.
- [ ] `apps/worker/Dockerfile` builds locally; worker boots and logs scheduler.
- [ ] `infra/suwayomi/fly.{staging,prod}.toml` deploys with persistent volume; extensions installed in both.
- [ ] `apps/web/fly.{staging,prod}.toml` deploys; web reachable at both URLs; Google + magic-link sign-in works in both.
- [ ] `apps/worker/fly.{staging,prod}.toml` deploys; worker logs scheduler ticks; polls update the DB.
- [ ] `.github/workflows/deploy-staging.yml` runs on PR open and comments the staging URL.
- [ ] `.github/workflows/deploy-prod.yml` runs on merge to `main` (with manual approval gate).
- [ ] `docs/deployment.md` exists and is accurate.
- [ ] `README.md` reflects the live app + new stack.
- [ ] Full user journey verified end-to-end in prod (Task 23).
- [ ] No `.env*` file is in the repo or any Docker image; all secrets are in Fly secrets or GitHub secrets.

When all 17 boxes are ticked, the Manhwa Bookmarker is shipped. The user is no longer your only user — the app is open to anyone with the URL.

---

## Pricing reality check

Plan 4 introduces real recurring costs. Verify you're OK with:

- Fly: ~$12-15/mo (6 machines, mostly stopped).
- Neon: $0 on free tier; $19/mo if you outgrow the free tier (10 GB or more activity).
- Resend: $0 up to 3k emails/mo; $20/mo for the next tier (50k/mo).
- Sentry: $0 up to 5k errors/mo; $26/mo for the Team tier.
- Domain (optional): ~$10/yr.
- Google OAuth: free.
- GitHub (public repo + Actions): free for public repos.

If any number alarms you, defer that subsystem (use Mailpit + skip Resend, skip Sentry, run only prod and skip staging, etc.). The plan can be reduced to ~$5/mo on the absolute minimum (1 Fly app for everything, no staging) but at significant operational cost (less safety, harder debugging).
