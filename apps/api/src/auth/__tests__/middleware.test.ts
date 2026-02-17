import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware } from '../middleware';

const { ensureUserForAuthMock } = vi.hoisted(() => ({
  ensureUserForAuthMock: vi.fn()
}));
const { isUserDeletedMock } = vi.hoisted(() => ({
  isUserDeletedMock: vi.fn()
}));

vi.mock('../../db/users', () => ({
  ensureUserForAuth: ensureUserForAuthMock
}));

vi.mock('../../db/privacy', () => ({
  isUserDeleted: isUserDeletedMock
}));

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const createToken = (secret: string): string => {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    user_id: '709a38d1-ab95-4f39-b0d6-5f5f9efe0e90',
    email: 'test@example.com',
    exp: Math.floor(Date.now() / 1000) + 300
  });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
};

describe('authMiddleware', () => {
  beforeEach(() => {
    ensureUserForAuthMock.mockReset();
    isUserDeletedMock.mockReset();
    isUserDeletedMock.mockResolvedValue(false);
    process.env.AUTH_JWT_SECRET = 'middleware-secret';
  });

  it('rejects unauthenticated requests', async () => {
    const app = new Hono();
    app.use('/v1/*', authMiddleware);
    app.get('/v1/test', (c) => c.json({ ok: true }));

    const response = await app.request('http://localhost/v1/test');
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/authorization/i);
  });

  it('allows valid JWT requests and attaches user context', async () => {
    ensureUserForAuthMock.mockResolvedValue({
      id: '709a38d1-ab95-4f39-b0d6-5f5f9efe0e90',
      email: 'test@example.com',
      plan: 'FREE',
      created_at: new Date().toISOString()
    });

    const app = new Hono<{ Variables: { authUser: { userId: string; email: string; plan: 'FREE' | 'PRO' | 'BUSINESS' } } }>();
    app.use('/v1/*', authMiddleware);
    app.get('/v1/test', (c) => c.json(c.get('authUser')));

    const response = await app.request('http://localhost/v1/test', {
      headers: {
        Authorization: `Bearer ${createToken('middleware-secret')}`
      }
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { userId: string; email: string; plan: string };
    expect(body.userId).toBe('709a38d1-ab95-4f39-b0d6-5f5f9efe0e90');
    expect(body.plan).toBe('FREE');
  });

  it('rejects tokens for deleted users', async () => {
    isUserDeletedMock.mockResolvedValue(true);

    const app = new Hono();
    app.use('/v1/*', authMiddleware);
    app.get('/v1/test', (c) => c.json({ ok: true }));

    const response = await app.request('http://localhost/v1/test', {
      headers: {
        Authorization: `Bearer ${createToken('middleware-secret')}`
      }
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/deleted/i);
  });
});
