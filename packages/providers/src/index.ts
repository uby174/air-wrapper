export type ProviderName = 'openai' | 'anthropic' | 'google';
export type ProviderAction = 'generateText' | 'embed';
export type MessageRole = 'system' | 'user' | 'assistant';

const DEFAULT_TIMEOUT_MS = 25_000;

interface JsonRecord {
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

const parseJson = (raw: string): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const providerStatusRetryable = (status: number): boolean =>
  status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

const extractErrorDetails = (payload: unknown): { message?: string; code?: string } => {
  if (!isRecord(payload)) return {};

  const nestedError = payload.error;
  if (isRecord(nestedError)) {
    return {
      message: asString(nestedError.message) ?? asString(payload.message),
      code: asString(nestedError.code) ?? asString(nestedError.type) ?? asString(payload.code)
    };
  }

  return {
    message: asString(payload.message),
    code: asString(payload.code)
  };
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GenerateTextParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface GenerateTextResult {
  text: string;
  usage?: ProviderUsage;
}

export interface EmbedParams {
  model: string;
  inputs: string[];
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
}

export interface LLMProvider {
  readonly name: ProviderName;
  generateText(input: GenerateTextParams): Promise<GenerateTextResult>;
  embed(input: EmbedParams): Promise<EmbedResult>;
}

export interface ProviderErrorLog {
  provider: ProviderName;
  model: string;
  status: number | null;
  error: string;
}

export class ProviderRequestError extends Error {
  readonly provider: ProviderName;
  readonly model: string;
  readonly status: number | null;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(params: {
    message: string;
    provider: ProviderName;
    model: string;
    status: number | null;
    retryable: boolean;
    code?: string;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'ProviderRequestError';
    this.provider = params.provider;
    this.model = params.model;
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable;
  }
}

interface RequestJsonInput {
  provider: ProviderName;
  model: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
}

const requestJson = async (input: RequestJsonInput): Promise<unknown> => {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...input.headers
      },
      body: JSON.stringify(input.body),
      signal: controller.signal
    });

    const rawBody = await response.text();
    const payload = parseJson(rawBody);

    if (!response.ok) {
      const details = extractErrorDetails(payload);
      const status = response.status;
      throw new ProviderRequestError({
        provider: input.provider,
        model: input.model,
        status,
        code: details.code,
        retryable: providerStatusRetryable(status),
        message: details.message ?? `${input.provider} request failed with status ${status}`
      });
    }

    return payload;
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }

    if (isAbortError(error)) {
      throw new ProviderRequestError({
        provider: input.provider,
        model: input.model,
        status: null,
        code: 'TIMEOUT',
        retryable: true,
        message: `${input.provider} request timed out after ${timeoutMs}ms`,
        cause: error
      });
    }

    throw new ProviderRequestError({
      provider: input.provider,
      model: input.model,
      status: null,
      code: 'NETWORK_ERROR',
      retryable: true,
      message: `${input.provider} request failed before response`,
      cause: error
    });
  } finally {
    clearTimeout(timer);
  }
};

const parseUsage = (usage: unknown): ProviderUsage | undefined => {
  if (!isRecord(usage)) return undefined;

  const inputTokens = asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens) ?? asNumber(usage.promptTokenCount);
  const outputTokens =
    asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens) ?? asNumber(usage.candidatesTokenCount);
  const totalTokens = asNumber(usage.total_tokens) ?? asNumber(usage.totalTokenCount);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
};

const parseOpenAIText = (payload: unknown): string => {
  if (!isRecord(payload)) return '';
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) return '';
  const message = choices[0].message;
  if (!isRecord(message)) return '';

  const content = message.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) ? asString(part.text) : undefined))
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
  }

  return '';
};

const parseOpenAIEmbeddings = (payload: unknown): number[][] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('OpenAI embeddings response missing data array');
  }

  return payload.data.map((item, index) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new Error(`OpenAI embeddings response item ${index} missing embedding`);
    }

    return item.embedding.map((value) => {
      if (typeof value !== 'number') {
        throw new Error(`OpenAI embeddings response item ${index} has non-numeric value`);
      }
      return value;
    });
  });
};

