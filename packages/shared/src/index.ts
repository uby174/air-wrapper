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

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type HealthResponse = z.infer<typeof healthSchema>;
