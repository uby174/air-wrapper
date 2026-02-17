import 'dotenv/config';
import { Pool, type QueryResultRow } from 'pg';

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_wrapper';

export const db = new Pool({
  connectionString
});

export const query = async <T extends QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> => {
  const result = await db.query<T>(text, params);
  return result.rows;
};

export const getEmbeddingDim = (): number => {
  const raw = Number(process.env.EMBEDDING_DIM ?? '1536');
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Invalid EMBEDDING_DIM: ${process.env.EMBEDDING_DIM}`);
  }
  return raw;
};
