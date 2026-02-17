# ai-wrapper

Production-ready starter monorepo using Turborepo + pnpm workspaces.

## Stack
- `apps/web`: Next.js 15 (App Router), Tailwind, shadcn-style UI primitives
- `apps/api`: Node 20 + TypeScript + Hono REST API
- `packages/shared`: shared types + zod schemas
- `packages/core`: routing constants, prompts, guardrails, cache helpers
- `packages/providers`: OpenAI/Anthropic/Google provider adapters (single interface)
- `packages/rag`: chunking, embeddings, retrieval helpers
- `infra/docker-compose.yml`: Postgres 15 + pgvector + Redis

## Quick start
1. Install deps
   - `pnpm install`
2. Start infra
   - `docker compose -f infra/docker-compose.yml up -d`
3. Run web + api
   - `pnpm dev`

## Workspace scripts
- `pnpm dev`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`

## Database migrations (apps/api)
- `pnpm --filter @ai-wrapper/api db:migrate`
- `pnpm --filter @ai-wrapper/api db:push`
- `pnpm --filter @ai-wrapper/api db:smoke`
- `pnpm --filter @ai-wrapper/api privacy:retention`

## Notes
- API defaults to `http://localhost:8787`
- Web defaults to `http://localhost:3000`
- Env templates are in root and each app (`.env.example`)

## GDPR / Privacy Controls (Implemented)
- Consent gating before AI processing (`REQUIRE_PRIVACY_CONSENT=true`).
- Data subject rights endpoints:
  - `GET /v1/privacy/me/status`
  - `POST /v1/privacy/me/consent`
  - `GET /v1/privacy/me/export`
  - `POST /v1/privacy/me/request`
  - `DELETE /v1/privacy/me`
- Retention cleanup:
  - startup cleanup (`PRIVACY_RETENTION_RUN_ON_STARTUP=true`)
  - manual run via `POST /v1/admin/privacy/retention-run` (requires `x-admin-token`)
  - CLI run via `pnpm --filter @ai-wrapper/api privacy:retention`
- Data minimization:
  - raw job input persistence toggle (`PRIVACY_STORE_RAW_INPUT=false`)
  - PDF/data-url persistence normalization (hash-based URL placeholders)
- Audit logging table (`audit_events`) for security/privacy operations.
- Deleted-account token blocking using `deleted_users`.

## Deployment Compliance Notes
- Set `CORS_ALLOW_ORIGINS` to your exact SaaS domains in production.
- Rotate `AUTH_JWT_SECRET` and `ADMIN_API_TOKEN` using secret manager.
- Keep Postgres + Redis in private network and enable backups + encryption at rest.
- Publish legal docs externally (Privacy Policy, Terms, DPA) matching versions configured in env.
