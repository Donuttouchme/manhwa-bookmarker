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
