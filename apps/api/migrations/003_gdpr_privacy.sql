alter table users
  add column if not exists privacy_policy_version text,
  add column if not exists terms_version text,
  add column if not exists consented_at timestamptz,
  add column if not exists marketing_consent boolean not null default false;

create table if not exists data_subject_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  request_type text not null check (request_type in ('export', 'delete', 'rectification', 'restriction', 'objection', 'portability')),
  status text not null default 'open' check (status in ('open', 'completed', 'rejected')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_data_subject_requests_user_id on data_subject_requests(user_id);
create index if not exists idx_data_subject_requests_status on data_subject_requests(status);

drop trigger if exists trg_data_subject_requests_updated_at on data_subject_requests;
create trigger trg_data_subject_requests_updated_at
before update on data_subject_requests
for each row
execute function set_updated_at();

create table if not exists deleted_users (
  id uuid primary key,
  deleted_at timestamptz not null default now(),
  reason text not null default 'user_requested'
);

create table if not exists audit_events (
  id bigserial primary key,
  user_id uuid,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_events_user_id on audit_events(user_id);
create index if not exists idx_audit_events_action on audit_events(action);
