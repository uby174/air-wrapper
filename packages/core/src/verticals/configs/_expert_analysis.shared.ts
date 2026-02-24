import { z } from 'zod';
import {
  expertAnalysisConfidenceSchema,
  expertAnalysisEvidenceQuoteSchema,
  expertAnalysisMetadataSchema,
  expertAnalysisPrioritySchema,
  expertAnalysisRecommendationSchema,
  expertAnalysisRiskSchema,
  expertAnalysisSeveritySchema,
  expertUseCaseKeySchema
} from '@ai-wrapper/shared';

export const NOT_PROVIDED = 'Not provided' as const;
export const EXPERT_ANALYSIS_SCHEMA_VERSION = 'expert_analysis_v3' as const;

export const severitySchema = expertAnalysisSeveritySchema;
export const prioritySchema = expertAnalysisPrioritySchema;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const toNonEmptyString = (value: unknown, fallback: string = NOT_PROVIDED): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
};

export const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
};

export const hasProvidedValue = (value: string): boolean => value.trim().length > 0 && value.trim() !== NOT_PROVIDED;

export const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values.filter((v) => v.trim().length > 0)));

export const nowIsoString = (): string => new Date().toISOString();

export const isGermanLocale = (locale: string | undefined | null): boolean => {
  if (!locale) return false;
  return /^de(?:[-_]|$)/i.test(locale.trim());
};

export const localeNarrativeInstruction = (locale: string | undefined | null): string =>
  isGermanLocale(locale)
    ? 'Narrative fields must be in formal German using "Sie".'
    : 'Narrative fields must be in English.';

export const toExecutiveSummaryArray = (value: unknown, fallbackSource?: string): string[] => {
  if (Array.isArray(value)) {
    const lines = toStringArray(value);
    if (lines.length > 0) return lines;
  }
  const fallback = toNonEmptyString(value, toNonEmptyString(fallbackSource, NOT_PROVIDED));
  if (fallback === NOT_PROVIDED) return [NOT_PROVIDED];
  return fallback
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
};

export const normalizeEvidenceQuotes = (value: unknown): Array<z.infer<typeof expertAnalysisEvidenceQuoteSchema>> => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const quote = toNonEmptyString(entry.quote, '');
      if (!quote) return null;
      const relevance = toNonEmptyString(entry.relevance, '');
      return {
        quote,
        relevance: relevance || 'Relevance not provided.'
      };
    })
    .filter((entry): entry is z.infer<typeof expertAnalysisEvidenceQuoteSchema> => Boolean(entry));
};

export const normalizeStructuredRisks = (value: unknown): Array<z.infer<typeof expertAnalysisRiskSchema>> => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (!isRecord(entry)) return null;

      const severityRaw = typeof entry.severity === 'string' ? entry.severity.trim().toLowerCase() : '';
      const legacySeverityRaw = typeof entry.risk_level === 'string' ? entry.risk_level.trim().toLowerCase() : '';
      const severityValue = severityRaw || legacySeverityRaw;
      const severity: z.infer<typeof severitySchema> =
        severityValue === 'high' || severityValue === 'medium' || severityValue === 'low' ? severityValue : 'medium';

      const title = toNonEmptyString(entry.title ?? entry.clause, '');
      const impact = toNonEmptyString(entry.impact ?? entry.explanation, '');
      if (!title || !impact) return null;

      const evidenceQuote = toNonEmptyString(entry.evidenceQuote ?? entry.evidence_quote, '');
      const mitigation = toNonEmptyString(
        entry.mitigation,
        'Review the cited evidence and request clarification or supporting documentation before acting.'
      );

      return {
        title,
        severity,
        evidenceQuote: evidenceQuote || NOT_PROVIDED,
        impact,
        mitigation
      };
    })
    .filter((entry): entry is z.infer<typeof expertAnalysisRiskSchema> => Boolean(entry));
};

