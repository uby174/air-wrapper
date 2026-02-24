import genericAnalysisVertical from './configs/generic_analysis.vertical';
import type { VerticalConfig } from './types';

export * from './types';
export { evaluateVerticalGuardrails } from './guardrails';

const verticalCache = new Map<string, Promise<VerticalConfig>>();

const normalizeUseCase = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
const formatUseCaseName = (verticalId: string): string => verticalId.replace(/_/g, ' ');

const isVerticalConfig = (value: unknown): value is VerticalConfig => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.inputTypesAllowed) &&
    candidate.rag !== null &&
    typeof candidate.rag === 'object' &&
    typeof candidate.promptTemplate === 'function' &&
    Boolean(candidate.outputSchema) &&
    candidate.guardrails !== null &&
    typeof candidate.guardrails === 'object'
  );
};

const createFallbackVertical = (verticalId: string): VerticalConfig => ({
  ...genericAnalysisVertical,
  id: verticalId || genericAnalysisVertical.id,
  name: verticalId ? `Generic Analysis (${formatUseCaseName(verticalId)})` : genericAnalysisVertical.name
});

const importVerticalModule = async (modulePath: string): Promise<VerticalConfig | null> => {
  try {
    const moduleRef = (await import(/* @vite-ignore */ modulePath)) as {
      default?: unknown;
    };
    const candidate = moduleRef.default;
    if (!isVerticalConfig(candidate)) {
      throw new Error(`Invalid vertical module shape for path ${modulePath}`);
    }
    return candidate;
  } catch {
    return null;
  }
};

const importVerticalById = async (verticalId: string): Promise<VerticalConfig | null> => {
  if (!verticalId) return null;

  const candidatePaths = [
    `./configs/${verticalId}.vertical.ts`,
    `./configs/${verticalId}.vertical.js`,
    `./configs/${verticalId}.vertical`
  ];

  for (const modulePath of candidatePaths) {
    const vertical = await importVerticalModule(modulePath);
    if (vertical) {
      return vertical;
    }
  }

  return null;
};

const loadVertical = async (useCase: string): Promise<VerticalConfig> => {
  const normalized = normalizeUseCase(useCase);
  const exact = await importVerticalById(normalized);

  if (exact) {
    return exact;
  }

  return createFallbackVertical(normalized);
};

export const getVertical = async (useCase: string): Promise<VerticalConfig> => {
  const normalized = normalizeUseCase(useCase);
  const cacheKey = normalized || genericAnalysisVertical.id;

  const cached = verticalCache.get(cacheKey);
  if (cached) return cached;

  const loader = loadVertical(useCase);
  verticalCache.set(cacheKey, loader);
  return loader;
};

export const seededVerticals = [
  'legal_contract_analysis',
  'medical_research_summary',
  'financial_report_analysis',
  'insurance_health'
] as const;
