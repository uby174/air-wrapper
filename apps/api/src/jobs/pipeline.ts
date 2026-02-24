import {
  baseSystemPrompt,
  classifyTask,
  estimateCost,
  routeModel,
  type PriceTable,
  type ProviderName,
  type TaskType
} from '@ai-wrapper/core';
import { evaluateVerticalGuardrails, getVertical, type VerticalInputType } from '@ai-wrapper/core/verticals';
import {
  AnthropicProvider,
  GoogleProvider,
  OllamaProvider,
  OpenAIProvider,
  type GenerateTextResult,
  type LLMProvider,
  type ProviderUsage
} from '@ai-wrapper/providers';
import {
  buildContext,
  chunkText,
  embedChunks,
  retrieveTopK,
  upsertDocument,
  type EmbeddingProvider,
  type RagQueryExecutor
} from '@ai-wrapper/rag';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { writeAuditEvent } from '../db/audit';
import { query } from '../db/client';
import { getJobRecord, markJobSucceeded } from '../db/jobs';
import { writeUsageEvent } from '../db/usage-events';
import { extractTextFromPdfUrl } from './pdf';
import { aiJobQueuePayloadSchema, jobInputSchema, persistedJobInputSchema, type AiJobQueuePayload } from './types';

const providers: Partial<Record<ProviderName, LLMProvider>> = {};

const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_API?.trim();
const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API?.trim();
const googleApiKey = process.env.GOOGLE_API_KEY?.trim() || process.env.GOOGLE_API?.trim();

if (openAiApiKey) {
  providers.openai = new OpenAIProvider({ apiKey: openAiApiKey });
}

if (anthropicApiKey) {
  providers.anthropic = new AnthropicProvider({ apiKey: anthropicApiKey });
}

if (googleApiKey) {
  providers.google = new GoogleProvider({ apiKey: googleApiKey });
}

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim();
if (ollamaBaseUrl) {
  providers.ollama = new OllamaProvider({ baseUrl: ollamaBaseUrl });
}

const PROVIDER_FALLBACK_ORDER: ProviderName[] = ['openai', 'anthropic', 'google', 'ollama'];

const OLLAMA_DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:3b';

// Domain-specific expert models built from infra/ollama Modelfiles.
// Fall back to the default Ollama model if the domain model is not configured.
const VERTICAL_OLLAMA_MODEL: Record<string, string> = {
  legal_contract_analysis: process.env.OLLAMA_LEGAL_MODEL ?? 'legal-analyst:3b',
  medical_research_summary: process.env.OLLAMA_MEDICAL_MODEL ?? 'medical-analyst:3b',
  financial_report_analysis: process.env.OLLAMA_FINANCIAL_MODEL ?? 'financial-analyst:3b'
};

const MODEL_BY_TASK_AND_PROVIDER: Record<TaskType, Record<ProviderName, string>> = {
  SIMPLE: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-2.5-flash',
    ollama: OLLAMA_DEFAULT_MODEL
  },
  MEDIUM: {
    openai: 'gpt-4o',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-2.5-flash',
    ollama: OLLAMA_DEFAULT_MODEL
  },
  COMPLEX: {
    openai: 'gpt-4o',
    anthropic: 'claude-3-5-sonnet-latest',
    google: 'gemini-2.5-pro',
    ollama: OLLAMA_DEFAULT_MODEL
  },
  LOCAL: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-2.5-flash',
    ollama: OLLAMA_DEFAULT_MODEL
  }
};

const EMBED_MODEL_BY_PROVIDER: Record<ProviderName, string> = {
  openai: 'text-embedding-3-small',
  anthropic: 'claude-embed-v1',
  google: 'gemini-embedding-001',
  ollama: 'nomic-embed-text'
};

const PRICE_TABLE_BY_PROVIDER: Record<ProviderName, PriceTable> = {
  openai: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  anthropic: { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  google: { inputPerMillion: 0.1, outputPerMillion: 0.3 },
  ollama: { inputPerMillion: 0, outputPerMillion: 0 }
};

const parseTaskType = (raw: string): TaskType | null => {
  const matched = raw.toUpperCase().match(/\b(SIMPLE|MEDIUM|COMPLEX)\b/);
  if (!matched) return null;
  return matched[1] as TaskType;
};

const uniqueProviders = (values: ProviderName[]): ProviderName[] => Array.from(new Set(values));
const approximateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const resolveUsageTokens = (
  usage: ProviderUsage | undefined,
  requestText: string,
  responseText: string
): { inputTokens: number; outputTokens: number } => {
  const inputTokens = usage?.inputTokens ?? approximateTokens(requestText);
  const outputTokens = usage?.outputTokens ?? approximateTokens(responseText);

  if (!usage?.inputTokens && !usage?.outputTokens && usage?.totalTokens) {
    const weightedInput = Math.round(usage.totalTokens * 0.7);
    return {
      inputTokens: weightedInput,
      outputTokens: Math.max(usage.totalTokens - weightedInput, 0)
    };
  }

  return { inputTokens, outputTokens };
};

const classifyAmbiguousTask = async (input: string): Promise<TaskType | null> => {
  const classifierOrder = uniqueProviders(['openai', 'google', 'anthropic']);
  const systemPrompt =
    'Classify user request complexity. Output only one token: SIMPLE, MEDIUM, or COMPLEX.';

  for (const providerName of classifierOrder) {
    const provider = providers[providerName];
    if (!provider) continue;

    const classifierModel = MODEL_BY_TASK_AND_PROVIDER.SIMPLE[providerName];

    try {
      const result = await provider.generateText({
        model: classifierModel,
        maxTokens: 16,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input }
        ]
      });

      const parsed = parseTaskType(result.text);
      if (parsed) return parsed;
    } catch {
      // Fallback to deterministic classifyTask heuristic path.
    }
  }

  return null;
};

const ragQueryExecutor: RagQueryExecutor = async <TRow>(
  text: string,
  params: unknown[] = []
): Promise<TRow[]> => (await query<QueryResultRow>(text, params)) as unknown as TRow[];

const selectEmbedRuntime = (preferred: ProviderName[] = []): {
  providerName: ProviderName;
  provider: EmbeddingProvider;
  model: string;
} | null => {
  const order = uniqueProviders([...preferred, ...PROVIDER_FALLBACK_ORDER]);

  for (const providerName of order) {
    const provider = providers[providerName];
    if (!provider) continue;
    return {
      providerName,
      provider,
      model: EMBED_MODEL_BY_PROVIDER[providerName]
    };
  }

  return null;
};

const buildGenerationOrder = (taskType: TaskType, preferred: ProviderName[] | undefined): ProviderName[] => {
  const routedProvider = routeModel(taskType).provider;
  const userPreferred = preferred ?? [];
  return uniqueProviders([...userPreferred, routedProvider, ...PROVIDER_FALLBACK_ORDER]);
};

