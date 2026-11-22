import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { mapHubEntry } from '../server/hubActivity.js';

const ORIGIN = 'https://partner.nexais.ca';
const COMPANY = 'company-nexais';
const hubDir = mkdtempSync(path.join(tmpdir(), 'hub-'));
const hubHtmlPath = path.join(hubDir, 'index.html');
writeFileSync(hubHtmlPath, '<!doctype html><html><head><title>Hub</title></head><body>HUB-PAGE<div id="cards">'
  + '<article class="card" data-group="1" data-name="copper creek golf club"><h4>Copper Creek Golf Club</h4><dd>MY-CONTACT</dd></article>\n'
  + '<article class="card" data-group="2" data-name="sassafraz"><h4>Sassafraz</h4><dd>SECRET-PROSPECT-LIST</dd></article>\n'
  + '</div></body></html>');

// ---- fake Supabase -----------------------------------------------------------------
const USERS = {
  'tok-partner': { id: 'u-partner', email: 'p@x.ca', user_metadata: { full_name: 'Pat Partner' }, kind: 'partner' },
  'tok-team': { id: 'u-team', email: 't@x.ca', user_metadata: { full_name: 'Tess Team' }, kind: 'team' },
  'tok-admin': { id: 'u-admin', email: 'a@x.ca', user_metadata: { full_name: 'Ada Admin' }, kind: 'admin' },
  'tok-outsider': { id: 'u-out', email: 'o@x.ca', user_metadata: {}, kind: 'outsider' },
  'tok-xss': { id: 'u-xss', email: 'x@x.ca', user_metadata: { full_name: '</script><script>alert(1)</script>' }, kind: 'partner' },
};
const PASSWORDS = { 'p@x.ca': ['pw-partner', 'tok-partner'], 'o@x.ca': ['pw-out', 'tok-outsider'] };

const UNSUB_OK = '11111111-2222-3333-4444-555555555555';
function makeFake(state) {
  return function makeClient(token) {
    const user = token ? USERS[token] : null;
    function query(table) {
      const q = { table, ops: [], payload: null, op: 'select' };
      const chain = {
        select() { return chain; }, eq(k, v) { q.ops.push(['eq', k, v]); return chain; }, or() { return chain; },
        like(k, v) { q.ops.push(['like', k, v]); return chain; }, not() { return chain; }, order() { return chain; }, limit() { return chain; },
        insert(p) { q.op = 'insert'; q.payload = p; return chain; }, update(p) { q.op = 'update'; q.payload = p; return chain; },
        upsert(p) { q.op = 'upsert'; q.payload = p; return chain; },
        single() { return resolve(true); }, maybeSingle() { return resolve(true); },
        then(ok, bad) { return resolve(false).then(ok, bad); },
      };
      function resolve(single) {
        state.calls.push({ table, op: q.op, payload: q.payload, ops: q.ops, user: user?.id });
        if (table === 'sales_agents') {
          const rows = user && (user.kind === 'partner') ? [{ id: `agent-${user.id}`, full_name: user.user_metadata.full_name, company_id: COMPANY, status: 'approved' }] : [];
          return Promise.resolve({ data: rows, error: null });
        }
        if (table === 'partner_missions' && q.op === 'select') return Promise.resolve({ data: state.missions, error: null });
        if (table === 'partner_missions' && q.op === 'insert') {
          const m = { id: `m-${state.calls.length}`, mission_code: 'M-0001', status: q.payload.status || 'requested' };
          return Promise.resolve({ data: single ? m : [m], error: null });
        }
        if (table === 'partner_activity_log' && q.op === 'insert') return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: single ? null : [], error: null });
      }
      return chain;
    }
    return {
      auth: {
        async getUser(t) { const u = USERS[t]; return u && !state.expired.has(t) ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'bad' } }; },
        async refreshSession({ refresh_token }) {
          if (refresh_token === 'rt-good') return { data: { session: { access_token: 'tok-partner', refresh_token: 'rt-new' }, user: USERS['tok-partner'] }, error: null };
          return { data: {}, error: { message: 'bad' } };
        },
        async signInWithPassword({ email, password }) {
          const rec = PASSWORDS[email];
          if (!rec || rec[0] !== password) return { data: {}, error: { message: 'Invalid login' } };
          return { data: { session: { access_token: rec[1], refresh_token: `rt-${rec[1]}` }, user: USERS[rec[1]] }, error: null };
        },
        async resetPasswordForEmail(email) { state.resets.push(email); return { data: {}, error: null }; },
      },
      async rpc(name, args) {
        state.calls.push({ rpc: name, args, user: user?.id });
        if (name === 'partner_email_unsubscribe') return { data: args.p_token === UNSUB_OK ? 'owner@bistro.ca' : null, error: null };
        if (name === 'nexais_rls_is_platform_admin') return { data: user?.kind === 'admin', error: null };
        if (name === 'nexais_partner_is_manager_of') return { data: user?.kind === 'team' || user?.kind === 'admin', error: null };
        return { data: null, error: null };
      },
      from: query,
    };
  };
}

