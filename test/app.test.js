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
writeFileSync(hubHtmlPath, '<!doctype html><html><head><title>Hub</title></head><body>SECRET-PROSPECT-LIST</body></html>');

// ---- fake Supabase -----------------------------------------------------------------
const USERS = {
  'tok-partner': { id: 'u-partner', email: 'p@x.ca', user_metadata: { full_name: 'Pat Partner' }, kind: 'partner' },
  'tok-team': { id: 'u-team', email: 't@x.ca', user_metadata: { full_name: 'Tess Team' }, kind: 'team' },
  'tok-admin': { id: 'u-admin', email: 'a@x.ca', user_metadata: { full_name: 'Ada Admin' }, kind: 'admin' },
  'tok-outsider': { id: 'u-out', email: 'o@x.ca', user_metadata: {}, kind: 'outsider' },
  'tok-xss': { id: 'u-xss', email: 'x@x.ca', user_metadata: { full_name: '</script><script>alert(1)</script>' }, kind: 'partner' },
};
const PASSWORDS = { 'p@x.ca': ['pw-partner', 'tok-partner'], 'o@x.ca': ['pw-out', 'tok-outsider'] };

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
      async rpc(name) {
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

test('partners never receive the hub prospect list; they get their own console', () => withServer(async (base) => {
  const r = await getAs(base, '/', 'nx_at=tok-partner');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/my');
  const my = await getAs(base, '/my', 'nx_at=tok-partner'); const html = await my.text();
  assert.equal(my.status, 200); assert.doesNotMatch(html, /SECRET-PROSPECT-LIST/); assert.match(html, /"role":"partner"/);
  const team = await getAs(base, '/team', 'nx_at=tok-partner'); assert.equal(team.status, 302); assert.equal(team.headers.get('location'), '/my');
  assert.equal((await getAs(base, '/api/team/partners', 'nx_at=tok-partner')).status, 403);
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
