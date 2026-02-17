import type { QueryResultRow } from 'pg';
import { db, query } from './client';
import type { UserPlan } from './users';

export const DATA_REQUEST_TYPES = [
  'export',
  'delete',
  'rectification',
  'restriction',
  'objection',
  'portability'
] as const;

export type DataRequestType = (typeof DATA_REQUEST_TYPES)[number];

export const DATA_REQUEST_STATUS = ['open', 'completed', 'rejected'] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATUS)[number];

export interface PrivacyStatusRow extends QueryResultRow {
  id: string;
  email: string;
  plan: UserPlan;
  created_at: string;
  privacy_policy_version: string | null;
  terms_version: string | null;
  consented_at: string | null;
  marketing_consent: boolean;
}

export interface DataSubjectRequestRow extends QueryResultRow {
  id: string;
  user_id: string;
  request_type: DataRequestType;
  status: DataRequestStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface UsageEventRow extends QueryResultRow {
  id: string;
  user_id: string;
  use_case: string;
  tokens_in: number;
  tokens_out: number;
  cost_estimate: string;
  created_at: string;
}

interface JobExportRow extends QueryResultRow {
  id: string;
  user_id: string;
  use_case: string;
  status: string;
  input: unknown;
  result: unknown;
  citations: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentExportRow extends QueryResultRow {
  id: string;
  user_id: string;
  title: string;
  source: string;
  created_at: string;
}

interface ChunkExportRow extends QueryResultRow {
  id: string;
  document_id: string;
  chunk_text: string;
  chunk_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface UserDataExportBundle {
  generated_at: string;
  user: PrivacyStatusRow;
  jobs: JobExportRow[];
  documents: DocumentExportRow[];
  chunks: ChunkExportRow[];
  usage_events: UsageEventRow[];
  data_subject_requests: DataSubjectRequestRow[];
}

export interface RetentionCleanupOutcome {
  jobsDeleted: number;
  documentsDeleted: number;
  usageEventsDeleted: number;
  dataRequestsDeleted: number;
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

export const getRetentionConfig = (): {
  jobsDays: number;
  documentsDays: number;
  usageEventsDays: number;
  requestsDays: number;
} => ({
  jobsDays: positiveInt(process.env.DATA_RETENTION_JOBS_DAYS, 30),
  documentsDays: positiveInt(process.env.DATA_RETENTION_DOCUMENTS_DAYS, 30),
  usageEventsDays: positiveInt(process.env.DATA_RETENTION_USAGE_DAYS, 365),
  requestsDays: positiveInt(process.env.DATA_RETENTION_DSR_DAYS, 365)
});

export const getPrivacyStatus = async (userId: string): Promise<PrivacyStatusRow | null> => {
  const rows = await query<PrivacyStatusRow>(
    `select id, email, plan, created_at, privacy_policy_version, terms_version, consented_at, marketing_consent
     from users
     where id = $1
     limit 1`,
    [userId]
  );

  return rows[0] ?? null;
};

export const updateUserConsent = async (params: {
  userId: string;
  privacyPolicyVersion: string;
  termsVersion?: string | null;
  marketingConsent?: boolean;
}): Promise<PrivacyStatusRow> => {
  const rows = await query<PrivacyStatusRow>(
    `update users
     set privacy_policy_version = $2,
         terms_version = coalesce($3, terms_version),
         consented_at = now(),
         marketing_consent = coalesce($4, marketing_consent)
     where id = $1
     returning id, email, plan, created_at, privacy_policy_version, terms_version, consented_at, marketing_consent`,
    [params.userId, params.privacyPolicyVersion, params.termsVersion ?? null, params.marketingConsent ?? null]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`User ${params.userId} not found`);
  }
  return row;
};

export const createDataSubjectRequest = async (params: {
  userId: string;
  requestType: DataRequestType;
  status?: DataRequestStatus;
  note?: string | null;
}): Promise<DataSubjectRequestRow> => {
  const rows = await query<DataSubjectRequestRow>(
    `insert into data_subject_requests (user_id, request_type, status, note)
     values ($1, $2, $3, $4)
     returning id, user_id, request_type, status, note, created_at, updated_at`,
    [params.userId, params.requestType, params.status ?? 'open', params.note ?? null]
  );

  const row = rows[0];
  if (!row) {
    throw new Error('Failed to create data subject request');
  }
  return row;
};

export const exportUserDataBundle = async (userId: string): Promise<UserDataExportBundle> => {
  const user = await getPrivacyStatus(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const [jobs, documents, chunks, usageEvents, requests] = await Promise.all([
    query<JobExportRow>(
      `select id, user_id, use_case, status, input, result, citations, error, created_at, updated_at
       from jobs
       where user_id = $1
       order by created_at asc`,
      [userId]
    ),
    query<DocumentExportRow>(
      `select id, user_id, title, source, created_at
       from documents
       where user_id = $1
       order by created_at asc`,
      [userId]
    ),
    query<ChunkExportRow>(
      `select c.id, c.document_id, c.chunk_text, c.chunk_order, c.metadata, c.created_at
       from chunks c
       join documents d on d.id = c.document_id
       where d.user_id = $1
       order by c.created_at asc`,
      [userId]
    ),
    query<UsageEventRow>(
      `select id, user_id, use_case, tokens_in, tokens_out, cost_estimate, created_at
       from usage_events
       where user_id = $1
       order by created_at asc`,
      [userId]
    ),
    query<DataSubjectRequestRow>(
      `select id, user_id, request_type, status, note, created_at, updated_at
       from data_subject_requests
       where user_id = $1
       order by created_at asc`,
      [userId]
    )
  ]);

  return {
    generated_at: new Date().toISOString(),
    user,
    jobs,
    documents,
    chunks,
    usage_events: usageEvents,
    data_subject_requests: requests
  };
};

export const deleteUserAndCascadeData = async (params: {
  userId: string;
  reason?: string;
}): Promise<{ deleted: boolean }> => {
  const client = await db.connect();
  try {
    await client.query('begin');

    await client.query(
      `insert into deleted_users (id, reason)
       values ($1, $2)
       on conflict (id) do update set deleted_at = now(), reason = excluded.reason`,
      [params.userId, params.reason ?? 'user_requested']
    );

    await client.query(
      `insert into data_subject_requests (user_id, request_type, status, note)
       values ($1, 'delete', 'completed', $2)`,
      [params.userId, params.reason ?? null]
    );

    const deleted = await client.query<{ id: string }>(
      `delete from users
       where id = $1
       returning id`,
      [params.userId]
    );

    await client.query('commit');
    return {
      deleted: Boolean(deleted.rows[0]?.id)
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

export const isUserDeleted = async (userId: string): Promise<boolean> => {
  const rows = await query<{ id: string }>(
    `select id
     from deleted_users
     where id = $1
     limit 1`,
    [userId]
  );
  return Boolean(rows[0]?.id);
};

export const runRetentionCleanup = async (): Promise<RetentionCleanupOutcome> => {
  const config = getRetentionConfig();
  const client = await db.connect();

  try {
    await client.query('begin');

    const jobs = await client.query<{ id: string }>(
      `delete from jobs
       where status in ('succeeded', 'failed')
         and created_at < now() - make_interval(days => $1)
       returning id`,
      [config.jobsDays]
    );

    const docs = await client.query<{ id: string }>(
      `delete from documents
       where created_at < now() - make_interval(days => $1)
       returning id`,
      [config.documentsDays]
    );

    const usage = await client.query<{ id: string }>(
      `delete from usage_events
       where created_at < now() - make_interval(days => $1)
       returning id`,
      [config.usageEventsDays]
    );

    const requests = await client.query<{ id: string }>(
      `delete from data_subject_requests
       where status = 'completed'
         and created_at < now() - make_interval(days => $1)
       returning id`,
      [config.requestsDays]
    );

    await client.query('commit');

    return {
      jobsDeleted: jobs.rowCount ?? 0,
      documentsDeleted: docs.rowCount ?? 0,
      usageEventsDeleted: usage.rowCount ?? 0,
      dataRequestsDeleted: requests.rowCount ?? 0
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};