async function withServer(fn, opts = {}) {
  const state = { calls: [], missions: [], expired: new Set(), resets: [] };
  const app = createApp({ makeClient: makeFake(state), companyId: COMPANY, publicOrigin: ORIGIN, hubHtmlPath, loginLimit: { max: 5, windowMs: 60000 }, updatePassword: async (t) => ({ ok: t === 'recovery-ok' }), ...opts });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, state); } finally { server.close(); }
}
const json = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
const getAs = (base, p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

test('anonymous visitor gets the login page and no hub data', () => withServer(async (base) => {
  const r = await getAs(base, '/');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/login');
  const r2 = await getAs(base, '/index.html'); assert.equal(r2.status, 302);
  const login = await getAs(base, '/login'); const body = await login.text();
  assert.equal(login.status, 200); assert.match(body, /sign in/i); assert.doesNotMatch(body, /SECRET-PROSPECT-LIST/);
  assert.equal((await getAs(base, '/api/missions')).status, 401);
  assert.equal(login.headers.get('x-frame-options'), 'DENY');
}));

test('no raw file serving (source, git, package files)', () => withServer(async (base) => {
  for (const p of ['/server/app.js', '/.git/config', '/package.json', '/.env']) assert.equal((await getAs(base, p)).status, 404, p);
}));

test('login: origin and JSON required, wrong password refused, non-member refused', () => withServer(async (base) => {
  const cross = await json(base, '/api/auth/login', { email: 'p@x.ca', password: 'pw-partner' }, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const form = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(form.status, 415);
  assert.equal((await json(base, '/api/auth/login', { email: 'p@x.ca', password: 'nope' })).status, 401);
  const outsider = await json(base, '/api/auth/login', { email: 'o@x.ca', password: 'pw-out' });
  assert.equal(outsider.status, 403); assert.equal(outsider.headers.get('set-cookie'), null);
}));

test('login success sets HttpOnly Secure SameSite cookies and opens the hub', () => withServer(async (base) => {
  const r = await json(base, '/api/auth/login', { email: 'p@x.ca', password: 'pw-partner' });
  assert.equal(r.status, 200);
  const cookies = r.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith('nx_at=tok-partner') && /HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Lax/.test(c)));
  const my = await getAs(base, '/my', 'nx_at=tok-partner');
  const html = await my.text();
  assert.equal(my.status, 200); assert.doesNotMatch(html, /SECRET-PROSPECT-LIST/);
  assert.match(html, /window\.NEXAIS_SESSION=\{"name":"Pat Partner","role":"partner"\}/);
  assert.equal(my.headers.get('cache-control'), 'no-store');
  const hub = await getAs(base, '/', 'nx_at=tok-admin'); const hubHtml = await hub.text();
  assert.match(hubHtml, /SECRET-PROSPECT-LIST/); assert.match(hubHtml, /\/app\/hub-bridge\.js/);
}));

