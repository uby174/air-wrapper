import IORedis from 'ioredis';
import type { UserPlan } from './db/users';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null
});

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const DEFAULT_DAILY_LIMITS: Record<UserPlan, number> = {
  FREE: parsePositiveInt(process.env.RATE_LIMIT_FREE_JOBS_PER_DAY, 10),
  PRO: parsePositiveInt(process.env.RATE_LIMIT_PRO_JOBS_PER_DAY, 100),
  BUSINESS: parsePositiveInt(process.env.RATE_LIMIT_BUSINESS_JOBS_PER_DAY, 1000)
};

export interface RateLimitOutcome {
  allowed: boolean;
  plan: UserPlan;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

const getUtcWindow = (): {
  dayKey: string;
  ttlSeconds: number;
  resetAt: string;
} => {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const tomorrowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  const ttlSeconds = Math.max(1, Math.ceil((tomorrowUtc.getTime() - now.getTime()) / 1000));

  return {
    dayKey,
    ttlSeconds,
    resetAt: tomorrowUtc.toISOString()
  };
};

export const getDailyJobLimitForPlan = (plan: UserPlan): number => DEFAULT_DAILY_LIMITS[plan];

export const consumeDailyJobQuota = async (params: {
  userId: string;
  plan: UserPlan;
}): Promise<RateLimitOutcome> => {
  const { dayKey, ttlSeconds, resetAt } = getUtcWindow();
  const limit = getDailyJobLimitForPlan(params.plan);
  const key = `rate:jobs:${dayKey}:${params.userId}`;

  const used = await redisConnection.incr(key);
  if (used === 1) {
    await redisConnection.expire(key, ttlSeconds);
  }

  const remaining = Math.max(limit - used, 0);
  return {
    allowed: used <= limit,
    plan: params.plan,
    limit,
    used,
    remaining,
    resetAt
  };
};

export const closeRateLimitConnection = async (): Promise<void> => {
  await redisConnection.quit();
};