const parseAnthropicText = (payload: unknown): string => {
  if (!isRecord(payload) || !Array.isArray(payload.content)) return '';

  return payload.content
    .map((block) => (isRecord(block) && block.type === 'text' ? asString(block.text) : undefined))
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
};

const parseAnthropicEmbeddings = (payload: unknown): number[][] => {
  if (!isRecord(payload)) throw new Error('Anthropic embeddings response is not an object');

  if (Array.isArray(payload.data)) {
    return payload.data.map((item, index) => {
      if (!isRecord(item) || !Array.isArray(item.embedding)) {
        throw new Error(`Anthropic embeddings response item ${index} missing embedding`);
      }

      return item.embedding.map((value) => {
        if (typeof value !== 'number') {
          throw new Error(`Anthropic embeddings response item ${index} has non-numeric value`);
        }
        return value;
      });
    });
  }

  if (Array.isArray(payload.embeddings)) {
    return payload.embeddings.map((item, index) => {
      if (!isRecord(item) || !Array.isArray(item.values)) {
        throw new Error(`Anthropic embeddings response item ${index} missing values`);
      }

      return item.values.map((value) => {
        if (typeof value !== 'number') {
          throw new Error(`Anthropic embeddings response item ${index} has non-numeric value`);
        }
        return value;
      });
    });
  }

  throw new Error('Anthropic embeddings response missing supported arrays');
};

const parseGoogleText = (payload: unknown): string => {
  if (!isRecord(payload) || !Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    return '';
  }

  const candidate = payload.candidates[0];
  if (!isRecord(candidate)) return '';
  const content = candidate.content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return '';

  return content.parts
    .map((part) => (isRecord(part) ? asString(part.text) : undefined))
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
};

const parseGoogleEmbeddings = (payload: unknown): number[][] => {
  if (!isRecord(payload) || !Array.isArray(payload.embeddings)) {
    throw new Error('Google embeddings response missing embeddings array');
  }

  return payload.embeddings.map((item, index) => {
    if (!isRecord(item) || !Array.isArray(item.values)) {
      throw new Error(`Google embeddings response item ${index} missing values`);
    }

    return item.values.map((value) => {
      if (typeof value !== 'number') {
        throw new Error(`Google embeddings response item ${index} has non-numeric value`);
      }
      return value;
    });
  });
};

const toAnthropicMessages = (
  messages: ChatMessage[]
): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } => {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((value) => value.length > 0)
    .join('\n\n');

  const conversation = messages
    .filter((message) => message.role !== 'system')
    .map((message): { role: 'user' | 'assistant'; content: string } => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content
    }));

  return {
    system: system.length > 0 ? system : undefined,
    messages: conversation.length > 0 ? conversation : [{ role: 'user', content: '' }]
  };
};

const toGoogleContent = (
  messages: ChatMessage[]
): { systemInstruction?: { parts: Array<{ text: string }> }; contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> } => {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((value) => value.length > 0)
    .join('\n\n');

  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message): { role: 'user' | 'model'; parts: Array<{ text: string }> } => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));

  return {
    systemInstruction: system.length > 0 ? { parts: [{ text: system }] } : undefined,
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: '' }] }]
  };
};

