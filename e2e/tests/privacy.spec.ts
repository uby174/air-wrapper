/**
 * E2E — Critical User Journeys 2 & 4:
 *   2. Save consent success
 *   4. Export data triggers download (verified via API contract)
 *
 * All tests use the API directly (no browser navigation needed for GDPR endpoints).
 * Browser-based tests require the web server to be running.
 */
import { test, expect } from '@playwright/test';

const API_BASE = process.env.API_URL ?? 'http://localhost:8787';
const WEB_BASE = process.env.WEB_URL ?? 'http://localhost:3000';

const TEST_EMAIL = `e2e-privacy-${Date.now()}@example.com`;
const TEST_PASSWORD = 'password123';

// Helper to get a fresh auth token
async function getAuthToken(request: import('@playwright/test').APIRequestContext, email: string): Promise<string> {
  const resp = await request.post(`${API_BASE}/v1/auth/dev-login`, {
    data: { email, password: TEST_PASSWORD }
  });
  const setCookie = resp.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/ai_wrapper_token=([^;]+)/);
  if (!match) throw new Error('No auth cookie received');
  return decodeURIComponent(match[1]);
}

test.describe('Privacy consent (API contract)', () => {
  test('POST /v1/privacy/me/consent saves consent and returns consented_at', async ({ request }) => {
    const token = await getAuthToken(request, TEST_EMAIL);

    const resp = await request.post(`${API_BASE}/v1/privacy/me/consent`, {
      data: {
        privacyPolicyVersion: '2026-02-15',
        termsVersion: '2026-02-15',
        marketingConsent: false
      },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(resp.status()).toBe(200);
    const body = await resp.json() as {
      consented_at: string;
      privacy_policy_version: string;
      terms_version: string;
      marketing_consent: boolean;
    };
    expect(body.consented_at).toBeTruthy();
    expect(body.privacy_policy_version).toBe('2026-02-15');
    expect(body.terms_version).toBe('2026-02-15');
    expect(body.marketing_consent).toBe(false);
  });

  test('GET /v1/privacy/me/status shows consent after saving', async ({ request }) => {
    const token = await getAuthToken(request, TEST_EMAIL);

    // Save consent first
    await request.post(`${API_BASE}/v1/privacy/me/consent`, {
      data: { privacyPolicyVersion: '2026-02-15' },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    // Now check status
    const statusResp = await request.get(`${API_BASE}/v1/privacy/me/status`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(statusResp.status()).toBe(200);
    const body = await statusResp.json() as {
      consent: { consented_at: string | null; privacy_policy_version: string | null };
    };
    expect(body.consent.consented_at).toBeTruthy();
    expect(body.consent.privacy_policy_version).toBe('2026-02-15');
  });

  test('POST /v1/privacy/me/request creates a portability request', async ({ request }) => {
    const token = await getAuthToken(request, TEST_EMAIL);

    const resp = await request.post(`${API_BASE}/v1/privacy/me/request`, {
      data: { requestType: 'portability', note: 'E2E test request' },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    // POST /v1/privacy/me/request returns 200 (no explicit status code set in handler)
    expect(resp.status()).toBe(200);
    const body = await resp.json() as { id: string; request_type: string; status: string };
    expect(body.id).toBeTruthy();
    expect(body.request_type).toBe('portability');
    expect(body.status).toBe('open');
  });
});

test.describe('Data export (Journey 4)', () => {
  test('GET /v1/privacy/me/export returns JSON bundle with required keys', async ({ request }) => {
    const token = await getAuthToken(request, TEST_EMAIL);

    const resp = await request.get(`${API_BASE}/v1/privacy/me/export`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(resp.status()).toBe(200);

    // Verify Content-Disposition suggests a download
    const disposition = resp.headers()['content-disposition'] ?? '';
    expect(disposition).toMatch(/attachment/);
    expect(disposition).toMatch(/\.json/);

    const bundle = await resp.json() as Record<string, unknown>;
    const requiredKeys = ['generated_at', 'user', 'jobs', 'documents', 'chunks', 'usage_events', 'data_subject_requests'];
    for (const key of requiredKeys) {
      expect(bundle).toHaveProperty(key);
    }
    expect(Array.isArray(bundle.jobs)).toBe(true);
    expect(Array.isArray(bundle.documents)).toBe(true);
    expect(bundle.generated_at).toBeTruthy();
  });
});

test.describe('Privacy consent UI', () => {
  test('privacy page loads and shows Consent section', async ({ page }) => {
    const apiCtx = page.request;
    const token = await getAuthToken(apiCtx, TEST_EMAIL);

    // Inject cookie
    await page.context().addCookies([{
      name: 'ai_wrapper_token',
      value: token,
      domain: 'localhost',
      path: '/'
    }]);

    await page.goto(`${WEB_BASE}/privacy`);

    // Page should contain the consent section
    await expect(page.getByText('Save Consent')).toBeVisible({ timeout: 10_000 });
  });

  test('clicking Save Consent shows success feedback', async ({ page }) => {
    const apiCtx = page.request;
    const email = `e2e-consent-ui-${Date.now()}@example.com`;
    const token = await getAuthToken(apiCtx, email);

    await page.context().addCookies([{
      name: 'ai_wrapper_token',
      value: token,
      domain: 'localhost',
      path: '/'
    }]);

    await page.goto(`${WEB_BASE}/privacy`);
    await page.waitForSelector('button:has-text("Save Consent")', { timeout: 10_000 });

    await page.click('button:has-text("Save Consent")');

    // Should show success message
    await expect(page.locator('.text-green-700, [class*="green"]').first()).toBeVisible({ timeout: 8_000 });
  });
});
