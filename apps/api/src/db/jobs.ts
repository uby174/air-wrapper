import type { QueryResultRow } from 'pg';
import { query } from './client';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobRecord extends QueryResultRow {
  id: string;
  user_id: string;
  use_case: string;
  status: JobStatus;
  input: unknown;
  result: unknown;
  citations: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateJobRecordInput {
  userId: string;
  useCase: string;
  input: unknown;
}

export interface JobListItem extends QueryResultRow {
  id: string;
  user_id: string;
  use_case: string;
  status: JobStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const createJobRecord = async (params: CreateJobRecordInput): Promise<JobRecord> => {
  const rows = await query<JobRecord>(
    `insert into jobs (user_id, use_case, status, input, result, citations)
     values ($1, $2, 'queued', $3::jsonb, '{}'::jsonb, '[]'::jsonb)
     returning id, user_id, use_case, status, input, result, citations, error, created_at, updated_at`,
    [params.userId, params.useCase, JSON.stringify(params.input)]
  );

  const record = rows[0];
  if (!record) {
    throw new Error('Failed to create job record');
  }
  return record;
};

export const getJobRecord = async (jobId: string): Promise<JobRecord | null> => {
  const rows = await query<JobRecord>(
    `select id, user_id, use_case, status, input, result, citations, error, created_at, updated_at
     from jobs
     where id = $1
     limit 1`,
    [jobId]
  );
  return rows[0] ?? null;
};

export const getJobRecordForUser = async (params: { jobId: string; userId: string }): Promise<JobRecord | null> => {
  const rows = await query<JobRecord>(
    `select id, user_id, use_case, status, input, result, citations, error, created_at, updated_at
     from jobs
     where id = $1 and user_id = $2
     limit 1`,
    [params.jobId, params.userId]
  );
  return rows[0] ?? null;
};

export const listRecentJobs = async (params: { userId: string; limit?: number }): Promise<JobListItem[]> => {
  const { userId, limit = 20 } = params;
  const resolvedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;

  return query<JobListItem>(
    `select id, user_id, use_case, status, error, created_at, updated_at
     from jobs
     where user_id = $2
     order by created_at desc
     limit $1`,
    [resolvedLimit, userId]
  );
};

const setJobStatus = async (jobId: string, status: JobStatus, error: string | null): Promise<void> => {
  await query(
    `update jobs
     set status = $2,
         error = $3
     where id = $1`,
    [jobId, status, error]
  );
};

export const markJobQueued = async (jobId: string, error: string | null = null): Promise<void> =>
  setJobStatus(jobId, 'queued', error);

export const markJobRunning = async (jobId: string): Promise<void> => setJobStatus(jobId, 'running', null);

export const markJobFailed = async (jobId: string, error: string): Promise<void> => setJobStatus(jobId, 'failed', error);

export const markJobSucceeded = async (jobId: string, result: unknown, citations: unknown): Promise<void> => {
  await query(
    `update jobs
     set status = 'succeeded',
         error = null,
         result = $2::jsonb,
         citations = $3::jsonb
     where id = $1`,
    [jobId, JSON.stringify(result), JSON.stringify(citations)]
  );
};
