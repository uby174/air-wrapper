export interface Chunk {
  id: string;
  text: string;
  embedding: number[];
}

export interface EmbeddingProvider {
  embed(input: { model: string; inputs: string[]; timeoutMs?: number }): Promise<{ vectors: number[][] }>;
}

export interface ChunkingOptions {
  size?: number;
  overlap?: number;
  source?: string;
  page?: number;
}

export interface RagChunkMetadata {
  source: string;
  page?: number;
  chunk_order: number;
  [key: string]: unknown;
}

export interface RagChunk {
  chunk_text: string;
  chunk_order: number;
  metadata: RagChunkMetadata;
}

export interface RagChunkWithVector extends RagChunk {
  embedding: number[];
}

export interface RetrievedChunk {
  chunk_id: string;
  chunk_text: string;
  metadata: RagChunkMetadata;
  score: number;
}

export interface CitationEntry {
  citation_id: string;
  chunk_id: string;
  chunk_text: string;
  score: number;
  metadata: RagChunkMetadata;
}

export interface BuiltContext {
  context: string;
  citations: CitationEntry[];
  citationMap: Record<string, string>;
}

export type RagQueryExecutor = <TRow>(text: string, params?: unknown[]) => Promise<TRow[]>;

interface InternalRagRuntimeConfig {
  provider?: EmbeddingProvider;
  model?: string;
  queryExecutor?: RagQueryExecutor;
  batchSize?: number;
}

export interface EmbedChunksOptions {
  provider?: EmbeddingProvider;
  model?: string;
  batchSize?: number;
  timeoutMs?: number;
}

export interface UpsertDocumentInput {
  title: string;
  source: string;
}

export interface UpsertDocumentOptions {
  queryExecutor?: RagQueryExecutor;
}

export interface RetrieveTopKOptions {
  provider?: EmbeddingProvider;
  model?: string;
  queryExecutor?: RagQueryExecutor;
  timeoutMs?: number;
}

const DEFAULT_CHUNK_SIZE = 900;
const DEFAULT_CHUNK_OVERLAP = 150;
const LEGACY_CHUNK_SIZE = 500;
const LEGACY_CHUNK_OVERLAP = 50;
const DEFAULT_EMBED_BATCH_SIZE = 64;
const DEFAULT_METADATA_SOURCE = 'unknown';

let runtimeConfig: InternalRagRuntimeConfig = {};

export const configureRag = (config: InternalRagRuntimeConfig): void => {
  runtimeConfig = {
    ...runtimeConfig,
    ...config
  };
};

const dot = (a: number[], b: number[]): number => a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
const magnitude = (a: number[]): number => Math.sqrt(dot(a, a));

export const cosineSimilarity = (a: number[], b: number[]): number => {
  const denom = magnitude(a) * magnitude(b);
  if (denom === 0) return 0;
  return dot(a, b) / denom;
};

const normalizeTextForChunking = (input: string): string => input.replace(/\r/g, '').trim();

const resolveCutIndex = (text: string, start: number, targetEnd: number): number => {
  if (targetEnd >= text.length) return text.length;
  const floor = Math.min(text.length, Math.max(start, targetEnd - 120));
  const window = text.slice(floor, targetEnd);
  const lastBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '), window.lastIndexOf('\t'));
  if (lastBreak <= 0) return targetEnd;
  return floor + lastBreak;
};

const chunkTextLegacy = (text: string, chunkSize = LEGACY_CHUNK_SIZE, overlap = LEGACY_CHUNK_OVERLAP): string[] => {
  const chunks: string[] = [];
  const normalized = normalizeTextForChunking(text);
  let cursor = 0;
  const effectiveSize = Math.max(1, chunkSize);
  const effectiveOverlap = Math.max(0, Math.min(overlap, effectiveSize - 1));

  while (cursor < normalized.length) {
    const next = normalized.slice(cursor, cursor + effectiveSize).trim();
    if (next) chunks.push(next);
    cursor += Math.max(effectiveSize - effectiveOverlap, 1);
  }

  return chunks;
};