/**
 * Repairs literal (unescaped) control characters inside JSON string values.
 * LLMs frequently emit newlines and tabs verbatim inside string values instead of
 * the required \\n / \\t escape sequences, making JSON.parse fail. This walks the
 * raw text character-by-character and replaces bare control characters only when
 * inside a string value, leaving structural whitespace untouched.
 */
const repairJsonLiteralControlChars = (raw: string): string => {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (escaped) {
      result += ch;
      escaped = false;
    } else if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
    } else if (ch === '"') {
      result += ch;
      inString = !inString;
    } else if (inString && ch === '\n') {
      result += '\\n';
    } else if (inString && ch === '\r') {
      result += '\\r';
    } else if (inString && ch === '\t') {
      result += '\\t';
    } else {
      result += ch;
    }
  }

  return result;
};

const extractJsonPayload = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (!trimmed) return { answer: '', key_points: [] };

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fencedMatch?.[1]) candidates.push(fencedMatch[1]);
  candidates.push(trimmed);

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Retry after repairing literal control characters inside string values.
      // This is the most common cause of LLM JSON parse failures.
      try {
        return JSON.parse(repairJsonLiteralControlChars(candidate)) as unknown;
      } catch {
        // Continue to next candidate.
      }
    }
  }

  return {
    answer: trimmed,
    key_points: []
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNonEmptyString = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
};

const extractKnownRecordFromString = (
  value: unknown,
  expectedKeys: string[]
): Record<string, unknown> | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = extractJsonPayload(value);
  if (!isRecord(parsed)) return null;
  if (!expectedKeys.some((key) => key in parsed)) return null;
  return parsed;
};

const stripMarkdownFence = (value: string): string => {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
};

const decodeJsonLikeString = (value: string): string => {
  const normalized = value.replace(/\r/g, '').trim();
  if (!normalized) return '';

  try {
    return JSON.parse(`"${normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`) as string;
  } catch {
    return normalized
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .trim();
  }
};

const extractJsonLikeStringField = (source: string, fieldName: string): string | null => {
  const normalizedSource = stripMarkdownFence(source);
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"([\\s\\S]*?)"(?=\\s*,\\s*"|\\s*[,}]|\\s*$)`, 'i');
  const match = normalizedSource.match(pattern);
  if (match?.[1]) {
    const decoded = decodeJsonLikeString(match[1]);
    return decoded.length > 0 ? decoded : null;
  }

  // Tolerate truncated strings where closing quotes are missing.
  const tolerantPattern = new RegExp(`"${fieldName}"\\s*:\\s*"([\\s\\S]*?)(?=\\n\\s*"\\w+"\\s*:|\\s*$)`, 'i');
  const tolerantMatch = normalizedSource.match(tolerantPattern);
  if (!tolerantMatch?.[1]) return null;
  const decoded = decodeJsonLikeString(tolerantMatch[1]).replace(/",\s*$/, '').trim();
  return decoded.length > 0 ? decoded : null;
};

const extractJsonLikeStringArrayField = (source: string, fieldName: string): string[] => {
  const normalizedSource = stripMarkdownFence(source);
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i');
  const match = normalizedSource.match(pattern);
  if (!match?.[1]) return [];

  const items: string[] = [];
  const itemRegex = /"((?:\\.|[^"\\])*)"/g;
  for (const itemMatch of match[1].matchAll(itemRegex)) {
    const decoded = decodeJsonLikeString(itemMatch[1] ?? '');
    if (decoded.length > 0) items.push(decoded);
  }

  return items;
};

