# System Architecture

## Overview

**AI Wrapper** is a vertical-first AI workflow system. It handles long-running, asynchronous LLM jobs with built-in RAG (Retrieval-Augmented Generation), privacy controls, and structured output validation.

- **Stack:** Next.js (Web), Hono (API), BullMQ (Async Jobs), Postgres + pgvector (DB/RAG).
- **Core Principle:** Provider-agnostic routing (OpenAI/Anthropic/Google/Ollama) with reliable retries and structured data extraction.

## 1. System Map

```mermaid
graph TD
    User((User)) -->|HTTPS| Web[Web App (Next.js)]
    Web -->|JSON/REST| API[API Service (Hono)]

    subgraph "Backend Infrastructure"
        API -->|Enqueue| Redis[(Redis)]
        Worker[Job Worker] -->|Dequeue| Redis
        Worker -->|Read/Write| DB[(Postgres + pgvector)]
        API -->|Read/Write| DB
    end

    subgraph "External Providers"
        Worker -->|Completions| OpenAI[OpenAI API]
        Worker -->|Completions| Anthropic[Anthropic API]
        Worker -->|Completions| Google[Google Gemini]
        Worker -->|Completions| Ollama[Local Ollama]
    end
```

## 2. Key Components

### A. Frontend (`apps/web`)
- **Framework:** Next.js 15 (App Router).
- **Styling:** Tailwind CSS + Radix UI (shadcn-like).
- **State:** React Server Components + Client Components for interactivity.
- **Auth:** JWT stored in `localStorage` (via `lib/session.ts`).

### B. Backend (`apps/api`)
- **Framework:** Hono (Node.js runtime).
- **Responsibilities:**
  - **Auth:** Custom JWT middleware (`auth/middleware.ts`).
  - **Routing:** API endpoints (`index.ts`).
  - **Privacy:** GDPR/CCPA logic (`db/privacy.ts`).
  - **Job Queue:** Enqueues tasks to BullMQ (`jobs/queue.ts`).

### C. Worker (`apps/api/src/jobs/worker-entry.ts`)
- **Process:** Runs separately from the API server (via `pnpm dev:worker` or `startAiJobsWorker`).
- **Logic:** `jobs/pipeline.ts`.
  1.  **Extract:** Pulls text from input (Text or PDF).
  2.  **Guardrails:** Checks for blocked content.
  3.  **Classify:** Determines task complexity (SIMPLE/MEDIUM/COMPLEX).
  4.  **Route:** Selects optimal LLM provider.
  5.  **RAG:** Chunks/Embeds input -> Retrieval (if enabled).
  6.  **Generate:** Calls LLM with prompt + context.
  7.  **Validate:** Ensures JSON output matches schema (with self-correction retry).
  8.  **Enrich:** Optional second pass to fill missing data.

### D. Shared Packages
- **`@ai-wrapper/core`**: Routing logic, cost estimation, guardrails.
- **`@ai-wrapper/providers`**: Unified interface for LLMs (`generateText`, `embed`).
- **`@ai-wrapper/rag`**: Chunking, embedding, vector retrieval.
- **`@ai-wrapper/shared`**: Zod schemas shared between Web and API.

## 3. Data Flow (Job Lifecycle)

1.  **Submission:** User POSTs to `/v1/jobs`.
2.  **Validation:** API validates schema & privacy consent.
3.  **Persistence:** Job record created in Postgres (`status: queued`).
4.  **Queue:** Job ID pushed to Redis (BullMQ).
5.  **Processing:** Worker picks up job.
    - Updates DB to `running`.
    - Executes pipeline (LLM calls).
    - Updates DB to `succeeded` (with result/citations) or `failed`.
6.  **Polling:** Web app polls `/v1/jobs/:id` for status.

## 4. Database Schema

Managed via raw SQL migrations (`apps/api/migrations`).

- **`users`**: Auth & Plan info (id, email, plan).
- **`jobs`**: AI tasks (input, result, status, error).
- **`documents`**: Source text metadata for RAG.
- **`chunks`**: Vector embeddings (1536 dim) + text segments.
- **`usage_events`**: Token usage & cost tracking.
- **`audit_events`**: Security & privacy audit log.
- **`data_subject_requests`**: GDPR/CCPA request tracking.
- **`schema_migrations`**: Migration history.

## 5. Privacy & Security

- **Row-Level Security (RLS):** Not native DB RLS, but application-level enforcement (`where user_id = ?`).
- **Data Minimization:** Option to hash inputs/outputs.
- **Retention:** Automated cleanup jobs (`privacy:retention`).
- **Audit:** All sensitive actions logged to `audit_events`.
