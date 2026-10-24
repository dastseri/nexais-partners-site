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

  // ---- the hub itself (members only) ------------------------------------------------
  let hubHtml = null;
  function hub() {
    if (hubHtml === null) hubHtml = readFileSync(hubHtmlPath, 'utf8');
    return hubHtml;
  }
  app.get(['/', '/index.html'], requireMember, (req, res) => {
    const boot = `<script>window.NEXAIS_SESSION=${escapeJsonForHtml({ name: req.member.name, role: req.member.role })};</script>`
      + '<script src="/app/hub-bridge.js"></script>';
    const html = hub().replace(/<head>/i, (m) => `${m}\n${boot}`);
    res.type('html').set('Cache-Control', 'no-store').send(html);
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[partners] error', err?.message || err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
