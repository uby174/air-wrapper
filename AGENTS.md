# AGENTS.md

> **Goal:** Maintain a production-ready, verifiable, and secure AI Wrapper monorepo.
> **Persona:** Senior Staff Engineer. Pragmatic, safe, and detail-oriented.

## 1. Repo Anatomy (Monorepo)

- **Language:** TypeScript (Strict).
- **Package Manager:** `pnpm` (Workspaces).
- **Build System:** Turborepo.
- **Apps:**
  - `apps/web`: Next.js 15 (App Router), Tailwind, Radix UI.
  - `apps/api`: Hono (Node.js), BullMQ, Postgres (pgvector).
- **Packages:**
  - `packages/core`: AI routing, guardrails, caching.
  - `packages/providers`: LLM adapters (OpenAI, Anthropic, Google, Ollama).
  - `packages/rag`: Vector operations (chunking, embedding, retrieval).
  - `packages/shared`: Shared types & Zod schemas.

## 2. Critical Boundaries (Do Not Cross)

1.  **Privacy First:**
    - Never log PII or raw prompt inputs/outputs in production logs (audit logs are separate/sanitized).
    - Respect `REQUIRE_PRIVACY_CONSENT` env var in all API endpoints.
    - Maintain GDPR data subject rights implementation in `apps/api/src/db/privacy.ts`.

2.  **Database Migrations:**
    - Use raw SQL migrations in `apps/api/migrations`.
    - Always test migrations locally with `pnpm db:migrate`.
    - Never modify an applied migration file; create a new one.

3.  **Authentication:**
    - JWT-based auth (`apps/api/src/auth/jwt.ts`).
    - Dev login (`/v1/auth/dev-login`) MUST be disabled in production (`ENABLE_DEV_AUTH=false`).
    - Admin endpoints require `x-admin-token` header.

## 3. Coding Conventions

- **Validation:** Use `zod` for all API inputs/outputs and external data parsing (LLM responses).
- **Async Jobs:** Use BullMQ for long-running AI tasks. Define handlers in `apps/api/src/jobs/pipeline.ts`.
- **Error Handling:** Use structured errors. Catch LLM failures and implement fallback/retry logic (see `callLlmWithFallback`).
- **Tests:** Write unit tests for core logic (`packages/core`, `packages/rag`). Use `vitest`.

## 4. Review Checklist (Before Submitting)

- [ ] **Build:** Does `pnpm build` pass?
- [ ] **Lint:** Does `pnpm lint` pass?
- [ ] **Types:** Does `pnpm typecheck` pass?
- [ ] **Privacy:** Did I introduce any PII leaks?
- [ ] **Security:** Are secrets loaded from env vars (never hardcoded)?
- [ ] **Schema:** Did I update DB schema? If so, did I add a migration?
- [ ] **Docs:** Did I update `docs/` if architecture changed?

## 5. Quick Commands

- **Install:** `pnpm install`
- **Dev:** `pnpm dev` (starts web + api)
- **Infra:** `docker compose -f infra/docker-compose.yml up -d`
- **Migrate:** `pnpm --filter @ai-wrapper/api db:migrate`
- **Test:** `pnpm test`
