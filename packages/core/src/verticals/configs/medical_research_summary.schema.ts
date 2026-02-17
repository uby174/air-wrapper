import { z } from 'zod';

export const medicalResearchSummarySchema = z.object({
  research_question: z.string().min(1),
  evidence_summary: z.string().min(1),
  key_findings: z.array(z.string().min(1)).default([]),
  limitations: z.array(z.string().min(1)).default([]),
  safety_notes: z.array(z.string().min(1)).default([]),
  not_medical_advice: z.literal(true).default(true)
});

export type MedicalResearchSummaryOutput = z.infer<typeof medicalResearchSummarySchema>;
