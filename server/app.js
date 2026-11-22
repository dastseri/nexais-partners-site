// partner.nexais.ca server: real login backed by the NexAIS CRM (Supabase Auth).
//
// Security model
// - Every data call runs with the signed-in user's own token, so the CRM's row-level
//   security decides what each person can see or change. The server never holds a
//   service-role key.
// - The hub page (with prospect data) is served only to signed-in members of the
//   NexAIS partner program: platform admin, NexAIS team (company staff), or an active
//   NexAIS sales agent (partner). Everyone else gets the login page and no data.
// - Sessions are HttpOnly, Secure, SameSite=Lax cookies. State-changing API calls
//   must come from this origin with a JSON body.

import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapHubEntry, dedupePrefix } from './hubActivity.js';
import { findHook as defaultFindHook } from './hookFinder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ACCESS_COOKIE = 'nx_at';
const REFRESH_COOKIE = 'nx_rt';
const INACTIVE_AGENT = new Set(['deleted', 'inactive', 'suspended', 'rejected', 'pending']);

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// Removes every call-list card whose business is not in `allowed` (dedupe prefixes).
export function keepOnlyCards(html, allowed) {
  return html.replace(/<article class="card" data-group="[^"]*" data-name="([^"]*)">[\s\S]*?<\/article>\s*/g, (block, name) => {
    const key = dedupePrefix(name.replace(/&amp;/g, '&').replace(/&#x27;/g, "'"));
    return allowed.has(key) ? block : '';
  });
}

export function createApp(options) {
  const {
    makeClient,            // (accessToken?) => supabase-like client
    updatePassword,        // (recoveryToken, password) => { ok }
    companyId,             // NexAIS company id (partner program owner)
    publicOrigin,          // e.g. https://partner.nexais.ca
    hubHtmlPath = path.join(here, '..', 'index.html'),
    secureCookies = true,
    loginLimit = { max: 10, windowMs: 15 * 60 * 1000 },
    now = () => Date.now(),
    findHook = defaultFindHook,     // ({bizName, city, crmNotes, env}) => hook result
    env = process.env,
  } = options;
  if (!makeClient || !companyId || !publicOrigin) throw new Error('makeClient, companyId and publicOrigin are required');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
    });
    next();
  });

  // ---- cookies ---------------------------------------------------------------
  const cookieBase = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
  function setSession(res, session) {
    res.append('Set-Cookie', `${ACCESS_COOKIE}=${encodeURIComponent(session.access_token)}; ${cookieBase}; Max-Age=3600`);
    res.append('Set-Cookie', `${REFRESH_COOKIE}=${encodeURIComponent(session.refresh_token)}; ${cookieBase}; Max-Age=${7 * 24 * 3600}`);
  }
  function clearSession(res) {
    res.append('Set-Cookie', `${ACCESS_COOKIE}=; ${cookieBase}; Max-Age=0`);
    res.append('Set-Cookie', `${REFRESH_COOKIE}=; ${cookieBase}; Max-Age=0`);
  }

  // ---- session resolution ----------------------------------------------------
  async function resolveSession(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies[ACCESS_COOKIE];
    let user = null;
    if (token) {
      const { data, error } = await makeClient().auth.getUser(token);
      if (!error && data?.user) user = data.user;
    }
    if (!user && cookies[REFRESH_COOKIE]) {
      const { data, error } = await makeClient().auth.refreshSession({ refresh_token: cookies[REFRESH_COOKIE] });
      if (!error && data?.session && data?.user) {
        setSession(res, data.session);
        token = data.session.access_token;
        user = data.user;
      }
    }
    if (!user) return null;
    return { user, token, db: makeClient(token) };
  }

  // Who is this person in the partner program? (admin | team | partner | null)
  async function programRole(session) {
    const { db, user } = session;
    const [admin, manager, agents] = await Promise.all([
      db.rpc('nexais_rls_is_platform_admin'),
      db.rpc('nexais_partner_is_manager_of', { p_company: companyId }),
      db.from('sales_agents').select('id, full_name, company_id, status').eq('company_id', companyId)
        .or(`auth_user_id.eq.${user.id},user_id.eq.${user.id}`),
    ]);
    const agentRows = (agents.data || []).filter((a) => !INACTIVE_AGENT.has(String(a.status || '').toLowerCase()));
    const myAgent = agentRows[0] || null;
    const name = user.user_metadata?.full_name || myAgent?.full_name || user.email;
    if (admin.data === true) return { role: 'admin', name, agentId: myAgent?.id || null };
    if (manager.data === true) return { role: 'team', name, agentId: myAgent?.id || null };
    if (myAgent) return { role: 'partner', name, agentId: myAgent.id };
    return null;
  }

  async function requireMember(req, res, next) {
    try {
      const session = await resolveSession(req, res);
      if (!session) return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Sign in required' }) : res.redirect(302, '/login');
      const member = await programRole(session);
      if (!member) {
        if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Not a member of the NexAIS partner program' });
        return res.status(403).type('html').set('Cache-Control', 'no-store').send(page('no-access.html'));
      }
      req.session = session;
      req.member = member;
      return next();
    } catch (err) {
      return next(err);
    }
  }

  // Same-origin JSON only for state changes (CSRF defense on top of SameSite cookies).
  function sameOrigin(req, res, next) {
    const origin = req.headers.origin || '';
    if (origin !== publicOrigin) return res.status(403).json({ error: 'Cross-origin request refused' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON body required' });
    return next();
  }

  // ---- login rate limit (per IP, in memory) -------------------------------------
  const attempts = new Map();
  function rateLimited(ip) {
    const t = now();
    const list = (attempts.get(ip) || []).filter((x) => t - x < loginLimit.windowMs);
    attempts.set(ip, list);
    return list.length >= loginLimit.max;
  }
  function recordAttempt(ip) {
    const list = attempts.get(ip) || [];
    list.push(now());
    attempts.set(ip, list);
  }

  // ---- static auth pages ---------------------------------------------------------
  const pages = new Map();
  function page(name) {
    if (!pages.has(name)) pages.set(name, readFileSync(path.join(here, 'public', name), 'utf8'));
    return pages.get(name);
  }
  app.get('/login', (req, res) => res.type('html').set('Cache-Control', 'no-store').send(page('login.html')));
  app.get('/reset', (req, res) => res.type('html').set('Cache-Control', 'no-store').send(page('reset.html')));
  app.get('/app/auth.css', (req, res) => res.type('css').send(page('auth.css')));
  app.get('/app/hub-bridge.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-store').send(page('hub-bridge.js')));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- auth API ---------------------------------------------------------------------
  app.post('/api/auth/login', sameOrigin, async (req, res, next) => {
    try {
      const ip = req.ip || 'unknown';
      if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      recordAttempt(ip);
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
      const { data, error } = await makeClient().auth.signInWithPassword({ email, password });
      if (error || !data?.session) return res.status(401).json({ error: 'Email or password is not correct' });
      const session = { user: data.user, token: data.session.access_token, db: makeClient(data.session.access_token) };
      const member = await programRole(session);
      if (!member) return res.status(403).json({ error: 'This account is not part of the NexAIS partner program' });
      setSession(res, data.session);
      return res.json({ ok: true, name: member.name, role: member.role });
    } catch (err) { return next(err); }
  });

  app.post('/api/auth/logout', sameOrigin, (req, res) => { clearSession(res); res.json({ ok: true }); });

  app.post('/api/auth/forgot', sameOrigin, async (req, res, next) => {
    try {
      const ip = req.ip || 'unknown';
      if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      recordAttempt(ip);
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (email) await makeClient().auth.resetPasswordForEmail(email, { redirectTo: `${publicOrigin}/reset` });
      return res.json({ ok: true }); // same answer whether or not the account exists
    } catch (err) { return next(err); }
  });

  app.post('/api/auth/reset', sameOrigin, async (req, res, next) => {
    try {
      const ip = req.ip || 'unknown';
      if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      recordAttempt(ip);
      const token = String(req.body?.access_token || '');
      const password = String(req.body?.password || '');
      if (!token || password.length < 10) return res.status(400).json({ error: 'Use a password of at least 10 characters' });
      const result = updatePassword ? await updatePassword(token, password) : { ok: false };
      if (!result.ok) return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
      clearSession(res);
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  // ---- member API (user's own token; CRM row-level security enforces scope) ----------
  app.get('/api/me', requireMember, (req, res) => {
    res.set('Cache-Control', 'no-store').json({ name: req.member.name, role: req.member.role, email: req.session.user.email });
  });

  app.get('/api/permissions/me', requireMember, async (req, res, next) => {
    try {
      if (req.member.role !== 'partner') return res.json({ can_call: true, can_sms: true, can_email: true, team: true });
      const { data } = await req.session.db.from('partner_permissions').select('can_call, can_sms, can_email').eq('agent_id', req.member.agentId).maybeSingle();
      return res.json({ can_call: !!data?.can_call, can_sms: !!data?.can_sms, can_email: false, team: false });
    } catch (err) { return next(err); }
  });

  app.get('/api/missions', requireMember, async (req, res, next) => {
    try {
      const { data, error } = await req.session.db.from('partner_missions')
        .select('id, mission_code, origin, status, business_name, city, vertical, website, public_phone, public_email, partner_summary, proposal_link, outcome, next_step, next_step_due, assigned_agent_id, updated_at')
        .eq('company_id', companyId).order('updated_at', { ascending: false }).limit(500);
      if (error) return res.status(400).json({ error: error.message });
      return res.set('Cache-Control', 'no-store').json({ missions: data });
    } catch (err) { return next(err); }
  });

  app.post('/api/missions', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const row = {
        company_id: companyId,
        origin: req.member.role === 'partner' ? 'partner_initiated' : (b.origin === 'partner_initiated' ? 'partner_initiated' : 'system_initiated'),
        business_name: String(b.business_name || '').trim().slice(0, 200),
        city: b.city ? String(b.city).slice(0, 100) : null,
        vertical: b.vertical ? String(b.vertical).slice(0, 100) : null,
        website: b.website ? String(b.website).slice(0, 300) : null,
        public_phone: b.public_phone ? String(b.public_phone).slice(0, 40) : null,
        public_email: b.public_email ? String(b.public_email).slice(0, 200) : null,
      };
      if (!row.business_name) return res.status(400).json({ error: 'Business name is required' });
      const { data, error } = await req.session.db.from('partner_missions').insert(row).select('id, mission_code, status').single();
      if (error) {
        const duplicate = /duplicate key|partner_missions_open_dedupe_idx/i.test(error.message || '');
        return res.status(duplicate ? 409 : 400).json({ error: duplicate ? 'This business already has an open mission' : error.message });
      }
      return res.status(201).json({ mission: data });
    } catch (err) { return next(err); }
  });

  app.patch('/api/missions/:id', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const allowed = req.member.role === 'partner'
        ? ['status', 'outcome', 'next_step', 'next_step_due']
        : ['status', 'outcome', 'next_step', 'next_step_due', 'assigned_agent_id', 'partner_summary', 'research_ref', 'proposal_link', 'city', 'vertical', 'website', 'public_phone', 'public_email'];
      const patch = {};
      for (const key of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) patch[key] = req.body[key];
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
      if (patch.assigned_agent_id && req.member.role !== 'partner' && !req.body.status) patch.status = 'assigned';
      const { data, error } = await req.session.db.from('partner_missions').update(patch).eq('id', req.params.id).select('id, mission_code, status').maybeSingle();
      if (error) return res.status(403).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Mission not found' });
      return res.json({ mission: data });
    } catch (err) { return next(err); }
  });

  app.post('/api/missions/:id/activity', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const row = {
        company_id: companyId,
        mission_id: req.params.id,
        action: String(b.action || ''),
        outcome: b.outcome || null,
        notes: b.notes ? String(b.notes).slice(0, 4000) : null,
      };
      const { error } = await req.session.db.from('partner_activity_log').insert(row);
      if (error) return res.status(403).json({ error: error.message });
      return res.status(201).json({ ok: true });
    } catch (err) { return next(err); }
  });

  app.put('/api/permissions/:agentId', requireMember, sameOrigin, async (req, res, next) => {
    try {
      if (req.member.role === 'partner') return res.status(403).json({ error: 'Only an admin or the team may change permissions' });
      const row = { agent_id: req.params.agentId, company_id: companyId, can_call: !!req.body?.can_call, can_sms: !!req.body?.can_sms };
      const { error } = await req.session.db.from('partner_permissions').upsert(row, { onConflict: 'agent_id' });
      if (error) return res.status(403).json({ error: error.message });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  // ---- consent records (CASL / CRTC) -----------------------------------------------------
  const CONSENT_CHANNELS = new Set(['sms', 'email', 'ai_call']);
  const CONSENT_BASES = new Set(['express', 'implied_inquiry', 'implied_business_relationship', 'conspicuous_publication']);
  const CONSENT_SOURCES = new Set(['call', 'form', 'email', 'sms', 'in_person', 'website']);

  app.get('/api/missions/:id/consents', requireMember, async (req, res, next) => {
    try {
      const { data, error } = await req.session.db.from('contact_consents')
        .select('id, channel, basis, evidence, source, obtained_at, expires_at, withdrawn_at, withdrawal_note')
        .eq('mission_id', req.params.id).order('obtained_at', { ascending: false });
      if (error) return res.status(400).json({ error: error.message });
      return res.set('Cache-Control', 'no-store').json({ consents: data || [] });
    } catch (err) { return next(err); }
  });

  app.post('/api/missions/:id/consents', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!CONSENT_CHANNELS.has(b.channel) || !CONSENT_BASES.has(b.basis)) return res.status(400).json({ error: 'Choose a channel and a legal basis' });
      const evidence = String(b.evidence || '').trim();
      if (evidence.length < 5) return res.status(400).json({ error: 'Describe how and when consent was given' });
      const row = { company_id: companyId, mission_id: req.params.id, channel: b.channel, basis: b.basis,
        evidence: evidence.slice(0, 2000), source: CONSENT_SOURCES.has(b.source) ? b.source : 'call' };
      const { error } = await req.session.db.from('contact_consents').insert(row);
      if (error) return res.status(403).json({ error: error.message });
      return res.status(201).json({ ok: true });
    } catch (err) { return next(err); }
  });

  app.post('/api/consents/:id/withdraw', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const note = String(req.body?.note || 'Withdrawn').slice(0, 500);
      const { data, error } = await req.session.db.from('contact_consents')
        .update({ withdrawn_at: new Date().toISOString(), withdrawal_note: note }).eq('id', req.params.id).select('id').maybeSingle();
      if (error) return res.status(403).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Consent not found' });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  // ---- team console data ----------------------------------------------------------------
  function requireTeam(req, res, next) {
    if (req.member.role === 'partner') return res.status(403).json({ error: 'Team only' });
    return next();
  }

  app.get('/api/team/partners', requireMember, requireTeam, async (req, res, next) => {
    try {
      const db = req.session.db;
      const [agents, perms] = await Promise.all([
        db.from('sales_agents').select('id, full_name, email, status, role').eq('company_id', companyId).order('full_name'),
        db.from('partner_permissions').select('agent_id, can_call, can_sms').eq('company_id', companyId),
      ]);
      if (agents.error) return res.status(400).json({ error: agents.error.message });
      const byAgent = new Map((perms.data || []).map((p) => [p.agent_id, p]));
      const partners = (agents.data || [])
        .filter((a) => !INACTIVE_AGENT.has(String(a.status || '').toLowerCase()))
        .map((a) => ({ id: a.id, name: a.full_name || a.email, role: a.role, can_call: !!byAgent.get(a.id)?.can_call, can_sms: !!byAgent.get(a.id)?.can_sms }));
      return res.set('Cache-Control', 'no-store').json({ partners });
    } catch (err) { return next(err); }
  });

  app.get('/api/activity', requireMember, async (req, res, next) => {
    try {
      const db = req.session.db;
      let q = db.from('partner_activity_log')
        .select('id, mission_id, actor_user, actor_agent_id, action, outcome, from_value, to_value, notes, consent_ok, created_at')
        .eq('company_id', companyId).order('created_at', { ascending: false }).limit(200);
      if (req.query.mission_id) q = q.eq('mission_id', String(req.query.mission_id));
      const { data, error } = await q;
      if (error) return res.status(400).json({ error: error.message });
      // Names: team sees partner names; partners see their own name and "NexAIS team" for others.
      const names = new Map();
      if (req.member.role !== 'partner') {
        const { data: agents } = await db.from('sales_agents').select('id, full_name, auth_user_id, user_id').eq('company_id', companyId);
        (agents || []).forEach((a) => { if (a.auth_user_id) names.set(a.auth_user_id, a.full_name); if (a.user_id) names.set(a.user_id, a.full_name); });
      }
      names.set(req.session.user.id, req.member.name);
      const rows = (data || []).map((r) => ({ ...r, actor_name: names.get(r.actor_user) || (r.actor_user ? 'NexAIS team' : 'System') }));
      return res.set('Cache-Control', 'no-store').json({ activity: rows });
    } catch (err) { return next(err); }
  });

  // The hub's in-page call log mirrors each new entry here.
  app.post('/api/hub/activity', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const mapped = mapHubEntry(req.body);
      if (mapped.error) return res.status(400).json({ error: mapped.error });
      const db = req.session.db;
      const prefix = dedupePrefix(mapped.business);
      const { data: found, error: findErr } = await db.from('partner_missions')
        .select('id, status').eq('company_id', companyId).like('dedupe_key', `${prefix}|%`)
        .not('status', 'in', '(won,lost,closed,rejected)').limit(1);
      if (findErr) return res.status(400).json({ error: findErr.message });
      let missionId = found?.[0]?.id;
      if (!missionId) {
        if (req.member.role === 'partner') return res.status(404).json({ error: 'No mission of yours matches this business' });
        const { data: created, error: createErr } = await db.from('partner_missions')
          .insert({ company_id: companyId, origin: 'system_initiated', status: 'approved', business_name: mapped.business })
          .select('id').single();
        if (createErr) return res.status(400).json({ error: createErr.message });
        missionId = created.id;
      }
      const { error } = await db.from('partner_activity_log').insert({ company_id: companyId, mission_id: missionId, ...mapped.row });
      if (error) return res.status(403).json({ error: error.message });
      return res.status(201).json({ ok: true, mission_id: missionId });
    } catch (err) { return next(err); }
  });

  // ---- shared business list for the hub (team and admin only) ------------------------
  const HUB_OPEN = '(won,lost,closed,rejected)';
  // Partners use the hub too; the CRM's row-level security limits them to their own missions.
  function requireTeam2(req, res, next) { return next(); }
  // Every open mission plus the latest logged call outcome on each, so every device shows the same list.
  app.get('/api/hub/state', requireMember, requireTeam2, async (req, res, next) => {
    try {
      const db = req.session.db;
      const { data: missions, error } = await db.from('partner_missions')
        .select('id, mission_code, origin, status, business_name, city, vertical, website, public_phone, partner_summary, proposal_link, created_at')
        .eq('company_id', companyId).not('status', 'in', HUB_OPEN).order('created_at', { ascending: true }).limit(1000);
      if (error) return res.status(400).json({ error: error.message });
      const { data: acts, error: actErr } = await db.from('partner_activity_log')
        .select('mission_id, outcome, created_at').eq('company_id', companyId).not('outcome', 'is', null)
        .order('created_at', { ascending: false }).limit(2000);
      if (actErr) return res.status(400).json({ error: actErr.message });
      const latest = {};
      for (const a of acts || []) if (a.mission_id && !latest[a.mission_id]) latest[a.mission_id] = { outcome: a.outcome, at: a.created_at };
      const rows = (missions || []).map((m) => ({ ...m, last_outcome: latest[m.id]?.outcome || null, last_outcome_at: latest[m.id]?.at || null }));
      return res.set('Cache-Control', 'no-store').json({ missions: rows });
    } catch (err) { return next(err); }
  });

  // A business added in the hub becomes a mission in research, shared with the whole team.
  app.post('/api/hub/business', requireMember, requireTeam2, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const cut = (v, n) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));
      const name = cut(b.name, 200);
      if (!name) return res.status(400).json({ error: 'Business name is required' });
      const summary = [b.contact ? `Contact: ${b.contact}` : '', b.note ? `Signal: ${b.note}` : ''].filter(Boolean).join('\n');
      const partner = req.member.role === 'partner';
      // A partner registers a request (the CRM fills in who asked); the team can file it straight into research.
      const row = {
        company_id: companyId, origin: partner ? 'partner_initiated' : 'system_initiated', status: partner ? 'requested' : 'researching',
        business_name: name, city: cut(b.city, 100), vertical: cut(b.industry, 100), website: cut(b.website, 300), public_phone: cut(b.phone, 40),
        partner_summary: !partner && summary ? summary.slice(0, 4000) : null,
      };
      const { data, error } = await req.session.db.from('partner_missions').insert(row).select('id, mission_code, status').single();
      if (error) {
        const duplicate = /duplicate key|dedupe/i.test(error.message || '');
        return res.status(duplicate ? 409 : 400).json({ error: duplicate ? 'This business already has an open mission' : error.message });
      }
      await req.session.db.from('partner_activity_log').insert({ company_id: companyId, mission_id: data.id, action: 'note',
        notes: `Business added in the hub${b.at ? ` (logged on device ${cut(b.at, 40)})` : ''}${partner && summary ? `\n${summary.slice(0, 3500)}` : ''}` });
      return res.status(201).json({ mission: data });
    } catch (err) { return next(err); }
  });

  // Removing a business in the hub closes its mission (the history stays in the CRM).
  app.post('/api/hub/business/close', requireMember, requireTeam2, sameOrigin, async (req, res, next) => {
    try {
      const prefix = dedupePrefix(req.body?.name);
      if (!prefix) return res.status(400).json({ error: 'Business name is required' });
      const db = req.session.db;
      const { data: found, error } = await db.from('partner_missions').select('id, origin')
        .eq('company_id', companyId).like('dedupe_key', `${prefix}|%`).not('status', 'in', HUB_OPEN).limit(1);
      if (error) return res.status(400).json({ error: error.message });
      const m = found?.[0];
      if (!m) return res.status(404).json({ error: 'No open mission for this business' });
      if (req.member.role === 'partner') return res.status(403).json({ error: 'Ask the NexAIS team to close a business' });
      const { error: upErr } = await db.from('partner_missions').update({ status: 'closed' }).eq('id', m.id).select('id').maybeSingle();
      if (upErr) return res.status(403).json({ error: upErr.message });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  // ---- calls & SMS from the company's own AVA line (checks run in the CRM: partner_* functions) ----
  async function missionFor(req, name) {
    const prefix = dedupePrefix(name);
    if (!prefix) return { error: 'Business name is required', status: 400 };
    const db = req.session.db;
    const { data: found, error } = await db.from('partner_missions').select('id')
      .eq('company_id', companyId).like('dedupe_key', `${prefix}|%`).not('status', 'in', HUB_OPEN).limit(1);
    if (error) return { error: error.message, status: 400 };
    if (found?.[0]?.id) return { id: found[0].id };
    if (req.member.role === 'partner') return { error: 'This business is not on your list yet', status: 404 };
    const { data: created, error: cErr } = await db.from('partner_missions')
      .insert({ company_id: companyId, origin: 'system_initiated', status: 'approved', business_name: String(name).trim().slice(0, 200) }).select('id').single();
    if (cErr) return { error: cErr.message, status: 400 };
    return { id: created.id };
  }
  const dbError = (res, error) => res.status(/42501/.test(error.code || '') ? 403 : 400).json({ error: String(error.message || 'Refused').slice(0, 200) });

  app.post('/api/sms/send', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const m = await missionFor(req, b.business);
      if (m.error) return res.status(m.status).json({ error: m.error });
      const { data, error } = await req.session.db.rpc('partner_send_sms', { p_mission: m.id, p_to: String(b.to || ''), p_body: String(b.body || ''), p_consent: b.consent === true });
      if (error) return dbError(res, error);
      return res.status(201).json({ sms: data });
    } catch (err) { return next(err); }
  });
  app.get('/api/sms/thread', requireMember, async (req, res, next) => {
    try {
      const m = await missionFor(req, req.query.business);
      if (m.error) return res.status(m.status).json({ error: m.error });
      const { data, error } = await req.session.db.rpc('partner_sms_thread', { p_mission: m.id, p_to: String(req.query.to || '') });
      if (error) return dbError(res, error);
      return res.set('Cache-Control', 'no-store').json({ messages: data || [] });
    } catch (err) { return next(err); }
  });
  app.get('/api/me/phone', requireMember, async (req, res, next) => {
    try {
      const { data } = await req.session.db.from('partner_user_phones').select('phone').maybeSingle();
      return res.set('Cache-Control', 'no-store').json({ phone: data?.phone || null });
    } catch (err) { return next(err); }
  });
  app.put('/api/me/phone', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const { data, error } = await req.session.db.rpc('partner_set_my_phone', { p_phone: String(req.body?.phone || '') });
      if (error) return dbError(res, error);
      return res.json({ phone: data });
    } catch (err) { return next(err); }
  });
  app.post('/api/calls/start', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const m = await missionFor(req, b.business);
      if (m.error) return res.status(m.status).json({ error: m.error });
      const { data, error } = await req.session.db.rpc('partner_start_call', { p_mission: m.id, p_to: String(b.to || '') });
      if (error) return dbError(res, error);
      return res.status(201).json({ call: data });
    } catch (err) { return next(err); }
  });
  app.get('/api/calls/:id', requireMember, async (req, res, next) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const { data, error } = await req.session.db.from('partner_click_calls')
        .select('id, status, error, duration_sec, created_at, answered_at, ended_at').eq('id', req.params.id).maybeSingle();
      if (error) return dbError(res, error);
      if (!data) return res.status(404).json({ error: 'Not found' });
      return res.set('Cache-Control', 'no-store').json({ call: data });
    } catch (err) { return next(err); }
  });

  // ---- AVA follow-up calls (consent required; the owner's on/off switch lives in the CRM) ----
  // ---- find the weak spot / hook for a business (CRM notes → Google Maps → AVA) ----
  const hookCache = new Map();   // key -> { at, result }
  const hookUse = new Map();     // user -> [timestamps]
  app.post('/api/hub/hook', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const name = String(b.business || '').trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'Business name is required' });
      const city = String(b.city || '').trim().slice(0, 100);
      const key = `${dedupePrefix(name)}|${city.toLowerCase()}`;
      const cached = hookCache.get(key);
      if (cached && now() - cached.at < 24 * 3600 * 1000 && !b.refresh) return res.json({ ...cached.result, cached: true });
      const uid = req.session.user.id;
      const recent = (hookUse.get(uid) || []).filter((t) => now() - t < 3600 * 1000);
      if (recent.length >= 20) return res.status(429).json({ error: 'Limit reached: 20 searches per hour' });
      hookUse.set(uid, [...recent, now()]);
      const db = req.session.db;
      const prefix = dedupePrefix(name);
      const { data: found } = await db.from('partner_missions').select('id, partner_summary, city')
        .eq('company_id', companyId).like('dedupe_key', `${prefix}|%`).not('status', 'in', HUB_OPEN).limit(1);
      const mission = found?.[0] || null;
      let crmNotes = [String(b.notes || '').slice(0, 2000), mission?.partner_summary || ''].filter(Boolean).join('\n');
      if (mission) {
        const { data: research } = await db.from('partner_activity_log').select('notes').eq('mission_id', mission.id)
          .eq('action', 'research_attached').order('created_at', { ascending: false }).limit(3);
        crmNotes = [crmNotes, ...(research || []).map((r) => r.notes || '')].filter(Boolean).join('\n').slice(0, 4000);
      }
      let result;
      try { result = await findHook({ bizName: name, city: city || mission?.city || '', crmNotes, env }); }
      catch (e) { return res.status(502).json({ error: String(e.message || 'Search failed').slice(0, 200) }); }
      hookCache.set(key, { at: now(), result });
      if (mission && result.hook) {
        const notes = [`Weak spot / hook (${result.by === 'ava' ? 'AVA' : 'rules'}, ${result.confidence}): ${result.hook}`,
          ...result.evidence.map((e) => `- ${e.source}: ${e.detail}`), result.opening ? `Opening: ${result.opening}` : ''].filter(Boolean).join('\n').slice(0, 4000);
        await db.from('partner_activity_log').insert({ company_id: companyId, mission_id: mission.id, action: 'research_attached', notes });
      }
      return res.json(result);
    } catch (err) { return next(err); }
  });

  // ---- one business's history: everything logged in the CRM (calls, SMS, email, AVA calls, notes) ----
  app.get('/api/hub/history', requireMember, async (req, res, next) => {
    try {
      const prefix = dedupePrefix(req.query.business);
      if (!prefix) return res.status(400).json({ error: 'Business name is required' });
      const db = req.session.db;
      const { data: found, error } = await db.from('partner_missions').select('id')
        .eq('company_id', companyId).like('dedupe_key', `${prefix}|%`).not('status', 'in', HUB_OPEN).limit(1);
      if (error) return res.status(400).json({ error: error.message });
      const id = found?.[0]?.id;
      if (!id) return res.set('Cache-Control', 'no-store').json({ items: [] });
      const [acts, calls] = await Promise.all([
        db.from('partner_activity_log').select('id, action, outcome, from_value, to_value, notes, actor_user, created_at')
          .eq('mission_id', id).order('created_at', { ascending: false }).limit(150),
        db.from('partner_click_calls').select('id, status, to_number, duration_sec, user_id, created_at')
          .eq('mission_id', id).order('created_at', { ascending: false }).limit(50),
      ]);
      if (acts.error) return res.status(400).json({ error: acts.error.message });
      const ids = [...new Set([...(acts.data || []).map((a) => a.actor_user), ...(calls.data || []).map((c) => c.user_id)].filter(Boolean))];
      const names = {};
      if (ids.length) {
        const { data: users } = await db.from('users').select('id, full_name, email').in('id', ids);
        for (const u of users || []) names[u.id] = u.full_name || String(u.email || '').split('@')[0];
      }
      const me = req.session.user.id;
      const who = (uid) => (uid === me ? 'me' : names[uid] || (uid ? 'team' : 'system'));
      const items = [
        ...(acts.data || []).map((a) => ({ kind: a.action, outcome: a.outcome, from: a.from_value, to: a.to_value, notes: a.notes, by: who(a.actor_user), at: a.created_at })),
        ...(calls.error ? [] : (calls.data || []).map((c) => ({ kind: 'line_call', status: c.status, to: c.to_number, duration: c.duration_sec, by: who(c.user_id), at: c.created_at }))),
      ].sort((x, y) => String(y.at).localeCompare(String(x.at)));
      return res.set('Cache-Control', 'no-store').json({ items });
    } catch (err) { return next(err); }
  });

  // ---- email from the NexAIS address (owner's switch; per-person can_email) ----
  app.get('/api/email/switch', requireMember, async (req, res, next) => {
    try {
      const { data, error } = await req.session.db.rpc('partner_email_enabled');
      if (error) return dbError(res, error);
      return res.set('Cache-Control', 'no-store').json({ enabled: data === true, can_toggle: req.member.role === 'admin' });
    } catch (err) { return next(err); }
  });
  app.put('/api/email/switch', requireMember, sameOrigin, async (req, res, next) => {
    try {
      if (req.member.role !== 'admin') return res.status(403).json({ error: 'Only the owner can turn email on or off' });
      const { data, error } = await req.session.db.rpc('partner_set_email_enabled', { p_on: req.body?.enabled === true });
      if (error) return dbError(res, error);
      return res.json({ enabled: data === true });
    } catch (err) { return next(err); }
  });
  app.post('/api/email/send', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const m = await missionFor(req, b.business);
      if (m.error) return res.status(m.status).json({ error: m.error });
      const { data, error } = await req.session.db.rpc('partner_send_email', {
        p_mission: m.id, p_to: String(b.to || ''), p_subject: String(b.subject || ''), p_body: String(b.body || ''), p_basis: String(b.basis || ''),
      });
      if (error) return dbError(res, error);
      return res.status(201).json({ email: data });
    } catch (err) { return next(err); }
  });
  app.get('/api/email/list', requireMember, async (req, res, next) => {
    try {
      const m = await missionFor(req, req.query.business);
      if (m.error) return res.status(m.status).json({ error: m.error });
      const { data, error } = await req.session.db.rpc('partner_email_list', { p_mission: m.id });
      if (error) return dbError(res, error);
      return res.set('Cache-Control', 'no-store').json({ emails: data || [] });
    } catch (err) { return next(err); }
  });

  app.get('/api/ava/switch', requireMember, async (req, res, next) => {
    try {
      const { data, error } = await req.session.db.rpc('partner_ava_enabled');
      if (error) return dbError(res, error);
      return res.set('Cache-Control', 'no-store').json({ enabled: data === true, can_toggle: req.member.role === 'admin' });
    } catch (err) { return next(err); }
  });
  app.put('/api/ava/switch', requireMember, sameOrigin, async (req, res, next) => {
    try {
      if (req.member.role !== 'admin') return res.status(403).json({ error: 'Only the owner can turn AVA calls on or off' });
      const { data, error } = await req.session.db.rpc('partner_set_ava_enabled', { p_on: req.body?.enabled === true });
      if (error) return dbError(res, error);
      return res.json({ enabled: data === true });
    } catch (err) { return next(err); }
  });
  app.get('/api/ava/overview', requireMember, async (req, res, next) => {
    try {
      const m = await missionFor(req, req.query.business);
      if (m.error) return res.status(m.status).json({ error: m.error });
      const { data, error } = await req.session.db.rpc('partner_ava_overview', { p_mission: m.id });
      if (error) return dbError(res, error);
      return res.set('Cache-Control', 'no-store').json(data || {});
    } catch (err) { return next(err); }
  });
  app.post('/api/ava/consent', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const m = await missionFor(req, b.business);
      if (m.error) return res.status(m.status).json({ error: m.error });
      const { data, error } = await req.session.db.rpc('partner_record_ava_consent', {
        p_mission: m.id, p_phone: String(b.phone || ''), p_person: String(b.person || ''), p_method: String(b.method || ''),
        p_given_at: b.given_at || null, p_note: String(b.note || '') });
      if (error) return dbError(res, error);
      return res.status(201).json({ id: data });
    } catch (err) { return next(err); }
  });
  app.post('/api/ava/call', requireMember, sameOrigin, async (req, res, next) => {
    try {
      const b = req.body || {};
      const m = await missionFor(req, b.business);
      if (m.error) return res.status(m.status).json({ error: m.error });
      const { data, error } = await req.session.db.rpc('partner_request_ava_call', {
        p_mission: m.id, p_phone: String(b.phone || ''), p_purpose: String(b.purpose || ''), p_note: String(b.note || ''),
        p_when: b.when || null, p_language: String(b.language || 'en') });
      if (error) return dbError(res, error);
      return res.status(201).json({ call: data });
    } catch (err) { return next(err); }
  });
  app.post('/api/ava/takeover/:id', requireMember, sameOrigin, async (req, res, next) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
      const { data, error } = await req.session.db.rpc('partner_ava_takeover', { p_call: req.params.id });
      if (error) return dbError(res, error);
      return res.json(data || { ok: true });
    } catch (err) { return next(err); }
  });

  // My earnings: commissions the CRM lets this person see (a partner sees only their own).
  app.get('/api/me/earnings', requireMember, async (req, res, next) => {
    try {
      const { data, error } = await req.session.db.from('commissions')
        .select('id, sale_amount, commission_percent, commission_amount, total_commission_amount, month_number, status, commission_type, earned_at, paid_at, created_at, notes, sales_agent_id, agent_id')
        .order('created_at', { ascending: false }).limit(500);
      if (error) return res.status(400).json({ error: error.message });
      const rows = (data || []).map((c) => ({
        amount: Number(c.total_commission_amount ?? c.commission_amount ?? 0), sale: c.sale_amount == null ? null : Number(c.sale_amount),
        percent: c.commission_percent == null ? null : Number(c.commission_percent), month: c.month_number, status: c.status,
        type: c.commission_type, earned_at: c.earned_at || c.created_at, paid_at: c.paid_at, note: c.notes ? String(c.notes).slice(0, 200) : '',
      }));
      return res.set('Cache-Control', 'no-store').json({ scope: req.member.role === 'partner' ? 'mine' : 'all', rows });
    } catch (err) { return next(err); }
  });

  // The standalone pricing calculator stays public, as on the static site.
  // Public unsubscribe page linked from every email (CASL). GET shows a confirm button; POST unsubscribes
  // (also the RFC 8058 one-click POST from mail apps).
  const UNSUB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const unsubPage = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#fff;color:#18181b;display:flex;min-height:90vh;align-items:center;justify-content:center;margin:0}
