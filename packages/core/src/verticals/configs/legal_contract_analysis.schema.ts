import { z } from 'zod';

export const legalContractAnalysisSchema = z.object({
  summary: z.string().min(1),
  key_risks: z
    .array(
      z.object({
        clause: z.string().min(1),
        risk_level: z.enum(['low', 'medium', 'high']),
        explanation: z.string().min(1)
      })
    )
    .default([]),
  obligations: z.array(z.string().min(1)).default([]),
  recommendations: z.array(z.string().min(1)).default([]),
  disclaimer: z.string().min(1).default('This is an AI analysis and not legal advice.')
});

export type LegalContractAnalysisOutput = z.infer<typeof legalContractAnalysisSchema>;
