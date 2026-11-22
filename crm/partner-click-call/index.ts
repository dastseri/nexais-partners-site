// partner-click-call — click-to-call for the partner hub from the company's own AVA line.
// Flow: the hub calls public.partner_start_call() (permission, limits, hours checked there) which inserts a
// partner_click_calls row and POSTs {type:"start", id} here. We ring the marketer's own phone from the company
// line; when they answer we transfer the call to the business, so the business sees the company number
// (NexAIS: +1 437-529-0400). Calls back to that number keep going to AVA — inbound routing is never changed.
//
// POST with header x-memory-secret = voice_memory_config.inbound_secret
//   {type:"start", id}     place the call for a queued row
//   {type:"setup"}         one-time: create the Telnyx Call Control application (stored as partner_call_app_id)
//   {type:"status"}        report the configuration (no secrets)
// POST ?token=<voice_memory_config.partner_click_call_token>   Telnyx call-control webhooks
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/partner-click-call`;
const TELNYX = "https://api.telnyx.com/v2";
const PROTECTED = new Set(["+14375290170"]);
const APP_NAME = "NexAIS Partner Click-to-Call";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function cfg(key: string) {
  const { data } = await supabase.from("voice_memory_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? "";
}
async function setCfg(key: string, value: string) {
  await supabase.from("voice_memory_config").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
}
async function telnyx(path: string, method = "GET", body?: unknown) {
  const key = Deno.env.get("TELNYX_API_KEY");
  if (!key) return { ok: false, status: 0, data: { error: "TELNYX_API_KEY missing" } };
  const res = await fetch(TELNYX + path, {
    method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
const b64 = (o: unknown) => btoa(JSON.stringify(o));
const unb64 = (s?: string) => { try { return s ? JSON.parse(atob(s)) : {}; } catch { return {}; } };
async function update(id: string, patch: Record<string, unknown>) {
  await supabase.from("partner_click_calls").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

async function webhookUrl() { return `${SELF}?token=${await cfg("partner_click_call_token")}`; }

async function setup() {
  const existing = await cfg("partner_call_app_id");
  if (existing) return { ok: true, app_id: existing, existing: true };
  const ovp = await telnyx("/outbound_voice_profiles?page[size]=50");
  if (!ovp.ok) return { ok: false, step: "outbound_voice_profiles", status: ovp.status, error: ovp.data };
  const profiles = (ovp.data?.data ?? []).filter((p: any) => p.enabled !== false);
  if (!profiles.length) return { ok: false, error: "No enabled outbound voice profile in Telnyx" };
  const profile = profiles[0];
  const app = await telnyx("/call_control_applications", "POST", {
    application_name: APP_NAME, webhook_event_url: await webhookUrl(), webhook_api_version: "2",
    anchorsite_override: "Latency", active: true, outbound: { outbound_voice_profile_id: profile.id },
  });
  if (!app.ok || !app.data?.data?.id) return { ok: false, step: "create_app", status: app.status, error: app.data };
  await setCfg("partner_call_app_id", app.data.data.id);
  return { ok: true, app_id: app.data.data.id, outbound_voice_profile: profile.name ?? profile.id };
}

async function start(id: string) {
  const { data: row } = await supabase.from("partner_click_calls").update({ status: "ringing_you", updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", "queued").select("*").maybeSingle();
  if (!row) return { ok: true, skipped: "not queued" };
  if (PROTECTED.has(row.from_number) || PROTECTED.has(row.to_number)) { await update(id, { status: "blocked", error: "protected line" }); return { ok: false }; }
  const app = await cfg("partner_call_app_id");
  if (!app) { await update(id, { status: "failed", error: "Click-to-call is not set up yet" }); return { ok: false, error: "not set up" }; }
  const r = await telnyx("/calls", "POST", {
    connection_id: app, to: row.agent_phone, from: row.from_number, timeout_secs: 30,
    client_state: b64({ id, leg: "agent" }), webhook_url: await webhookUrl(),
  });
  const ccid = r.data?.data?.call_control_id;
  if (!r.ok || !ccid) { await update(id, { status: "failed", error: `telnyx ${r.status}: ${JSON.stringify(r.data?.errors ?? r.data).slice(0, 300)}` }); return { ok: false }; }
  await update(id, { agent_call_id: ccid });
  return { ok: true };
}

async function onEvent(ev: any) {
  const type: string = ev?.data?.event_type ?? "";
  const p = ev?.data?.payload ?? {};
  const st = unb64(p.client_state);
  if (!st?.id) return;
  const { data: row } = await supabase.from("partner_click_calls").select("*").eq("id", st.id).maybeSingle();
  if (!row) return;
  const now = new Date().toISOString();
  if (type === "call.answered" && st.leg === "agent" && row.status === "ringing_you") {
    await update(row.id, { status: "connecting" });
    const t = await telnyx(`/calls/${encodeURIComponent(p.call_control_id)}/actions/transfer`, "POST", {
      to: row.to_number, from: row.from_number, timeout_secs: 30,
      client_state: b64({ id: row.id, leg: "business" }), webhook_url: await webhookUrl(),
    });
    if (!t.ok) await update(row.id, { status: "failed", error: `transfer ${t.status}: ${JSON.stringify(t.data?.errors ?? t.data).slice(0, 300)}` });
    return;
  }
  if (type === "call.bridged" && row.status !== "connected" && row.status !== "ended") {
    await update(row.id, { status: "connected", answered_at: now });
    return;
  }
  if (type === "call.hangup") {
    if (["ended", "you_missed", "no_answer", "failed", "blocked"].includes(row.status)) return;
    const status = row.status === "ringing_you" ? "you_missed" : row.status === "connecting" ? "no_answer" : "ended";
    const duration = row.answered_at ? Math.max(0, Math.round((Date.now() - new Date(row.answered_at).getTime()) / 1000)) : 0;
    await update(row.id, { status, ended_at: now, duration_sec: duration, error: status === "ended" ? null : (p.hangup_cause ?? null) });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true, service: "partner-click-call", version: 1 });
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token) {
    if (token !== (await cfg("partner_click_call_token"))) return json({ error: "unauthorized" }, 401);
    const ev = await req.json().catch(() => ({}));
    EdgeRuntime.waitUntil(onEvent(ev).catch((e) => console.error("[click-call] event", e)));
    return json({ ok: true });
  }
  const secret = await cfg("inbound_secret");
  if (!secret || req.headers.get("x-memory-secret") !== secret) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  if (body?.type === "start" && body?.id) return json(await start(String(body.id)));
  if (body?.type === "setup") return json(await setup());
  if (body?.type === "status") return json({ ok: true, app_id: (await cfg("partner_call_app_id")) || null, telnyx_key: !!Deno.env.get("TELNYX_API_KEY") });
  return json({ error: "unknown request" }, 400);
});
