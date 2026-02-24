import { z } from 'zod';
import {
  confidenceFieldSchema,
  evidenceQuotesFieldSchema,
  metadataFieldSchema,
  NOT_PROVIDED,
  recommendationsFieldSchema,
  risksFieldSchema
} from './_expert_analysis.shared';

const legacyMetricSchema = z.object({
  metric: z.string().min(1),
  value: z.string().min(1),
  interpretation: z.string().min(1)
});

export const financialReportAnalysisResultSchema = z.object({
  executiveSummary: z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
      return [NOT_PROVIDED];
    },
    z.array(z.string().min(1)).min(1).max(8).default([NOT_PROVIDED])
  ),
  evidenceQuotes: evidenceQuotesFieldSchema,
  risks: risksFieldSchema,
  recommendations: recommendationsFieldSchema,
  missingInfo: z.array(z.string().min(1)).max(30).default([]),
  confidence: confidenceFieldSchema.default({ overall: 'low', reasons: ['Confidence not provided.'] }),
  metadata: metadataFieldSchema('financial_report_analysis').default({
    useCaseKey: 'financial_report_analysis',
    createdAt: new Date().toISOString()
  }),

  reportingPeriod: z.string().min(1).default(NOT_PROVIDED),
  revenueNumbers: z.string().min(1).default(NOT_PROVIDED),
  liquidityPosition: z.string().min(1).default(NOT_PROVIDED),

  // Legacy compatibility aliases
  executive_summary: z.string().min(1).default(NOT_PROVIDED),
  evidence_quotes: z.array(z.object({ quote: z.string(), source_ref: z.string().optional(), relevance: z.string() })).default([]),
  key_metrics: z.array(legacyMetricSchema).default([]),
  risk_flags: z.array(z.string().min(1)).default([]),
  missing_info: z.array(z.string().min(1)).default([]),
  reporting_period: z.string().min(1).default(NOT_PROVIDED),
  revenue_numbers: z.string().min(1).default(NOT_PROVIDED),
  liquidity_position: z.string().min(1).default(NOT_PROVIDED),
  disclaimer: z.string().min(1).default('This analysis is informational and not investment advice.')
});

export const financialReportAnalysisSchema = financialReportAnalysisResultSchema;

export type FinancialReportAnalysisResult = z.infer<typeof financialReportAnalysisResultSchema>;
export type FinancialReportAnalysisOutput = FinancialReportAnalysisResult;