main{max-width:440px;padding:32px;border:1px solid #e4e4e7;border-radius:12px}h1{font-size:18px;margin:0 0 8px}p{color:#52525b;line-height:1.5;margin:0 0 14px}
button{background:#18181b;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer}</style></head><body><main>${inner}</main></body></html>`;
  const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function unsubscribe(req, res, confirm) {
    const token = String(req.query.u || '');
    const bad = () => res.status(400).type('html').send(unsubPage('Unsubscribe', '<h1>Link not valid</h1><p>Email info@nexais.ca and we will remove you.</p>'));
    if (!UNSUB_RE.test(token)) return bad();
    const { data, error } = await makeClient().rpc('partner_email_unsubscribe', { p_token: token, p_confirm: confirm });
    if (error || !data) return bad();
    res.set('Cache-Control', 'no-store');
    if (!confirm) {
      return res.type('html').send(unsubPage('Unsubscribe', `<h1>Unsubscribe ${escHtml(data)}?</h1><p>NexAIS will not email this address again.</p>
<form method="post" action="/unsubscribe?u=${token}"><button type="submit">Unsubscribe</button></form>`));
    }
    return res.type('html').send(unsubPage('Unsubscribed', `<h1>You are unsubscribed</h1><p>${escHtml(data)} will not receive emails from NexAIS again.</p>`));
  }
  app.get('/unsubscribe', (req, res, next) => unsubscribe(req, res, false).catch(next));
  app.post('/unsubscribe', (req, res, next) => unsubscribe(req, res, true).catch(next));

  app.get('/calculator.html', (req, res) => res.type('html').sendFile(path.join(here, '..', 'calculator.html')));

  // ---- the hub itself (members only) ------------------------------------------------
  let hubHtml = null;
  function hub() {
    if (hubHtml === null) hubHtml = readFileSync(hubHtmlPath, 'utf8');
    return hubHtml;
  }
  function bootScript(req) {
    return `<script>window.NEXAIS_SESSION=${escapeJsonForHtml({ name: req.member.name, role: req.member.role })};</script>`;
  }
  app.get('/team', requireMember, (req, res) => {
    if (req.member.role === 'partner') return res.redirect(302, '/my');
    return res.type('html').set('Cache-Control', 'no-store').send(page('team.html').replace('<!--BOOT-->', bootScript(req)));
  });
  app.get('/my', requireMember, (req, res) => {
    res.type('html').set('Cache-Control', 'no-store').send(page('my.html').replace('<!--BOOT-->', bootScript(req)));
  });
  app.get('/app/console.css', (req, res) => res.type('css').send(page('console.css')));
  app.get('/app/console-common.js', (req, res) => res.type('application/javascript').send(page('console-common.js')));

  // The hub holds the team's full prospect list, so partners get their own console instead.
  // Partners get the same hub, but the prospect cards are cut down to their own missions on the server,
  // so no other business's contacts ever reach their browser.
  app.get(['/', '/index.html'], requireMember, async (req, res, next) => {
    try {
      const boot = `<script>window.NEXAIS_SESSION=${escapeJsonForHtml({ name: req.member.name, role: req.member.role })};</script>`
        + '<script src="/app/hub-bridge.js"></script>';
      let html = hub();
      if (req.member.role === 'partner') {
        const { data, error } = await req.session.db.from('partner_missions').select('business_name')
          .eq('company_id', companyId).not('status', 'in', HUB_OPEN).limit(1000);
        if (error) return res.status(503).type('text').send('The CRM is not reachable right now — please try again.');
        html = keepOnlyCards(html, new Set((data || []).map((m) => dedupePrefix(m.business_name)).filter(Boolean)));
      }
      html = html.replace(/<head>/i, (m) => `${m}\n${boot}`);
      return res.type('html').set('Cache-Control', 'no-store').send(html);
    } catch (err) { return next(err); }
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[partners] error', err?.message || err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
