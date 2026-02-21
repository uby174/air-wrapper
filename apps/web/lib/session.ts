'use client';

export interface LocalSession {
  email: string;
  token: string;
}

const SESSION_STORAGE_KEY = 'ai_wrapper_session';

const toBase64 = (input: string): string => {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  const padding = remainder === 0 ? '' : '='.repeat(4 - remainder);
  return `${normalized}${padding}`;
};

const parseJwtExpiration = (token: string): number | null => {
  const segments = token.split('.');
  if (segments.length !== 3) return null;

  try {
    const payloadRaw = window.atob(toBase64(segments[1] ?? ''));
    const payload = JSON.parse(payloadRaw) as { exp?: unknown };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp;
  } catch {
    return null;
  }
};

export const getLocalSession = (): LocalSession | null => {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<LocalSession>;
    if (typeof parsed.email !== 'string' || !parsed.email.trim()) return null;
    if (typeof parsed.token !== 'string' || !parsed.token.trim()) return null;

    const token = parsed.token.trim();
    const exp = parseJwtExpiration(token);
    if (typeof exp === 'number' && exp <= Math.floor(Date.now() / 1000)) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }

    return {
      email: parsed.email.trim().toLowerCase(),
      token
    };
  } catch {
    return null;
  }
};

export const setLocalSession = (session: LocalSession): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      email: session.email.trim().toLowerCase(),
      token: session.token.trim()
    })
  );
};

export const clearLocalSession = (): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
};
