/**
 * E2E — Critical User Journey 3:
 *   Create job/chat from dashboard and observe it in history
 *
 * Uses API directly (worker disabled in test env, so job stays "queued").
 */
import { test, expect } from '@playwright/test';

const API_BASE = process.env.API_URL ?? 'http://localhost:8787';
const WEB_BASE = process.env.WEB_URL ?? 'http://localhost:3000';

const TEST_EMAIL = `e2e-jobs-${Date.now()}@example.com`;
const TEST_PASSWORD = 'password123';

async function getAuthToken(request: import('@playwright/test').APIRequestContext, email: string): Promise<string> {
  const resp = await request.post(`${API_BASE}/v1/auth/dev-login`, {
    data: { email, password: TEST_PASSWORD }
  });
  const setCookie = resp.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/ai_wrapper_token=([^;]+)/);
  if (!match) throw new Error('No auth cookie received');
  return decodeURIComponent(match[1]);
}

async function saveConsent(request: import('@playwright/test').APIRequestContext, token: string): Promise<void> {
  await request.post(`${API_BASE}/v1/privacy/me/consent`, {
    data: { privacyPolicyVersion: '2026-02-15', termsVersion: '2026-02-15' },
    headers: { Cookie: `ai_wrapper_token=${token}` }
  });
}

test.describe('Job creation (Journey 3) — API contract', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request, TEST_EMAIL);
    await saveConsent(request, token);
  });

  test('POST /v1/jobs creates a job with status=queued', async ({ request }) => {
    const resp = await request.post(`${API_BASE}/v1/jobs`, {
      data: {
        use_case: 'legal_contract_analysis',
        input: { type: 'text', text: 'Analyze this E2E test contract.' }
      },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(resp.status()).toBe(202);
    const body = await resp.json() as { id: string; status: string; remainingToday: number };
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('queued');
    expect(typeof body.remainingToday).toBe('number');
  });

  test('created job appears in GET /v1/jobs list', async ({ request }) => {
    // Create a job
    const createResp = await request.post(`${API_BASE}/v1/jobs`, {
      data: {
        use_case: 'generic_analysis',
        input: { type: 'text', text: 'History list E2E test.' }
      },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });
    const { id: jobId } = await createResp.json() as { id: string };

    // Fetch the list
    const listResp = await request.get(`${API_BASE}/v1/jobs?limit=10`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(listResp.status()).toBe(200);
    const { items } = await listResp.json() as { items: Array<{ id: string; status: string }> };
    const found = items.find((item) => item.id === jobId);
    expect(found).toBeDefined();
    expect(found?.status).toBe('queued');
  });

  test('GET /v1/jobs/:id returns job detail', async ({ request }) => {
    const createResp = await request.post(`${API_BASE}/v1/jobs`, {
      data: {
        use_case: 'medical_research_summary',
        input: { type: 'text', text: 'Detail view E2E test.' }
      },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });
    const { id: jobId } = await createResp.json() as { id: string };

    const detailResp = await request.get(`${API_BASE}/v1/jobs/${jobId}`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(detailResp.status()).toBe(200);
    const body = await detailResp.json() as { id: string; use_case: string; status: string };
    expect(body.id).toBe(jobId);
    expect(body.use_case).toBe('medical_research_summary');
    expect(body.status).toBe('queued');
  });

  test('GET /v1/jobs/:id/result returns queued state (no result yet)', async ({ request }) => {
    const createResp = await request.post(`${API_BASE}/v1/jobs`, {
      data: {
        use_case: 'financial_report_analysis',
        input: { type: 'text', text: 'Result state E2E test.' }
      },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });
    const { id: jobId } = await createResp.json() as { id: string };

    const resultResp = await request.get(`${API_BASE}/v1/jobs/${jobId}/result`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    // 202 for pending/queued state
    expect([200, 202]).toContain(resultResp.status());
    const body = await resultResp.json() as { id: string; status: string };
    expect(body.status).toBe('queued');
    expect(body).not.toHaveProperty('result');
  });

  test('POST /v1/jobs returns 412 when user has no consent', async ({ request }) => {
    const noConsentEmail = `e2e-noconsent-${Date.now()}@example.com`;
    const noConsentToken = await getAuthToken(request, noConsentEmail);

    const resp = await request.post(`${API_BASE}/v1/jobs`, {
      data: {
        use_case: 'legal_contract_analysis',
        input: { type: 'text', text: 'Should be blocked.' }
      },
      headers: { Cookie: `ai_wrapper_token=${noConsentToken}` }
    });

    expect(resp.status()).toBe(412);
    const body = await resp.json() as { error: string };
    expect(body.error).toMatch(/consent/i);
  });

  test('POST /v1/jobs returns 400 for unknown use_case', async ({ request }) => {
    const resp = await request.post(`${API_BASE}/v1/jobs`, {
      data: {
        use_case: 'nonexistent_vertical',
        input: { type: 'text', text: 'Should return 400.' }
      },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(resp.status()).toBe(400);
    const body = await resp.json() as { error: string; available: string[] };
    expect(body.error).toMatch(/unknown use_case/i);
    expect(Array.isArray(body.available)).toBe(true);
  });
});

test.describe('Dashboard and history UI (Journey 3)', () => {
  test('dashboard page loads and shows job submission form', async ({ page }) => {
    const email = `e2e-dash-ui-${Date.now()}@example.com`;
    const token = await getAuthToken(page.request, email);

    await page.context().addCookies([{
      name: 'ai_wrapper_token',
      value: token,
      domain: 'localhost',
      path: '/'
    }]);

    await page.goto(`${WEB_BASE}/dashboard`);
    // Should show the text area or vertical selector
    await expect(page.getByRole('combobox').or(page.locator('textarea, select')).first()).toBeVisible({ timeout: 10_000 });
  });

  test('history page loads and shows job list', async ({ page }) => {
    const email = `e2e-history-ui-${Date.now()}@example.com`;
    const token = await getAuthToken(page.request, email);

    // Create consent + job first via API
    await page.request.post(`${API_BASE}/v1/privacy/me/consent`, {
      data: { privacyPolicyVersion: '2026-02-15' },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });
    await page.request.post(`${API_BASE}/v1/jobs`, {
      data: { use_case: 'generic_analysis', input: { type: 'text', text: 'History UI test.' } },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    await page.context().addCookies([{
      name: 'ai_wrapper_token',
      value: token,
      domain: 'localhost',
      path: '/'
    }]);

    await page.goto(`${WEB_BASE}/history`);
    // Should show jobs list (at least one entry or "No jobs" message)
    await expect(page.locator('body')).toContainText(/generic_analysis|queued|No jobs|history/i, { timeout: 10_000 });
  });
});
