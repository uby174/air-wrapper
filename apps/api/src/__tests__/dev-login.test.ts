/**
 * Integration tests for POST /v1/auth/dev-login
 * Covers: happy path, invalid payload, disabled flag behavior
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { signJwtToken } from '../auth/jwt';

// Mock db and rate-limit dependencies so tests don't need a real DB
const { upsertUserByEmailMock } = vi.hoisted(() => ({
  upsertUserByEmailMock: vi.fn()
}));
const { writeAuditEventMock } = vi.hoisted(() => ({
  writeAuditEventMock: vi.fn()
}));

vi.mock('../db/users', () => ({
  upsertUserByEmail: upsertUserByEmailMock
}));

vi.mock('../db/audit', () => ({
  writeAuditEvent: writeAuditEventMock
}));

const devLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const buildTestApp = (enableDevAuth: boolean, jwtSecret: string | undefined) => {
  const app = new Hono();

  app.post('/v1/auth/dev-login', zValidator('json', devLoginSchema), async (c) => {
    if (!enableDevAuth) {
      return c.json({ error: 'Dev auth is disabled.' }, 404);
    }

    if (!jwtSecret) {
      return c.json({ error: 'Server JWT auth is not configured. Set AUTH_JWT_SECRET.' }, 500);
    }

    const payload = c.req.valid('json');
    const user = await upsertUserByEmailMock(payload.email);
    const token = signJwtToken({ user_id: user.id, email: user.email }, jwtSecret, 86400);

    c.header('Set-Cookie', `ai_wrapper_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`);

    void writeAuditEventMock({ userId: user.id, action: 'auth.dev_login.success', metadata: { enableDevAuth } });

    return c.json({ user: { id: user.id, email: user.email, plan: user.plan } });
  });

  return app;
};

describe('POST /v1/auth/dev-login', () => {
  const testUser = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    email: 'test@example.com',
    plan: 'FREE'
  };

  beforeEach(() => {
    upsertUserByEmailMock.mockReset();
    writeAuditEventMock.mockReset();
    writeAuditEventMock.mockResolvedValue(undefined);
  });

  it('returns user object and sets auth cookie on success', async () => {
    upsertUserByEmailMock.mockResolvedValue(testUser);
    const app = buildTestApp(true, 'test-secret');

    const response = await app.request('http://localhost/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string; email: string; plan: string } };
    expect(body.user.id).toBe(testUser.id);
    expect(body.user.email).toBe(testUser.email);
    expect(body.user.plan).toBe('FREE');

    const setCookie = response.headers.get('Set-Cookie');
    expect(setCookie).toMatch(/ai_wrapper_token=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
  });

  it('returns 400 for invalid email', async () => {
    const app = buildTestApp(true, 'test-secret');

    const response = await app.request('http://localhost/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'notanemail', password: 'password123' })
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(false);
    expect(upsertUserByEmailMock).not.toHaveBeenCalled();
  });

  it('returns 400 for short password (<6 chars)', async () => {
    const app = buildTestApp(true, 'test-secret');

    const response = await app.request('http://localhost/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'abc' })
    });

    expect(response.status).toBe(400);
    expect(upsertUserByEmailMock).not.toHaveBeenCalled();
  });

  it('returns 400 for missing body fields', async () => {
    const app = buildTestApp(true, 'test-secret');

    const response = await app.request('http://localhost/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
  });

  it('returns 404 when ENABLE_DEV_AUTH is false', async () => {
    const app = buildTestApp(false, 'test-secret');

    const response = await app.request('http://localhost/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/disabled/i);
    expect(upsertUserByEmailMock).not.toHaveBeenCalled();
  });

  it('returns 500 when AUTH_JWT_SECRET is not configured', async () => {
    const app = buildTestApp(true, undefined);

    const response = await app.request('http://localhost/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/AUTH_JWT_SECRET/i);
  });

  it('token in Set-Cookie is a valid JWT containing user_id', async () => {
    upsertUserByEmailMock.mockResolvedValue(testUser);
    const secret = 'integration-test-secret';
    const app = buildTestApp(true, secret);

    const response = await app.request('http://localhost/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
    });

    expect(response.status).toBe(200);
    const setCookie = response.headers.get('Set-Cookie') ?? '';
    const tokenMatch = setCookie.match(/ai_wrapper_token=([^;]+)/);
    expect(tokenMatch).not.toBeNull();

    const rawToken = decodeURIComponent(tokenMatch![1]);
    const [, payloadB64] = rawToken.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as {
      user_id: string;
      email: string;
      exp: number;
    };

    expect(payload.user_id).toBe(testUser.id);
    expect(payload.email).toBe(testUser.email);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
