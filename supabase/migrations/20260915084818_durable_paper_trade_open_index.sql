create unique index if not exists paper_trades_one_open_per_token_idx
  on public.paper_trades(token_id)
  where status = 'open';
