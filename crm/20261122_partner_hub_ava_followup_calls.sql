-- Partner hub: AVA follow-up calls with recorded consent (CRTC ADAD rules). Approved by the owner 2026-11-22.
-- The owner alone turns the feature on/off (voice_memory_config.partner_ava_calls_enabled). Calls are placed by
-- the existing ava-outbound dispatcher from the company line (source 'manual', linked via partner_ava_calls); no new dialing path.

insert into public.voice_memory_config (key, value, updated_at)
select 'partner_ava_calls_enabled', 'off', now()
where not exists (select 1 from public.voice_memory_config where key = 'partner_ava_calls_enabled');

create table if not exists public.partner_ava_consents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  mission_id uuid not null references public.partner_missions(id) on delete cascade,
  phone text not null,
  person_name text not null,
  method text not null check (method in ('phone_call','sms','email','in_person','web_form')),
  given_at timestamptz not null,
  note text,
  recorded_by uuid not null,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists partner_ava_consents_mission_idx on public.partner_ava_consents (mission_id, phone);
alter table public.partner_ava_consents enable row level security;

create table if not exists public.partner_ava_calls (
  ava_call_id uuid primary key references public.ava_outbound_calls(id) on delete cascade,
  mission_id uuid not null references public.partner_missions(id) on delete cascade,
  company_id uuid not null,
  consent_id uuid not null references public.partner_ava_consents(id),
  purpose text not null,
  requested_by uuid not null,
  created_at timestamptz not null default now()
);
alter table public.partner_ava_calls enable row level security;

create or replace function public.partner_ava_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.voice_memory_config where key = 'partner_ava_calls_enabled'), 'off') = 'on'
$$;
grant execute on function public.partner_ava_enabled() to authenticated;

