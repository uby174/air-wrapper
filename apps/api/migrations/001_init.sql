create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  source text not null,
  created_at timestamptz not null default now()
);

create table if not exists chunks (
  id bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  chunk_text text not null,
  chunk_order int not null,
  embedding vector(__EMBEDDING_DIM__) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  use_case text not null,
  status text not null default 'queued',
  input jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  use_case text not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_estimate numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_chunks_document_id on chunks(document_id);
create index if not exists idx_documents_user_id on documents(user_id);
create index if not exists idx_jobs_user_id on jobs(user_id);
create index if not exists idx_usage_events_user_id on usage_events(user_id);

create index if not exists idx_chunks_embedding_cosine
  on chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_jobs_updated_at on jobs;
create trigger trg_jobs_updated_at
before update on jobs
for each row
execute function set_updated_at();
