alter table public.live_trades
  add column if not exists current_stop numeric,
  add column if not exists stop_reason text,
  add column if not exists protection_started_at timestamptz,
  add column if not exists last_protection_check_at timestamptz,
  add column if not exists last_price_source text,
  add column if not exists sell_lock_request_id text,
  add column if not exists sell_broadcast_at timestamptz,
  add column if not exists exit_amount_sol numeric,
  add column if not exists realized_pnl_sol numeric,
  add column if not exists realized_pnl_pct numeric;

create index if not exists live_trades_protection_status_idx
  on public.live_trades(wallet_address, status, updated_at)
  where status in ('open', 'closing');

create unique index if not exists live_trades_sell_lock_request_unique
  on public.live_trades(sell_lock_request_id)
  where sell_lock_request_id is not null;

comment on column public.live_trades.current_stop is
  'Monotonic live protection threshold expressed as PnL percent; it may move upward but never downward.';
comment on column public.live_trades.stop_reason is
  'Reason for the current protection floor (initial stop, trailing, profit lock, or emergency context).';
comment on column public.live_trades.sell_lock_request_id is
  'Execution-audit request id that owns the atomic protection sell lock while status=closing.';
comment on column public.live_trades.sell_broadcast_at is
  'Timestamp when a protection sell entered the broadcast stage; used for restart/uncertainty reconciliation.';
