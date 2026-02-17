import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyJwtToken } from '../jwt';

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = (header: Record<string, unknown>, payload: Record<string, unknown>, secret: string): string => {
  const encodedHeader = encode(header);
  const encodedPayload = encode(payload);
  const signature = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
};

describe('verifyJwtToken', () => {
  const secret = 'test-secret';

  it('accepts a valid HS256 token with user_id', () => {
    const token = sign(
      { alg: 'HS256', typ: 'JWT' },
      {
        user_id: '8c3dfe79-58df-40cb-a314-c2e96d4f9ff3',
        email: 'user@example.com',
        exp: Math.floor(Date.now() / 1000) + 300
      },
      secret
    );

    const payload = verifyJwtToken(token, secret);
    expect(payload.user_id).toBe('8c3dfe79-58df-40cb-a314-c2e96d4f9ff3');
    expect(payload.email).toBe('user@example.com');
  });

  it('rejects invalid signatures', () => {
    const token = sign(
      { alg: 'HS256', typ: 'JWT' },
      {
        user_id: '8c3dfe79-58df-40cb-a314-c2e96d4f9ff3',
        exp: Math.floor(Date.now() / 1000) + 300
      },
      'wrong-secret'
    );

    expect(() => verifyJwtToken(token, secret)).toThrow(/signature/i);
  });

  it('rejects expired tokens', () => {
    const token = sign(
      { alg: 'HS256', typ: 'JWT' },
      {
        user_id: '8c3dfe79-58df-40cb-a314-c2e96d4f9ff3',
        exp: Math.floor(Date.now() / 1000) - 10
      },
      secret
    );

    expect(() => verifyJwtToken(token, secret)).toThrow(/expired/i);
  });
});
