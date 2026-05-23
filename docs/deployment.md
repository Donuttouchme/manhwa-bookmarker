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
