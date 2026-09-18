create or replace view public.solana_paper_performance as
with bridge_trades as (
  select
    coalesce(metadata->'sizing'->>'strategy', metadata->>'strategy', 'unknown') as strategy,
    entry_score,
    pnl_pct,
    pnl_usd,
    peak_pnl_pct,
    closed_at
  from public.paper_trades
  where status = 'closed'
    and coalesce(metadata->'sizing'->>'strategy', metadata->>'strategy', '') in (
      'solana-ultra-probe',
      'solana-ultra-qualified'
    )
)
select
  strategy,
  case
    when entry_score is null then 'unknown'
    when entry_score < 68 then '<68'
    when entry_score < 72 then '68-71'
    when entry_score < 80 then '72-79'
    when entry_score < 90 then '80-89'
    else '90+'
  end as score_band,
  count(*)::int as closed_trades,
  count(*) filter (where pnl_pct > 0)::int as winners,
  round(
    case when count(*) > 0
      then (100.0 * count(*) filter (where pnl_pct > 0) / count(*))
      else 0
    end,
    2
  ) as win_rate_pct,
  round(avg(pnl_pct)::numeric, 4) as avg_pnl_pct,
  round(coalesce(sum(pnl_usd), 0)::numeric, 6) as total_pnl_usd,
  round(avg(peak_pnl_pct)::numeric, 4) as avg_peak_pnl_pct,
  max(closed_at) as latest_closed_at
from bridge_trades
group by strategy, score_band
order by strategy, score_band;

grant select on public.solana_paper_performance to service_role;

comment on view public.solana_paper_performance is
  'Closed Solana Ultra PAPER outcomes grouped by strategy and entry score band. Historical legacy paper trades are excluded.';
