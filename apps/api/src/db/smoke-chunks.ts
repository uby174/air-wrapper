import { db, getEmbeddingDim } from './client.js';

const vectorLiteral = (dim: number, seed = 0.001): string => {
  const values = Array.from({ length: dim }, (_, idx) => Number((seed + idx * 0.00001).toFixed(6)));
  return `[${values.join(',')}]`;
};

const run = async () => {
  const dim = getEmbeddingDim();
  const client = await db.connect();

  try {
    await client.query('begin');

    const email = `smoke-${Date.now()}@example.com`;
    const userRes = await client.query<{ id: string }>(
      'insert into users(email) values ($1) returning id',
      [email]
    );
    const userId = userRes.rows[0]?.id;
    if (!userId) throw new Error('Failed to insert user.');

    const docRes = await client.query<{ id: string }>(
      'insert into documents(user_id, title, source) values ($1, $2, $3) returning id',
      [userId, 'Smoke Document', 'smoke-test']
    );
    const documentId = docRes.rows[0]?.id;
    if (!documentId) throw new Error('Failed to insert document.');

    const embedding = vectorLiteral(dim);
    await client.query(
      `
      insert into chunks (document_id, chunk_text, chunk_order, embedding, metadata)
      values ($1, $2, $3, $4::vector, $5::jsonb)
    `,
      [documentId, 'This is a smoke test chunk.', 0, embedding, JSON.stringify({ source: 'smoke' })]
    );

    const nearest = await client.query<{ id: number; chunk_text: string }>(
      `
      select id, chunk_text
      from chunks
      where document_id = $1
      order by embedding <=> $2::vector
      limit 1
    `,
      [documentId, embedding]
    );

    if (!nearest.rowCount || nearest.rowCount < 1) {
      throw new Error('Smoke test failed: no chunk rows returned.');
    }

    await client.query('commit');
    console.log('Smoke test passed. Insert + query on chunks table succeeded.');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await db.end();
  }
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Smoke test failed:', error);
    process.exit(1);
  });
