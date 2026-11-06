-- Ward schema for Supabase.
-- Paste these statements into the Supabase SQL editor. Do not paste a file path.
-- The API uses the service-role key, which bypasses RLS.
-- anon and authenticated have no policies, so the browser cannot read or write these tables.

create table if not exists public.observations (
  account_id text primary key check (char_length(account_id) between 2 and 64),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  code_hash text,
  previous_code_hash text,
  code_hash_changed_at timestamptz,
  chain_created_at timestamptz,
  tx_count bigint,
  block_height bigint,
  full_access_keys integer,
  source text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.checks (
  id uuid primary key,
  agent_id text not null check (char_length(agent_id) between 2 and 64),
  receiver_id text not null check (char_length(receiver_id) between 2 and 64),
  method_name text not null,
  decision text not null check (decision in ('allow', 'warn', 'block')),
  score integer not null check (score between 0 and 100),
  reasons jsonb not null,
  signals jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists checks_agent_created_idx
  on public.checks (agent_id, created_at desc);

create table if not exists public.interactions (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null check (char_length(agent_id) between 2 and 64),
  receiver_id text not null check (char_length(receiver_id) between 2 and 64),
  method_name text not null,
  decision text not null check (decision in ('allow', 'warn')),
  human_approved boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists interactions_pair_idx
  on public.interactions (agent_id, receiver_id);

create table if not exists public.reports (
  reporter_account_id text not null check (char_length(reporter_account_id) between 2 and 64),
  target_account_id text not null check (char_length(target_account_id) between 2 and 64),
  reason text not null check (char_length(reason) between 8 and 280),
  evidence text not null check (char_length(evidence) between 32 and 500),
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (reporter_account_id, target_account_id)
);

create index if not exists reports_target_idx
  on public.reports (target_account_id, created_at desc);

alter table public.observations enable row level security;
alter table public.checks enable row level security;
alter table public.interactions enable row level security;
alter table public.reports enable row level security;

revoke all on table public.observations from anon, authenticated;
revoke all on table public.checks from anon, authenticated;
revoke all on table public.interactions from anon, authenticated;
revoke all on table public.reports from anon, authenticated;
