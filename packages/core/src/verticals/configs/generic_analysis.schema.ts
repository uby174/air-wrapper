import { z } from 'zod';

export const genericAnalysisSchema = z.object({
  answer: z.string().min(1),
  key_points: z.array(z.string()).default([])
});

export type GenericAnalysisOutput = z.infer<typeof genericAnalysisSchema>;