test('partners get the hub with only their own businesses; never other prospects or the team console', () => withServer(async (base, state) => {
  state.missions = [{ business_name: 'Copper Creek Golf Club' }];
  const r = await getAs(base, '/', 'nx_at=tok-partner'); const html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /HUB-PAGE/); assert.match(html, /MY-CONTACT/);
  assert.doesNotMatch(html, /SECRET-PROSPECT-LIST/); assert.match(html, /"role":"partner"/);
  const team = await getAs(base, '/team', 'nx_at=tok-partner'); assert.equal(team.status, 302); assert.equal(team.headers.get('location'), '/my');
  assert.equal((await getAs(base, '/api/team/partners', 'nx_at=tok-partner')).status, 403);
  const teamHub = await (await getAs(base, '/', 'nx_at=tok-team')).text();
  assert.match(teamHub, /SECRET-PROSPECT-LIST/);
}));

test('team gets the hub and the team console', () => withServer(async (base) => {
  const hub = await getAs(base, '/', 'nx_at=tok-team'); assert.equal(hub.status, 200); assert.match(await hub.text(), /SECRET-PROSPECT-LIST/);
  const team = await getAs(base, '/team', 'nx_at=tok-team'); assert.equal(team.status, 200); assert.match(await team.text(), /Team console/);
  assert.equal((await getAs(base, '/api/team/partners', 'nx_at=tok-team')).status, 200);
  assert.equal((await getAs(base, '/app/console-common.js')).status, 200);
}));

test('signed-in non-member sees no-access page, never the hub', () => withServer(async (base) => {
  const r = await getAs(base, '/', 'nx_at=tok-outsider'); const html = await r.text();
  assert.equal(r.status, 403); assert.doesNotMatch(html, /SECRET-PROSPECT-LIST/); assert.match(html, /No access/);
}));

test('expired access token is refreshed from the refresh cookie', () => withServer(async (base, state) => {
  state.expired.add('tok-partner');
  const r = await getAs(base, '/my', 'nx_at=tok-partner; nx_rt=rt-good');
  // refresh returns the same (fake) token which is still marked expired for getUser, but the refreshed user is used
  assert.equal(r.status, 200);
  assert.ok(r.headers.getSetCookie().some((c) => c.startsWith('nx_rt=rt-new')));
  const bad = await getAs(base, '/', 'nx_at=tok-partner; nx_rt=rt-bad'); assert.equal(bad.status, 302);
}));

test('login attempts are rate limited per IP', () => withServer(async (base) => {
  for (let i = 0; i < 5; i++) await json(base, '/api/auth/login', { email: 'p@x.ca', password: 'nope' });
  assert.equal((await json(base, '/api/auth/login', { email: 'p@x.ca', password: 'pw-partner' })).status, 429);
}));

test('forgot password answers the same for any email; reset needs a valid recovery token', () => withServer(async (base, state) => {
  assert.equal((await json(base, '/api/auth/forgot', { email: 'nobody@x.ca' })).status, 200);
  assert.deepEqual(state.resets, ['nobody@x.ca']);
  assert.equal((await json(base, '/api/auth/reset', { access_token: 'recovery-bad', password: 'long-enough-pw' })).status, 400);
  assert.equal((await json(base, '/api/auth/reset', { access_token: 'recovery-ok', password: 'short' })).status, 400);
  assert.equal((await json(base, '/api/auth/reset', { access_token: 'recovery-ok', password: 'long-enough-pw' })).status, 200);
}));

test('session name is escaped in the page (no script injection)', () => withServer(async (base) => {
  const html = await (await getAs(base, '/my', 'nx_at=tok-xss')).text();
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script\\u003e/);
}));