const chunkTextStructured = (text: string, options: ChunkingOptions = {}): RagChunk[] => {
  const normalized = normalizeTextForChunking(text);
  if (!normalized) return [];

  const size = Math.max(100, options.size ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_CHUNK_OVERLAP, size - 1));
  const source = options.source ?? DEFAULT_METADATA_SOURCE;
  const chunks: RagChunk[] = [];

  let cursor = 0;
  let chunkOrder = 0;

  while (cursor < normalized.length) {
    const targetEnd = Math.min(cursor + size, normalized.length);
    const adjustedEnd = resolveCutIndex(normalized, cursor, targetEnd);
    const chunkTextValue = normalized.slice(cursor, adjustedEnd).trim();

    if (chunkTextValue) {
      chunks.push({
        chunk_text: chunkTextValue,
        chunk_order: chunkOrder,
        metadata: {
          source,
          page: options.page,
          chunk_order: chunkOrder
        }
      });
      chunkOrder += 1;
    }

    if (adjustedEnd >= normalized.length) break;
    cursor = Math.max(adjustedEnd - overlap, cursor + 1);
  }

  return chunks;
};

export function chunkText(text: string, chunkSize?: number, overlap?: number): string[];
export function chunkText(text: string, options?: ChunkingOptions): RagChunk[];
export function chunkText(
  text: string,
  optionsOrSize: ChunkingOptions | number = LEGACY_CHUNK_SIZE,
  overlap = LEGACY_CHUNK_OVERLAP
): string[] | RagChunk[] {
  if (typeof optionsOrSize === 'number') {
    return chunkTextLegacy(text, optionsOrSize, overlap);
  }

  return chunkTextStructured(text, optionsOrSize);
}

export const fakeEmbedding = (input: string, dims = 16): number[] => {
  const vector = Array.from({ length: dims }, () => 0);
  for (let i = 0; i < input.length; i += 1) {
    vector[i % dims] += input.charCodeAt(i) / 255;
  }
  return vector;
};

const asFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const ensureQueryExecutor = (options?: { queryExecutor?: RagQueryExecutor }): RagQueryExecutor => {
  const resolved = options?.queryExecutor ?? runtimeConfig.queryExecutor;
  if (!resolved) {
    throw new Error('RAG queryExecutor is not configured. Pass queryExecutor option or call configureRag(...).');
  }
  return resolved;
};

const ensureEmbedProviderAndModel = (
  options?: { provider?: EmbeddingProvider; model?: string; batchSize?: number }
): { provider: EmbeddingProvider; model: string; batchSize: number } => {
  const provider = options?.provider ?? runtimeConfig.provider;
  const model = options?.model ?? runtimeConfig.model;
  const batchSize = Math.max(1, options?.batchSize ?? runtimeConfig.batchSize ?? DEFAULT_EMBED_BATCH_SIZE);

  if (!provider) {
    throw new Error('RAG embed provider is not configured. Pass provider option or call configureRag(...).');
  }

  if (!model) {
    throw new Error('RAG embed model is not configured. Pass model option or call configureRag(...).');
  }

  return { provider, model, batchSize };
};

const toVectorLiteral = (vector: number[]): string => {
  const serialized = vector.map((value) => Number(value).toFixed(8)).join(',');
  return `[${serialized}]`;
};

const parseVectorLiteral = (input: unknown): number[] => {
  if (Array.isArray(input)) {
    return input.map((value) => asFiniteNumber(value));
  }

  if (typeof input !== 'string') return [];
  const normalized = input.trim();
  if (!normalized) return [];
  const inner = normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  if (!inner.trim()) return [];

  return inner.split(',').map((value) => asFiniteNumber(value.trim()));
};

const parseMetadata = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
};

