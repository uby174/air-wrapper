import { getLocalSession } from '@/lib/session';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

export const callApi = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Authorization') && typeof window !== 'undefined') {
    const session = getLocalSession();
    if (session?.token) {
      headers.set('Authorization', `Bearer ${session.token}`);
    }
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API request failed (${response.status}): ${body}`);
  }
  return response.json() as Promise<T>;
};

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobCreateRequest {
  use_case: string;
  input:
    | {
        type: 'text';
        text: string;
        storageUrl?: string;
      }
    | {
        type: 'pdf';
        storageUrl: string;
      };
  options?: {
    rag?: {
      enabled?: boolean;
      storeInputAsDocs?: boolean;
      topK?: number;
    };
    timeoutMs?: number;
  };
}

export interface JobCreateResponse {
  id: string;
  status: JobStatus;
}

export interface JobStatusResponse {
  id: string;
  use_case: string;
  status: JobStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobResultCitation {
  citation_id: string;
  chunk_id: string;
  chunk_text?: string;
  score: number;
  metadata: {
    source: string;
    page?: number;
    chunk_order: number;
    [key: string]: unknown;
  };
}

export interface JobResultResponse {
  id: string;
  status: JobStatus;
  result: Record<string, unknown>;
  citations: JobResultCitation[];
}

export interface JobListItem {
  id: string;
  user_id: string;
  use_case: string;
  status: JobStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobListResponse {
  items: JobListItem[];
}

export interface DevLoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    plan: 'FREE' | 'PRO' | 'BUSINESS';
  };
}

export type PrivacyRequestType = 'export' | 'delete' | 'rectification' | 'restriction' | 'objection' | 'portability';

export interface PrivacyStatusResponse {
  user: {
    id: string;
    email: string;
    plan: 'FREE' | 'PRO' | 'BUSINESS';
    created_at: string;
  };
  consent: {
    privacy_policy_version: string | null;
    terms_version: string | null;
    consented_at: string | null;
    marketing_consent: boolean;
  };
  retention: {
    jobsDays: number;
    documentsDays: number;
    usageEventsDays: number;
    requestsDays: number;
  };
}

export interface PrivacyConsentResponse {
  consented_at: string;
  privacy_policy_version: string;
  terms_version: string | null;
  marketing_consent: boolean;
}

export interface PrivacyRequestResponse {
  id: string;
  request_type: PrivacyRequestType;
  status: 'open' | 'completed' | 'rejected';
  created_at: string;
}

export interface DeleteAccountResponse {
  deleted: boolean;
  message: string;
}

export const createJob = (payload: JobCreateRequest): Promise<JobCreateResponse> =>
  callApi<JobCreateResponse>('/v1/jobs', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const getJobStatus = (id: string): Promise<JobStatusResponse> => callApi<JobStatusResponse>(`/v1/jobs/${id}`);

export const getJobResult = (id: string): Promise<JobResultResponse> => callApi<JobResultResponse>(`/v1/jobs/${id}/result`);

export const listRecentJobs = (limit = 20): Promise<JobListResponse> =>
  callApi<JobListResponse>(`/v1/jobs?limit=${Math.min(Math.max(Math.trunc(limit), 1), 100)}`);

export const devLogin = (payload: { email: string; password: string }): Promise<DevLoginResponse> =>
  callApi<DevLoginResponse>('/v1/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const getPrivacyStatus = (): Promise<PrivacyStatusResponse> => callApi<PrivacyStatusResponse>('/v1/privacy/me/status');

export const updatePrivacyConsent = (payload: {
  privacyPolicyVersion: string;
  termsVersion?: string;
  marketingConsent?: boolean;
}): Promise<PrivacyConsentResponse> =>
  callApi<PrivacyConsentResponse>('/v1/privacy/me/consent', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const createPrivacyRequest = (payload: {
  requestType: PrivacyRequestType;
  note?: string;
}): Promise<PrivacyRequestResponse> =>
  callApi<PrivacyRequestResponse>('/v1/privacy/me/request', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const exportMyData = (): Promise<Record<string, unknown>> =>
  callApi<Record<string, unknown>>('/v1/privacy/me/export');

export const deleteMyAccount = (): Promise<DeleteAccountResponse> =>
  callApi<DeleteAccountResponse>('/v1/privacy/me', {
    method: 'DELETE'
  });
