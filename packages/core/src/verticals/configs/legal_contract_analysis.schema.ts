import { z } from 'zod';
import {
  confidenceFieldSchema,
  evidenceQuotesFieldSchema,
  metadataFieldSchema,
  NOT_PROVIDED,
  recommendationsFieldSchema,
  risksFieldSchema
} from './_expert_analysis.shared';

const legacyLegalRiskSchema = z.object({
  clause: z.string().min(1),
  risk_level: z.enum(['low', 'medium', 'high']),
  explanation: z.string().min(1),
  evidence_quote_refs: z.array(z.string().min(1)).default([])
});

export const legalContractAnalysisResultSchema = z.object({
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
  metadata: metadataFieldSchema('legal_contract_analysis').default({
    useCaseKey: 'legal_contract_analysis',
    createdAt: new Date().toISOString()
  }),

  // Domain-specific legal extracted fields (used for no-hallucination checks and UI detail)
  contractType: z.string().min(1).default(NOT_PROVIDED),
  parties: z.string().min(1).default(NOT_PROVIDED),
  governingLaw: z.string().min(1).default(NOT_PROVIDED),
  jurisdiction: z.string().min(1).default(NOT_PROVIDED),
  disputeResolution: z.string().min(1).default(NOT_PROVIDED),
  liabilityCap: z.string().min(1).default(NOT_PROVIDED),

  // Legacy compatibility aliases (pipeline/UI/tests still reference these)
  summary: z.string().min(1).default(NOT_PROVIDED),
  executive_summary: z.string().min(1).default(NOT_PROVIDED),
  evidence_quotes: z.array(z.object({ quote: z.string(), source_ref: z.string().optional(), relevance: z.string() })).default([]),
  key_risks: z.array(legacyLegalRiskSchema).default([]),
  obligations: z.array(z.string().min(1)).default([]),
  missing_info: z.array(z.string().min(1)).default([]),
  contract_type: z.string().min(1).default(NOT_PROVIDED),
  governing_law: z.string().min(1).default(NOT_PROVIDED),
  dispute_resolution: z.string().min(1).default(NOT_PROVIDED),
  liability_cap: z.string().min(1).default(NOT_PROVIDED),
  disclaimer: z.string().min(1).default('This is an AI analysis and not legal advice.')
});

export const legalContractAnalysisSchema = legalContractAnalysisResultSchema;

export type LegalContractAnalysisResult = z.infer<typeof legalContractAnalysisResultSchema>;
export type LegalContractAnalysisOutput = LegalContractAnalysisResult;