-- owner's switch (platform admin only)
create or replace function public.partner_set_ava_enabled(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.nexais_rls_is_platform_admin() then raise exception 'only the owner can turn AVA calls on or off' using errcode = '42501'; end if;
  update public.voice_memory_config set value = case when p_on then 'on' else 'off' end, updated_at = now() where key = 'partner_ava_calls_enabled';
  return p_on;
end $$;
revoke all on function public.partner_set_ava_enabled(boolean) from public, anon;
grant execute on function public.partner_set_ava_enabled(boolean) to authenticated;

create or replace function public.partner_record_ava_consent(p_mission uuid, p_phone text, p_person text, p_method text, p_given_at timestamptz, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_phone text := public.partner_e164(p_phone); v_id uuid;
begin
  v_company := public.partner_comm_check(p_mission, 'call');
  if v_phone is null then raise exception 'enter the number they agreed to be called on' using errcode = '22023'; end if;
  if btrim(coalesce(p_person, '')) = '' then raise exception 'enter who gave the consent' using errcode = '22023'; end if;
  if p_method not in ('phone_call','sms','email','in_person','web_form') then raise exception 'choose how they agreed' using errcode = '22023'; end if;
  if p_given_at is null or p_given_at > now() + interval '5 minutes' then raise exception 'enter when they agreed' using errcode = '22023'; end if;
  insert into public.partner_ava_consents (company_id, mission_id, phone, person_name, method, given_at, note, recorded_by)
  values (v_company, p_mission, v_phone, left(btrim(p_person), 120), p_method, p_given_at, left(coalesce(p_note, ''), 500), auth.uid())
  returning id into v_id;
  insert into public.partner_activity_log (company_id, mission_id, action, to_value, notes)
  values (v_company, p_mission, 'note', v_phone, 'Consent recorded: ' || left(btrim(p_person), 120) || ' agreed that AVA may call ' || v_phone || ' (' || p_method || ')');
  return v_id;
end $$;
revoke all on function public.partner_record_ava_consent(uuid, text, text, text, timestamptz, text) from public, anon;
grant execute on function public.partner_record_ava_consent(uuid, text, text, text, timestamptz, text) to authenticated;

create or replace function public.partner_request_ava_call(p_mission uuid, p_phone text, p_purpose text, p_note text, p_when timestamptz, p_language text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_company uuid; v_phone text := public.partner_e164(p_phone); c public.partner_ava_consents;
        m public.partner_missions; v_goal text; v_who text; v_id uuid; v_type text;
begin
  if not public.partner_ava_enabled() then raise exception 'AVA calls are turned off right now' using errcode = '42501'; end if;
  v_company := public.partner_comm_check(p_mission, 'call');
  select * into m from public.partner_missions where id = p_mission;
  select * into c from public.partner_ava_consents
   where mission_id = p_mission and phone = v_phone and withdrawn_at is null order by given_at desc limit 1;
  if c.id is null then raise exception 'record their consent for this number first' using errcode = '42501'; end if;
  if v_phone !~ '^\+1[0-9]{10}$' then raise exception 'only Canadian and US numbers' using errcode = '22023'; end if;
  if exists (select 1 from public.phone_number_mappings where phone_number = v_phone) then raise exception 'cannot call one of our own lines' using errcode = '22023'; end if;
  if exists (select 1 from public.partner_ava_calls pc join public.ava_outbound_calls a on a.id = pc.ava_call_id
             where pc.mission_id = p_mission and a.status in ('scheduled','calling')) then
    raise exception 'AVA already has a call planned for this business' using errcode = '42501'; end if;
  if (select count(*) from public.partner_ava_calls where requested_by = v_uid and created_at > now() - interval '1 day') >= 20 then
    raise exception 'limit reached: 20 AVA calls per day per person' using errcode = '42501'; end if;
  select coalesce(nullif(full_name, ''), 'the NexAIS team') into v_who from public.sales_agents
   where (auth_user_id = v_uid or user_id = v_uid) order by created_at limit 1;
  v_who := coalesce(v_who, 'the NexAIS team');
  v_type := case when p_purpose = 'requested_callback' then 'callback' else 'follow_up' end;
  v_goal := 'Say clearly at the start that you are AVA, an AI assistant calling on behalf of ' || v_who || ' at NexAIS, and that the call is recorded. '
    || case p_purpose
         when 'follow_up_proposal' then 'Follow up on the AVA proposal NexAIS prepared for ' || m.business_name || '. Ask whether they had a chance to look at it, answer simple questions about what AVA does, and offer either a short call with ' || v_who || ' or the free 7-day trial.'
         when 'book_demo' then 'Book a time for ' || v_who || ' to show ' || m.business_name || ' how AVA would answer their calls. Agree a day and time and confirm it back.'
         when 'trial_reminder' then 'Remind ' || m.business_name || ' about starting their free 7-day AVA trial and ask if anything is stopping them; offer that ' || v_who || ' will call to help.'
         when 'requested_callback' then 'They asked to be called back. Find out what they need and arrange for ' || v_who || ' to follow up.'
         else 'Follow up with ' || m.business_name || ' for ' || v_who || '.' end
    || ' Never quote prices or promise anything that is not stated here; say ' || v_who || ' will confirm in writing. If they ask not to be called again, confirm and end the call.'
    || case when btrim(coalesce(p_note, '')) <> '' then ' Context from ' || v_who || ': ' || left(btrim(p_note), 400) else '' end;
  if p_purpose not in ('follow_up_proposal','book_demo','trial_reminder','requested_callback') then raise exception 'choose the purpose of the call' using errcode = '22023'; end if;
  insert into public.ava_outbound_calls (company_id, call_type, source, goal, customer_name, customer_phone, language, scheduled_for, status, attempts, created_by)
  values (v_company, v_type, 'manual', v_goal, c.person_name, v_phone,
          case when lower(coalesce(p_language, 'en')) like 'fa%' then 'fa' else 'en' end,
          greatest(now(), coalesce(p_when, now())), 'scheduled', 0, (select u.id from public.users u where u.id = v_uid))
  returning id into v_id;
  insert into public.partner_ava_calls (ava_call_id, mission_id, company_id, consent_id, purpose, requested_by)
  values (v_id, p_mission, v_company, c.id, p_purpose, v_uid);
  insert into public.partner_activity_log (company_id, mission_id, action, to_value, notes)
  values (v_company, p_mission, 'note', v_phone, 'AVA call planned (' || p_purpose || ') for ' || to_char(greatest(now(), coalesce(p_when, now())) at time zone 'America/Toronto', 'Mon DD HH24:MI'));
  return jsonb_build_object('id', v_id, 'status', 'scheduled');
end $$;
revoke all on function public.partner_request_ava_call(uuid, text, text, text, timestamptz, text) from public, anon;
grant execute on function public.partner_request_ava_call(uuid, text, text, text, timestamptz, text) to authenticated;

create or replace function public.partner_ava_overview(p_mission uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_company uuid;
begin
  v_company := public.partner_comm_check(p_mission, 'call');
  return jsonb_build_object(
    'enabled', public.partner_ava_enabled(),
    'consents', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'phone', phone, 'person', person_name, 'method', method, 'given_at', given_at) order by given_at desc)
                 from public.partner_ava_consents where mission_id = p_mission and withdrawn_at is null), '[]'::jsonb),
    'calls', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'purpose', pc.purpose, 'phone', a.customer_phone, 'status', a.status,
                 'scheduled_for', a.scheduled_for, 'outcome', a.outcome, 'summary', a.result_summary, 'error', a.error, 'takeover', a.takeover_status,
                 'updated_at', a.updated_at) order by a.created_at desc)
                 from public.partner_ava_calls pc join public.ava_outbound_calls a on a.id = pc.ava_call_id where pc.mission_id = p_mission), '[]'::jsonb));
