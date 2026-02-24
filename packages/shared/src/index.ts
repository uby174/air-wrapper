import { z } from 'zod';

export const chatRequestSchema = z.object({
  message: z.string().min(1),
  provider: z.enum(['openai', 'anthropic', 'google']).default('openai')
});

export const chatResponseSchema = z.object({
  reply: z.string(),
  provider: z.enum(['openai', 'anthropic', 'google'])
});

export const healthSchema = z.object({
  ok: z.literal(true),
  service: z.string()
});

export const expertUseCaseKeySchema = z.enum([
  'legal_contract_analysis',
  'medical_research_summary',
  'financial_report_analysis'
]);

export const expertAnalysisSeveritySchema = z.enum(['high', 'medium', 'low']);
export const expertAnalysisPrioritySchema = z.enum(['high', 'medium', 'low']);

export const expertAnalysisEvidenceQuoteSchema = z.object({
  quote: z.string().min(1),
  relevance: z.string().min(1)
});

export const expertAnalysisRiskSchema = z.object({
  title: z.string().min(1),
  severity: expertAnalysisSeveritySchema,
  evidenceQuote: z.string().min(1),
  impact: z.string().min(1),
  mitigation: z.string().min(1)
});

export const expertAnalysisRecommendationSchema = z.object({
  action: z.string().min(1),
  rationale: z.string().min(1),
  priority: expertAnalysisPrioritySchema
});

export const expertAnalysisConfidenceSchema = z.object({
  overall: z.enum(['high', 'medium', 'low']),
  reasons: z.array(z.string().min(1))
});

export const expertAnalysisMetadataSchema = z.object({
  useCaseKey: expertUseCaseKeySchema,
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  createdAt: z.string().datetime({ offset: true })
});

export const ExpertAnalysisResultSchema = z.object({
  executiveSummary: z.array(z.string().min(1)).min(1).max(8),
  evidenceQuotes: z.array(expertAnalysisEvidenceQuoteSchema).max(20),
  risks: z.array(expertAnalysisRiskSchema).max(30),
  recommendations: z.array(expertAnalysisRecommendationSchema).max(30),
  missingInfo: z.array(z.string().min(1)).max(30),
  confidence: expertAnalysisConfidenceSchema,
  metadata: expertAnalysisMetadataSchema
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type HealthResponse = z.infer<typeof healthSchema>;
export type ExpertUseCaseKey = z.infer<typeof expertUseCaseKeySchema>;
export type ExpertAnalysisResult = z.infer<typeof ExpertAnalysisResultSchema>;
