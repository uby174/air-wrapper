import { describe, expect, it } from 'vitest';
import {
  buildContext,
  chunkText,
  cosineSimilarity,
  embedChunks,
  retrieveTopK,
  upsertDocument,
  type RagQueryExecutor
} from '../index';

interface InMemoryDocument {
  id: string;
  userId: string;
  title: string;
  source: string;
}

interface InMemoryChunk {
  id: string;
  documentId: string;
  chunkText: string;
  chunkOrder: number;
  embedding: number[];
  metadata: Record<string, unknown>;
}

const parseVectorLiteral = (input: unknown): number[] => {
  if (typeof input !== 'string') return [];
  const cleaned = input.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!cleaned) return [];
  return cleaned.split(',').map((item) => Number(item));
};

class InMemoryRagDb {
  private documentCounter = 0;
  private chunkCounter = 0;
  private readonly documents: InMemoryDocument[] = [];
  private readonly chunks: InMemoryChunk[] = [];

  readonly query: RagQueryExecutor = async <TRow extends Record<string, unknown>>(
    text: string,
    params: unknown[] = []
  ): Promise<TRow[]> => {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();

    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return [];
    }

    if (normalized.startsWith('select id from documents')) {
      const [userId, title, source] = params as [string, string, string];
      const existing = this.documents.find(
        (doc) => doc.userId === userId && doc.title === title && doc.source === source
      );
      return (existing ? [{ id: existing.id }] : []) as TRow[];
    }

    if (normalized.startsWith('insert into documents')) {
      const [userId, title, source] = params as [string, string, string];
      const id = `doc-${++this.documentCounter}`;
      this.documents.push({ id, userId, title, source });
      return [{ id } as TRow];
    }

    if (normalized.startsWith('update documents')) {
      const [documentId, title, source] = params as [string, string, string];
      const doc = this.documents.find((row) => row.id === documentId);
      if (doc) {
        doc.title = title;
        doc.source = source;
      }
      return [];
    }

    if (normalized.startsWith('delete from chunks where document_id')) {
      const [documentId] = params as [string];
      for (let i = this.chunks.length - 1; i >= 0; i -= 1) {
        if (this.chunks[i].documentId === documentId) {
          this.chunks.splice(i, 1);
        }
      }
      return [];
    }

    if (normalized.startsWith('insert into chunks')) {
      const [documentId, chunkTextValue, chunkOrder, embeddingLiteral, metadataJson] = params as [
        string,
        string,
        number,
        string,
        string
      ];

      const id = String(++this.chunkCounter);
      this.chunks.push({
        id,
        documentId,
        chunkText: chunkTextValue,
        chunkOrder,
        embedding: parseVectorLiteral(embeddingLiteral),
        metadata: JSON.parse(metadataJson) as Record<string, unknown>
      });
      return [];
    }

    if (normalized.startsWith('select c.id::text as chunk_id')) {
      const [userId, queryVectorLiteral, limitRaw] = params as [string, string, number];
      const queryVector = parseVectorLiteral(queryVectorLiteral);
      const limit = Number(limitRaw);

      const allowedDocumentIds = new Set(
        this.documents.filter((document) => document.userId === userId).map((document) => document.id)
      );

      const rows = this.chunks
        .filter((chunk) => allowedDocumentIds.has(chunk.documentId))
        .map((chunk) => {
          const source = this.documents.find((doc) => doc.id === chunk.documentId)?.source ?? 'unknown';
          return {
            chunk_id: chunk.id,
            chunk_text: chunk.chunkText,
            metadata: chunk.metadata,
            chunk_order: chunk.chunkOrder,
            document_source: source,
            score: cosineSimilarity(queryVector, chunk.embedding)
          };
        })
        .sort((left, right) => Number(right.score) - Number(left.score))
        .slice(0, limit);

      return rows as TRow[];
    }

    throw new Error(`Unhandled SQL in test double: ${normalized}`);
  };

  getChunkIds(): Set<string> {
    return new Set(this.chunks.map((chunk) => chunk.id));
  }
}

const deterministicEmbed = (input: string): number[] => {
  const vector = [0, 0, 0, 0, 0, 0];
  const normalized = input.toLowerCase();

  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    vector[i % vector.length] += code / 255;
  }

  if (normalized.includes('distributed')) vector[0] += 4;
  if (normalized.includes('consensus')) vector[1] += 4;
  if (normalized.includes('queue')) vector[2] += 3;
  if (normalized.includes('apple')) vector[5] += 2;

  return vector;
};

describe('RAG pipeline', () => {
  it('stores embeddings, retrieves relevant chunks, and maps citations to chunk ids', async () => {
    const db = new InMemoryRagDb();
    const provider = {
      embed: async ({ inputs }: { model: string; inputs: string[] }) => ({
        vectors: inputs.map((input) => deterministicEmbed(input))
      })
    };

    const source = 'docs://distributed-systems';
    const documentText = [
      'Apples are fruit and can be green or red.',
      'Distributed systems rely on consensus protocols and idempotent queue workers.',
      'Queue retries and consensus rules improve reliability in distributed systems.'
    ].join('\n');

    const chunks = chunkText(documentText, { size: 120, overlap: 20, source, page: 4 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.metadata.source).toBe(source);
    expect(chunks[0]?.metadata.chunk_order).toBe(0);
    expect(chunks[0]?.metadata.page).toBe(4);

    const chunksWithVectors = await embedChunks(chunks, {
      provider,
      model: 'test-embed-model'
    });

    const documentId = await upsertDocument(
      'user-123',
      { title: 'Distributed Systems Notes', source },
      chunksWithVectors,
      { queryExecutor: db.query }
    );

    expect(documentId).toBe('doc-1');

    const retrieved = await retrieveTopK(
      'user-123',
      'How do distributed systems use consensus and queue retries?',
      6,
      {
        provider,
        model: 'test-embed-model',
        queryExecutor: db.query
      }
    );

    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved[0]?.chunk_text.toLowerCase()).toContain('distributed systems');
    expect(retrieved[0]?.metadata.source).toBe(source);
    expect(typeof retrieved[0]?.metadata.chunk_order).toBe('number');

    const contextResult = buildContext(retrieved);
    expect(contextResult.context).toContain('[C');
    expect(contextResult.citations.length).toBe(retrieved.length);

    const storedChunkIds = db.getChunkIds();
    for (const citation of contextResult.citations) {
      expect(contextResult.citationMap[citation.citation_id]).toBe(citation.chunk_id);
      expect(storedChunkIds.has(citation.chunk_id)).toBe(true);
    }
  });
});