const extractJsonLikeLegalRisks = (
  source: string
): Array<{ clause: string; risk_level: 'low' | 'medium' | 'high'; explanation: string }> => {
  const normalizedSource = stripMarkdownFence(source);
  const keyRisksMatch = normalizedSource.match(/"key_risks"\s*:\s*\[([\s\S]*?)\](?=\s*,\s*"|\s*})/i);
  if (!keyRisksMatch?.[1]) return [];

  const risks: Array<{ clause: string; risk_level: 'low' | 'medium' | 'high'; explanation: string }> = [];
  const objectRegex = /\{([\s\S]*?)\}/g;

  for (const objectMatch of keyRisksMatch[1].matchAll(objectRegex)) {
    const block = `{${objectMatch[1] ?? ''}}`;
    const clause = extractJsonLikeStringField(block, 'clause') ?? '';
    const explanation = extractJsonLikeStringField(block, 'explanation') ?? '';
    const riskLevelRaw = (extractJsonLikeStringField(block, 'risk_level') ?? '').toLowerCase();
    const risk_level: 'low' | 'medium' | 'high' =
      riskLevelRaw === 'low' || riskLevelRaw === 'medium' || riskLevelRaw === 'high' ? riskLevelRaw : 'medium';

    if (clause && explanation) {
      risks.push({ clause, risk_level, explanation });
    }
  }

  return risks;
};

const extractJsonLikeFinancialMetrics = (
  source: string
): Array<{ metric: string; value: string; interpretation: string }> => {
  const normalizedSource = stripMarkdownFence(source);
  const metricsMatch = normalizedSource.match(/"key_metrics"\s*:\s*\[([\s\S]*?)\](?=\s*,\s*"|\s*})/i);
  if (!metricsMatch?.[1]) return [];

  const metrics: Array<{ metric: string; value: string; interpretation: string }> = [];
  const objectRegex = /\{([\s\S]*?)\}/g;

  for (const objectMatch of metricsMatch[1].matchAll(objectRegex)) {
    const block = `{${objectMatch[1] ?? ''}}`;
    const metric = extractJsonLikeStringField(block, 'metric') ?? '';
    const value = extractJsonLikeStringField(block, 'value') ?? '';
    const interpretation = extractJsonLikeStringField(block, 'interpretation') ?? '';

    if (metric && value && interpretation) {
      metrics.push({ metric, value, interpretation });
    }
  }

  return metrics;
};

const coerceVerticalOutput = (verticalId: string, rawText: string, payload: unknown): unknown => {
  const asObject = isRecord(payload) ? payload : {};
  const fallbackSummary = toNonEmptyString(rawText, 'AI response generated.');

  switch (verticalId) {
    case 'legal_contract_analysis': {
      const summaryText = typeof asObject.summary === 'string' ? asObject.summary : '';
      const merged = {
        ...asObject,
        ...(extractKnownRecordFromString(asObject.answer, [
          'summary',
          'key_risks',
          'obligations',
          'recommendations',
          'disclaimer'
        ]) ??
          extractKnownRecordFromString(rawText, [
            'summary',
            'key_risks',
            'obligations',
            'recommendations',
            'disclaimer'
          ]) ??
          {}),
        ...(extractKnownRecordFromString(asObject.summary, [
          'summary',
          'key_risks',
          'obligations',
          'recommendations',
          'disclaimer'
        ]) ?? {})
      };

      // Fall back to rawText as extraction source when summaryText is empty (JSON parse failed).
      const extractionSource = summaryText.length > 0 ? summaryText : rawText;

      const nestedSummary = extractJsonLikeStringField(extractionSource, 'summary');
      const nestedObligations = extractJsonLikeStringArrayField(extractionSource, 'obligations');
      const nestedRecommendations = extractJsonLikeStringArrayField(extractionSource, 'recommendations');
      const nestedDisclaimer = extractJsonLikeStringField(extractionSource, 'disclaimer');
      const nestedRisks = extractJsonLikeLegalRisks(extractionSource);
      const summaryLooksJsonLike =
        extractionSource.trimStart().startsWith('```') || /"\s*summary\s*"\s*:/.test(extractionSource);
      const summaryFallback = summaryLooksJsonLike || summaryText.trim().length === 0 ? fallbackSummary : summaryText;
      const normalizedMergedRisks = Array.isArray(merged.key_risks) ? merged.key_risks : [];
      const normalizedMergedObligations = toStringArray(merged.obligations);
      const normalizedMergedRecommendations = toStringArray(merged.recommendations);

      const summaryCandidate = nestedSummary ?? (summaryLooksJsonLike ? '' : merged.summary);

      return {
        summary: toNonEmptyString(summaryCandidate, summaryFallback),
        key_risks:
          normalizedMergedRisks.length > 0
            ? normalizedMergedRisks
              .map((item) => {
                if (!isRecord(item)) return null;
                const clause = toNonEmptyString(item.clause, '');
                const riskLevelRaw = typeof item.risk_level === 'string' ? item.risk_level.trim().toLowerCase() : '';
                const risk_level =
                  riskLevelRaw === 'low' || riskLevelRaw === 'medium' || riskLevelRaw === 'high'
                    ? riskLevelRaw
                    : 'medium';
                const explanation = toNonEmptyString(item.explanation, '');
                if (!clause || !explanation) return null;
                return { clause, risk_level, explanation };
              })
              .filter((item): item is { clause: string; risk_level: 'low' | 'medium' | 'high'; explanation: string } =>
                Boolean(item)
              )
            : nestedRisks,
        obligations: normalizedMergedObligations.length > 0 ? normalizedMergedObligations : nestedObligations,
        recommendations:
          normalizedMergedRecommendations.length > 0 ? normalizedMergedRecommendations : nestedRecommendations,
        disclaimer: toNonEmptyString(merged.disclaimer, nestedDisclaimer ?? 'This is an AI analysis and not legal advice.')
      };
    }

    case 'medical_research_summary': {
      const evidenceSummaryText = typeof asObject.evidence_summary === 'string' ? asObject.evidence_summary : '';
      const merged = {
        ...asObject,
        ...(extractKnownRecordFromString(asObject.answer, [
          'research_question',
          'evidence_summary',
          'key_findings',
          'limitations',
          'safety_notes'
        ]) ??
          extractKnownRecordFromString(rawText, [
            'research_question',
            'evidence_summary',
            'key_findings',
            'limitations',
            'safety_notes'
          ]) ??
          {}),
        ...(extractKnownRecordFromString(asObject.evidence_summary, [
          'research_question',
          'evidence_summary',
          'key_findings',
          'limitations',
          'safety_notes'
        ]) ?? {})
      };

      // Fall back to rawText as extraction source when evidenceSummaryText is empty (JSON parse failed).
      const extractionSource = evidenceSummaryText.length > 0 ? evidenceSummaryText : rawText;

      const nestedResearchQuestion = extractJsonLikeStringField(extractionSource, 'research_question');
      const nestedEvidenceSummary = extractJsonLikeStringField(extractionSource, 'evidence_summary');
      const nestedFindings = extractJsonLikeStringArrayField(extractionSource, 'key_findings');
      const nestedLimitations = extractJsonLikeStringArrayField(extractionSource, 'limitations');
      const nestedSafetyNotes = extractJsonLikeStringArrayField(extractionSource, 'safety_notes');
      const summaryLooksJsonLike =
        extractionSource.trimStart().startsWith('```') ||
        /"\s*research_question\s*"\s*:/.test(extractionSource) ||
        /"\s*evidence_summary\s*"\s*:/.test(extractionSource);
      const evidenceSummaryCandidate = nestedEvidenceSummary ?? (summaryLooksJsonLike ? '' : merged.evidence_summary);
      const mergedFindings = toStringArray(merged.key_findings);
      const mergedLimitations = toStringArray(merged.limitations);
      const mergedSafetyNotes = toStringArray(merged.safety_notes);

      return {
        research_question: toNonEmptyString(
          nestedResearchQuestion ?? merged.research_question,
          'Research question not specified.'
        ),
        evidence_summary: toNonEmptyString(evidenceSummaryCandidate, fallbackSummary),
        key_findings: mergedFindings.length > 0 ? mergedFindings : nestedFindings,
        limitations: mergedLimitations.length > 0 ? mergedLimitations : nestedLimitations,
        safety_notes: mergedSafetyNotes.length > 0 ? mergedSafetyNotes : nestedSafetyNotes,
        not_medical_advice: true
      };
    }

    case 'financial_report_analysis': {
      const executiveSummaryText = typeof asObject.executive_summary === 'string' ? asObject.executive_summary : '';
      const merged = {
        ...asObject,
        ...(extractKnownRecordFromString(asObject.answer, [
          'executive_summary',
          'key_metrics',
          'risk_flags',
          'recommendations',
          'disclaimer'
        ]) ??
          // When JSON parsing failed entirely asObject.answer === rawText but extractJsonPayload
          // also failed on it, so we try rawText as a last-resort object source.
          extractKnownRecordFromString(rawText, [
            'executive_summary',
            'key_metrics',
            'risk_flags',
            'recommendations',
            'disclaimer'
          ]) ??
          {}),
        ...(extractKnownRecordFromString(asObject.executive_summary, [
          'executive_summary',
          'key_metrics',
          'risk_flags',
          'recommendations',
          'disclaimer'
        ]) ?? {})
      };

      // When JSON parsing failed, asObject.executive_summary is undefined (executiveSummaryText = '').
      // Fall back to direct regex extraction from rawText in that case so we can still
      // recover structured fields even when the outer parse produced no executive_summary.
      const extractionSource = executiveSummaryText.length > 0 ? executiveSummaryText : rawText;

      const nestedExecutiveSummary = extractJsonLikeStringField(extractionSource, 'executive_summary');
      const nestedRiskFlags = extractJsonLikeStringArrayField(extractionSource, 'risk_flags');
      const nestedRecommendations = extractJsonLikeStringArrayField(extractionSource, 'recommendations');
      const nestedDisclaimer = extractJsonLikeStringField(extractionSource, 'disclaimer');
      const nestedMetrics = extractJsonLikeFinancialMetrics(extractionSource);
      const summaryLooksJsonLike =
        extractionSource.trimStart().startsWith('```') || /"\s*executive_summary\s*"\s*:/.test(extractionSource);
      const summaryCandidate = nestedExecutiveSummary ?? (summaryLooksJsonLike ? '' : merged.executive_summary);
      const normalizedMergedMetrics = Array.isArray(merged.key_metrics)
        ? merged.key_metrics
            .map((item) => {
              if (!isRecord(item)) return null;
              const metric = toNonEmptyString(item.metric, '');
              const value = toNonEmptyString(item.value, '');
              const interpretation = toNonEmptyString(item.interpretation, '');
              if (!metric || !value || !interpretation) return null;
              return { metric, value, interpretation };
            })
            .filter((item): item is { metric: string; value: string; interpretation: string } => Boolean(item))
        : [];
      const normalizedMergedRiskFlags = toStringArray(merged.risk_flags);
      const normalizedMergedRecommendations = toStringArray(merged.recommendations);

      return {
        executive_summary: toNonEmptyString(summaryCandidate, fallbackSummary),
        key_metrics: normalizedMergedMetrics.length > 0 ? normalizedMergedMetrics : nestedMetrics,
        risk_flags: normalizedMergedRiskFlags.length > 0 ? normalizedMergedRiskFlags : nestedRiskFlags,
        recommendations: normalizedMergedRecommendations.length > 0 ? normalizedMergedRecommendations : nestedRecommendations,
        disclaimer: toNonEmptyString(
          merged.disclaimer,
          nestedDisclaimer ?? 'This analysis is informational and not investment advice.'
        )
      };
    }

    default:
      return payload;
  }
};

const parseValidatedOutput = (schema: z.ZodTypeAny, verticalId: string, rawText: string): unknown => {
  const payload = extractJsonPayload(rawText);
  const direct = schema.safeParse(payload);
  const repairedPayload = coerceVerticalOutput(verticalId, rawText, payload);
  const repaired = schema.safeParse(repairedPayload);
  if (repaired.success) {
    const payloadChanged = JSON.stringify(repairedPayload) !== JSON.stringify(payload);
    if (!direct.success || payloadChanged) {
      console.warn({
        scope: 'ai_jobs_output_repair',
        vertical: verticalId,
        message: 'Output schema normalization applied.'
      });
    }
    return repaired.data;
  }

  if (direct.success) return direct.data;
  throw direct.error;
};

const hasStructuredSignal = (verticalId: string, rawText: string): boolean => {
  const payload = extractJsonPayload(rawText);
  if (!isRecord(payload)) return false;

  const requiredSignalsByVertical: Record<string, string[]> = {
    legal_contract_analysis: [
      'executiveSummary',
      'summary',
      'evidenceQuotes',
      'evidence_quotes',
      'risks',
      'key_risks',
      'recommendations'
    ],
    medical_research_summary: [
      'executiveSummary',
      'researchQuestion',
      'research_question',
      'evidence_summary',
      'evidenceQuotes',
      'evidence_quotes',
      'risks',
      'key_findings'
    ],
    financial_report_analysis: [
      'executiveSummary',
      'executive_summary',
      'evidenceQuotes',
      'evidence_quotes',
      'risks',
      'key_metrics',
      'risk_flags',
      'recommendations'
    ]
  };

  const signals = requiredSignalsByVertical[verticalId];
  if (!signals) return true;
  return signals.some((key) => key in payload);
};

type StructuredOutputValidationStage = 'initial' | 'enrichment';

interface StructuredOutputValidationFailurePayload {
  code: 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED';
  statusCode: 502;
  verticalId: string;
  stage: StructuredOutputValidationStage;
  retryAttempted: true;
  message: string;
  issues?: unknown[];
  rawPreview: string;
}

class StructuredOutputValidationError extends Error {
  statusCode = 502 as const;
  payload: StructuredOutputValidationFailurePayload;

  constructor(payload: StructuredOutputValidationFailurePayload) {
    super(JSON.stringify(payload));
    this.name = 'StructuredOutputValidationError';
    this.payload = payload;
  }
}

const summarizeIssues = (error: unknown): unknown[] | undefined => {
  if (!(error instanceof z.ZodError)) return undefined;
  return error.issues.map((issue) => ({
    path: issue.path,
    code: issue.code,
    message: issue.message
  }));
};

const truncateForAudit = (value: string, limit = 4000): string => {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
};

const buildStructuredOutputFixMessages = (params: {
  originalMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  invalidRawText: string;
  verticalId: string;
}): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> => [
  ...params.originalMessages,
  { role: 'assistant', content: params.invalidRawText },
  {
    role: 'user',
    content: [
      `The previous response for vertical "${params.verticalId}" failed JSON/schema validation.`,
      'Return ONLY corrected JSON matching the schema; no extra text.',
      'Return exactly one valid JSON object.',
      'Preserve meaning where possible. If information is missing, use "Not provided".'
    ].join(' ')
  }
];

const parseValidatedOutputWithRetry = async (params: {
  schema: z.ZodTypeAny;
  verticalId: string;
  rawText: string;
  stage: StructuredOutputValidationStage;
  jobId: string;
  userId: string;
  originalMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  callParams: {
    taskType: TaskType;
    order: ProviderName[];
    maxTokens: number;
    temperature: number;
    ollamaModelOverride?: string;
  };
}): Promise<{
  output: unknown;
  retryGeneration: { providerName: ProviderName; result: GenerateTextResult; model: string } | null;
}> => {
  try {
    if (!hasStructuredSignal(params.verticalId, params.rawText)) {
      throw new Error('Missing structured output fields in model response.');
    }
    return {
      output: parseValidatedOutput(params.schema, params.verticalId, params.rawText),
      retryGeneration: null
    };
  } catch (firstError) {
    await Promise.resolve(
      writeAuditEvent({
        userId: params.userId,
        action: 'job_structured_output_schema_validation_failed_attempt',
        metadata: {
          jobId: params.jobId,
          verticalId: params.verticalId,
          stage: params.stage,
          attempt: 1,
          issues: summarizeIssues(firstError),
          rawPreview: truncateForAudit(params.rawText)
        }
      })
    ).catch(() => {
      // Non-blocking audit logging.
    });

    const retryMessages = buildStructuredOutputFixMessages({
      originalMessages: params.originalMessages,
      invalidRawText: params.rawText,
      verticalId: params.verticalId
    });

    const retryGeneration = await callLlmWithFallback({
      taskType: params.callParams.taskType,
      order: params.callParams.order,
      messages: retryMessages,
      maxTokens: params.callParams.maxTokens,
      temperature: Math.min(params.callParams.temperature, 0.2),
      ollamaModelOverride: params.callParams.ollamaModelOverride
    });

    try {
      if (!hasStructuredSignal(params.verticalId, retryGeneration.result.text)) {
        throw new Error('Missing structured output fields in retry model response.');
      }
      return {
        output: parseValidatedOutput(params.schema, params.verticalId, retryGeneration.result.text),
        retryGeneration
      };
    } catch (secondError) {
      const payload: StructuredOutputValidationFailurePayload = {
        code: 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED',
        statusCode: 502,
        verticalId: params.verticalId,
        stage: params.stage,
        retryAttempted: true,
        message: 'Model returned invalid structured JSON after one repair retry.',
        issues: summarizeIssues(secondError),
        rawPreview: truncateForAudit(retryGeneration.result.text)
      };

      await Promise.resolve(
        writeAuditEvent({
          userId: params.userId,
          action: 'job_structured_output_schema_validation_failed_final',
          metadata: {
            jobId: params.jobId,
            ...payload
          }
        })
      ).catch(() => {
        // Non-blocking audit logging.
      });

      throw new StructuredOutputValidationError(payload);
    }
  }
};

const attachRuntimeModelMetadata = (
  verticalId: string,
  output: unknown,
  runtime: { providerName: ProviderName; model: string }
): unknown => {
  if (!isRecord(output)) return output;
  const metadata = isRecord(output.metadata) ? output.metadata : {};
  const createdAt =
    typeof metadata.createdAt === 'string' && metadata.createdAt.trim().length > 0
      ? metadata.createdAt
      : new Date().toISOString();

  return {
    ...output,
    metadata: {
      ...metadata,
      useCaseKey: typeof metadata.useCaseKey === 'string' && metadata.useCaseKey.trim().length > 0 ? metadata.useCaseKey : verticalId,
      provider: runtime.providerName,
      model: runtime.model,
      createdAt
    }
  };
};

const arrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

const structuredOutputCompletenessScore = (verticalId: string, output: unknown): number => {
  if (!isRecord(output)) return 0;

  switch (verticalId) {
    case 'legal_contract_analysis': {
      const summaryScore = typeof output.summary === 'string' && output.summary.trim().length > 0 ? 1 : 0;
      const risksScore = Math.min(arrayLength(output.key_risks), 6) * 2;
      const obligationsScore = Math.min(arrayLength(output.obligations), 6);
      const recommendationsScore = Math.min(arrayLength(output.recommendations), 6);
      return summaryScore + risksScore + obligationsScore + recommendationsScore;
    }

    case 'financial_report_analysis': {
      const summaryScore =
        typeof output.executive_summary === 'string' && output.executive_summary.trim().length > 0 ? 1 : 0;
      const metricsScore = Math.min(arrayLength(output.key_metrics), 6) * 2;
      const riskFlagsScore = Math.min(arrayLength(output.risk_flags), 6);
      const recommendationsScore = Math.min(arrayLength(output.recommendations), 6);
      return summaryScore + metricsScore + riskFlagsScore + recommendationsScore;
    }

    case 'insurance_health': {
      const summaryScore = typeof output.plain_summary === 'string' && output.plain_summary.trim().length > 0 ? 1 : 0;
      const coveredScore = Math.min(arrayLength(output.what_is_covered), 6) * 2;
      const notCoveredScore = Math.min(arrayLength(output.what_is_NOT_covered), 6);
      const risksScore = Math.min(arrayLength(output.risks), 6);
      return summaryScore + coveredScore + notCoveredScore + risksScore;
    }

    case 'medical_research_summary': {
      const summaryScore =
        typeof output.evidence_summary === 'string' && output.evidence_summary.trim().length > 0 ? 1 : 0;
      const findingsScore = Math.min(arrayLength(output.key_findings), 6) * 2;
      const limitationsScore = Math.min(arrayLength(output.limitations), 6);
      const safetyScore = Math.min(arrayLength(output.safety_notes), 6);
      return summaryScore + findingsScore + limitationsScore + safetyScore;
    }

    default:
      return 0;
  }
};

const SPARSE_COMPLETENESS_THRESHOLDS: Partial<Record<string, number>> = {
  legal_contract_analysis: 8,
  medical_research_summary: 9,
  financial_report_analysis: 8,
  insurance_health: 8
};

const SPARSE_ENRICH_MIN_INPUT_LENGTH: Partial<Record<string, number>> = {
  legal_contract_analysis: 220,
  medical_research_summary: 200,
  financial_report_analysis: 180,
  insurance_health: 200
};

const ENRICHMENT_MIN_MAX_TOKENS: Partial<Record<string, number>> = {
  legal_contract_analysis: 3000,
  medical_research_summary: 3000,
  financial_report_analysis: 3400,
  insurance_health: 3000
};

const isUnderfilledStructuredOutput = (verticalId: string, output: unknown): boolean => {
  if (!isRecord(output)) return true;

  switch (verticalId) {
    case 'legal_contract_analysis': {
      const keyRisks = arrayLength(output.key_risks);
      const obligations = arrayLength(output.obligations);
      const recommendations = arrayLength(output.recommendations);
      return keyRisks < 2 || obligations < 1 || recommendations < 2;
    }

    case 'medical_research_summary': {
      const findings = arrayLength(output.key_findings);
      const limitations = arrayLength(output.limitations);
      const safetyNotes = arrayLength(output.safety_notes);
      return findings < 3 || limitations < 2 || safetyNotes < 2;
    }

    case 'financial_report_analysis': {
      const metrics = arrayLength(output.key_metrics);
      const riskFlags = arrayLength(output.risk_flags);
      const recommendations = arrayLength(output.recommendations);
      return metrics < 2 || riskFlags < 2 || recommendations < 2;
    }

    case 'insurance_health': {
      const covered = arrayLength(output.what_is_covered);
      const notCovered = arrayLength(output.what_is_NOT_covered);
      const risks = arrayLength(output.risks);
      return covered < 3 || notCovered < 1 || risks < 2;
    }

    default:
      return false;
  }
};

const shouldAttemptSparseEnrichment = (verticalId: string, inputText: string, output: unknown): boolean => {
  const threshold = SPARSE_COMPLETENESS_THRESHOLDS[verticalId];
  if (threshold === undefined) return false;

  const minInputLength = SPARSE_ENRICH_MIN_INPUT_LENGTH[verticalId] ?? 0;
  if (inputText.trim().length < minInputLength) return false;

  if (isUnderfilledStructuredOutput(verticalId, output)) {
    return true;
  }

  return structuredOutputCompletenessScore(verticalId, output) < threshold;
};

const buildSparseEnrichmentMessages = (params: {
  verticalId: string;
  inputText: string;
  context: string;
  previousOutput: unknown;
}): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> => {
  const previousJson = JSON.stringify(params.previousOutput);

  if (params.verticalId === 'legal_contract_analysis') {
    return [
      {
        role: 'system',
        content:
          'You are a senior contracts counsel specializing in commercial risk review. Return strict JSON only. No markdown code fences. Use only provided evidence and output "Not provided" for missing fields.'
      },
      {
        role: 'user',
        content: [
          'The prior response was too sparse and left structured arrays mostly empty.',
          'Return JSON with keys:',
          '{"executive_summary": string, "summary": string, "evidence_quotes": [{"quote": string, "source_ref": string, "relevance": string}], "risks": [{"title": string, "severity": "low|medium|high", "impact": string, "evidence_refs": string[], "status": "observed|potential|not_assessable"}], "key_risks": [{"clause": string, "risk_level": "low|medium|high", "explanation": string, "evidence_quote_refs": string[]}], "obligations": string[], "recommendations": string[], "missing_info": string[], "confidence": {"level": "low|medium|high", "score": number, "rationale": string}, "metadata": {"use_case": "legal_contract_analysis", "no_hallucination_mode": true, "not_provided_fields": string[]}, "contract_type": string, "parties": string, "governing_law": string, "jurisdiction": string, "dispute_resolution": string, "liability_cap": string, "disclaimer": string}.',
          'Completeness requirements: include Executive Summary, Evidence Quotes, Risks, Recommendations, Missing Info, and Confidence every time.',
          'Include at least 4 key_risks and at least 3 recommendations when evidence exists.',
          'If governing_law/jurisdiction/dispute_resolution/liability_cap are missing, set them to "Not provided" and list them in missing_info.',
          'Contract content:',
          params.inputText,
          params.context ? `Retrieved context:\n${params.context}` : '',
          `Previous sparse output:\n${previousJson}`
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];
  }

  if (params.verticalId === 'medical_research_summary') {
    return [
      {
        role: 'system',
        content:
          'You are a clinical research methodologist and evidence synthesis specialist. Return strict JSON only. No markdown code fences. Use only provided evidence, no diagnosis/treatment advice, and output "Not provided" for missing fields.'
      },
      {
        role: 'user',
        content: [
          'The prior response was too sparse and left structured arrays mostly empty.',
          'Return JSON with keys:',
          '{"executive_summary": string, "research_question": string, "evidence_summary": string, "evidence_quotes": [{"quote": string, "source_ref": string, "relevance": string}], "risks": [{"title": string, "severity": "low|medium|high", "impact": string, "evidence_refs": string[], "status": "observed|potential|not_assessable"}], "key_findings": string[], "limitations": string[], "safety_notes": string[], "recommendations": string[], "missing_info": string[], "confidence": {"level": "low|medium|high", "score": number, "rationale": string}, "metadata": {"use_case": "medical_research_summary", "no_hallucination_mode": true, "not_provided_fields": string[]}, "study_design": string, "sample_size": string, "primary_endpoint": string, "effect_size_summary": string, "disclaimer": string, "not_medical_advice": true}.',
          'Completeness requirements: include Executive Summary, Evidence Quotes, Risks, Recommendations, Missing Info, and Confidence every time.',
          'Include at least 5 key_findings, 4 limitations, and 4 safety_notes when evidence exists.',
          'If sample_size/study_design/primary_endpoint/effect_size_summary are missing, set them to "Not provided" and list them in missing_info.',
          'Prioritize study design, sample size, population, endpoints, effect direction/magnitude, and confidence limits when available.',
          'Medical research content:',
          params.inputText,
          params.context ? `Retrieved context:\n${params.context}` : '',
          `Previous sparse output:\n${previousJson}`
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];
  }

  if (params.verticalId === 'financial_report_analysis') {
    return [
      {
        role: 'system',
        content:
          'You are a senior equity research analyst specializing in forensic financial statement review. Return strict JSON only. No markdown code fences. Use only provided evidence, do not give personalized investment advice, and output "Not provided" for missing fields.'
      },
      {
        role: 'user',
        content: [
          'The prior response was too sparse and left structured arrays mostly empty.',
          'Return JSON with keys:',
          '{"executive_summary": string, "evidence_quotes": [{"quote": string, "source_ref": string, "relevance": string}], "risks": [{"title": string, "severity": "low|medium|high", "impact": string, "evidence_refs": string[], "status": "observed|potential|not_assessable"}], "key_metrics": [{"metric": string, "value": string, "interpretation": string}], "risk_flags": string[], "recommendations": string[], "missing_info": string[], "confidence": {"level": "low|medium|high", "score": number, "rationale": string}, "metadata": {"use_case": "financial_report_analysis", "no_hallucination_mode": true, "not_provided_fields": string[]}, "reporting_period": string, "revenue_numbers": string, "liquidity_position": string, "disclaimer": string}.',
          'Completeness requirements: include Executive Summary, Evidence Quotes, Risks, Recommendations, Missing Info, and Confidence every time.',
          'Include at least 4 key_metrics, 4 risk_flags, and 4 recommendations when evidence exists.',
          'If reporting_period/revenue_numbers/liquidity_position are missing, set them to "Not provided" and list them in missing_info.',
          'Financial report content:',
          params.inputText,
          params.context ? `Retrieved context:\n${params.context}` : '',
          `Previous sparse output:\n${previousJson}`
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];
  }

  if (params.verticalId === 'insurance_health') {
    return [
      {
        role: 'system',
        content:
          'You are a friendly, knowledgeable health insurance advisor helping ordinary people understand their insurance policy. Return strict JSON only. No markdown code fences. Use plain, simple English. No jargon. Be honest about risks. Be encouraging about genuine benefits. Never give medical advice.'
      },
      {
        role: 'user',
        content: [
          'The previous analysis may have missed specific coverage limits or network restrictions.',
          'Look again for: in-network vs out-of-network rules, prior authorization requirements, mental health parity, prescription drug tiers, and any unusual exclusions.',
          'Return JSON with keys matching the original schema:',
          JSON.stringify({
            plain_summary: 'string',
            plan_type: 'string',
            monthly_cost: {
              premium: 'string',
              deductible: 'string',
              out_of_pocket_max: 'string',
              copays: ['string']
            },
            what_is_covered: [
              { category: 'string', covered: true, details: 'string' }
            ],
            what_is_NOT_covered: [
              { exclusion: 'string', reason: 'string', impact: 'string' }
            ],
            risks: [
              {
                title: 'string',
                description: 'string',
                severity: 'low|medium|high',
                what_to_watch_out_for: 'string'
              }
            ],
            benefits: [
              { title: 'string', description: 'string', value_to_you: 'string' }
            ],
            most_important: ['string'],
            questions_to_ask: ['string'],
            red_flags: ['string'],
            overall_rating: {
              score: 0,
              verdict: 'excellent|good|fair|poor|avoid',
              one_line_summary: 'string'
            },
            disclaimer: 'string'
          }, null, 2),
          'Policy Document:',
          params.inputText,
          params.context ? `Retrieved context:\n${params.context}` : '',
          `Previous sparse output:\n${previousJson}`
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];
  }

  return [];
};

const callLlmWithFallback = async (params: {
  taskType: TaskType;
  order: ProviderName[];
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  temperature: number;
  ollamaModelOverride?: string;
}): Promise<{ providerName: ProviderName; result: GenerateTextResult; model: string }> => {
  let lastError: unknown = null;

  for (const providerName of params.order) {
    const provider = providers[providerName];
    if (!provider) continue;

    const model =
      providerName === 'ollama' && params.ollamaModelOverride
        ? params.ollamaModelOverride
        : MODEL_BY_TASK_AND_PROVIDER[params.taskType][providerName];

    try {
      const result = await provider.generateText({
        model,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        messages: params.messages
      });

      return { providerName, result, model };
    } catch (error) {
      lastError = error;
      console.error({
        scope: 'ai_jobs_generation',
        provider: providerName,
        model,
        error: error instanceof Error ? error.message : 'Unknown generation error'
      });
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('No configured provider available for generation');
};

const extractInputText = async (
  input: z.infer<typeof persistedJobInputSchema>['input']
): Promise<{ text: string; source: string }> => {
  if (input.type === 'text') {
    const source = input.storageUrl ?? 'inline:text';
    return {
      text: input.text.trim(),
      source
    };
  }

  const text = await extractTextFromPdfUrl(input.storageUrl);
  return {
    text,
    source: input.storageUrl
  };
};

const ensureNonEmptyText = (text: string): string => {
  const normalized = text.trim();
  if (!normalized) {
    throw new Error('Extracted input text is empty');
  }
  return normalized;
};

export const processAiJob = async (payloadRaw: AiJobQueuePayload): Promise<void> => {
  const payload = aiJobQueuePayloadSchema.parse(payloadRaw);
  const record = await getJobRecord(payload.dbJobId);

  if (!record) {
    throw new Error(`Job ${payload.dbJobId} not found`);
  }

  const vertical = await getVertical(record.use_case);
  const persistedInput = persistedJobInputSchema.parse(record.input);
  const input = payload.runtimeInput ? jobInputSchema.parse(payload.runtimeInput) : persistedInput.input;
  const { options } = persistedInput;
  const inputType = input.type as VerticalInputType;

  if (!vertical.inputTypesAllowed.includes(inputType)) {
    throw new Error(
      `Vertical ${vertical.id} does not allow input type ${inputType}. Allowed: ${vertical.inputTypesAllowed.join(', ')}`
    );
  }

  const extracted = await extractInputText(input);
  const extractedText = ensureNonEmptyText(extracted.text);
  const guardrails = evaluateVerticalGuardrails(extractedText, vertical.guardrails);

  if (guardrails.refusalMatches.length > 0) {
    const refusalResult = {
      status: 'refused',
      message: 'Request blocked by vertical guardrails.',
      refusal_rules: guardrails.refusalMatches
    };

    await markJobSucceeded(record.id, refusalResult, []);
    await writeUsageEvent({
      userId: record.user_id,
      useCase: `job_${vertical.id}_refused`,
      tokensIn: approximateTokens(extractedText),
      tokensOut: 0,
      costEstimate: 0
    });
    return;
  }

  const guardedInputText = ensureNonEmptyText(guardrails.sanitizedInput);

  const taskType = await classifyTask(guardedInputText, {
    classifyAmbiguous: classifyAmbiguousTask
  });
  const modelRoute = routeModel(taskType);
  const generationOrder = buildGenerationOrder(taskType, options?.preferredProviders);
  const hasGenerationProvider = generationOrder.some((providerName) => Boolean(providers[providerName]));

  if (!hasGenerationProvider) {
    throw new Error(
      'No AI provider is configured. Set OPENAI_API_KEY, GOOGLE_API_KEY, or ANTHROPIC_API_KEY in apps/api/.env and restart the API.'
    );
  }

  const ragEnabledRequested = options?.rag?.enabled ?? vertical.rag.enabled;
  const ragTopK = options?.rag?.topK ?? vertical.rag.topK;
  const embedRuntime = ragEnabledRequested ? selectEmbedRuntime(options?.preferredProviders) : null;
  const ragEnabled = ragEnabledRequested && Boolean(embedRuntime);
  const ragStorageDisabled = process.env.PRIVACY_DISABLE_RAG_STORAGE === 'true';
  const ragStoreInput =
    ragEnabled && (options?.rag?.storeInputAsDocs ?? options?.rag?.storeInput ?? vertical.rag.storeInputAsDocs);
  const resolvedRagStoreInput = ragStoreInput && !ragStorageDisabled;
  const ragRetrieve = ragEnabled && ragTopK > 0;

  if (ragEnabledRequested && !embedRuntime) {
    console.warn({
      scope: 'ai_jobs_rag',
      jobId: record.id,
      vertical: vertical.id,
      message: 'RAG requested but no embedding provider configured. Continuing without RAG.'
    });
  }

  if (ragStorageDisabled && ragStoreInput) {
    console.warn({
      scope: 'ai_jobs_rag',
      jobId: record.id,
      vertical: vertical.id,
      message: 'RAG storage was requested but is disabled by PRIVACY_DISABLE_RAG_STORAGE=true.'
    });
  }

  if (resolvedRagStoreInput && embedRuntime) {
    try {
      const ragChunks = chunkText(guardedInputText, {
        size: 900,
        overlap: 150,
        source: extracted.source
      });

      const chunksWithVectors = await embedChunks(ragChunks, {
        provider: embedRuntime.provider,
        model: embedRuntime.model
      });

      await upsertDocument(
        record.user_id,
        {
          title: `${vertical.name}:${record.id}`,
          source: extracted.source
        },
        chunksWithVectors,
        { queryExecutor: ragQueryExecutor }
      );
    } catch (error) {
      console.error({
        scope: 'ai_jobs_rag_store',
        jobId: record.id,
        vertical: vertical.id,
        provider: embedRuntime.providerName,
        model: embedRuntime.model,
        error: error instanceof Error ? error.message : 'Unknown rag-store error'
      });
    }
  }

  let context = '';
  let citations: unknown[] = [];

  if (ragRetrieve && embedRuntime) {
    try {
      const retrieved = await retrieveTopK(record.user_id, guardedInputText, ragTopK, {
        provider: embedRuntime.provider,
        model: embedRuntime.model,
        queryExecutor: ragQueryExecutor
      });

      const built = buildContext(retrieved);
      context = built.context;
      citations = built.citations;
    } catch (error) {
      console.error({
        scope: 'ai_jobs_rag_retrieve',
        jobId: record.id,
        vertical: vertical.id,
        provider: embedRuntime.providerName,
        model: embedRuntime.model,
        error: error instanceof Error ? error.message : 'Unknown rag-retrieve error'
      });
    }
  }

  const temperature = options?.temperature ?? (taskType === 'SIMPLE' ? 0.2 : taskType === 'MEDIUM' ? 0.4 : 0.5);
  const minMaxTokensByVertical: Partial<Record<string, number>> = {
    legal_contract_analysis: 2200,
    medical_research_summary: 2200,
    financial_report_analysis: 2400
  };
  const resolvedBaseMaxTokens = options?.maxTokens ?? modelRoute.maxTokens;
  const minMaxTokens = minMaxTokensByVertical[vertical.id] ?? 0;
  const maxTokens = Math.max(resolvedBaseMaxTokens, minMaxTokens);

  const promptMessages = vertical.promptTemplate({
    inputText: guardedInputText,
    context,
    useCase: vertical.id,
    locale: options?.locale
  });

  if (promptMessages.length === 0) {
    throw new Error(`Vertical ${vertical.id} promptTemplate returned no messages`);
  }

  const messages = [{ role: 'system' as const, content: baseSystemPrompt }, ...promptMessages];
  const usageCallRecords: Array<{
    providerName: ProviderName;
    requestText: string;
    result: GenerateTextResult;
  }> = [];

  const ollamaModelOverride = VERTICAL_OLLAMA_MODEL[vertical.id];

  const generation = await callLlmWithFallback({
    taskType,
    order: generationOrder,
    messages,
    maxTokens,
    temperature,
    ollamaModelOverride
  });
  usageCallRecords.push({
    providerName: generation.providerName,
    requestText: messages.map((message) => message.content).join('\n\n'),
    result: generation.result
  });

  const parsedInitial = await parseValidatedOutputWithRetry({
    schema: vertical.outputSchema,
    verticalId: vertical.id,
    rawText: generation.result.text,
    stage: 'initial',
    jobId: record.id,
    userId: record.user_id,
    originalMessages: messages,
    callParams: {
      taskType,
      order: generationOrder,
      maxTokens,
      temperature,
      ollamaModelOverride
    }
  });
  const effectiveInitialGeneration = parsedInitial.retryGeneration ?? generation;
  if (parsedInitial.retryGeneration) {
    usageCallRecords.push({
      providerName: parsedInitial.retryGeneration.providerName,
      requestText: [...messages, { role: 'assistant' as const, content: generation.result.text }].map((m) => m.content).join('\n\n'),
      result: parsedInitial.retryGeneration.result
    });
  }

  let output = parsedInitial.output;
  if (vertical.postProcess) {
    output = await vertical.postProcess(output);
  }
  output = attachRuntimeModelMetadata(vertical.id, output, {
    providerName: effectiveInitialGeneration.providerName,
    model: effectiveInitialGeneration.model
  });

  if (shouldAttemptSparseEnrichment(vertical.id, guardedInputText, output)) {
    const enrichmentMessages = buildSparseEnrichmentMessages({
      verticalId: vertical.id,
      inputText: guardedInputText,
      context,
      previousOutput: output
    });

    if (enrichmentMessages.length > 0) {
      try {
        const enrichmentGeneration = await callLlmWithFallback({
          taskType,
          order: generationOrder,
          messages: enrichmentMessages,
          maxTokens: Math.max(maxTokens, ENRICHMENT_MIN_MAX_TOKENS[vertical.id] ?? 2600),
          temperature: Math.min(temperature, 0.3),
          ollamaModelOverride
        });

        usageCallRecords.push({
          providerName: enrichmentGeneration.providerName,
          requestText: enrichmentMessages.map((message) => message.content).join('\n\n'),
          result: enrichmentGeneration.result
        });

        const parsedEnrichment = await parseValidatedOutputWithRetry({
          schema: vertical.outputSchema,
          verticalId: vertical.id,
          rawText: enrichmentGeneration.result.text,
          stage: 'enrichment',
          jobId: record.id,
          userId: record.user_id,
          originalMessages: enrichmentMessages,
          callParams: {
            taskType,
            order: generationOrder,
            maxTokens: Math.max(maxTokens, ENRICHMENT_MIN_MAX_TOKENS[vertical.id] ?? 2600),
            temperature: Math.min(temperature, 0.3),
            ollamaModelOverride
          }
        });
        const effectiveEnrichmentGeneration = parsedEnrichment.retryGeneration ?? enrichmentGeneration;
        if (parsedEnrichment.retryGeneration) {
          usageCallRecords.push({
            providerName: parsedEnrichment.retryGeneration.providerName,
            requestText: [...enrichmentMessages, { role: 'assistant' as const, content: enrichmentGeneration.result.text }]
              .map((m) => m.content)
              .join('\n\n'),
            result: parsedEnrichment.retryGeneration.result
          });
        }

        let enrichedOutput = parsedEnrichment.output;
        if (vertical.postProcess) {
          enrichedOutput = await vertical.postProcess(enrichedOutput);
        }
        enrichedOutput = attachRuntimeModelMetadata(vertical.id, enrichedOutput, {
          providerName: effectiveEnrichmentGeneration.providerName,
          model: effectiveEnrichmentGeneration.model
        });

        const baseScore = structuredOutputCompletenessScore(vertical.id, output);
        const enrichedScore = structuredOutputCompletenessScore(vertical.id, enrichedOutput);

        if (enrichedScore > baseScore) {
          output = enrichedOutput;
          console.warn({
            scope: 'ai_jobs_output_enrichment',
            jobId: record.id,
            vertical: vertical.id,
            baseScore,
            enrichedScore,
            message: 'Applied sparse output enrichment pass.'
          });
        } else {
          console.warn({
            scope: 'ai_jobs_output_enrichment',
            jobId: record.id,
            vertical: vertical.id,
            baseScore,
            enrichedScore,
            message: 'Enrichment pass did not improve structured completeness.'
          });
        }
      } catch (error) {
        console.error({
          scope: 'ai_jobs_output_enrichment',
          jobId: record.id,
          vertical: vertical.id,
          error: error instanceof Error ? error.message : 'Unknown enrichment error'
        });
      }
    }
  }

  await markJobSucceeded(record.id, output, citations);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostEstimate = 0;

  for (const usageCall of usageCallRecords) {
    const usage = resolveUsageTokens(usageCall.result.usage, usageCall.requestText, usageCall.result.text);
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalCostEstimate += estimateCost(usage, PRICE_TABLE_BY_PROVIDER[usageCall.providerName]);
  }

  await writeUsageEvent({
    userId: record.user_id,
    useCase: `job_${vertical.id}_${taskType.toLowerCase()}`,
    tokensIn: totalInputTokens,
    tokensOut: totalOutputTokens,
    costEstimate: Number(totalCostEstimate.toFixed(6))
  });
};
