import { query } from './client';

interface UserRow {
  id: string;
}

interface InsertUsageEventInput {
  useCase: string;
  tokensIn: number;
  tokensOut: number;
  costEstimate: number;
  userId?: string;
}

let cachedDefaultUserId: string | null = null;

const defaultUsageEmail = process.env.USAGE_DEFAULT_EMAIL ?? 'usage-local@ai-wrapper.local';

export const resolveDefaultUsageUserId = async (): Promise<string> => {
  if (cachedDefaultUserId) return cachedDefaultUserId;

  const rows = await query<UserRow>(
    `insert into users (email)
     values ($1)
     on conflict (email) do update set email = excluded.email
     returning id`,
    [defaultUsageEmail]
  );

  const userId = rows[0]?.id;
  if (!userId) {
    throw new Error('Failed to resolve default usage user ID');
  }

  cachedDefaultUserId = userId;
  return userId;
};

export const writeUsageEvent = async (input: InsertUsageEventInput): Promise<void> => {
  const resolvedUserId = input.userId ?? (await resolveDefaultUsageUserId());
  const tokensIn = Math.max(0, Math.round(input.tokensIn));
  const tokensOut = Math.max(0, Math.round(input.tokensOut));
  const costEstimate = Number(Math.max(0, input.costEstimate).toFixed(6));

  await query(
    `insert into usage_events (user_id, use_case, tokens_in, tokens_out, cost_estimate)
     values ($1, $2, $3, $4, $5)`,
    [resolvedUserId, input.useCase, tokensIn, tokensOut, costEstimate]
  );
};
