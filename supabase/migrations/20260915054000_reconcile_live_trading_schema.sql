create table if not exists public.live_trades (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id) on delete cascade,
  wallet_address text not null,
  status text not null default 'open' check (status in ('pending','open','closing','closed','failed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  entry_tx text,
  exit_tx text,
  entry_price_usd numeric,
  exit_price_usd numeric,
  input_sol numeric,
  quantity_atomic numeric,
  high_water_pnl_pct numeric not null default 0,
  highest_price_usd numeric,
  exit_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists live_trades_wallet_status_opened_idx
  on public.live_trades(wallet_address, status, opened_at desc);
create unique index if not exists live_trades_one_active_per_wallet_token
  on public.live_trades(token_id, wallet_address)
  where status in ('pending','open','closing');

alter table public.live_trades enable row level security;
revoke all on table public.live_trades from anon, authenticated;
grant select, insert, update, delete on table public.live_trades to service_role;

drop trigger if exists trg_live_trades_updated_at on public.live_trades;
create trigger trg_live_trades_updated_at
before update on public.live_trades
for each row execute function public.set_updated_at();
