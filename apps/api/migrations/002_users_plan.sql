do $$
begin
  create type user_plan as enum ('FREE', 'PRO', 'BUSINESS');
exception
  when duplicate_object then null;
end
$$;

alter table users
  add column if not exists plan user_plan;

update users
set plan = 'FREE'
where plan is null;

alter table users
  alter column plan set default 'FREE',
  alter column plan set not null;