test('hub activity: partner cannot create missions; team creates one and logs the call', () => withServer(async (base, state) => {
  const entry = { at: '2026-10-24T16:00:00Z', business: 'Steed Logistics', what: 'status', from: 'Not called', to: 'Voicemail left' };
  const p = await json(base, '/api/hub/activity', entry, { Cookie: 'nx_at=tok-partner' });
  assert.equal(p.status, 404);
  const t = await json(base, '/api/hub/activity', entry, { Cookie: 'nx_at=tok-team' });
  assert.equal(t.status, 201);
  const inserts = state.calls.filter((c) => c.op === 'insert');
  assert.deepEqual(inserts.map((c) => c.table), ['partner_missions', 'partner_activity_log']);
  assert.equal(inserts[0].payload.origin, 'system_initiated');
  assert.equal(inserts[1].payload.action, 'call'); assert.equal(inserts[1].payload.outcome, 'voicemail_left');
  assert.ok(inserts.every((c) => c.user === 'u-team'), 'writes run with the signed-in user token');
  assert.equal((await json(base, '/api/hub/activity', { ...entry, to: 'Bogus' }, { Cookie: 'nx_at=tok-team' })).status, 400);
  assert.equal((await json(base, '/api/hub/activity', entry, { Cookie: 'nx_at=tok-team', Origin: 'https://evil.example' })).status, 403);
}));

test('partners cannot change permissions or create system missions', () => withServer(async (base, state) => {
  assert.equal((await fetch(base + '/api/permissions/agent-x', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: 'nx_at=tok-partner' }, body: '{"can_call":true}' })).status, 403);
  const r = await json(base, '/api/missions', { business_name: 'New Co', origin: 'system_initiated' }, { Cookie: 'nx_at=tok-partner' });
  assert.equal(r.status, 201);
  assert.equal(state.calls.find((c) => c.table === 'partner_missions' && c.op === 'insert').payload.origin, 'partner_initiated');
}));

test('hub entry mapping', () => {
  assert.equal(mapHubEntry({ business: 'A', what: 'action', to: 'SMS' }).row.action, 'sms');
  assert.equal(mapHubEntry({ business: 'A', what: 'action', to: 'Email' }).row.action, 'email');
  assert.equal(mapHubEntry({ business: 'A', what: 'notes', to: 'hi' }).row.action, 'note');
  assert.ok(mapHubEntry({ business: '', what: 'notes', to: 'hi' }).error);
  assert.ok(mapHubEntry({ business: 'A', what: 'status', to: 'Won' }).error);
});

test('consent API validates channel, basis and evidence, and writes with the user token', () => withServer(async (base, state) => {
  const H = { Cookie: 'nx_at=tok-partner' };
  assert.equal((await json(base, '/api/missions/m1/consents', { channel: 'fax', basis: 'express', evidence: 'said yes' }, H)).status, 400);
  assert.equal((await json(base, '/api/missions/m1/consents', { channel: 'sms', basis: 'express', evidence: 'ok' }, H)).status, 400);
  const r = await json(base, '/api/missions/m1/consents', { channel: 'sms', basis: 'express', evidence: 'Owner agreed to texts on call', source: 'call' }, H);
  assert.equal(r.status, 201);
  const ins = state.calls.find((c) => c.table === 'contact_consents' && c.op === 'insert');
  assert.equal(ins.payload.mission_id, 'm1'); assert.equal(ins.payload.company_id, COMPANY); assert.equal(ins.user, 'u-partner');
  assert.equal((await json(base, '/api/missions/m1/consents', { channel: 'sms', basis: 'express', evidence: 'Owner agreed' }, { ...H, Origin: 'https://evil.example' })).status, 403);
}));