end $$;
revoke all on function public.partner_ava_overview(uuid) from public, anon;
grant execute on function public.partner_ava_overview(uuid) to authenticated;

-- take over a live AVA call: AVA hands the call to the requester's own mobile
create or replace function public.partner_ava_takeover(p_call uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pc public.partner_ava_calls; v_to text;
begin
  select * into pc from public.partner_ava_calls where ava_call_id = p_call;
  if pc.ava_call_id is null then raise exception 'call not found' using errcode = '22023'; end if;
  perform public.partner_comm_check(pc.mission_id, 'call');
  select phone into v_to from public.partner_user_phones where user_id = auth.uid();
  if v_to is null then raise exception 'save your own mobile number first (Calls page)' using errcode = '22023'; end if;
  update public.ava_outbound_calls set takeover_status = 'requested', takeover_to = v_to, takeover_by = (select u.id from public.users u where u.id = auth.uid()), takeover_at = now(), updated_at = now()
   where id = p_call and status = 'calling' and coalesce(takeover_status, '') not in ('requested','transferring','transferred');
  if not found then raise exception 'the call is not live right now' using errcode = '42501'; end if;
  perform net.http_post(
    url := 'https://kubgqrxjeghmialdxvdd.supabase.co/functions/v1/ava-outbound',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-memory-secret', (select value from public.voice_memory_config where key = 'inbound_secret')),
    body := jsonb_build_object('message', jsonb_build_object('type', 'takeover', 'id', p_call)), timeout_milliseconds := 20000);
  return jsonb_build_object('ok', true, 'to', v_to);
end $$;
revoke all on function public.partner_ava_takeover(uuid) from public, anon;
grant execute on function public.partner_ava_takeover(uuid) to authenticated;

-- when AVA finishes, write the result on the business (shared with the whole team)
create or replace function public.partner_ava_call_result() returns trigger
language plpgsql security definer set search_path = public as $$
declare pc public.partner_ava_calls; v_outcome text;
begin
  if new.status is not distinct from old.status or new.status not in ('done','failed','blocked') then return new; end if;
  select * into pc from public.partner_ava_calls where ava_call_id = new.id;
  if pc.ava_call_id is null then return new; end if;
  v_outcome := case new.outcome
    when 'interested' then 'reached_decision_maker' when 'confirmed' then 'reached_decision_maker' when 'rescheduled' then 'callback_scheduled'
    when 'callback_requested' then 'callback_scheduled' when 'not_interested' then 'not_interested' when 'voicemail' then 'voicemail_left'
    else null end;
  insert into public.partner_activity_log (company_id, mission_id, action, outcome, to_value, notes)
  values (pc.company_id, pc.mission_id, case when v_outcome is null then 'note' else 'call' end, v_outcome, new.customer_phone,
          left('AVA call ' || new.status || coalesce(' — ' || new.outcome, '') || coalesce(': ' || new.result_summary, '') || coalesce(' (' || new.error || ')', ''), 4000));
  return new;
exception when others then
  raise warning 'partner_ava_call_result: %', sqlerrm;
  return new;
end $$;
drop trigger if exists partner_ava_call_result on public.ava_outbound_calls;
create trigger partner_ava_call_result after update of status on public.ava_outbound_calls
  for each row when (new.status in ('done','failed','blocked')) execute function public.partner_ava_call_result();
