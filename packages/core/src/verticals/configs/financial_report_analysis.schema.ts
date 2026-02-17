import { z } from 'zod';

export const financialReportAnalysisSchema = z.object({
  executive_summary: z.string().min(1),
  key_metrics: z
    .array(
      z.object({
        metric: z.string().min(1),
        value: z.string().min(1),
        interpretation: z.string().min(1)
      })
    )
    .default([]),
  risk_flags: z.array(z.string().min(1)).default([]),
  recommendations: z.array(z.string().min(1)).default([]),
  disclaimer: z.string().min(1).default('This analysis is informational and not investment advice.')
});

export type FinancialReportAnalysisOutput = z.infer<typeof financialReportAnalysisSchema>;