const trimTrailingSlash = (input: string): string => input.replace(/\/+$/, '');

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class OpenAIProvider implements LLMProvider {
  readonly name: ProviderName = 'openai';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs?: number;

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new Error('OpenAIProvider requires a non-empty apiKey');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? 'https://api.openai.com/v1');
    this.timeoutMs = config.timeoutMs;
  }

  async generateText(input: GenerateTextParams): Promise<GenerateTextResult> {
    const payload = await requestJson({
      provider: this.name,
      model: input.model,
      url: `${this.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: {
        model: input.model,
        messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
        temperature: input.temperature,
        max_tokens: input.maxTokens
      },
      timeoutMs: input.timeoutMs ?? this.timeoutMs
    });

    return {
      text: parseOpenAIText(payload),
      usage: isRecord(payload) ? parseUsage(payload.usage) : undefined
    };
  }

  async embed(input: EmbedParams): Promise<EmbedResult> {
    const payload = await requestJson({
      provider: this.name,
      model: input.model,
      url: `${this.baseUrl}/embeddings`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: {
        model: input.model,
        input: input.inputs
      },
      timeoutMs: input.timeoutMs ?? this.timeoutMs
    });

    return { vectors: parseOpenAIEmbeddings(payload) };
  }
}

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
  anthropicVersion?: string;
  timeoutMs?: number;
}

export class AnthropicProvider implements LLMProvider {
  readonly name: ProviderName = 'anthropic';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly timeoutMs?: number;

  constructor(config: AnthropicProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new Error('AnthropicProvider requires a non-empty apiKey');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? 'https://api.anthropic.com/v1');
    this.version = config.anthropicVersion ?? '2023-06-01';
    this.timeoutMs = config.timeoutMs;
  }

  async generateText(input: GenerateTextParams): Promise<GenerateTextResult> {
    const normalized = toAnthropicMessages(input.messages);

    const payload = await requestJson({
      provider: this.name,
      model: input.model,
      url: `${this.baseUrl}/messages`,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.version
      },
      body: {
        model: input.model,
        max_tokens: input.maxTokens ?? 512,
        temperature: input.temperature,
        system: normalized.system,
        messages: normalized.messages
      },
      timeoutMs: input.timeoutMs ?? this.timeoutMs
    });

    return {
      text: parseAnthropicText(payload),
      usage: isRecord(payload) ? parseUsage(payload.usage) : undefined
    };
  }

  async embed(input: EmbedParams): Promise<EmbedResult> {
    const payload = await requestJson({
      provider: this.name,
      model: input.model,
      url: `${this.baseUrl}/embeddings`,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.version
      },
      body: {
        model: input.model,
        input: input.inputs
      },
      timeoutMs: input.timeoutMs ?? this.timeoutMs
    });

    return { vectors: parseAnthropicEmbeddings(payload) };
  }
}

export interface GoogleProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  vertexEndpoint?: string;
  vertexAccessToken?: string;
  timeoutMs?: number;
}

export class GoogleProvider implements LLMProvider {
  readonly name: ProviderName = 'google';

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly vertexEndpoint?: string;
  private readonly vertexAccessToken?: string;
  private readonly timeoutMs?: number;

  constructor(config: GoogleProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta');
    this.vertexEndpoint = config.vertexEndpoint ? trimTrailingSlash(config.vertexEndpoint) : undefined;
    this.vertexAccessToken = config.vertexAccessToken;
    this.timeoutMs = config.timeoutMs;

    const hasGemini = Boolean(this.apiKey);
    const hasVertex = Boolean(this.vertexEndpoint && this.vertexAccessToken);

    if (!hasGemini && !hasVertex) {
      throw new Error('GoogleProvider requires either apiKey (Gemini) or vertexEndpoint + vertexAccessToken (Vertex)');
    }
  }

  private buildGoogleUrl(model: string, action: 'generateContent' | 'batchEmbedContents'): string {
    if (this.vertexEndpoint && this.vertexAccessToken) {
      const hasModelSegment = this.vertexEndpoint.includes('/models/');
      const base = hasModelSegment ? this.vertexEndpoint : `${this.vertexEndpoint}/models/${encodeURIComponent(model)}`;
      return `${base}:${action}`;
    }

    return `${this.baseUrl}/models/${encodeURIComponent(model)}:${action}?key=${this.apiKey}`;
  }

  private googleHeaders(): Record<string, string> {
    if (this.vertexAccessToken) {
      return { Authorization: `Bearer ${this.vertexAccessToken}` };
    }
    return {};
  }

  async generateText(input: GenerateTextParams): Promise<GenerateTextResult> {
    const normalized = toGoogleContent(input.messages);

    const payload = await requestJson({
      provider: this.name,
      model: input.model,
      url: this.buildGoogleUrl(input.model, 'generateContent'),
      headers: this.googleHeaders(),
      body: {
        systemInstruction: normalized.systemInstruction,
        contents: normalized.contents,
        generationConfig: {
          temperature: input.temperature,
          maxOutputTokens: input.maxTokens
        }
      },
      timeoutMs: input.timeoutMs ?? this.timeoutMs
    });

    return {
      text: parseGoogleText(payload),
      usage: isRecord(payload) ? parseUsage(payload.usageMetadata) : undefined
    };
  }

  async embed(input: EmbedParams): Promise<EmbedResult> {
    const payload = await requestJson({
      provider: this.name,
      model: input.model,
      url: this.buildGoogleUrl(input.model, 'batchEmbedContents'),
      headers: this.googleHeaders(),
      body: {
        requests: input.inputs.map((text) => ({
          content: {
            parts: [{ text }]
          }
        }))
      },
      timeoutMs: input.timeoutMs ?? this.timeoutMs
    });

    return { vectors: parseGoogleEmbeddings(payload) };
  }
}

type FallbackRequestMap = {
  generateText: GenerateTextParams;
  embed: EmbedParams;
};

type FallbackResultMap = {
  generateText: GenerateTextResult;
  embed: EmbedResult;
};

export interface ExecuteWithFallbackRequest<TAction extends ProviderAction> {
  action: TAction;
  input: FallbackRequestMap[TAction];
  providers: Partial<Record<ProviderName, LLMProvider>>;
  logger?: (entry: ProviderErrorLog) => void;
}

export interface ExecuteWithFallbackResult<TAction extends ProviderAction> {
  provider: ProviderName;
  result: FallbackResultMap[TAction];
}

const normalizeLogError = (error: unknown): { status: number | null; message: string } => {
  if (error instanceof ProviderRequestError) {
    return { status: error.status, message: error.message };
  }

  if (error instanceof Error) {
    return { status: null, message: error.message };
  }

  return { status: null, message: 'Unknown provider error' };
};

export const executeWithFallback = async <TAction extends ProviderAction>(
  request: ExecuteWithFallbackRequest<TAction>,
  preferredProviderOrder: ProviderName[]
): Promise<ExecuteWithFallbackResult<TAction>> => {
  let lastError: unknown = null;
  const logger = request.logger ?? ((entry: ProviderErrorLog) => console.error(entry));

  for (const providerName of preferredProviderOrder) {
    const provider = request.providers[providerName];
    if (!provider) continue;

    try {
      if (request.action === 'generateText') {
        const result = await provider.generateText(request.input as GenerateTextParams);
        return { provider: providerName, result: result as FallbackResultMap[TAction] };
      }

      const result = await provider.embed(request.input as EmbedParams);
      return { provider: providerName, result: result as FallbackResultMap[TAction] };
    } catch (error) {
      lastError = error;
      const normalized = normalizeLogError(error);

      logger({
        provider: providerName,
        model: request.input.model,
        status: normalized.status,
        error: normalized.message
      });
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('No providers available for requested fallback order');
};

export interface CompletionInput {
  system: string;
  user: string;
}

export interface ProviderAdapter {
  name: ProviderName;
  complete(input: CompletionInput): Promise<string>;
}

export interface ProviderConfig {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
}

const fallbackReply = (provider: ProviderName, user: string): string =>
  `[${provider}] API key missing, returning local fallback for: ${user.slice(0, 80)}`;

const LEGACY_MODELS: Record<ProviderName, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  google: 'gemini-pro-latest'
};

const toLegacyAdapter = (providerName: ProviderName, provider: LLMProvider | undefined): ProviderAdapter => ({
  name: providerName,
  complete: async ({ system, user }) => {
    if (!provider) return fallbackReply(providerName, user);

    const response = await provider.generateText({
      model: LEGACY_MODELS[providerName],
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    return response.text || `No response from ${providerName}.`;
  }
});

export const createProviderAdapters = (config: ProviderConfig): Record<ProviderName, ProviderAdapter> => {
  const providers: Partial<Record<ProviderName, LLMProvider>> = {};

  if (config.openaiApiKey) {
    providers.openai = new OpenAIProvider({ apiKey: config.openaiApiKey });
  }

  if (config.anthropicApiKey) {
    providers.anthropic = new AnthropicProvider({ apiKey: config.anthropicApiKey });
  }

  if (config.googleApiKey) {
    providers.google = new GoogleProvider({ apiKey: config.googleApiKey });
  }

  return {
    openai: toLegacyAdapter('openai', providers.openai),
    anthropic: toLegacyAdapter('anthropic', providers.anthropic),
    google: toLegacyAdapter('google', providers.google)
  };
};
