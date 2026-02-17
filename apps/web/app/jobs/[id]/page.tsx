'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getJobResult, getJobStatus, type JobResultCitation, type JobResultResponse, type JobStatusResponse } from '@/lib/api';
import { getLocalSession } from '@/lib/session';
import { verticalNameById } from '@/lib/verticals';

const toSectionTitle = (value: string): string =>
  value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());

const formatDateTime = (value: string): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
};

const statusVariant = (status: string): 'secondary' | 'warning' | 'success' | 'destructive' => {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'running') return 'warning';
  return 'secondary';
};

const isPrimitive = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const decodeJsonLikeString = (value: string): string =>
  value
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .trim();

const extractJsonLikeStringField = (source: string, fieldName: string): string | null => {
  const trimmed = source.trim();
  const strict = new RegExp(`"${fieldName}"\\s*:\\s*"([\\s\\S]*?)"(?=\\s*,\\s*"|\\s*[,}]|\\s*$)`, 'i');
  const strictMatch = trimmed.match(strict);
  if (strictMatch?.[1]) return decodeJsonLikeString(strictMatch[1]);

  const tolerant = new RegExp(`"${fieldName}"\\s*:\\s*"([\\s\\S]*?)(?=\\n\\s*"\\w+"\\s*:|\\s*$)`, 'i');
  const tolerantMatch = trimmed.match(tolerant);
  if (!tolerantMatch?.[1]) return null;
  return decodeJsonLikeString(tolerantMatch[1].replace(/",\s*$/, ''));
};

const extractJsonLikeStringArrayField = (source: string, fieldName: string): string[] => {
  const trimmed = source.trim();
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i');
  const match = trimmed.match(pattern);
  if (!match?.[1]) return [];

  const items: string[] = [];
  const itemRegex = /"((?:\\.|[^"\\])*)"/g;
  for (const itemMatch of match[1].matchAll(itemRegex)) {
    const decoded = decodeJsonLikeString(itemMatch[1] ?? '');
    if (decoded.length > 0) {
      items.push(decoded);
    }
  }

  return items;
};

const extractJsonLikeObjectArrayField = (
  source: string,
  fieldName: string,
  requiredKeys: string[]
): Array<Record<string, string>> => {
  const trimmed = source.trim();
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i');
  const match = trimmed.match(pattern);
  if (!match?.[1]) return [];

  const items: Array<Record<string, string>> = [];
  const objectRegex = /\{([\s\S]*?)\}/g;

  for (const objectMatch of match[1].matchAll(objectRegex)) {
    const block = `{${objectMatch[1] ?? ''}}`;
    const item: Record<string, string> = {};
    let valid = true;

    for (const key of requiredKeys) {
      const extracted = extractJsonLikeStringField(block, key);
      if (!extracted) {
        valid = false;
        break;
      }
      item[key] = extracted;
    }

    if (valid) {
      items.push(item);
    }
  }

  return items;
};

