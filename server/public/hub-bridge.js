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
      if (x.what === 'biz-added') return; // new businesses travel through /api/hub/business instead
      var id = idOf(x);
      if (seen[id]) return;
      seen[id] = 1; added = true;
      // Notes are saved while the person types: keep only the latest unsent note per business,
      // and hold it briefly so half-typed versions never reach the CRM.
      if (x.what === 'notes') {
        queue = queue.filter(function (q) { return !(q.what === 'notes' && q.business === x.business); });
        queue.push(Object.assign({}, x, { holdUntil: Date.now() + 20000 }));
        setTimeout(flush, 20500);
        return;
      }
      queue.push(x);
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
    var now = Date.now();
    var index = -1;
    for (var i = 0; i < queue.length; i++) { if (!queue[i].holdUntil || queue[i].holdUntil <= now) { index = i; break; } }
    if (index < 0) { render(); return; }
    flushing = true;
    var entry = queue[index];
    var entryId = idOf(entry);
    fetch('/api/hub/activity', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: entry.at, business: entry.business, what: entry.what, from: entry.from, to: entry.to }),
    }).then(function (r) {
      if (r.status === 401) { location.replace('/login'); return 'stop'; }
      // 4xx other than 401/429: the CRM refused this entry (e.g. no permission) — drop it, keep it on the device log.
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) {
        var q = get(QUEUE, []).filter(function (x) { return idOf(x) !== entryId; }); rawSet(QUEUE, JSON.stringify(q));
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
    bar.appendChild(who); bar.appendChild(statusEl);
    if (S.role === 'team' || S.role === 'admin') {
      var team = document.createElement('a'); team.href = '/team'; team.textContent = 'Team console';
      team.setAttribute('style', 'color:#fff;text-decoration:underline');
      bar.appendChild(team);
    }
    bar.appendChild(out);
    document.body.appendChild(bar);
    render(); flush();
  });
  window.addEventListener('online', flush);
  setInterval(flush, 60000);

  /* ---- shared business list: new businesses go to the CRM; everyone's businesses come back from it ---- */
  var BIZQ = 'nexais-hub-crm-bizq-v1', CALLLOG = 'nexais-hub-calllog-v1';
  var OUTCOME_LABEL = { not_called: 'Not called', reached_decision_maker: 'Reached decision-maker', gatekeeper: 'Gatekeeper',
    voicemail_left: 'Voicemail left', not_interested: 'Not interested', callback_scheduled: 'Callback scheduled', demo_booked: 'Demo booked' };
  var IND_KEYS = ['restaurant', 'venue', 'golf', 'winery', 'clinic', 'transport', 'beauty', 'trades', 'auto', 'realestate', 'other'];
  function indOf(v) {
    var t = String(v || '').toLowerCase();
    if (IND_KEYS.indexOf(t) >= 0) return t;
    if (/transport|logistic|truck/.test(t)) return 'transport';
    if (/clinic|spa|dental|medical/.test(t)) return 'clinic';
    if (/restaurant|venue|catering/.test(t)) return 'restaurant';
    return 'other';
  }
  function summaryField(summary, label) {
    var m = String(summary || '').match(new RegExp('^' + label + ':\\s*(.+)$', 'm'));
    return m ? m[1].trim() : '';
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  var bizBusy = false;
  function flushBiz() {
    if (bizBusy) return;
    var q = get(BIZQ, []);
    if (!q.length) return;
    bizBusy = true;
    var b = q[0];
    post('/api/hub/business', b).then(function (r) {
      if (r.status === 401) { location.replace('/login'); return 'stop'; }
      if (r.ok || r.status === 409 || (r.status >= 400 && r.status < 500 && r.status !== 429)) {
        rawSet(BIZQ, JSON.stringify(get(BIZQ, []).filter(function (x) { return x.name !== b.name; })));
        if (!r.ok && r.status !== 409) console.warn('[hub] CRM refused a new business', r.status, b.name);
        return 'next';
      }
      return 'stop';
    }).catch(function () { return 'stop'; }).then(function (step) {
      bizBusy = false;
      if (step === 'next') setTimeout(flushBiz, 50);
    });
  }
  function loadState() {
    if (!window.NEXAIS_newBiz) return;
    fetch('/api/hub/state', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (r.status === 401) { location.replace('/login'); return null; }
      return r.ok ? r.json() : null;
    }).then(function (data) {
      if (!data || !data.missions) return;
      var saved = get(CALLLOG, {}), changed = false;
      data.missions.forEach(function (m) {
        var name = String(m.business_name || '').trim(); if (!name) return;
        if (!window.NEXAIS_newBiz.exists(name)) {
          window.NEXAIS_newBiz.importCRM({ name: name, ind: indOf(m.vertical), city: m.city || '', phone: m.public_phone || '', web: m.website || '',
            contact: summaryField(m.partner_summary, 'Contact'), note: summaryField(m.partner_summary, 'Signal'), mission: m.mission_code, research: '',
            evidence: summaryField(m.partner_summary, 'Evidence'), source: summaryField(m.partner_summary, 'Source'), score: summaryField(m.partner_summary, 'Pain score'),
            studied: summaryField(m.partner_summary, 'Research'), proposalStatus: summaryField(m.partner_summary, 'Proposal') });
          changed = true;
        }
        var label = OUTCOME_LABEL[m.last_outcome];
        if (!label) return;
        var key = name.toLowerCase();
        var card = Array.prototype.filter.call(document.querySelectorAll('#cards .card'), function (c) { return c.getAttribute('data-name') === key; })[0];
        var sel = card && card.querySelector('.status');
        if (!sel || sel.value === label) return;
        var local = saved[name];
        if (local && local.at && m.last_outcome_at && local.at > m.last_outcome_at) return; // this device has the newer result
        sel.value = label; changed = true;
      });
      if (changed) {
        if (window.NEXAIS_refreshTracker) window.NEXAIS_refreshTracker();
        if (window.NEXAIS_shellReload) window.NEXAIS_shellReload();
      }
    }).catch(function () {});
  }
  document.addEventListener('DOMContentLoaded', function () {
    var nb = window.NEXAIS_newBiz;
    if (nb) {
      var origAdd = nb.add, origRemove = nb.remove;
      nb.add = function (b) {
        var card = origAdd.apply(this, arguments);
        var q = get(BIZQ, []);
        q.push({ name: b.name, industry: b.ind, city: b.city, phone: b.phone, website: b.web, contact: b.contact, note: b.note, at: new Date().toISOString() });
        rawSet(BIZQ, JSON.stringify(q));
        setTimeout(flushBiz, 0);
        return card;
      };
      nb.remove = function (name) {
        origRemove.apply(this, arguments);
        post('/api/hub/business/close', { name: name }).catch(function () {});
      };
    }
    flushBiz();
    loadState();
  });
  setInterval(function () { flushBiz(); loadState(); }, 120000);
  window.addEventListener('online', flushBiz);
})();