// ---- shared business list (hub) ---------------------------------------------------------
async function signedIn(base, token) {
  return { cookie: `nx_at=${token}`, origin: ORIGIN };
}
test('hub state: team gets open missions with latest outcome; partners refused', () => withServer(async (base, state) => {
  state.missions = [{ id: 'm1', business_name: 'Maple Freight Lines', status: 'researching', vertical: 'transport' }];
  const team = await fetch(`${base}/api/hub/state`, { headers: { cookie: 'nx_at=tok-team' } });
  assert.equal(team.status, 200);
  const body = await team.json();
  assert.equal(body.missions[0].business_name, 'Maple Freight Lines');
  assert.equal(body.missions[0].last_outcome, null);
  const partner = await fetch(`${base}/api/hub/state`, { headers: { cookie: 'nx_at=tok-partner' } });
  assert.equal(partner.status, 200); // row-level security limits partners to their own missions
}));
test('hub business: team adds a business as a mission in research; origin and JSON enforced', () => withServer(async (base, state) => {
  const h = { cookie: 'nx_at=tok-team', origin: ORIGIN, 'content-type': 'application/json' };
  const ok = await fetch(`${base}/api/hub/business`, { method: 'POST', headers: h,
    body: JSON.stringify({ name: 'Maple Freight Lines', industry: 'transport', city: 'Brampton', phone: '(905) 555-0142', contact: 'Ana — Ops', note: 'Hiring dispatcher' }) });
  assert.equal(ok.status, 201);
  const ins = state.calls.find((c) => c.table === 'partner_missions' && c.op === 'insert');
  assert.equal(ins.payload.status, 'researching');
  assert.equal(ins.payload.origin, 'system_initiated');
  assert.equal(ins.payload.vertical, 'transport');
  assert.match(ins.payload.partner_summary, /Contact: Ana — Ops\nSignal: Hiring dispatcher/);
  assert.ok(state.calls.some((c) => c.table === 'partner_activity_log' && c.op === 'insert'));
  const empty = await fetch(`${base}/api/hub/business`, { method: 'POST', headers: h, body: JSON.stringify({ name: '  ' }) });
  assert.equal(empty.status, 400);
  const cross = await fetch(`${base}/api/hub/business`, { method: 'POST', headers: { ...h, origin: 'https://evil.example' }, body: '{"name":"X"}' });
  assert.equal(cross.status, 403);
  state.calls.length = 0;
  const partner = await fetch(`${base}/api/hub/business`, { method: 'POST', headers: { ...h, cookie: 'nx_at=tok-partner' }, body: JSON.stringify({ name: 'X Co', contact: 'Bo' }) });
  assert.equal(partner.status, 201);
  const pins = state.calls.find((c) => c.table === 'partner_missions' && c.op === 'insert');
  assert.equal(pins.payload.origin, 'partner_initiated'); assert.equal(pins.payload.status, 'requested'); assert.equal(pins.payload.partner_summary, null);
  const close = await fetch(`${base}/api/hub/business/close`, { method: 'POST', headers: { ...h, cookie: 'nx_at=tok-partner' }, body: JSON.stringify({ name: 'X Co' }) });
  assert.notEqual(close.status, 200);
}));
test('research entries map to notes on the mission', () => {
  assert.equal(mapHubEntry({ business: 'Maple', what: 'research', to: 'AVA request' }).row.action, 'note');
  assert.match(mapHubEntry({ business: 'Maple', what: 'research-note', to: 'Phone-only dispatch' }).row.notes, /Research note: Phone-only dispatch/);
  assert.equal(mapHubEntry({ business: 'Maple', what: 'biz-added' }).error, 'Unknown entry type');
});
test('calculator stays public; hub does not', () => withServer(async (base) => {
  const calc = await fetch(`${base}/calculator.html`, { redirect: 'manual' });
  assert.equal(calc.status, 200);
  const hub = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(hub.status, 302);
}));

test('earnings: signed-in members read commissions with their own token', () => withServer(async (base, state) => {
  const r = await fetch(`${base}/api/me/earnings`, { headers: { cookie: 'nx_at=tok-partner' } });
  assert.equal(r.status, 200);
  const body = await r.json(); assert.equal(body.scope, 'mine'); assert.ok(Array.isArray(body.rows));
  assert.ok(state.calls.some((c) => c.table === 'commissions' && c.user === 'u-partner'));
  assert.equal((await fetch(`${base}/api/me/earnings`)).status, 401);
}));

