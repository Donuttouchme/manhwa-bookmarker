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
