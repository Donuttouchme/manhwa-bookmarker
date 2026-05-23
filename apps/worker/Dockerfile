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
# openssl: Prisma's platform-detect script needs the `openssl` binary to identify
# the OpenSSL version at runtime. Without it, Prisma defaults to the legacy
# "linux-musl" (openssl-1.1) engine which fails on Alpine 3.20+ (openssl-3 only).
RUN apk add --no-cache tini openssl && \
    addgroup -S nodejs && adduser -S worker -G nodejs
COPY --from=prisma --chown=worker:nodejs /app /app
COPY --chown=worker:nodejs apps/worker apps/worker
COPY --chown=worker:nodejs packages packages
# Run from the worker package directory so that Node can resolve the bare
# "tsx" specifier from local node_modules (pnpm hoisting puts it there).
WORKDIR /app/apps/worker
USER worker
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "/app/apps/worker/src/index.ts"]
