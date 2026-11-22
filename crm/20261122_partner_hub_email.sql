-- Partner hub: email to a business from the NexAIS company address (sent by the partner-email-send
-- edge function through Resend). Owner approved 2026-11-22 (marketers may now email, per person, can_email).
-- Starts OFF: nothing is sent until partner_email_enabled = 'on' (owner/platform admin only) and the
-- Resend key + sending domain are set. CASL: sender identity, mailing address and a working
-- unsubscribe link in every email; unsubscribed addresses are blocked for the whole company.

-- 1) settings ------------------------------------------------------------------------------------
insert into public.voice_memory_config (key, value) values
  ('partner_email_enabled', 'off'),
  ('partner_email_from', 'NexAIS <info@nexais.ca>'),
  ('partner_email_reply_to', 'info@nexais.ca'),
  ('partner_email_mailing_address', '')
on conflict (key) do nothing;

-- 2) permission check now knows 'email' (can_email) ----------------------------------------------
create or replace function public.partner_comm_check(p_mission uuid, p_kind text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); m record; v_ok boolean;
begin
  if v_uid is null then raise exception 'sign in required' using errcode = '42501'; end if;
  select id, company_id, assigned_agent_id, requested_by_agent_id into m from public.partner_missions where id = p_mission;
  if not found then raise exception 'business not found' using errcode = '22023'; end if;
  if public.nexais_partner_is_manager_of(m.company_id) then return m.company_id; end if;
  if not (m.assigned_agent_id in (select public.nexais_rls_my_agent_ids())
          or m.requested_by_agent_id in (select public.nexais_rls_my_agent_ids())) then
    raise exception 'this business is not assigned to you' using errcode = '42501';
  end if;
  select bool_or(case when p_kind = 'sms' then coalesce(pp.can_sms, false)
                      when p_kind = 'email' then coalesce(pp.can_email, false)
                      else coalesce(pp.can_call, false) end) into v_ok
    from public.partner_permissions pp where pp.agent_id in (select public.nexais_rls_my_agent_ids());
  if not coalesce(v_ok, false) then
    raise exception '% is not enabled for you; ask the NexAIS admin',
      case when p_kind = 'sms' then 'SMS' when p_kind = 'email' then 'Email' else 'Calling' end using errcode = '42501';
  end if;
  return m.company_id;
end $$;
revoke all on function public.partner_comm_check(uuid, text) from public, anon, authenticated;

-- 3) tables -----------------------------------------------------------------------------------------
create table if not exists public.partner_email_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  mission_id uuid not null references public.partner_missions(id) on delete cascade,
  user_id uuid not null,
  sender_name text,
  to_email text not null,
  subject text not null,
  body text not null,
  consent_basis text not null check (consent_basis in ('express', 'published')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'blocked')),
  provider_id text,
  error text,
  unsub_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists partner_email_messages_mission_idx on public.partner_email_messages (mission_id, created_at desc);
create index if not exists partner_email_messages_user_idx on public.partner_email_messages (user_id, created_at desc);
create unique index if not exists partner_email_messages_unsub_idx on public.partner_email_messages (unsub_token);
alter table public.partner_email_messages enable row level security;
drop policy if exists partner_email_messages_read on public.partner_email_messages;
create policy partner_email_messages_read on public.partner_email_messages for select
  using (user_id = auth.uid() or public.nexais_partner_is_staff_of(company_id));

create table if not exists public.partner_email_suppressions (
  company_id uuid not null,
  email text not null,
  reason text not null default 'unsubscribed',
  created_at timestamptz not null default now(),
  primary key (company_id, email)
);
alter table public.partner_email_suppressions enable row level security;
drop policy if exists partner_email_suppressions_read on public.partner_email_suppressions;
create policy partner_email_suppressions_read on public.partner_email_suppressions for select
  using (public.nexais_partner_is_staff_of(company_id));

-- 4) switch -------------------------------------------------------------------------------------------
create or replace function public.partner_email_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.voice_memory_config where key = 'partner_email_enabled'), 'off') = 'on'
$$;
grant execute on function public.partner_email_enabled() to authenticated;