export const normalizeStructuredRecommendations = (
  value: unknown
): Array<z.infer<typeof expertAnalysisRecommendationSchema>> => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        const action = entry.trim();
        if (!action) return null;
        return {
          action,
          rationale: 'Derived from model recommendation text.',
          priority: 'medium' as const
        };
      }

      if (!isRecord(entry)) return null;
      const action = toNonEmptyString(entry.action, '');
      const rationale = toNonEmptyString(entry.rationale, '');
      if (!action || !rationale) return null;

      const priorityRaw = typeof entry.priority === 'string' ? entry.priority.trim().toLowerCase() : '';
      const priority: z.infer<typeof prioritySchema> =
        priorityRaw === 'high' || priorityRaw === 'medium' || priorityRaw === 'low' ? priorityRaw : 'medium';

      return {
        action,
        rationale,
        priority
      };
    })
    .filter((entry): entry is z.infer<typeof expertAnalysisRecommendationSchema> => Boolean(entry));
};

export const normalizeConfidence = (value: unknown): z.infer<typeof expertAnalysisConfidenceSchema> => {
  if (!isRecord(value)) {
    return {
      overall: 'low',
      reasons: ['Confidence reduced because the model did not provide a structured confidence block.']
    };
  }

  const overallRaw =
    typeof value.overall === 'string'
      ? value.overall.trim().toLowerCase()
      : typeof value.level === 'string'
        ? value.level.trim().toLowerCase()
        : '';
  const overall: z.infer<typeof expertAnalysisConfidenceSchema>['overall'] =
    overallRaw === 'high' || overallRaw === 'medium' || overallRaw === 'low' ? overallRaw : 'medium';

  const reasons = toStringArray(value.reasons);
  if (reasons.length > 0) {
    return { overall, reasons };
  }

  const legacyReason = toNonEmptyString(value.rationale, '');
  return {
    overall,
    reasons: legacyReason ? [legacyReason] : ['Confidence rationale not provided.']
  };
};

export const buildResultMetadata = (
  useCaseKey: z.infer<typeof expertAnalysisMetadataSchema>['useCaseKey'],
  overrides?: Partial<z.infer<typeof expertAnalysisMetadataSchema>>
): z.infer<typeof expertAnalysisMetadataSchema> => ({
  useCaseKey,
  createdAt: overrides?.createdAt ?? nowIsoString(),
  ...(overrides?.provider ? { provider: overrides.provider } : {}),
  ...(overrides?.model ? { model: overrides.model } : {})
});

export const evidenceQuotesFieldSchema = z.preprocess(
  (input) => {
    if (!Array.isArray(input)) return input;
    return input.map((entry) => {
      if (!isRecord(entry)) return entry;
      return {
        quote: entry.quote,
        relevance: entry.relevance ?? entry.source_ref ?? 'Relevance not provided.'
      };
    });
  },
  z.array(expertAnalysisEvidenceQuoteSchema).max(20).default([])
);

export const risksFieldSchema = z.preprocess((input) => normalizeStructuredRisks(input), z.array(expertAnalysisRiskSchema).max(30).default([]));

export const recommendationsFieldSchema = z.preprocess(
  (input) => normalizeStructuredRecommendations(input),
  z.array(expertAnalysisRecommendationSchema).max(30).default([])
);

export const confidenceFieldSchema = z.preprocess((input) => normalizeConfidence(input), expertAnalysisConfidenceSchema);

export const metadataFieldSchema = (useCaseKey: z.infer<typeof expertAnalysisMetadataSchema>['useCaseKey']) =>
  z.preprocess((input) => {
    if (!isRecord(input)) return buildResultMetadata(useCaseKey);
    const legacyUseCaseCandidate = toNonEmptyString(input.useCaseKey ?? input.use_case, useCaseKey);
    const parsedUseCase = expertUseCaseKeySchema.safeParse(legacyUseCaseCandidate);
    const legacyUseCase = parsedUseCase.success ? parsedUseCase.data : useCaseKey;
    const createdAt = toNonEmptyString(input.createdAt, nowIsoString());
    const provider = toNonEmptyString(input.provider, '');
    const model = toNonEmptyString(input.model, '');
    return buildResultMetadata(legacyUseCase, {
      createdAt,
      provider: provider || undefined,
      model: model || undefined
    });
  }, expertAnalysisMetadataSchema.extend({ useCaseKey: z.literal(useCaseKey) }));
