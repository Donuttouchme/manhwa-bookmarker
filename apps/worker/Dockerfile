# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20-alpine

# ── Stage 1: all deps (dev + prod) ────────────────────────────────
# Install all dependencies so prisma generate can run (prisma CLI is a devDep of @manhwa/db).
FROM node:${NODE_VERSION} AS all-deps
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
FROM all-deps AS prisma
COPY packages/db/prisma/ packages/db/prisma/
RUN pnpm --filter @manhwa/db exec prisma generate

# ── Stage 3: deploy (prod-only, self-contained) ──────────────────
# pnpm deploy copies the worker + its workspace deps into /deploy
# with only production dependencies — devDeps are excluded.
# tsx lives in 'dependencies' so it is included.
FROM prisma AS deploy
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter @manhwa/worker deploy --prod /deploy
# Overlay the generated Prisma client (the .prisma dir created by prisma generate)
# from the prisma stage onto the deploy output. Both stages resolve @prisma/client
# to the same pnpm virtual-store path, so a glob copy keeps this version-agnostic.
RUN src=$(echo /app/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma) && \
    dst=$(echo /deploy/node_modules/.pnpm/@prisma+client@*/node_modules) && \
    cp -r "$src" "$dst/.prisma"

# ── Stage 4: runner ─────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
# openssl: Prisma's platform-detect script needs the `openssl` binary to identify
# the OpenSSL version at runtime. Without it, Prisma defaults to the legacy
# "linux-musl" (openssl-1.1) engine which fails on Alpine 3.20+ (openssl-3 only).
RUN apk add --no-cache tini openssl && \
    addgroup -S nodejs && adduser -S worker -G nodejs
COPY --from=deploy --chown=worker:nodejs /deploy /app
USER worker
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "/app/src/index.ts"]
