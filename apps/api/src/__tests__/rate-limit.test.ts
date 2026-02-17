import { describe, expect, it, vi } from 'vitest';

class FakeRedis {
  private readonly counters = new Map<string, number>();

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

vi.mock('ioredis', () => ({
  default: FakeRedis
}));

describe('consumeDailyJobQuota', () => {
  it('enforces FREE plan daily limit and returns blocked state after limit', async () => {
    const { consumeDailyJobQuota } = await import('../rate-limit');

    const userId = 'cdb3467a-f0ca-4a53-bd12-8a90e987b3da';
    let last = await consumeDailyJobQuota({ userId, plan: 'FREE' });

    for (let i = 0; i < 10; i += 1) {
      last = await consumeDailyJobQuota({ userId, plan: 'FREE' });
    }

    expect(last.limit).toBe(10);
    expect(last.used).toBe(11);
    expect(last.allowed).toBe(false);
    expect(last.remaining).toBe(0);
    expect(last.resetAt).toContain('T00:00:00.000Z');
  });
});
