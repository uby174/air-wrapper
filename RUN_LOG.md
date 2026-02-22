# Run Log

**Date:** 2026-02-22
**Tester:** Claude Code (QA lead role)
**Platform:** Windows 11 / Git Bash / Docker Desktop
**Workspace root:** `C:\Users\engra\Downloads\purify_proper (1)\ai-wrapper`

---

## §1 — Finding Workspace Root

```
$ ls ai-wrapper/
.env  .env.example  apps/  infra/  node_modules/  package.json  packages/  pnpm-workspace.yaml  turbo.json
```

Confirmed:
- `package.json` → `"name": "ai-wrapper"` ✓
- `turbo.json` → tasks: dev, build, lint, typecheck ✓
- `pnpm-workspace.yaml` → packages: apps/*, packages/* ✓

---

## §2 — Infra Boot

```bash
$ docker compose -f infra/docker-compose.yml up -d postgres redis
# Output:
time="..." level=warning msg="version attribute is obsolete"
Container infra-postgres-1 Running
Container infra-redis-1 Running
```

```bash
# .env already present — checked key vars:
DATABASE_URL=postgres://postgres:postgres@postgres:5432/ai_wrapper  # (docker network)
REDIS_URL=redis://redis:6379                                          # (docker network)
AUTH_JWT_SECRET=local-dev-secret-change-me
ADMIN_API_TOKEN=local-dev-admin-change-me
ENABLE_DEV_AUTH=true
REQUIRE_PRIVACY_CONSENT=true
```

---

## §3 — Migrations

```bash
$ DATABASE_URL=postgres://postgres:postgres@localhost:5432/ai_wrapper \
  REDIS_URL=redis://localhost:6379 \
  pnpm --filter @ai-wrapper/api db:migrate

Applying migration 001_init.sql...      Applied 001_init.sql.
Applying migration 002_users_plan.sql... Applied 002_users_plan.sql.
Applying migration 003_gdpr_privacy.sql... Applied 003_gdpr_privacy.sql.
Applying migration 004_webhook_url.sql... Applied 004_webhook_url.sql.
Applying migration 005_batch_id.sql...   Applied 005_batch_id.sql.
Applying migration 006_gobd_audit.sql... Applied 006_gobd_audit.sql.
Applying migration 007_ai_act_logging.sql... Applied 007_ai_act_logging.sql.
Applying migration 008_teams.sql...      Applied 008_teams.sql.
Applying migration 009_integrations.sql... Applied 009_integrations.sql.
Migrations complete.
```

---

## §4 — Stack Health

```bash
# Start API (DISABLE_AI_JOBS_WORKER=true for clean test env)
$ DATABASE_URL=postgres://postgres:postgres@localhost:5432/ai_wrapper \
  REDIS_URL=redis://localhost:6379 \
  AUTH_JWT_SECRET=local-dev-secret-change-me \
  ADMIN_API_TOKEN=local-dev-admin-change-me \
  ENABLE_DEV_AUTH=true REQUIRE_PRIVACY_CONSENT=true \
  DISABLE_AI_JOBS_WORKER=true pnpm --filter @ai-wrapper/api dev &

$ curl -s http://localhost:8787/health
{"ok":true,"service":"api"}
```

Result: **API healthy** ✓

---

## §5 — API Endpoint Verification (curl)

### 5.1 Auth Endpoints

```bash
# dev-login success
$ curl -s -X POST http://localhost:8787/v1/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'

{"user":{"id":"ce3676d2-6308-4cae-b676-1f91167d9f07","email":"test@example.com","plan":"FREE"}}
# STATUS: 200 ✓ | Set-Cookie: ai_wrapper_token=eyJ... HttpOnly; SameSite=Strict
```

```bash
# dev-login invalid email
$ curl -s -X POST http://localhost:8787/v1/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"notanemail","password":"password123"}'

{"success":false,"error":{"issues":[{"validation":"email","code":"invalid_string",
"message":"Invalid email","path":["email"]}],"name":"ZodError"}}
# STATUS: 400 ✓
```

```bash
# dev-login short password
$ curl -s -X POST http://localhost:8787/v1/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"short"}'

{"success":false,"error":{"issues":[{"code":"too_small","minimum":6,"type":"string",
"message":"String must contain at least 6 character(s)","path":["password"]}],"name":"ZodError"}}
# STATUS: 400 ✓
```

```bash
# unauthenticated request to protected endpoint
$ curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/v1/jobs
401 ✓
```

### 5.2 Privacy Endpoints

All commands below use TOKEN acquired from dev-login (qatest@example.com).

```bash
# GET privacy status (no consent yet)
$ curl -s http://localhost:8787/v1/privacy/me/status -H "Cookie: ai_wrapper_token=${TOKEN}"

{"user":{"id":"...","email":"qatest@example.com","plan":"FREE","created_at":"..."},
"consent":{"privacy_policy_version":null,"terms_version":null,"consented_at":null,
"marketing_consent":false},"retention":{"jobsDays":30,"documentsDays":30,...}}
# STATUS: 200 ✓ | consent.consented_at = null (as expected)
```

```bash
# POST consent save
$ curl -s -X POST http://localhost:8787/v1/privacy/me/consent \
  -H "Content-Type: application/json" \
  -H "Cookie: ai_wrapper_token=${TOKEN}" \
  -d '{"privacyPolicyVersion":"2026-02-15","termsVersion":"2026-02-15","marketingConsent":false}'

{"consented_at":"2026-02-22T03:43:30.797Z","privacy_policy_version":"2026-02-15",
"terms_version":"2026-02-15","marketing_consent":false}
# STATUS: 200 ✓
```

```bash
# POST privacy request (portability)
$ curl -s -X POST http://localhost:8787/v1/privacy/me/request \
  -H "Content-Type: application/json" \
  -H "Cookie: ai_wrapper_token=${TOKEN}" \
  -d '{"requestType":"portability","note":"Test data portability request"}'

{"id":"35ce9d22-9b61-4ec1-bac0-413866336fc7","request_type":"portability",
"status":"open","created_at":"2026-02-22T03:43:30.856Z"}
# STATUS: 201 ✓
```

```bash
# GET export
$ curl -s http://localhost:8787/v1/privacy/me/export -H "Cookie: ai_wrapper_token=${TOKEN}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(list(d.keys()))'

['generated_at', 'user', 'jobs', 'documents', 'chunks', 'usage_events', 'data_subject_requests']
# STATUS: 200 ✓ | Content-Disposition: attachment; filename="ai-wrapper-user-export-..."
```

```bash
# DELETE account (separate deleteme@ user)
$ curl -s -X DELETE http://localhost:8787/v1/privacy/me -H "Cookie: ai_wrapper_token=${TOKEN_DELETEME}"

{"deleted":true,"message":"Account and related data deletion has been executed. Re-authentication is required."}
# STATUS: 200 ✓
```

```bash
# Use deleted user's token → must be rejected
$ curl -s http://localhost:8787/v1/privacy/me/status -H "Cookie: ai_wrapper_token=${TOKEN_DELETEME}"

{"error":"User has been deleted. This token is no longer valid. Please sign in again."}
# STATUS: 401 ✓
```

### 5.3 Jobs Endpoints

```bash
# POST job without consent (noconsent@ user)
$ curl -s -X POST http://localhost:8787/v1/jobs \
  -H "Content-Type: application/json" -H "Cookie: ai_wrapper_token=${TOKEN2}" \
  -d '{"use_case":"legal_contract_analysis","input":{"type":"text","text":"Test."}}'

{"error":"Privacy consent is required before creating jobs. Call POST /v1/privacy/me/consent first."}
# STATUS: 412 ✓
```

```bash
# POST job with invalid use_case
$ curl -s -X POST http://localhost:8787/v1/jobs \
  -H "Content-Type: application/json" -H "Cookie: ai_wrapper_token=${TOKEN}" \
  -d '{"use_case":"invalid_vertical","input":{"type":"text","text":"Test."}}'

{"error":"Unknown use_case: 'invalid_vertical'","available":["legal_contract_analysis",
"medical_research_summary","financial_report_analysis","german_vertrag_analyse",
"german_steuerdokument","german_arbeitsrecht","generic_analysis"]}
# STATUS: 400 ✓
```

```bash
# POST job success (qatest@ user has consent)
$ curl -s -X POST http://localhost:8787/v1/jobs \
  -H "Content-Type: application/json" -H "Cookie: ai_wrapper_token=${TOKEN}" \
  -d '{"use_case":"legal_contract_analysis","input":{"type":"text","text":"Analyze this test contract."}}'

{"id":"b2e74bb2-ce1e-4af4-abd0-6aec264c62f4","status":"queued","remainingToday":9}
# STATUS: 202 ✓
```

```bash
# GET job by ID
$ curl -s http://localhost:8787/v1/jobs/b2e74bb2-ce1e-4af4-abd0-6aec264c62f4 \
  -H "Cookie: ai_wrapper_token=${TOKEN}"

{"id":"b2e74bb2-...","batch_id":null,"team_id":null,"webhook_url":null,
"use_case":"legal_contract_analysis","status":"queued","error":null,"created_at":"...","updated_at":"..."}
# STATUS: 200 ✓
```

```bash
# GET job result (queued — not yet processed since worker disabled)
$ curl -s http://localhost:8787/v1/jobs/b2e74bb2-.../result \
  -H "Cookie: ai_wrapper_token=${TOKEN}"

{"id":"b2e74bb2-...","status":"queued"}
# STATUS: 200 ✓ | No result body yet (correct — worker not running)
```

```bash
# GET jobs list with limit
$ curl -s "http://localhost:8787/v1/jobs?limit=5" -H "Cookie: ai_wrapper_token=${TOKEN}"

{"items":[{"id":"b2e74bb2-...","use_case":"legal_contract_analysis","status":"queued",...}]}
# STATUS: 200 ✓
```

### 5.4 Admin Endpoints

```bash
# Admin without token → 401
$ curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:8787/v1/admin/users/00000000-0000-0000-0000-000000000001/plan \
  -H "Content-Type: application/json" -d '{"plan":"PRO"}'
401 ✓
```

---

## §6 — Automated Test Results

```bash
$ DATABASE_URL=postgres://postgres:postgres@localhost:5432/ai_wrapper \
  REDIS_URL=redis://localhost:6379 \
  AUTH_JWT_SECRET=local-dev-secret-change-me \
  pnpm --filter @ai-wrapper/api test

RUN v3.2.4

 ✓ src/privacy/__tests__/data-minimization.test.ts (2 tests) 5ms
 ✓ src/db/__tests__/usage-events.test.ts (1 test) 76ms
 ✓ src/auth/__tests__/jwt.test.ts (3 tests) 14ms
 ✓ src/__tests__/rate-limit.test.ts (1 test) 399ms
 ✓ src/auth/__tests__/middleware.test.ts (6 tests) 269ms
 ✓ src/jobs/__tests__/pipeline-verticals.test.ts (13 tests) 498ms

 Test Files  6 passed (6)
       Tests  26 passed (26)
    Duration  1.92s
```

**All 26 tests pass** ✓

---

## §7 — Summary

| Step | Result |
|------|--------|
| Docker Postgres + Redis start | ✓ Running |
| All 9 migrations applied | ✓ Complete |
| API health endpoint | ✓ 200 OK |
| dev-login success | ✓ 200 + cookie |
| dev-login validation (bad email, short pw) | ✓ 400 |
| Privacy status GET | ✓ 200 |
| Consent save POST | ✓ 200 |
| Privacy request POST (portability) | ✓ 201 |
| Data export GET | ✓ 200 + JSON bundle |
| Account deletion DELETE | ✓ 200 + deleted=true |
| Deleted user token rejected | ✓ 401 |
| Job creation (no consent) | ✓ 412 |
| Job creation (valid) | ✓ 202 |
| Job get by ID | ✓ 200 |
| Job result (queued) | ✓ 200 |
| Jobs list | ✓ 200 |
| Unauthenticated → 401 | ✓ |
| All 26 automated tests | ✓ PASS |
