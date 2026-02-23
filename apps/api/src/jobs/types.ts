import { z } from 'zod';

const providerNameSchema = z.enum(['openai', 'anthropic', 'google', 'ollama']);

const textInputSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
  storageUrl: z.string().url().optional()
});

const pdfInputSchema = z.object({
  type: z.literal('pdf'),
  storageUrl: z.string().url(),
  text: z.string().optional()
});

export const jobInputSchema = z.discriminatedUnion('type', [textInputSchema, pdfInputSchema]);

export const jobOptionsSchema = z
  .object({
    rag: z
      .object({
        enabled: z.boolean().optional(),
        storeInputAsDocs: z.boolean().optional(),
        storeInput: z.boolean().optional(),
        topK: z.number().int().min(1).max(20).optional()
      })
      .optional(),
    preferredProviders: z.array(providerNameSchema).min(1).max(3).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional()
  })
  .optional();

export const createJobRequestSchema = z.object({
  use_case: z.string().min(1),
  input: jobInputSchema,
  options: jobOptionsSchema
});

export const persistedJobInputSchema = z.object({
  input: jobInputSchema,
  options: jobOptionsSchema
});

export const aiJobQueuePayloadSchema = z.object({
  dbJobId: z.string().uuid(),
  runtimeInput: jobInputSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional()
});

export type JobInput = z.infer<typeof jobInputSchema>;
export type JobOptions = z.infer<typeof jobOptionsSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type PersistedJobInput = z.infer<typeof persistedJobInputSchema>;
export type AiJobQueuePayload = z.infer<typeof aiJobQueuePayloadSchema>;
