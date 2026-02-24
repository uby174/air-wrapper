# Development Guide

## Prerequisites

- **Node.js:** v20+ (recommended for Hono & Next.js).
- **pnpm:** `pnpm` (required for workspaces).
- **Docker:** For local Postgres + Redis.

## Getting Started

1.  **Clone & Install**
    ```bash
    git clone <repo-url>
    cd ai-wrapper
    pnpm install
    ```

2.  **Environment Setup**
    - Copy `.env.example` to `.env` in root, `apps/web/`, and `apps/api/`.
    - Fill in your API keys (OPENAI_API_KEY, etc.).
    ```bash
    cp .env.example .env
    cp apps/web/.env.example apps/web/.env
    cp apps/api/.env.example apps/api/.env
    ```

3.  **Start Infrastructure (Docker)**
    ```bash
    docker compose -f infra/docker-compose.yml up -d
    ```
    - **Postgres:** `localhost:5432` (user: postgres, pass: postgres, db: ai_wrapper)
    - **Redis:** `localhost:6379`

4.  **Run Migrations**
    ```bash
    pnpm --filter @ai-wrapper/api db:migrate
    ```

5.  **Start Development Server**
    ```bash
    pnpm dev
    ```
    - **Web:** [http://localhost:3000](http://localhost:3000)
    - **API:** [http://localhost:8787](http://localhost:8787)
    - **Worker:** Started automatically with API in dev mode (unless `DISABLE_AI_JOBS_WORKER=true`).

## Key Commands

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Start Web + API + Worker in parallel. |
| `pnpm build` | Build all apps/packages for production. |
| `pnpm lint` | Run ESLint across the monorepo. |
| `pnpm test` | Run Vitest tests (API/Core/RAG). |
| `pnpm format` | Format code with Prettier. |
| `pnpm --filter @ai-wrapper/api db:migrate` | Apply pending SQL migrations. |
| `pnpm --filter @ai-wrapper/api db:smoke` | Run smoke tests on DB connection. |
| `pnpm --filter @ai-wrapper/api privacy:retention` | Manually trigger GDPR data cleanup. |

## Troubleshooting

### Database Connection Issues
- Ensure Docker is running: `docker ps`.
- Check `.env` matches `infra/docker-compose.yml`.
- Reset DB volume if stuck: `docker compose -f infra/docker-compose.yml down -v`.

### Job Processing Stuck
- Check Redis connection.
- Verify worker is running (`pnpm dev` usually handles this).
- Check `bullmq` dashboard or logs for failed jobs.

### "Module not found"
- Did you add a new package? Run `pnpm install` again to link workspaces.
- Check `pnpm-workspace.yaml`.

## Testing

- **Unit Tests:** `pnpm test` runs `vitest` in packages.
- **Manual Verification:** See `MANUAL_VERIFICATION.md` for manual test steps.
