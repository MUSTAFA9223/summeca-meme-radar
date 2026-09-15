revoke all on function public.activate_telegram_code(text,text,text,text,text)
  from public, anon, authenticated;

grant execute on function public.activate_telegram_code(text,text,text,text,text)
  to service_role;
