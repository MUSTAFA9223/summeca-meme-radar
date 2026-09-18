create table if not exists public.candidate_funnel (
  id uuid primary key default gen_random_uuid(),
  network text not null,
  token_address text not null,
  source text,
  stage text not null,
  score numeric,
  rejection_reason text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (network, token_address)
);

create index if not exists candidate_funnel_stage_seen_idx
  on public.candidate_funnel (stage, last_seen_at desc);

comment on table public.candidate_funnel is
  'Durable discovery-to-trade funnel telemetry. This table never authorizes live execution.';

comment on column public.candidate_funnel.rejection_reason is
  'Latest candidate gating reason; provider uncertainty must be distinguished from confirmed risk.';
