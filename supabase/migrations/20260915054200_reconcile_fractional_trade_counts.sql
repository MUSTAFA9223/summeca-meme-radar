alter table public.snapshots
  alter column buys_30s type numeric using buys_30s::numeric,
  alter column sells_30s type numeric using sells_30s::numeric;
