// partner-email-send — sends a partner-hub email from the NexAIS company address through Resend.
// public.partner_send_email() checks permission, the owner's switch, CASL basis, unsubscribes and limits,
// inserts a partner_email_messages row and POSTs {id} here with x-memory-secret.
//   POST {id}                 send one queued email
//   POST {type:"status"}      report configuration (no secrets)
// Unsubscribe links point to the partner app (<partner_email_unsub_base>/unsubscribe?u=<token>), which calls
// public.partner_email_unsubscribe() — Supabase serves function HTML as text/plain, so the page lives there.
// Secret RESEND_API_KEY must be set on the function. Sender/reply-to/mailing address live in voice_memory_config.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function cfg(key: string) {
  const { data } = await supabase.from("voice_memory_config").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? "").trim();
}

function render(body: string, sender: string, mailing: string, unsubUrl: string) {
  const paras = esc(body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0e7a4f">$1</a>')}</p>`).join("");
  const footer = `NexAIS Inc. · ${mailing} · info@nexais.ca · +1 (437) 529-0400`;
  const htmlBody = `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.55;color:#18181b;max-width:600px">${paras}
<hr style="border:0;border-top:1px solid #e4e4e7;margin:24px 0 12px"><p style="font-size:12px;color:#71717a;margin:0">Sent by ${esc(sender)} on behalf of ${esc(footer)}<br>
You received this because your business address is published for business enquiries, or you asked us to contact you. <a href="${unsubUrl}" style="color:#71717a">Unsubscribe</a></p></div>`;
  const text = `${body}\n\n--\nSent by ${sender} on behalf of ${footer}\nUnsubscribe: ${unsubUrl}`;
  return { htmlBody, text };
}

async function send(id: string) {
  const { data: m } = await supabase.from("partner_email_messages").select("*").eq("id", id).maybeSingle();
  if (!m) return json({ error: "not found" }, 404);
  if (m.status !== "queued") return json({ status: m.status });
  const fail = async (status: string, error: string) => {
    await supabase.from("partner_email_messages").update({ status, error: error.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", id);
    return json({ status, error });
  };
  if ((await cfg("partner_email_enabled")) !== "on") return fail("blocked", "email sending is switched off");
  const { data: sup } = await supabase.from("partner_email_suppressions").select("email").eq("company_id", m.company_id).eq("email", m.to_email).maybeSingle();
  if (sup) return fail("blocked", "address unsubscribed");
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return fail("failed", "email service not connected yet");
  const [from, replyTo, mailing, base] = [await cfg("partner_email_from"), await cfg("partner_email_reply_to"), await cfg("partner_email_mailing_address"), await cfg("partner_email_unsub_base")];
  if (!from || !mailing || !base) return fail("failed", "sender or mailing address not configured");
  const unsubUrl = `${base.replace(/\/$/, "")}/unsubscribe?u=${m.unsub_token}`;
  const { htmlBody, text } = render(m.body, m.sender_name || "the NexAIS team", mailing, unsubUrl);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `partner-email-${id}` },
    body: JSON.stringify({
      from, to: [m.to_email], subject: m.subject, html: htmlBody, text,
      reply_to: replyTo || undefined,
      headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) return fail("failed", `email service: ${data?.message || res.status}`);
  await supabase.from("partner_email_messages").update({ status: "sent", provider_id: data?.id ?? null, error: null, updated_at: new Date().toISOString() }).eq("id", id);
  return json({ status: "sent" });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (req.headers.get("x-memory-secret") !== (await cfg("inbound_secret"))) return json({ error: "unauthorized" }, 401);
  const body: any = await req.json().catch(() => ({}));
  if (body.type === "status") {
    return json({
      enabled: (await cfg("partner_email_enabled")) === "on", resend_key: !!Deno.env.get("RESEND_API_KEY"),
      from: await cfg("partner_email_from"), reply_to: await cfg("partner_email_reply_to"), mailing_address_set: !!(await cfg("partner_email_mailing_address")),
    });
  }
  if (typeof body.id !== "string") return json({ error: "id required" }, 400);
  return send(body.id);
});
