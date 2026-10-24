/* NexAIS partner hub bridge — loaded in <head> by the server before the hub's own scripts.
 * - The server login replaces the old shared-key gate.
 * - Every result is logged under the signed-in person's name (no free-typed names).
 * - Each new call-log entry is mirrored to the CRM (/api/hub/activity). Entries that fail
 *   (offline, server down) wait in a queue on this device and are retried.
 * The hub page itself is not modified; this script only hooks its existing storage keys. */
(function () {
  'use strict';
  var S = window.NEXAIS_SESSION || {};
  var LOG = 'nexais-hub-activity-v1', USER = 'nexais-hub-user-v1';
  var QUEUE = 'nexais-hub-crm-queue-v1', START = 'nexais-hub-crm-start-v1', SEEN = 'nexais-hub-crm-seen-v1';
  function get(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function rawSet(k, v) { try { Storage.prototype.setItem.__orig.call(localStorage, k, v); } catch (e) {} }

  try { sessionStorage.setItem('nexais-gate-ok', '1'); } catch (e) {}

  var originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (this === localStorage && key === USER) value = JSON.stringify(S.name || ''); // name comes from the login
    originalSetItem.call(this, key, value);
    if (this === localStorage && key === LOG) queueNew();
  };
  Storage.prototype.setItem.__orig = originalSetItem;

  rawSet(USER, JSON.stringify(S.name || ''));
  if (!get(START, null)) rawSet(START, JSON.stringify(new Date().toISOString()));

  function idOf(x) { return [x.at, x.by, x.business, x.what].join('|'); }
  function queueNew() {
    var start = get(START, ''), seen = get(SEEN, {}), queue = get(QUEUE, []), log = get(LOG, []);
    var added = false;
    log.forEach(function (x) {
      if (!x || !x.at || x.at < start || x.by !== S.name) return; // only this person's entries since sign-in
      var id = idOf(x);
      if (seen[id]) return;
      seen[id] = 1; queue.push(x); added = true;
    });
    if (added) { rawSet(SEEN, JSON.stringify(seen)); rawSet(QUEUE, JSON.stringify(queue)); setTimeout(flush, 0); }
  }

  var flushing = false, statusEl = null;
  function render() {
    if (!statusEl) return;
    var n = get(QUEUE, []).length;
    statusEl.textContent = n ? (document.documentElement.lang === 'fa' ? n + ' مورد در انتظار ثبت در CRM' : n + ' waiting to reach the CRM')
                             : (document.documentElement.lang === 'fa' ? 'همه در CRM ثبت شد ✓' : 'All saved to the CRM ✓');
  }
  function flush() {
    if (flushing) return;
    var queue = get(QUEUE, []);
    if (!queue.length) { render(); return; }
    flushing = true;
    var entry = queue[0];
    fetch('/api/hub/activity', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: entry.at, business: entry.business, what: entry.what, from: entry.from, to: entry.to }),
    }).then(function (r) {
      if (r.status === 401) { location.replace('/login'); return 'stop'; }
      // 4xx other than 401/429: the CRM refused this entry (e.g. no permission) — drop it, keep it on the device log.
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) {
        var q = get(QUEUE, []); q.shift(); rawSet(QUEUE, JSON.stringify(q));
        if (!r.ok) console.warn('[hub] CRM refused an entry', r.status, entry.business);
        return 'next';
      }
      return 'stop';
    }).catch(function () { return 'stop'; }).then(function (step) {
      flushing = false; render();
      if (step === 'next') setTimeout(flush, 50);
    });
  }

  function signOut() {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .finally(function () { location.replace('/login'); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var gate = document.getElementById('gate'); if (gate) gate.remove();
    document.body.classList.remove('locked');
    var change = document.getElementById('set-user'); if (change) change.style.display = 'none';
    var bar = document.createElement('div');
    bar.id = 'nx-session-bar';
    bar.setAttribute('style', 'position:fixed;z-index:9999;bottom:12px;inset-inline-end:12px;display:flex;gap:8px;align-items:center;'
      + 'background:rgba(20,23,28,.92);color:#fff;font:13px/1.3 system-ui,sans-serif;padding:8px 10px;border-radius:10px;max-width:calc(100vw - 24px)');
    var who = document.createElement('span'); who.textContent = (S.name || '') + (S.role ? ' · ' + S.role : '');
    statusEl = document.createElement('span'); statusEl.style.opacity = '.8';
    var out = document.createElement('button'); out.type = 'button'; out.textContent = 'Sign out';
    out.setAttribute('style', 'background:#fff;color:#14171c;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit');
    out.addEventListener('click', signOut);
    bar.appendChild(who); bar.appendChild(statusEl); bar.appendChild(out);
    document.body.appendChild(bar);
    render(); flush();
  });
  window.addEventListener('online', flush);
  setInterval(flush, 60000);
})();
