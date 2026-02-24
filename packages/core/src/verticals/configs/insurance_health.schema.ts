import { z } from 'zod';

export const HealthInsuranceSchema = z.object({
  plain_summary: z
    .string()
    .describe('3-5 sentences in plain English (no jargon) explaining what this plan covers'),
  plan_type: z
    .string()
    .describe("e.g. 'HMO', 'PPO', 'EPO', 'HDHP', 'Public Health / AOK', 'Private (PKV)'"),
  monthly_cost: z.object({
    premium: z.string().describe('monthly premium amount'),
    deductible: z.string().describe('annual deductible (Selbstbeteiligung)'),
    out_of_pocket_max: z.string().describe('maximum you pay per year'),
    copays: z.array(z.string()).describe("e.g. ['€10 GP visit', '€30 specialist']")
  }),
  what_is_covered: z.array(
    z.object({
      category: z.string().describe("e.g. 'Hospital stays', 'Dental', 'Mental health'"),
      covered: z.boolean(),
      details: z.string().describe('plain explanation')
    })
  ),
  what_is_NOT_covered: z.array(
    z.object({
      exclusion: z.string().describe("plain name, e.g. 'Cosmetic surgery'"),
      reason: z.string().describe('brief explanation why it is excluded'),
      impact: z.string().describe('what this means for you specifically')
    })
  ),
  risks: z.array(
    z.object({
      title: z.string(),
      description: z.string().describe('explain risk in simple terms'),
      severity: z.enum(['low', 'medium', 'high']),
      what_to_watch_out_for: z.string()
    })
  ),
  benefits: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      value_to_you: z.string().describe('why this matters in practice')
    })
  ),
  most_important: z
    .array(z.string())
    .describe(
      '5 bullet points: the MOST important things to know before signing. Written as if explaining to a friend, no legal language'
    ),
  questions_to_ask: z
    .array(z.string())
    .describe('3-5 specific questions the person should ask the insurer'),
  red_flags: z
    .array(z.string())
    .describe('Anything unusual, suspicious, or that a consumer should be wary of'),
  overall_rating: z.object({
    score: z.number().min(1).max(10).describe('overall quality score'),
    verdict: z.enum(['excellent', 'good', 'fair', 'poor', 'avoid']),
    one_line_summary: z.string().describe('one sentence verdict for a non-expert')
  }),
  disclaimer: z
    .string()
    .describe("standard: 'This is informational only, not medical or legal advice'")
});

export type HealthInsuranceAnalysis = z.infer<typeof HealthInsuranceSchema>;
