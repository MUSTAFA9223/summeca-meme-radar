create table if not exists public.tokens (
  id uuid primary key default gen_random_uuid(),
  chain text not null default 'solana' check (chain = 'solana'),
  address text not null unique,
  symbol text,
  name text,
  source text,
  listed_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  initial_price_usd numeric,
  initial_liquidity_usd numeric,
  highest_price_usd numeric,
  highest_return_pct numeric,
  status text not null default 'tracking' check (status in ('tracking','rejected','entered','closed','expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.snapshots (
  id bigint generated always as identity primary key,
  token_id uuid not null references public.tokens(id) on delete cascade,
  observed_at timestamptz not null default now(),
  price_usd numeric,
  liquidity_usd numeric,
  market_cap_usd numeric,
  holder_count bigint,
  buys_30s integer,
  sells_30s integer,
  buy_volume_30s_usd numeric,
  sell_volume_30s_usd numeric,
  unique_buyers_30s integer,
  buyer_acceleration numeric,
  volume_acceleration numeric,
  top10_holder_pct numeric,
  creator_pct numeric,
  honeypot boolean,
  mint_authority_disabled boolean,
  freeze_authority_disabled boolean,
  entry_score numeric,
  moon_score numeric,
  risk_score numeric,
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.signals (
  id bigint generated always as identity primary key,
  token_id uuid not null references public.tokens(id) on delete cascade,
  snapshot_id bigint references public.snapshots(id) on delete set null,
  created_at timestamptz not null default now(),
  signal_type text not null check (signal_type in ('watch','entry','moon','exit_prepare','exit','risk_reject')),
  entry_score numeric,
  moon_score numeric,
  risk_score numeric,
  reason jsonb not null default '{}'::jsonb
);

create table if not exists public.paper_trades (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id) on delete cascade,
  status text not null default 'open' check (status in ('open','closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  entry_price_usd numeric not null,
  exit_price_usd numeric,
  size_usd numeric not null,
  quantity numeric not null,
  pnl_pct numeric,
  pnl_usd numeric,
  peak_pnl_pct numeric,
  highest_price_usd numeric,
  peak_observed_at timestamptz,
  exit_reason text,
  entry_score numeric,
  moon_score numeric,
  risk_score numeric,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.peak_events (
  id bigint generated always as identity primary key,
  token_id uuid not null references public.tokens(id) on delete cascade,
  paper_trade_id uuid references public.paper_trades(id) on delete cascade,
  observed_at timestamptz not null default now(),
  event_type text not null check (event_type in ('new_peak','momentum_weakening','trailing_tighten','emergency_exit','exit')),
  price_usd numeric,
  pnl_pct numeric,
  entry_score numeric,
  moon_score numeric,
  risk_score numeric,
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_tokens_listed_at on public.tokens(listed_at desc);
create index if not exists idx_tokens_status on public.tokens(status);
create index if not exists idx_snapshots_token_time on public.snapshots(token_id, observed_at desc);
create index if not exists idx_signals_token_time on public.signals(token_id, created_at desc);
create index if not exists idx_signals_type_time on public.signals(signal_type, created_at desc);
create index if not exists idx_paper_trades_status on public.paper_trades(status, opened_at desc);
create index if not exists idx_peak_events_trade_time on public.peak_events(paper_trade_id, observed_at desc);

alter table public.tokens enable row level security;
alter table public.snapshots enable row level security;
alter table public.signals enable row level security;
alter table public.paper_trades enable row level security;
alter table public.peak_events enable row level security;

revoke all on table public.tokens, public.snapshots, public.signals, public.paper_trades, public.peak_events from anon, authenticated;
grant select, insert, update, delete on table public.tokens, public.snapshots, public.signals, public.paper_trades, public.peak_events to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tokens_updated_at on public.tokens;
create trigger trg_tokens_updated_at
before update on public.tokens
for each row execute function public.set_updated_at();