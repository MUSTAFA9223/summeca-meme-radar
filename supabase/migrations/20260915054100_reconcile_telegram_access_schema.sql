create table if not exists public.telegram_activation_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  created_by_chat_id text not null,
  access_days integer check (access_days is null or (access_days between 1 and 3650)),
  max_uses integer not null default 1 check (max_uses between 1 and 100),
  used_count integer not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.telegram_subscribers (
  chat_id text primary key,
  telegram_user_id text,
  username text,
  first_name text,
  role text not null default 'subscriber' check (role in ('owner','subscriber')),
  active boolean not null default true,
  notify_enabled boolean not null default true,
  activation_code_id uuid references public.telegram_activation_codes(id) on delete set null,
  activated_at timestamptz not null default now(),
  access_expires_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists telegram_activation_codes_status_idx
  on public.telegram_activation_codes(revoked_at, expires_at);
create index if not exists telegram_subscribers_active_idx
  on public.telegram_subscribers(active, notify_enabled);
create index if not exists telegram_subscribers_activation_code_id_idx
  on public.telegram_subscribers(activation_code_id);

alter table public.telegram_activation_codes enable row level security;
alter table public.telegram_subscribers enable row level security;
revoke all on table public.telegram_activation_codes, public.telegram_subscribers from anon, authenticated;
grant select, insert, update, delete on table public.telegram_activation_codes, public.telegram_subscribers to service_role;

create or replace function public.activate_telegram_code(
  p_code_hash text,
  p_chat_id text,
  p_telegram_user_id text default null,
  p_username text default null,
  p_first_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.telegram_activation_codes%rowtype;
  v_access_expires_at timestamptz;
begin
  select * into v_code
  from public.telegram_activation_codes
  where code_hash = p_code_hash
  for update;

  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_code.revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if v_code.expires_at is not null and v_code.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired_code'); end if;
  if v_code.used_count >= v_code.max_uses then return jsonb_build_object('ok', false, 'reason', 'used'); end if;

  if v_code.access_days is null then
    v_access_expires_at := null;
  else
    v_access_expires_at := now() + make_interval(days => v_code.access_days);
  end if;

  insert into public.telegram_subscribers (
    chat_id, telegram_user_id, username, first_name, role, active, notify_enabled,
    activation_code_id, activated_at, access_expires_at, last_seen_at
  ) values (
    p_chat_id, p_telegram_user_id, p_username, p_first_name, 'subscriber', true, true,
    v_code.id, now(), v_access_expires_at, now()
  )
  on conflict (chat_id) do update set
    telegram_user_id = excluded.telegram_user_id,
    username = excluded.username,
    first_name = excluded.first_name,
    active = true,
    notify_enabled = true,
    activation_code_id = excluded.activation_code_id,
    activated_at = now(),
    access_expires_at = excluded.access_expires_at,
    last_seen_at = now();

  update public.telegram_activation_codes
  set used_count = used_count + 1, last_used_at = now()
  where id = v_code.id;

  return jsonb_build_object('ok', true, 'access_expires_at', v_access_expires_at, 'permanent', v_code.access_days is null);
end;
$$;

revoke all on function public.activate_telegram_code(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.activate_telegram_code(text,text,text,text,text) to service_role;
