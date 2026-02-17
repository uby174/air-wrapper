import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const jwtHeaderSchema = z.object({
  alg: z.string(),
  typ: z.string().optional()
});

const jwtPayloadSchema = z
  .object({
    user_id: z.string().uuid(),
    email: z.string().email().optional(),
    exp: z.number().optional(),
    iat: z.number().optional()
  })
  .passthrough();

const toBase64 = (input: string): string => {
  const remainder = input.length % 4;
  const padding = remainder === 0 ? '' : '='.repeat(4 - remainder);
  return `${input}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
};

const decodeBase64Url = (input: string): string => Buffer.from(toBase64(input), 'base64').toString('utf-8');

const parseJsonObject = (raw: string, label: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${label} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JWT ${label}: ${error instanceof Error ? error.message : 'Unknown parse error'}`);
  }
};

const createSignature = (value: string, secret: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url');

export type JwtAuthPayload = z.infer<typeof jwtPayloadSchema>;

export interface JwtSignInput {
  user_id: string;
  email?: string;
}

const jwtSignInputSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().email().optional()
});

export const signJwtToken = (input: JwtSignInput, secret: string, expiresInSeconds = 60 * 60 * 24): string => {
  if (!secret.trim()) {
    throw new Error('JWT secret is empty');
  }

  const normalized = jwtSignInputSchema.parse(input);
  const nowEpochSec = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? Math.trunc(expiresInSeconds) : 60 * 60 * 24;
  const exp = nowEpochSec + ttl;

  const headerEncoded = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadEncoded = Buffer.from(
    JSON.stringify({
      user_id: normalized.user_id,
      ...(normalized.email ? { email: normalized.email } : {}),
      iat: nowEpochSec,
      exp
    })
  ).toString('base64url');

  const signatureEncoded = createSignature(`${headerEncoded}.${payloadEncoded}`, secret);
  return `${headerEncoded}.${payloadEncoded}.${signatureEncoded}`;
};

export const verifyJwtToken = (token: string, secret: string): JwtAuthPayload => {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error('JWT token is empty');
  }

  if (!secret.trim()) {
    throw new Error('JWT secret is empty');
  }

  const segments = trimmed.split('.');
  if (segments.length !== 3) {
    throw new Error('JWT token must have three segments');
  }

  const [headerEncoded, payloadEncoded, signatureEncoded] = segments;
  const headerRaw = decodeBase64Url(headerEncoded);
  const payloadRaw = decodeBase64Url(payloadEncoded);

  const header = jwtHeaderSchema.parse(parseJsonObject(headerRaw, 'header'));
  if (header.alg !== 'HS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}`);
  }

  const expectedSignature = createSignature(`${headerEncoded}.${payloadEncoded}`, secret);
  const actualBuffer = Buffer.from(signatureEncoded);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('JWT signature verification failed');
  }

  const payload = jwtPayloadSchema.parse(parseJsonObject(payloadRaw, 'payload'));

  if (typeof payload.exp === 'number') {
    const nowEpochSec = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowEpochSec) {
      throw new Error('JWT token is expired');
    }
  }

  return payload;
};
