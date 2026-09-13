create index if not exists idx_paper_trades_token_id on public.paper_trades(token_id);
create index if not exists idx_peak_events_token_id on public.peak_events(token_id);
create index if not exists idx_signals_snapshot_id on public.signals(snapshot_id);

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
