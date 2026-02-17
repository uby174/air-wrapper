'use client';

export interface LocalSession {
  email: string;
  token: string;
}

const SESSION_STORAGE_KEY = 'ai_wrapper_session';

export const getLocalSession = (): LocalSession | null => {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<LocalSession>;
    if (typeof parsed.email !== 'string' || !parsed.email.trim()) return null;
    if (typeof parsed.token !== 'string' || !parsed.token.trim()) return null;
    return {
      email: parsed.email.trim().toLowerCase(),
      token: parsed.token.trim()
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
