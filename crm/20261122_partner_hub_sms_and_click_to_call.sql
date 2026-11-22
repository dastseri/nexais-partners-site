-- Partner hub: SMS and click-to-call from the company's own AVA line (NexAIS: +1 437-529-0400).
-- Approved by the owner 2026-11-22. Does not change any line's inbound routing or assistant.
-- Every check runs on the signed-in user (auth.uid()): managers of the company, or a partner whose
-- admin granted can_sms / can_call and who owns the mission.

-- 1) phone helper -----------------------------------------------------------------------
create or replace function public.partner_e164(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when btrim(p) ~ '^\+[1-9][0-9]{7,14}$' then btrim(p)
    when length(regexp_replace(p, '\D', '', 'g')) = 10 then '+1' || regexp_replace(p, '\D', '', 'g')
    when length(regexp_replace(p, '\D', '', 'g')) = 11 and left(regexp_replace(p, '\D', '', 'g'), 1) = '1' then '+' || regexp_replace(p, '\D', '', 'g')
    else null end
$$;

-- 2) who may contact a mission's business ----------------------------------------------
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
  select bool_or(case when p_kind = 'sms' then coalesce(pp.can_sms, false) else coalesce(pp.can_call, false) end) into v_ok
    from public.partner_permissions pp where pp.agent_id in (select public.nexais_rls_my_agent_ids());
  if not coalesce(v_ok, false) then
    raise exception '% is not enabled for you; ask the NexAIS admin', case when p_kind = 'sms' then 'SMS' else 'Calling' end using errcode = '42501';
  end if;
  return m.company_id;
end $$;
revoke all on function public.partner_comm_check(uuid, text) from public, anon, authenticated;

create or replace function public.partner_company_line(p_company uuid) returns text
language sql stable security definer set search_path = public as $$
  select phone_number from public.phone_number_mappings
   where company_id = p_company and phone_number <> '+14375290170' and coalesce(status, 'active') = 'active'
   order by (provider = 'vapi') desc, created_at limit 1
$$;
revoke all on function public.partner_company_line(uuid) from public, anon, authenticated;

