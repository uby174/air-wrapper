import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getEmbeddingDim } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../../migrations');

const run = async () => {
  const embeddingDim = getEmbeddingDim();
  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    console.log('No migration files found.');
    return;
  }

  const client = await db.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    for (const file of files) {
      const already = await client.query<{ filename: string }>(
        'select filename from schema_migrations where filename = $1',
        [file]
      );

      if (already.rowCount && already.rowCount > 0) {
        console.log(`Skipping migration ${file} (already applied).`);
        continue;
      }

      const absolutePath = path.join(migrationsDir, file);
      const rawSql = await fs.readFile(absolutePath, 'utf-8');
      const sql = rawSql.replaceAll('__EMBEDDING_DIM__', String(embeddingDim));

      console.log(`Applying migration ${file}...`);
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`Applied ${file}.`);
    }
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await db.end();
  }
};

run()
  .then(() => {
    console.log('Migrations complete.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
