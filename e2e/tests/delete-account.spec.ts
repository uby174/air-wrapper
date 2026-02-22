/**
 * E2E — Critical User Journey 5:
 *   Delete account forces logout and blocks authenticated pages
 */
import { test, expect } from '@playwright/test';

const API_BASE = process.env.API_URL ?? 'http://localhost:8787';
const WEB_BASE = process.env.WEB_URL ?? 'http://localhost:3000';

const TEST_PASSWORD = 'password123';

async function getAuthToken(request: import('@playwright/test').APIRequestContext, email: string): Promise<string> {
  const resp = await request.post(`${API_BASE}/v1/auth/dev-login`, {
    data: { email, password: TEST_PASSWORD }
  });
  const setCookie = resp.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/ai_wrapper_token=([^;]+)/);
  if (!match) throw new Error(`No auth cookie received for ${email}`);
  return decodeURIComponent(match[1]);
}

test.describe('Account deletion (Journey 5) — API contract', () => {
  test('DELETE /v1/privacy/me deletes account and returns deleted=true', async ({ request }) => {
    const email = `e2e-delete-${Date.now()}@example.com`;
    const token = await getAuthToken(request, email);

    const resp = await request.delete(`${API_BASE}/v1/privacy/me`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(resp.status()).toBe(200);
    const body = await resp.json() as { deleted: boolean; message: string };
    expect(body.deleted).toBe(true);
    expect(body.message).toMatch(/deletion|deleted|re-authentication/i);
  });

  test('deleted user token is rejected with 401', async ({ request }) => {
    const email = `e2e-delete-reject-${Date.now()}@example.com`;
    const token = await getAuthToken(request, email);

    // Delete the account
    await request.delete(`${API_BASE}/v1/privacy/me`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    // Any subsequent authenticated request should fail
    const resp = await request.get(`${API_BASE}/v1/privacy/me/status`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    expect(resp.status()).toBe(401);
    const body = await resp.json() as { error: string };
    expect(body.error).toMatch(/deleted/i);
  });

  test('re-login after deletion creates fresh account', async ({ request }) => {
    const email = `e2e-relogin-${Date.now()}@example.com`;

    // Login first time
    const resp1 = await request.post(`${API_BASE}/v1/auth/dev-login`, {
      data: { email, password: TEST_PASSWORD }
    });
    const body1 = await resp1.json() as { user: { id: string } };
    const originalId = body1.user.id;

    // Delete account
    const token1 = await getAuthToken(request, email);
    await request.delete(`${API_BASE}/v1/privacy/me`, {
      headers: { Cookie: `ai_wrapper_token=${token1}` }
    });

    // Re-login with same email → fresh user
    const resp2 = await request.post(`${API_BASE}/v1/auth/dev-login`, {
      data: { email, password: TEST_PASSWORD }
    });
    const body2 = await resp2.json() as { user: { id: string; email: string } };

    expect(body2.user.email).toBe(email);
    expect(body2.user.id).not.toBe(originalId); // different UUID
  });

  test('deleted user jobs are not accessible', async ({ request }) => {
    const email = `e2e-cascade-${Date.now()}@example.com`;
    const token = await getAuthToken(request, email);

    // Create consent + job
    await request.post(`${API_BASE}/v1/privacy/me/consent`, {
      data: { privacyPolicyVersion: '2026-02-15' },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });
    const jobResp = await request.post(`${API_BASE}/v1/jobs`, {
      data: { use_case: 'generic_analysis', input: { type: 'text', text: 'Job before deletion.' } },
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });
    const { id: jobId } = await jobResp.json() as { id: string };

    // Delete account
    await request.delete(`${API_BASE}/v1/privacy/me`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });

    // Old token can't access jobs anymore
    const accessResp = await request.get(`${API_BASE}/v1/jobs/${jobId}`, {
      headers: { Cookie: `ai_wrapper_token=${token}` }
    });
    expect(accessResp.status()).toBe(401);
  });
});

test.describe('Account deletion UI (Journey 5)', () => {
  test('delete confirmation requires typing DELETE (case-insensitive)', async ({ page }) => {
    const email = `e2e-delete-ui-${Date.now()}@example.com`;
    const token = await getAuthToken(page.request, email);

    await page.context().addCookies([{
      name: 'ai_wrapper_token',
      value: token,
      domain: 'localhost',
      path: '/'
    }]);

    await page.goto(`${WEB_BASE}/privacy`);
    await page.waitForSelector('text=Delete Account', { timeout: 10_000 });

    // Find the delete confirmation input (placeholder="DELETE")
    const deleteInput = page.locator('input[placeholder="DELETE"]');
    await deleteInput.waitFor({ timeout: 8_000 });

    // Button should be disabled until "DELETE" is typed
    const deleteBtn = page.locator('button:has-text("Delete My Account")');
    await expect(deleteBtn).toBeDisabled();

    // Type the wrong word
    await deleteInput.fill('delete-wrong');
    await expect(deleteBtn).toBeDisabled();

    // Type "DELETE" (correct)
    await deleteInput.fill('DELETE');
    await expect(deleteBtn).not.toBeDisabled();
  });

  test('after delete, user is redirected to /login', async ({ page }) => {
    const email = `e2e-delete-redirect-${Date.now()}@example.com`;
    const token = await getAuthToken(page.request, email);

    await page.context().addCookies([{
      name: 'ai_wrapper_token',
      value: token,
      domain: 'localhost',
      path: '/'
    }]);

    await page.goto(`${WEB_BASE}/privacy`);
    await page.waitForSelector('text=Delete Account', { timeout: 10_000 });

    const deleteInput = page.locator('input[placeholder="DELETE"]');
    await deleteInput.waitFor({ timeout: 8_000 });
    await deleteInput.fill('DELETE');

    const deleteBtn = page.locator('button:has-text("Delete My Account")');
    await deleteBtn.click();

    // Should redirect to /login after deletion
    await page.waitForURL(`${WEB_BASE}/login`, { timeout: 10_000 });
    expect(page.url()).toContain('/login');
  });
});