-- 3) SMS from the company line ---------------------------------------------------------------
create or replace function public.partner_send_sms(p_mission uuid, p_to text, p_body text, p_consent boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_company uuid; v_to text := public.partner_e164(p_to);
        v_body text := btrim(coalesce(p_body, '')); v_from text; v_twilio text[]; v_provider text; v public.sms_messages;
begin
  v_company := public.partner_comm_check(p_mission, 'sms');
  if not coalesce(p_consent, false) then raise exception 'consent is required before texting (CASL)' using errcode = '22023'; end if;
  if v_to is null then raise exception 'enter a valid mobile number' using errcode = '22023'; end if;
  if length(v_body) = 0 or length(v_body) > 1000 then raise exception 'message must be 1-1000 characters' using errcode = '22023'; end if;
  if exists (select 1 from public.phone_number_mappings where phone_number = v_to) then raise exception 'cannot text one of our own lines' using errcode = '22023'; end if;
  if (select count(*) from public.sms_messages where company_id = v_company and source = 'crm_manual' and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'limit reached: 60 SMS per hour for this line' using errcode = '42501'; end if;
  if (select count(*) from public.sms_messages where company_id = v_company and source = 'crm_manual' and to_number = v_to and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'limit reached: 5 SMS to the same number in 10 minutes' using errcode = '42501'; end if;
  if (select count(*) from public.sms_messages where source = 'crm_manual' and metadata->>'sent_by_user' = v_uid::text and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'limit reached: 30 SMS per hour per person' using errcode = '42501'; end if;
  v_from := public.partner_company_line(v_company);
  if v_from is null then raise exception 'this company has no SMS line' using errcode = '42501'; end if;
  select string_to_array(replace(value, ' ', ''), ',') into v_twilio from public.voice_memory_config where key = 'sms_twilio_numbers';
  v_provider := case when v_from = any(coalesce(v_twilio, '{}')) then 'twilio' else 'telnyx' end;
  insert into public.sms_messages (company_id, contact_id, direction, from_number, to_number, body, status, source, metadata, created_at, updated_at)
  values (v_company, null, 'outbound', v_from, v_to, v_body, 'queued', 'crm_manual',
          jsonb_build_object('provider', v_provider, 'sent_by_user', v_uid, 'other_party', v_to, 'channel', 'partner_hub',
                             'mission_id', p_mission, 'consent', true), now(), now())
  returning * into v;
  perform net.http_post(
    url := 'https://kubgqrxjeghmialdxvdd.supabase.co/functions/v1/ava-sms-send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-memory-secret', (select value from public.voice_memory_config where key = 'inbound_secret')),
    body := jsonb_build_object('id', v.id), timeout_milliseconds := 20000);
  insert into public.partner_activity_log (company_id, mission_id, action, to_value, notes)
  values (v_company, p_mission, 'sms', v_to, left('SMS from the company line: ' || v_body, 4000));
  return jsonb_build_object('id', v.id, 'status', v.status, 'from', v_from, 'to', v_to);
end $$;
revoke all on function public.partner_send_sms(uuid, text, text, boolean) from public, anon;
grant execute on function public.partner_send_sms(uuid, text, text, boolean) to authenticated;

create or replace function public.partner_sms_thread(p_mission uuid, p_to text)
returns table (id uuid, direction text, body text, status text, created_at timestamptz, error text)
language plpgsql stable security definer set search_path = public as $$
declare v_company uuid; v_to text := public.partner_e164(p_to);
begin
  v_company := public.partner_comm_check(p_mission, 'sms');
  if v_to is null then return; end if;
  return query select s.id, s.direction, s.body, s.status, s.created_at, s.provider_error
    from public.sms_messages s where s.company_id = v_company and (s.to_number = v_to or s.from_number = v_to)
    order by s.created_at desc limit 50;
end $$;
revoke all on function public.partner_sms_thread(uuid, text) from public, anon;
grant execute on function public.partner_sms_thread(uuid, text) to authenticated;

-- 4) click-to-call ----------------------------------------------------------------------------
create table if not exists public.partner_user_phones (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone text not null check (phone ~ '^\+1[0-9]{10}$'),
  updated_at timestamptz not null default now()
);
alter table public.partner_user_phones enable row level security;
drop policy if exists partner_user_phones_own on public.partner_user_phones;
create policy partner_user_phones_own on public.partner_user_phones for select using (user_id = auth.uid());

create or replace function public.partner_set_my_phone(p_phone text) returns text
language plpgsql security definer set search_path = public as $$
declare v text := public.partner_e164(p_phone);
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '42501'; end if;
  if v is null or v !~ '^\+1[0-9]{10}$' then raise exception 'enter your Canadian or US mobile number' using errcode = '22023'; end if;
  if exists (select 1 from public.phone_number_mappings where phone_number = v) then raise exception 'use your own mobile, not a company line' using errcode = '22023'; end if;
  insert into public.partner_user_phones (user_id, phone, updated_at) values (auth.uid(), v, now())
  on conflict (user_id) do update set phone = excluded.phone, updated_at = now();
  return v;
end $$;
revoke all on function public.partner_set_my_phone(text) from public, anon;
grant execute on function public.partner_set_my_phone(text) to authenticated;

create table if not exists public.partner_click_calls (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  mission_id uuid not null references public.partner_missions(id) on delete cascade,
  user_id uuid not null,
  agent_phone text not null,
  to_number text not null,
  from_number text not null,
  status text not null default 'queued'
    check (status in ('queued','ringing_you','connecting','connected','ended','you_missed','no_answer','failed','blocked')),
  agent_call_id text,
  error text,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_sec integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists partner_click_calls_user_idx on public.partner_click_calls (user_id, created_at desc);
alter table public.partner_click_calls enable row level security;
drop policy if exists partner_click_calls_read on public.partner_click_calls;
create policy partner_click_calls_read on public.partner_click_calls for select
  using (user_id = auth.uid() or public.nexais_partner_is_staff_of(company_id));

create or replace function public.partner_start_call(p_mission uuid, p_to text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_company uuid; v_to text := public.partner_e164(p_to); v_agent text; v_from text;
        v_local timestamp := (now() at time zone 'America/Toronto'); r public.partner_click_calls;
begin
  v_company := public.partner_comm_check(p_mission, 'call');
  select phone into v_agent from public.partner_user_phones where user_id = v_uid;
  if v_agent is null then raise exception 'add your own mobile number first' using errcode = '22023'; end if;
  if v_to is null or v_to !~ '^\+1[0-9]{10}$' then raise exception 'only Canadian and US numbers can be called' using errcode = '22023'; end if;
  if v_to = v_agent then raise exception 'that is your own number' using errcode = '22023'; end if;
  if exists (select 1 from public.phone_number_mappings where phone_number = v_to) then raise exception 'cannot call one of our own lines' using errcode = '22023'; end if;
  if extract(hour from v_local) < 8 or extract(hour from v_local) >= 21 then
    raise exception 'calls are allowed 8:00-21:00 Toronto time' using errcode = '42501'; end if;
  if exists (select 1 from public.partner_click_calls where user_id = v_uid and status in ('queued','ringing_you','connecting','connected')
             and created_at > now() - interval '30 minutes') then
    raise exception 'you already have a call in progress' using errcode = '42501'; end if;
  if (select count(*) from public.partner_click_calls where user_id = v_uid and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'limit reached: 30 calls per hour per person' using errcode = '42501'; end if;
  v_from := public.partner_company_line(v_company);
  if v_from is null then raise exception 'this company has no phone line' using errcode = '42501'; end if;
  insert into public.partner_click_calls (company_id, mission_id, user_id, agent_phone, to_number, from_number)
  values (v_company, p_mission, v_uid, v_agent, v_to, v_from) returning * into r;
  perform net.http_post(
    url := 'https://kubgqrxjeghmialdxvdd.supabase.co/functions/v1/partner-click-call',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-memory-secret', (select value from public.voice_memory_config where key = 'inbound_secret')),
    body := jsonb_build_object('type', 'start', 'id', r.id), timeout_milliseconds := 20000);
  insert into public.partner_activity_log (company_id, mission_id, action, to_value, notes)
  values (v_company, p_mission, 'call', v_to, 'Call started from the company line (click-to-call)');
  return jsonb_build_object('id', r.id, 'status', r.status, 'from', v_from, 'to', v_to);
end $$;
revoke all on function public.partner_start_call(uuid, text) from public, anon;
grant execute on function public.partner_start_call(uuid, text) to authenticated;

-- webhook token for the Telnyx call-control application (kept server-side)
insert into public.voice_memory_config (key, value, updated_at)
select 'partner_click_call_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), now()
where not exists (select 1 from public.voice_memory_config where key = 'partner_click_call_token');