const normalizeMetadata = (
  metadata: unknown,
  fallback: { source: string; chunkOrder: number; page?: number }
): RagChunkMetadata => {
  const parsed = parseMetadata(metadata);
  const source =
    typeof parsed.source === 'string' && parsed.source.trim().length > 0 ? parsed.source : fallback.source;

  const maybePage = asFiniteNumber(parsed.page, Number.NaN);
  const page = Number.isFinite(maybePage) ? maybePage : fallback.page;
  const chunkOrderCandidate = asFiniteNumber(parsed.chunk_order, Number.NaN);
  const chunk_order = Number.isFinite(chunkOrderCandidate) ? chunkOrderCandidate : fallback.chunkOrder;

  return {
    ...parsed,
    source,
    ...(page !== undefined ? { page } : {}),
    chunk_order
  };
};

export const embedChunks = async (
  chunks: RagChunk[],
  options: EmbedChunksOptions = {}
): Promise<RagChunkWithVector[]> => {
  if (chunks.length === 0) return [];

  const { provider, model, batchSize } = ensureEmbedProviderAndModel(options);
  const withVectors: RagChunkWithVector[] = [];

  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const response = await provider.embed({
      model,
      inputs: batch.map((chunk) => chunk.chunk_text),
      timeoutMs: options.timeoutMs
    });

    if (response.vectors.length !== batch.length) {
      throw new Error(
        `Embedding vector count mismatch for batch starting at ${start}: expected ${batch.length}, got ${response.vectors.length}`
      );
    }

    for (let i = 0; i < batch.length; i += 1) {
      withVectors.push({
        ...batch[i],
        embedding: response.vectors[i]
      });
    }
  }

  return withVectors;
};

interface ExistingDocumentRow {
  id: string;
}

interface InsertDocumentRow {
  id: string;
}

export const upsertDocument = async (
  userId: string,
  document: UpsertDocumentInput,
  chunksWithVectors: RagChunkWithVector[],
  options: UpsertDocumentOptions = {}
): Promise<string> => {
  const queryExecutor = ensureQueryExecutor(options);

  if (!userId.trim()) {
    throw new Error('upsertDocument requires a non-empty userId');
  }

  if (!document.title.trim()) {
    throw new Error('upsertDocument requires a non-empty title');
  }

  if (!document.source.trim()) {
    throw new Error('upsertDocument requires a non-empty source');
  }

  await queryExecutor('begin');

  try {
    const existing = await queryExecutor<ExistingDocumentRow>(
      `select id
       from documents
       where user_id = $1 and title = $2 and source = $3
       order by created_at desc
       limit 1`,
      [userId, document.title, document.source]
    );

    let documentId = existing[0]?.id;

    if (!documentId) {
      const inserted = await queryExecutor<InsertDocumentRow>(
        `insert into documents (user_id, title, source)
         values ($1, $2, $3)
         returning id`,
        [userId, document.title, document.source]
      );

      const insertedId = inserted[0]?.id;
      if (!insertedId) {
        throw new Error('Failed to insert document row');
      }
      documentId = insertedId;
    } else {
      await queryExecutor(
        `update documents
         set title = $2, source = $3
         where id = $1`,
        [documentId, document.title, document.source]
      );

      await queryExecutor('delete from chunks where document_id = $1', [documentId]);
    }

    for (const chunk of chunksWithVectors) {
      const normalizedMetadata = normalizeMetadata(chunk.metadata, {
        source: document.source,
        chunkOrder: chunk.chunk_order
      });

      await queryExecutor(
        `insert into chunks (document_id, chunk_text, chunk_order, embedding, metadata)
         values ($1, $2, $3, $4::vector, $5::jsonb)`,
        [
          documentId,
          chunk.chunk_text,
          chunk.chunk_order,
          toVectorLiteral(chunk.embedding),
          JSON.stringify(normalizedMetadata)
        ]
      );
    }

    await queryExecutor('commit');
    return documentId;
  } catch (error) {
    await queryExecutor('rollback').catch(() => null);
    throw error;
  }
};