create or replace function public.partner_set_email_enabled(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.nexais_rls_is_platform_admin() then raise exception 'only the NexAIS owner can change this' using errcode = '42501'; end if;
  if p_on and coalesce((select value from public.voice_memory_config where key = 'partner_email_mailing_address'), '') = '' then
    raise exception 'set the mailing address for the email footer first (CASL)' using errcode = '22023'; end if;
  update public.voice_memory_config set value = case when p_on then 'on' else 'off' end, updated_at = now() where key = 'partner_email_enabled';
  return p_on;
end $$;
revoke all on function public.partner_set_email_enabled(boolean) from public, anon;
grant execute on function public.partner_set_email_enabled(boolean) to authenticated;

-- 5) send ---------------------------------------------------------------------------------------------
create or replace function public.partner_send_email(p_mission uuid, p_to text, p_subject text, p_body text, p_basis text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_company uuid; v_to text := lower(btrim(coalesce(p_to, '')));
        v_subject text := btrim(coalesce(p_subject, '')); v_body text := btrim(coalesce(p_body, '')); v_name text;
        r public.partner_email_messages;
begin
  v_company := public.partner_comm_check(p_mission, 'email');
  if not public.partner_email_enabled() then raise exception 'email sending is switched off by the NexAIS owner' using errcode = '42501'; end if;
  if p_basis not in ('express', 'published') then raise exception 'choose why we may email this address (CASL)' using errcode = '22023'; end if;
  if v_to !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'enter a valid email address' using errcode = '22023'; end if;
  if v_to like '%@nexais.ca' then raise exception 'cannot email our own address' using errcode = '22023'; end if;
  if length(v_subject) = 0 or length(v_subject) > 200 then raise exception 'subject must be 1-200 characters' using errcode = '22023'; end if;
  if length(v_body) = 0 or length(v_body) > 8000 then raise exception 'message must be 1-8000 characters' using errcode = '22023'; end if;
  if exists (select 1 from public.partner_email_suppressions where company_id = v_company and email = v_to) then
    raise exception 'this address unsubscribed; do not email it again' using errcode = '42501'; end if;
  if (select count(*) from public.partner_email_messages where user_id = v_uid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'limit reached: 20 emails per hour per person' using errcode = '42501'; end if;
  if (select count(*) from public.partner_email_messages where company_id = v_company and created_at > now() - interval '1 day') >= 30 then
    raise exception 'limit reached: 30 emails per day for the company' using errcode = '42501'; end if;
  if (select count(*) from public.partner_email_messages where company_id = v_company and to_email = v_to and created_at > now() - interval '1 day') >= 3 then
    raise exception 'limit reached: 3 emails to the same address per day' using errcode = '42501'; end if;
  select coalesce(nullif(btrim(u.full_name), ''), split_part(u.email, '@', 1)) into v_name from public.users u where u.id = v_uid;
  insert into public.partner_email_messages (company_id, mission_id, user_id, sender_name, to_email, subject, body, consent_basis)
  values (v_company, p_mission, v_uid, v_name, v_to, v_subject, v_body, p_basis) returning * into r;
  perform net.http_post(
    url := 'https://kubgqrxjeghmialdxvdd.supabase.co/functions/v1/partner-email-send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-memory-secret', (select value from public.voice_memory_config where key = 'inbound_secret')),
    body := jsonb_build_object('id', r.id), timeout_milliseconds := 20000);
  insert into public.partner_activity_log (company_id, mission_id, action, to_value, notes)
  values (v_company, p_mission, 'email', v_to, left('Email from the NexAIS address: ' || v_subject, 4000));
  return jsonb_build_object('id', r.id, 'status', r.status, 'to', v_to);
end $$;
revoke all on function public.partner_send_email(uuid, text, text, text, text) from public, anon;
grant execute on function public.partner_send_email(uuid, text, text, text, text) to authenticated;

create or replace function public.partner_email_list(p_mission uuid)
returns table (id uuid, to_email text, subject text, status text, error text, sender_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_company uuid;
begin
  v_company := public.partner_comm_check(p_mission, 'email');
  return query select e.id, e.to_email, e.subject, e.status, e.error, e.sender_name, e.created_at
    from public.partner_email_messages e where e.mission_id = p_mission order by e.created_at desc limit 30;
end $$;
revoke all on function public.partner_email_list(uuid) from public, anon;
grant execute on function public.partner_email_list(uuid) to authenticated;

-- 6) unsubscribe (public link in every email; served by the partner app at /unsubscribe) -------------
insert into public.voice_memory_config (key, value) values ('partner_email_unsub_base', 'https://nexais-partners-crm-test.onrender.com')
on conflict (key) do nothing;

create or replace function public.partner_email_unsubscribe(p_token uuid, p_confirm boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  select company_id, to_email into m from public.partner_email_messages where unsub_token = p_token;
  if not found then return null; end if;
  if p_confirm then
    insert into public.partner_email_suppressions (company_id, email, reason) values (m.company_id, m.to_email, 'unsubscribed')
    on conflict (company_id, email) do nothing;
  end if;
  return m.to_email;
end $$;
revoke all on function public.partner_email_unsubscribe(uuid, boolean) from public;
grant execute on function public.partner_email_unsubscribe(uuid, boolean) to anon, authenticated;
