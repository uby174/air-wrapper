import type { QueryResultRow } from 'pg';
import { query } from './client';

export const USER_PLAN_VALUES = ['FREE', 'PRO', 'BUSINESS'] as const;
export type UserPlan = (typeof USER_PLAN_VALUES)[number];

export interface UserRecord extends QueryResultRow {
  id: string;
  email: string;
  plan: UserPlan;
  created_at: string;
}

const planSet = new Set<string>(USER_PLAN_VALUES);

const normalizePlan = (plan: unknown): UserPlan => {
  if (typeof plan === 'string') {
    const upper = plan.trim().toUpperCase();
    if (planSet.has(upper)) {
      return upper as UserPlan;
    }
  }
  return 'FREE';
};

const fallbackEmailForUserId = (userId: string): string => `user-${userId}@auth.local`;

export const getUserById = async (userId: string): Promise<UserRecord | null> => {
  const rows = await query<UserRecord>(
    `select id, email, plan, created_at
     from users
     where id = $1
     limit 1`,
    [userId]
  );

  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    plan: normalizePlan(row.plan)
  };
};

export const ensureUserForAuth = async (params: {
  userId: string;
  emailHint?: string | null;
}): Promise<UserRecord> => {
  const existing = await getUserById(params.userId);
  if (existing) {
    return existing;
  }

  const email =
    typeof params.emailHint === 'string' && params.emailHint.trim().length > 0
      ? params.emailHint.trim().toLowerCase()
      : fallbackEmailForUserId(params.userId);

  await query(
    `insert into users (id, email, plan)
     values ($1, $2, 'FREE')
     on conflict (id) do nothing`,
    [params.userId, email]
  );

  const created = await getUserById(params.userId);
  if (!created) {
    throw new Error(`Failed to resolve user ${params.userId}`);
  }
  return created;
};

export const updateUserPlan = async (params: { userId: string; plan: UserPlan }): Promise<UserRecord | null> => {
  const rows = await query<UserRecord>(
    `update users
     set plan = $2
     where id = $1
     returning id, email, plan, created_at`,
    [params.userId, params.plan]
  );

  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    plan: normalizePlan(row.plan)
  };
};

export const upsertUserByEmail = async (email: string): Promise<UserRecord> => {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error('Email is required');
  }

  const rows = await query<UserRecord>(
    `insert into users (email, plan)
     values ($1, 'FREE')
     on conflict (email) do update set email = excluded.email
     returning id, email, plan, created_at`,
    [normalizedEmail]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`Failed to upsert user ${normalizedEmail}`);
  }

  return {
    ...row,
    plan: normalizePlan(row.plan)
  };
};
