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

const MODEL_BY_TASK_AND_PROVIDER: Record<TaskType, Record<ProviderName, string>> = {
  SIMPLE: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-flash-latest',
    ollama: process.env.OLLAMA_MODEL ?? 'qwen2.5:3b'
  },
  MEDIUM: {
    openai: 'gpt-4.1-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-pro-latest',
    ollama: process.env.OLLAMA_MODEL ?? 'qwen2.5:3b'
  },
  COMPLEX: {
    openai: 'gpt-4.1',
    anthropic: 'claude-3-5-sonnet-latest',
    google: 'gemini-pro-latest',
    ollama: process.env.OLLAMA_MODEL ?? 'qwen2.5:3b'
  },
  LOCAL: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-flash-latest',
    ollama: process.env.OLLAMA_MODEL ?? 'qwen2.5:3b'
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
      // Continue attempts.
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
        ]) ?? {}),
        ...(extractKnownRecordFromString(asObject.summary, [
          'summary',
          'key_risks',
          'obligations',
          'recommendations',
          'disclaimer'
        ]) ?? {})
      };

      const nestedSummary = extractJsonLikeStringField(summaryText, 'summary');
      const nestedObligations = extractJsonLikeStringArrayField(summaryText, 'obligations');
      const nestedRecommendations = extractJsonLikeStringArrayField(summaryText, 'recommendations');
      const nestedDisclaimer = extractJsonLikeStringField(summaryText, 'disclaimer');
      const nestedRisks = extractJsonLikeLegalRisks(summaryText);
      const summaryLooksJsonLike =
        summaryText.trimStart().startsWith('```') || /"\s*summary\s*"\s*:/.test(summaryText);
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
        ]) ?? {}),
        ...(extractKnownRecordFromString(asObject.evidence_summary, [
          'research_question',
          'evidence_summary',
          'key_findings',
          'limitations',
          'safety_notes'
        ]) ?? {})
      };

      const nestedResearchQuestion = extractJsonLikeStringField(evidenceSummaryText, 'research_question');
      const nestedEvidenceSummary = extractJsonLikeStringField(evidenceSummaryText, 'evidence_summary');
      const nestedFindings = extractJsonLikeStringArrayField(evidenceSummaryText, 'key_findings');
      const nestedLimitations = extractJsonLikeStringArrayField(evidenceSummaryText, 'limitations');
      const nestedSafetyNotes = extractJsonLikeStringArrayField(evidenceSummaryText, 'safety_notes');
      const summaryLooksJsonLike =
        evidenceSummaryText.trimStart().startsWith('```') ||
        /"\s*research_question\s*"\s*:/.test(evidenceSummaryText) ||
        /"\s*evidence_summary\s*"\s*:/.test(evidenceSummaryText);
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
        ]) ?? {}),
        ...(extractKnownRecordFromString(asObject.executive_summary, [
          'executive_summary',
          'key_metrics',
          'risk_flags',
          'recommendations',
          'disclaimer'
        ]) ?? {})
      };

      const nestedExecutiveSummary = extractJsonLikeStringField(executiveSummaryText, 'executive_summary');
      const nestedRiskFlags = extractJsonLikeStringArrayField(executiveSummaryText, 'risk_flags');
      const nestedRecommendations = extractJsonLikeStringArrayField(executiveSummaryText, 'recommendations');
      const nestedDisclaimer = extractJsonLikeStringField(executiveSummaryText, 'disclaimer');
      const nestedMetrics = extractJsonLikeFinancialMetrics(executiveSummaryText);
      const summaryLooksJsonLike =
        executiveSummaryText.trimStart().startsWith('```') || /"\s*executive_summary\s*"\s*:/.test(executiveSummaryText);
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
  financial_report_analysis: 8
};

const SPARSE_ENRICH_MIN_INPUT_LENGTH: Partial<Record<string, number>> = {
  legal_contract_analysis: 220,
  medical_research_summary: 200,
  financial_report_analysis: 180
};

const ENRICHMENT_MIN_MAX_TOKENS: Partial<Record<string, number>> = {
  legal_contract_analysis: 3000,
  medical_research_summary: 3000,
  financial_report_analysis: 3400
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
          'You are a senior contracts counsel specializing in commercial risk review. Return strict JSON only. Do not use markdown code fences.'
      },
      {
        role: 'user',
        content: [
          'The prior response was too sparse and left structured arrays mostly empty.',
          'Return JSON with keys:',
          '{"summary": string, "key_risks": [{"clause": string, "risk_level": "low|medium|high", "explanation": string}], "obligations": string[], "recommendations": string[], "disclaimer": string}.',
          'Completeness requirements: include at least 4 key_risks and at least 3 recommendations when evidence exists.',
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
          'You are a clinical research methodologist and evidence synthesis specialist. Return strict JSON only. Do not use markdown code fences.'
      },
      {
        role: 'user',
        content: [
          'The prior response was too sparse and left structured arrays mostly empty.',
          'Return JSON with keys:',
          '{"research_question": string, "evidence_summary": string, "key_findings": string[], "limitations": string[], "safety_notes": string[], "not_medical_advice": true}.',
          'Completeness requirements: include at least 5 key_findings, 4 limitations, and 4 safety_notes when evidence exists.',
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
          'You are a senior equity research analyst specializing in forensic financial statement review. Return strict JSON only. Do not use markdown code fences.'
      },
      {
        role: 'user',
        content: [
          'The prior response was too sparse and left structured arrays mostly empty.',
          'Return JSON with keys:',
          '{"executive_summary": string, "key_metrics": [{"metric": string, "value": string, "interpretation": string}], "risk_flags": string[], "recommendations": string[], "disclaimer": string}.',
          'Completeness requirements: include at least 4 key_metrics, 4 risk_flags, and 4 recommendations when evidence exists.',
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

  return [];
};

const callLlmWithFallback = async (params: {
  taskType: TaskType;
  order: ProviderName[];
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  temperature: number;
}): Promise<{ providerName: ProviderName; result: GenerateTextResult; model: string }> => {
  let lastError: unknown = null;

  for (const providerName of params.order) {
    const provider = providers[providerName];
    if (!provider) continue;

    const model = MODEL_BY_TASK_AND_PROVIDER[params.taskType][providerName];

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
    useCase: vertical.id
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

  const generation = await callLlmWithFallback({
    taskType,
    order: generationOrder,
    messages,
    maxTokens,
    temperature
  });
  usageCallRecords.push({
    providerName: generation.providerName,
    requestText: messages.map((message) => message.content).join('\n\n'),
    result: generation.result
  });

  let output = parseValidatedOutput(vertical.outputSchema, vertical.id, generation.result.text);
  if (vertical.postProcess) {
    output = await vertical.postProcess(output);
  }

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
          temperature: Math.min(temperature, 0.3)
        });

        usageCallRecords.push({
          providerName: enrichmentGeneration.providerName,
          requestText: enrichmentMessages.map((message) => message.content).join('\n\n'),
          result: enrichmentGeneration.result
        });

        let enrichedOutput = parseValidatedOutput(vertical.outputSchema, vertical.id, enrichmentGeneration.result.text);
        if (vertical.postProcess) {
          enrichedOutput = await vertical.postProcess(enrichedOutput);
        }

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