interface RetrievedChunkRow {
  chunk_id: string;
  chunk_text: string;
  metadata: unknown;
  score: number | string;
  chunk_order: number | string;
  document_source: string;
}

const retrieveTopKFromStorage = async (
  userId: string,
  queryText: string,
  k: number,
  options: RetrieveTopKOptions = {}
): Promise<RetrievedChunk[]> => {
  const queryExecutor = ensureQueryExecutor(options);
  const { provider, model } = ensureEmbedProviderAndModel(options);
  const limit = Math.max(1, k);

  const embedResponse = await provider.embed({
    model,
    inputs: [queryText],
    timeoutMs: options.timeoutMs
  });

  const queryVector = embedResponse.vectors[0];
  if (!queryVector || queryVector.length === 0) {
    return [];
  }

  const rows = await queryExecutor<RetrievedChunkRow>(
    `select
       c.id::text as chunk_id,
       c.chunk_text,
       c.metadata,
       c.chunk_order,
       d.source as document_source,
       1 - (c.embedding <=> $2::vector) as score
     from chunks c
     inner join documents d on d.id = c.document_id
     where d.user_id = $1
     order by c.embedding <=> $2::vector asc
     limit $3`,
    [userId, toVectorLiteral(queryVector), limit]
  );

  return rows.map((row) => {
    const chunkOrder = asFiniteNumber(row.chunk_order, 0);
    return {
      chunk_id: String(row.chunk_id),
      chunk_text: row.chunk_text,
      metadata: normalizeMetadata(row.metadata, {
        source: row.document_source ?? DEFAULT_METADATA_SOURCE,
        chunkOrder
      }),
      score: asFiniteNumber(row.score, 0)
    };
  });
};

const retrieveTopKByVector = (query: number[], chunks: Chunk[], k = 3): Chunk[] =>
  [...chunks]
    .sort((left, right) => cosineSimilarity(query, right.embedding) - cosineSimilarity(query, left.embedding))
    .slice(0, Math.max(1, k));

export function retrieveTopK(query: number[], chunks: Chunk[], k?: number): Chunk[];
export function retrieveTopK(
  userId: string,
  queryText: string,
  k?: number,
  options?: RetrieveTopKOptions
): Promise<RetrievedChunk[]>;
export function retrieveTopK(
  arg1: number[] | string,
  arg2: Chunk[] | string,
  arg3?: number,
  arg4?: RetrieveTopKOptions
): Chunk[] | Promise<RetrievedChunk[]> {
  if (Array.isArray(arg1) && Array.isArray(arg2)) {
    return retrieveTopKByVector(arg1, arg2, arg3 ?? 3);
  }

  if (typeof arg1 === 'string' && typeof arg2 === 'string') {
    return retrieveTopKFromStorage(arg1, arg2, arg3 ?? 6, arg4);
  }

  throw new Error('Invalid retrieveTopK arguments');
}

export const buildContext = (retrievedChunks: RetrievedChunk[]): BuiltContext => {
  const citations: CitationEntry[] = [];
  const citationMap: Record<string, string> = {};
  const contextBlocks: string[] = [];

  for (const chunk of retrievedChunks) {
    const citationId = `C${chunk.chunk_id}`;
    const pageSuffix = typeof chunk.metadata.page === 'number' ? ` p.${chunk.metadata.page}` : '';

    citations.push({
      citation_id: citationId,
      chunk_id: chunk.chunk_id,
      chunk_text: chunk.chunk_text,
      score: chunk.score,
      metadata: chunk.metadata
    });

    citationMap[citationId] = chunk.chunk_id;
    contextBlocks.push(
      `[${citationId}] source=${chunk.metadata.source}${pageSuffix} chunk=${chunk.metadata.chunk_order}\n${chunk.chunk_text}`
    );
  }

  return {
    context: contextBlocks.join('\n\n'),
    citations,
    citationMap
  };
};
