revoke all on table public.live_trades from anon, authenticated;
grant select, insert, update, delete on table public.live_trades to service_role;

revoke all on table public.telegram_activation_codes, public.telegram_subscribers from anon, authenticated;
grant select, insert, update, delete on table public.telegram_activation_codes, public.telegram_subscribers to service_role;

create index if not exists telegram_subscribers_activation_code_id_idx
  on public.telegram_subscribers(activation_code_id);
