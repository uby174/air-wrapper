import { z } from 'zod';
import {
  confidenceFieldSchema,
  evidenceQuotesFieldSchema,
  metadataFieldSchema,
  NOT_PROVIDED,
  recommendationsFieldSchema,
  risksFieldSchema
} from './_expert_analysis.shared';

export const medicalResearchSummaryResultSchema = z.object({
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
  metadata: metadataFieldSchema('medical_research_summary').default({
    useCaseKey: 'medical_research_summary',
    createdAt: new Date().toISOString()
  }),

  // Domain-specific extracted fields used for deterministic summaries
  researchQuestion: z.string().min(1).default(NOT_PROVIDED),
  studyDesign: z.string().min(1).default(NOT_PROVIDED),
  sampleSize: z.string().min(1).default(NOT_PROVIDED),
  primaryEndpoint: z.string().min(1).default(NOT_PROVIDED),
  effectSizeSummary: z.string().min(1).default(NOT_PROVIDED),

  // Legacy compatibility aliases
  research_question: z.string().min(1).default(NOT_PROVIDED),
  evidence_summary: z.string().min(1).default(NOT_PROVIDED),
  key_findings: z.array(z.string().min(1)).default([]),
  limitations: z.array(z.string().min(1)).default([]),
  safety_notes: z.array(z.string().min(1)).default([]),
  missing_info: z.array(z.string().min(1)).default([]),
  study_design: z.string().min(1).default(NOT_PROVIDED),
  sample_size: z.string().min(1).default(NOT_PROVIDED),
  primary_endpoint: z.string().min(1).default(NOT_PROVIDED),
  effect_size_summary: z.string().min(1).default(NOT_PROVIDED),
  executive_summary: z.string().min(1).default(NOT_PROVIDED),
  evidence_quotes: z.array(z.object({ quote: z.string(), source_ref: z.string().optional(), relevance: z.string() })).default([]),
  disclaimer: z.string().min(1).default('This is an AI analysis of research evidence and not medical advice.'),
  not_medical_advice: z.literal(true).default(true)
});

export const medicalResearchSummarySchema = medicalResearchSummaryResultSchema;

export type MedicalResearchSummaryResult = z.infer<typeof medicalResearchSummaryResultSchema>;
export type MedicalResearchSummaryOutput = MedicalResearchSummaryResult;