test('calls & SMS: origin enforced; RPCs run with the user token on the business mission', () => withServer(async (base, state) => {
  state.missions = [{ id: 'm-1', business_name: 'Sassafraz' }];
  const h = { cookie: 'nx_at=tok-team', origin: ORIGIN, 'content-type': 'application/json' };
  const cross = await fetch(`${base}/api/sms/send`, { method: 'POST', headers: { ...h, origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
  const anon = await fetch(`${base}/api/calls/start`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401);
  const bad = await fetch(`${base}/api/calls/not-an-id`, { headers: { cookie: 'nx_at=tok-team' } });
  assert.equal(bad.status, 400);
}));

test('AVA calls: only the owner may flip the switch; origin enforced', () => withServer(async (base) => {
  const h = { origin: ORIGIN, 'content-type': 'application/json' };
  const team = await fetch(`${base}/api/ava/switch`, { method: 'PUT', headers: { ...h, cookie: 'nx_at=tok-team' }, body: '{"enabled":true}' });
  assert.equal(team.status, 403);
  const partner = await fetch(`${base}/api/ava/switch`, { method: 'PUT', headers: { ...h, cookie: 'nx_at=tok-partner' }, body: '{"enabled":true}' });
  assert.equal(partner.status, 403);
  const cross = await fetch(`${base}/api/ava/call`, { method: 'POST', headers: { ...h, origin: 'https://evil.example', cookie: 'nx_at=tok-team' }, body: '{}' });
  assert.equal(cross.status, 403);
  const bad = await fetch(`${base}/api/ava/takeover/nope`, { method: 'POST', headers: { ...h, cookie: 'nx_at=tok-team' }, body: '{}' });
  assert.equal(bad.status, 400);
}));

test('email: owner-only switch, origin enforced, partner send reaches the DB check', () => withServer(async (base, state) => {
  const h = { origin: ORIGIN, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/email/switch`, { method: 'PUT', headers: { ...h, cookie: 'nx_at=tok-team' }, body: '{"enabled":true}' })).status, 403);
  assert.equal((await fetch(`${base}/api/email/switch`, { method: 'PUT', headers: { ...h, cookie: 'nx_at=tok-partner' }, body: '{"enabled":true}' })).status, 403);
  const cross = await fetch(`${base}/api/email/send`, { method: 'POST', headers: { ...h, origin: 'https://evil.example', cookie: 'nx_at=tok-team' }, body: '{}' });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(`${base}/api/email/send`, { method: 'POST', headers: h, body: '{}' })).status, 401);
  state.missions = [{ id: 'm-1' }];
  const ok = await fetch(`${base}/api/email/send`, { method: 'POST', headers: { ...h, cookie: 'nx_at=tok-partner' },
    body: JSON.stringify({ business: 'Bistro', to: 'owner@bistro.ca', subject: 'Hi', body: 'Hello', basis: 'published' }) });
  assert.equal(ok.status, 201);
  const call = state.calls.find((c) => c.rpc === 'partner_send_email');
  assert.deepEqual(call.args, { p_mission: 'm-1', p_to: 'owner@bistro.ca', p_subject: 'Hi', p_body: 'Hello', p_basis: 'published' });
}));

test('unsubscribe page is public, confirms on GET and unsubscribes only on POST', () => withServer(async (base, state) => {
  const bad = await fetch(`${base}/unsubscribe?u=not-a-token`);
  assert.equal(bad.status, 400);
  const page = await fetch(`${base}/unsubscribe?u=${UNSUB_OK}`);
  assert.equal(page.status, 200); assert.match(await page.text(), /owner@bistro\.ca/);
  assert.equal(state.calls.find((c) => c.rpc === 'partner_email_unsubscribe').args.p_confirm, false);
  const post = await fetch(`${base}/unsubscribe?u=${UNSUB_OK}`, { method: 'POST' });
  assert.equal(post.status, 200); assert.match(await post.text(), /unsubscribed/i);
  assert.equal(state.calls.filter((c) => c.rpc === 'partner_email_unsubscribe').pop().args.p_confirm, true);
}));
