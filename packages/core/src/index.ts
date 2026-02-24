import type { ChatRequest } from '@ai-wrapper/shared';

export const routes = {
  health: '/health',
  chat: '/v1/chat'
} as const;

export type TaskType = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'LOCAL';
export type ProviderName = 'openai' | 'anthropic' | 'google' | 'ollama';

export interface UsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface PriceTable {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface ModelRoute {
  provider: ProviderName;
  model: string;
  maxTokens: number;
  cacheable: boolean;
}

export interface ClassifyTaskOptions {
  classifyAmbiguous?: (input: string) => Promise<TaskType | null | undefined>;
}

export const baseSystemPrompt = [
  'You are AI Wrapper assistant.',
  'Be concise, factual, and safe.',
  'Do not provide harmful instructions.'
].join(' ');

const TASK_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'LOCAL'] as const;

const isTaskType = (value: unknown): value is TaskType =>
  typeof value === 'string' && TASK_ORDER.includes(value as TaskType);

const normalizeText = (input: string): string => input.trim().replace(/\s+/g, ' ').toLowerCase();

const splitWordCount = (value: string): number => value.split(/\s+/).filter(Boolean).length;

const SIMPLE_REGEX = [
  /\btranslate\b/i,
  /\btranslation\b/i,
  /\bspell(?:ing)?\s*(?:check|fix)?\b/i,
  /\bgrammar\b/i,
  /\bproofread\b/i,
  /\brephrase\b/i,
  /\bparaphrase\b/i,
  /\bformat\b/i,
  /\bfix punctuation\b/i,
  /\bwhat is\b/i,
  /\bwho is\b/i,
  /\bwhen is\b/i,
  /\bwhere is\b/i,
  /\bdefine\b/i,
  /\bcapital of\b/i
];

const MEDIUM_REGEX = [
  /\bsummar(?:ize|ise)\b/i,
  /\bcompare\b/i,
  /\bpros and cons\b/i,
  /\boutline\b/i,
  /\bdraft\b/i,
  /\bemail\b/i,
  /\bextract\b/i,
  /\bclassify\b/i,
  /\bexplain\b/i,
  /\brefactor\b/i
];

const COMPLEX_REGEX = [
  /\barchitecture\b/i,
  /\bsystem design\b/i,
  /\bthreat model\b/i,
  /\bincident response\b/i,
  /\bproduction outage\b/i,
  /\bcompliance\b/i,
  /\broadmap\b/i,
  /\bresearch report\b/i,
  /\bmulti[-\s]?step\b/i,
  /\bend[-\s]?to[-\s]?end\b/i,
  /\btrade[-\s]?offs?\b/i,
  /\bfinancial model\b/i,
  /\blegal\b/i,
  /\bmedical\b/i
];

const classifyByRegex = (rawInput: string): TaskType | null => {
  const normalized = normalizeText(rawInput);
  if (!normalized) return 'SIMPLE';

  if (COMPLEX_REGEX.some((pattern) => pattern.test(normalized))) {
    return 'COMPLEX';
  }

  const wordCount = splitWordCount(normalized);
  const looksBasicQuestion =
    /^(what|who|when|where|which|define)\b/i.test(normalized) &&
    wordCount <= 14 &&
    !/\bcompare|trade[-\s]?off|architecture|plan|strategy\b/i.test(normalized);

  if (looksBasicQuestion || SIMPLE_REGEX.some((pattern) => pattern.test(normalized))) {
    return 'SIMPLE';
  }

  if (MEDIUM_REGEX.some((pattern) => pattern.test(normalized))) {
    return 'MEDIUM';
  }

  return null;
};

const heuristicClassify = (rawInput: string): TaskType => {
  const normalized = normalizeText(rawInput);
  if (!normalized) return 'SIMPLE';

  const wordCount = splitWordCount(normalized);
  const complexSignals = [
    /\bdesign\b/i,
    /\bstrategy\b/i,
    /\broadmap\b/i,
    /\boptimi[sz]e\b/i,
    /\bscal(?:e|ing)\b/i,
    /\bsecurity\b/i,
    /\bevaluate\b/i,
    /\bdeep\b/i,
    /\bcomprehensive\b/i,
    /\bdetailed\b/i,
    /\bmultiple\b/i
  ].filter((pattern) => pattern.test(normalized)).length;

  const mediumSignals = [
    /\bsummar(?:ize|ise)\b/i,
    /\bexplain\b/i,
    /\bdraft\b/i,
    /\bemail\b/i,
    /\bcompare\b/i,
    /\btable\b/i,
    /\bbullet\b/i,
    /\bplan\b/i
  ].filter((pattern) => pattern.test(normalized)).length;

  if (wordCount > 45 || complexSignals >= 2) return 'COMPLEX';
  if (wordCount <= 12 && mediumSignals === 0) return 'SIMPLE';
  if (mediumSignals >= 1 || wordCount <= 35) return 'MEDIUM';
  return 'COMPLEX';
};

export const classifyTask = async (userInput: string, options: ClassifyTaskOptions = {}): Promise<TaskType> => {
  const layerOne = classifyByRegex(userInput);
  if (layerOne) return layerOne;

  if (options.classifyAmbiguous) {
    try {
      const layerTwo = await options.classifyAmbiguous(normalizeText(userInput));
      if (isTaskType(layerTwo)) {
        return layerTwo;
      }
    } catch {
      // Fall back to deterministic heuristic if classifier call fails.
    }
  }

  return heuristicClassify(userInput);
};

const ROUTE_BY_TASK: Record<TaskType, ModelRoute> = {
  SIMPLE: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    maxTokens: 400,
    cacheable: true
  },
  MEDIUM: {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    maxTokens: 900,
    cacheable: false
  },
  COMPLEX: {
    provider: 'google',
    model: 'gemini-pro-latest',
    maxTokens: 1800,
    cacheable: false
  },
  LOCAL: {
    provider: 'ollama',
    model: 'qwen2.5:3b',
    maxTokens: 2000,
    cacheable: false
  }
};

export const routeModel = (taskType: TaskType): ModelRoute => ROUTE_BY_TASK[taskType];

export const estimateCost = (usage: UsageTokens, priceTable: PriceTable): number => {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  let resolvedInputTokens = inputTokens;
  let resolvedOutputTokens = outputTokens;

  if ((resolvedInputTokens === 0 || resolvedOutputTokens === 0) && usage.totalTokens && usage.totalTokens > 0) {
    const weightedInput = Math.round(usage.totalTokens * 0.7);
    resolvedInputTokens = resolvedInputTokens || weightedInput;
    resolvedOutputTokens = resolvedOutputTokens || Math.max(usage.totalTokens - weightedInput, 0);
  }

  const inputCost = (resolvedInputTokens / 1_000_000) * priceTable.inputPerMillion;
  const outputCost = (resolvedOutputTokens / 1_000_000) * priceTable.outputPerMillion;

  return Number((inputCost + outputCost).toFixed(6));
};

export const applyGuardrails = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return 'Please provide a message.';
  return trimmed.slice(0, 8000);
};

export const cacheKeyForChat = (input: ChatRequest): string =>
  `chat:${input.provider}:${input.message.toLowerCase()}`;

const memoryCache = new Map<string, { value: string; expiresAt: number }>();

export const setMemoryCache = (key: string, value: string, ttlMs = 30_000): void => {
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

export const getMemoryCache = (key: string): string | null => {
  const found = memoryCache.get(key);
  if (!found) return null;
  if (Date.now() > found.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return found.value;
};
