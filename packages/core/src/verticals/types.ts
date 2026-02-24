import type { z } from 'zod';

export type VerticalInputType = 'text' | 'pdf';

export interface VerticalRagConfig {
  enabled: boolean;
  storeInputAsDocs: boolean;
  topK: number;
}

export interface VerticalPromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface VerticalPromptContext {
  inputText: string;
  context: string;
  useCase: string;
  locale?: string;
}

export interface VerticalPiiRule {
  id: string;
  pattern: RegExp;
  replacement: string;
  description?: string;
}

export interface VerticalRefusalRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

export interface VerticalGuardrails {
  piiRules: VerticalPiiRule[];
  refusalRules: VerticalRefusalRule[];
}

export interface VerticalGuardrailEvaluation {
  sanitizedInput: string;
  piiMatches: string[];
  refusalMatches: Array<{
    id: string;
    reason: string;
  }>;
}

export interface VerticalConfig<TOutput = unknown> {
  id: string;
  name: string;
  inputTypesAllowed: VerticalInputType[];
  rag: VerticalRagConfig;
  promptTemplate: (context: VerticalPromptContext) => VerticalPromptMessage[];
  outputSchema: z.ZodTypeAny;
  postProcess?: (output: TOutput) => TOutput | Promise<TOutput>;
  guardrails: VerticalGuardrails;
}

type VerticalDefinition<TSchema extends z.ZodTypeAny> = Omit<
  VerticalConfig<z.output<TSchema>>,
  'outputSchema' | 'postProcess'
> & {
  outputSchema: TSchema;
  postProcess?: (output: z.output<TSchema>) => z.output<TSchema> | Promise<z.output<TSchema>>;
};

export const defineVertical = <TSchema extends z.ZodTypeAny>(config: VerticalDefinition<TSchema>): VerticalConfig => {
  return config as VerticalConfig;
};