const parseJsonLikeObject = (value: string): Record<string, unknown> | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  if (trimmed.startsWith('```')) {
    candidates.push(trimmed.replace(/^```(?:json)?\s*/i, '').trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Best-effort parse attempts only.
    }
  }

  const recovered: Record<string, unknown> = {};
  const stringFields = ['summary', 'disclaimer', 'executive_summary', 'evidence_summary', 'research_question'];
  const stringArrayFields = ['obligations', 'recommendations', 'risk_flags', 'key_findings', 'limitations', 'safety_notes'];

  for (const field of stringFields) {
    const extracted = extractJsonLikeStringField(trimmed, field);
    if (extracted) {
      recovered[field] = extracted;
    }
  }

  for (const field of stringArrayFields) {
    const extracted = extractJsonLikeStringArrayField(trimmed, field);
    if (extracted.length > 0) {
      recovered[field] = extracted;
    }
  }

  const recoveredLegalRisks = extractJsonLikeObjectArrayField(trimmed, 'key_risks', [
    'clause',
    'risk_level',
    'explanation'
  ]);
  if (recoveredLegalRisks.length > 0) {
    recovered.key_risks = recoveredLegalRisks;
  }

  const recoveredMetrics = extractJsonLikeObjectArrayField(trimmed, 'key_metrics', ['metric', 'value', 'interpretation']);
  if (recoveredMetrics.length > 0) {
    recovered.key_metrics = recoveredMetrics;
  }

  return Object.keys(recovered).length > 0 ? recovered : null;
};

const normalizeStructuredResult = (input: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = { ...input };

  const mergeIfMissing = (key: string, candidate: unknown): void => {
    if (candidate === undefined) return;

    const current = normalized[key];
    const currentEmpty =
      current === undefined ||
      current === null ||
      (typeof current === 'string' && current.trim().length === 0) ||
      (Array.isArray(current) && current.length === 0);

    if (currentEmpty) {
      normalized[key] = candidate;
    }
  };

  const nestedCarrierFields = ['summary', 'executive_summary', 'evidence_summary'];
  for (const field of nestedCarrierFields) {
    const carrier = normalized[field];
    if (typeof carrier !== 'string' || carrier.trim().length === 0) continue;

    const nested = parseJsonLikeObject(carrier);
    if (!nested) continue;

    const nestedCarrier = nested[field];
    if (typeof nestedCarrier === 'string' && nestedCarrier.trim().length > 0) {
      normalized[field] = nestedCarrier.trim();
    } else {
      const recovered = extractJsonLikeStringField(carrier, field);
      if (recovered) {
        normalized[field] = recovered;
      }
    }

    for (const [key, value] of Object.entries(nested)) {
      mergeIfMissing(key, value);
    }
  }

  return normalized;
};

const RenderFieldValue = ({ value }: { value: unknown }) => {
  if (isPrimitive(value)) {
    return <p className="whitespace-pre-wrap text-sm text-foreground">{String(value)}</p>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-sm text-muted-foreground">No structured items extracted.</p>;

    if (value.every((item) => isPrimitive(item))) {
      return (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {value.map((item, index) => (
            <li key={`${String(item)}-${index}`}>{String(item)}</li>
          ))}
        </ul>
      );
    }

    if (value.every((item) => isRecord(item) && Object.values(item).every((nested) => isPrimitive(nested)))) {
      return (
        <div className="space-y-2">
          {value.map((item, index) => (
            <div key={`object-item-${index}`} className="rounded-md border border-border bg-secondary p-3 text-sm">
              {Object.entries(item as Record<string, unknown>).map(([key, nestedValue]) => (
                <p key={`${key}-${index}`} className="leading-6">
                  <span className="font-medium">{toSectionTitle(key)}:</span>{' '}
                  <span>{nestedValue === null ? 'N/A' : String(nestedValue)}</span>
                </p>
              ))}
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <pre key={`json-${index}`} className="overflow-x-auto rounded-md bg-secondary p-3 text-xs">
            {JSON.stringify(item, null, 2)}
          </pre>
        ))}
      </div>
    );
  }

  if (typeof value === 'object') {
    return (
      <pre className="overflow-x-auto rounded-md bg-secondary p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }

  return <p className="text-sm text-muted-foreground">Unsupported value.</p>;
};

const normalizeCitations = (value: unknown): JobResultCitation[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JobResultCitation => typeof item === 'object' && item !== null);
};

export default function JobDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const jobId = typeof params.id === 'string' ? params.id : '';

  const [job, setJob] = useState<JobStatusResponse | null>(null);
  const [result, setResult] = useState<JobResultResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(null);

  const citations = useMemo(() => normalizeCitations(result?.citations ?? []), [result?.citations]);
  const normalizedResult = useMemo(
    () => normalizeStructuredResult((result?.result ?? {}) as Record<string, unknown>),
    [result?.result]
  );
  const selectedCitation = citations.find((citation) => citation.citation_id === selectedCitationId) ?? citations[0] ?? null;

  useEffect(() => {
    if (!getLocalSession()) {
      router.replace('/login');
    }
  }, [router]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const status = await getJobStatus(jobId);
        if (cancelled) return;
        setJob(status);

        if (status.status === 'succeeded') {
          const jobResult = await getJobResult(jobId);
          if (cancelled) return;
          setResult(jobResult);
          const normalized = normalizeCitations(jobResult.citations);
          if (normalized.length > 0) {
            setSelectedCitationId((current) => current ?? normalized[0]?.citation_id ?? null);
          }
        }

        setError(null);
      } catch (requestError) {
        if (cancelled) return;
        setError(requestError instanceof Error ? requestError.message : 'Failed to load job details.');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void refresh();
    const interval = setInterval(() => {
      if (job?.status === 'succeeded' || job?.status === 'failed') return;
      void refresh();
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId, job?.status]);

  return (
    <AppShell title={`Job ${jobId.slice(0, 8) || 'Details'}`} subtitle="Track progress and review structured results with citations.">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Status
              {job ? <Badge variant={statusVariant(job.status)}>{job.status}</Badge> : null}
            </CardTitle>
            <CardDescription>
              {job ? verticalNameById(job.use_case) : 'Loading job metadata...'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              <span className="font-medium">Job ID:</span> {jobId}
            </p>
            {job ? (
              <>
                <p>
                  <span className="font-medium">Created:</span> {formatDateTime(job.created_at)}
                </p>
                <p>
                  <span className="font-medium">Updated:</span> {formatDateTime(job.updated_at)}
                </p>
              </>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="secondary" onClick={() => router.push('/history')}>
                Back to History
              </Button>
              <Button variant="secondary" onClick={() => router.push('/dashboard')}>
                New Job
              </Button>
            </div>
            {loading ? <p className="text-muted-foreground">Refreshing status...</p> : null}
            {job?.status === 'failed' ? <p className="rounded-md bg-red-50 p-2 text-red-700">{job.error ?? 'Job failed.'}</p> : null}
            {error ? <p className="rounded-md bg-red-50 p-2 text-red-700">{error}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Citations</CardTitle>
            <CardDescription>Click a citation to inspect source chunk text.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {citations.length === 0 ? <p className="text-sm text-muted-foreground">No citations yet.</p> : null}
            {citations.map((citation) => (
              <button
                key={citation.citation_id}
                type="button"
                onClick={() => setSelectedCitationId(citation.citation_id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                  selectedCitation?.citation_id === citation.citation_id ? 'border-primary bg-blue-50' : 'border-border bg-white'
                }`}
              >
                <p className="font-medium">{citation.citation_id}</p>
                <p className="text-xs text-muted-foreground">
                  {citation.metadata.source}
                  {typeof citation.metadata.page === 'number' ? ` - p.${citation.metadata.page}` : ''}
                </p>
              </button>
            ))}

            {selectedCitation ? (
              <div className="mt-3 rounded-md border border-border bg-secondary p-3">
                <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Source Chunk</p>
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {selectedCitation.chunk_text ?? 'Chunk text is unavailable in this record.'}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Structured Output</CardTitle>
          <CardDescription>Parsed and validated result sections from the job response.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!result && <p className="text-sm text-muted-foreground">Result is not ready yet. This view updates automatically.</p>}

          {result &&
            Object.entries(normalizedResult).map(([key, value]) => (
              <section key={key} className="rounded-lg border border-border p-4">
                <h3 className="mb-2 text-base font-semibold">{toSectionTitle(key)}</h3>
                <RenderFieldValue value={value} />
              </section>
            ))}

          {result && Object.keys(normalizedResult).length === 0 ? (
            <p className="text-sm text-muted-foreground">No structured output fields were returned for this job.</p>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Need another run? <Link href="/dashboard" className="underline">Create a new job</Link>.
          </p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
