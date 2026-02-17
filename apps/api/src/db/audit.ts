import { query } from './client';

export interface AuditEventInput {
  userId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
}

export const writeAuditEvent = async (input: AuditEventInput): Promise<void> => {
  await query(
    `insert into audit_events (user_id, action, metadata)
     values ($1, $2, $3::jsonb)`,
    [input.userId ?? null, input.action, JSON.stringify(input.metadata ?? {})]
  );
};
