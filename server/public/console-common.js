/* Shared helpers for /team and /my. All page text is set with textContent (no HTML injection). */
(function () {
  'use strict';
  var fa = false;
  try { fa = localStorage.getItem('nexais-auth-lang') === 'fa'; } catch (e) {}
  var NX = window.NX = {};
  NX.fa = function () { return fa; };
  NX.t = function (en, f) { return fa ? f : en; };
  NX.applyLang = function () {
    document.documentElement.lang = fa ? 'fa' : 'en';
    document.documentElement.dir = fa ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-en]').forEach(function (el) { el.textContent = el.getAttribute(fa ? 'data-fa' : 'data-en'); });
  };
  NX.toggleLang = function () { fa = !fa; try { localStorage.setItem('nexais-auth-lang', fa ? 'fa' : 'en'); } catch (e) {} NX.applyLang(); if (NX.onLang) NX.onLang(); };
  NX.el = function (tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { e.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  };
  NX.api = function (method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) {
      if (r.status === 401) { location.replace('/login'); throw new Error('signed out'); }
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  };
  NX.signOut = function () { NX.api('POST', '/api/auth/logout', {}).finally(function () { location.replace('/login'); }); };
  NX.STATUS = ['requested', 'researching', 'ready_for_review', 'approved', 'assigned', 'in_progress', 'won', 'lost', 'closed', 'rejected'];
  NX.STATUS_FA = { requested: 'درخواست', researching: 'در تحقیق', ready_for_review: 'آمادهٔ بررسی', approved: 'تأییدشده', assigned: 'سپرده‌شده', in_progress: 'در حال انجام', won: 'برنده', lost: 'از دست رفته', closed: 'بسته', rejected: 'رد شده' };
  NX.status = function (s) { return fa ? (NX.STATUS_FA[s] || s) : s.replace(/_/g, ' '); };
  NX.OUTCOMES = [['reached_decision_maker', 'Reached decision-maker', 'به تصمیم‌گیرنده رسیدم'], ['gatekeeper', 'Gatekeeper', 'منشی / واسطه'],
    ['voicemail_left', 'Voicemail left', 'پیام صوتی گذاشتم'], ['callback_scheduled', 'Callback scheduled', 'تماس مجدد برنامه‌ریزی شد'],
    ['demo_booked', 'Demo booked', 'دمو رزرو شد'], ['not_interested', 'Not interested', 'علاقه نداشت']];
  NX.CHANNELS = [['sms', 'SMS', 'پیامک'], ['email', 'Email', 'ایمیل'], ['ai_call', 'AVA automated call', 'تماس خودکار AVA']];
  NX.BASES = [['express', 'Express — they clearly said yes', 'صریح — خودشان گفتند بله'],
    ['implied_inquiry', 'Implied — they asked us (6 months)', 'ضمنی — خودشان پرسیدند (۶ ماه)'],
    ['implied_business_relationship', 'Implied — customer (2 years)', 'ضمنی — مشتری (۲ سال)'],
    ['conspicuous_publication', 'Published address, relevant (email only)', 'آدرس منتشرشده و مرتبط (فقط ایمیل)']];
  NX.label = function (list, key) { var x = list.filter(function (i) { return i[0] === key; })[0]; return x ? NX.t(x[1], x[2]) : key; };
  // Consent panel for one mission (used by /team and /my).
  NX.consentPanel = function (missionId, canAdd, say) {
    var el = NX.el, t = NX.t;
    var list = el('ul', { class: 'log' });
    var channel = el('select'), basis = el('select');
    NX.CHANNELS.forEach(function (c) { channel.appendChild(el('option', { value: c[0], text: t(c[1], c[2]) })); });
    NX.BASES.forEach(function (b) { basis.appendChild(el('option', { value: b[0], text: t(b[1], b[2]) })); });
    var evidence = el('textarea', { placeholder: t('How and when did they agree? (who, date, words used)', 'چگونه و کی رضایت دادند؟ (چه کسی، تاریخ، جمله)') });
    var add = el('button', { type: 'button', class: 'primary', text: t('Record consent', 'ثبت رضایت') });
    function load() {
      NX.api('GET', '/api/missions/' + encodeURIComponent(missionId) + '/consents').then(function (j) {
        list.textContent = '';
        if (!j.consents.length) list.appendChild(el('li', { text: t('No consent on record. Do not text or email.', 'رضایتی ثبت نشده. پیامک یا ایمیل نفرستید.') }));
        j.consents.forEach(function (c) {
          var expired = c.expires_at && new Date(c.expires_at) < new Date();
          var state = c.withdrawn_at ? t('WITHDRAWN', 'لغو شده') + ' ' + NX.when(c.withdrawn_at) : (expired ? t('EXPIRED', 'منقضی') : t('active', 'فعال'));
          var li = el('li', { text: NX.label(NX.CHANNELS, c.channel) + ' · ' + NX.label(NX.BASES, c.basis) + ' · ' + state + ' · ' + c.evidence + ' ' });
          if (!c.withdrawn_at) {
            var w = el('button', { type: 'button', text: t('Record STOP / withdrawal', 'ثبت لغو (STOP)') });
            w.addEventListener('click', function () {
              NX.api('POST', '/api/consents/' + encodeURIComponent(c.id) + '/withdraw', { note: 'Withdrawn (recorded in partner app)' }).then(load).catch(function (e) { say(e.message); });
            });
            li.appendChild(w);
          }
          list.appendChild(li);
        });
      }).catch(function (e) { say(e.message); });
    }
    add.addEventListener('click', function () {
      NX.api('POST', '/api/missions/' + encodeURIComponent(missionId) + '/consents', { channel: channel.value, basis: basis.value, evidence: evidence.value, source: 'call' })
        .then(function () { evidence.value = ''; say(t('Consent recorded', 'رضایت ثبت شد'), true); load(); }).catch(function (e) { say(e.message); });
    });
    var body = [list];
    if (canAdd) body.push(el('div', { class: 'grid', style: 'margin-top:6px' }, [channel, basis]), evidence, el('div', { class: 'row', style: 'margin-top:6px' }, [add]),
      el('p', { class: 'warn', text: t('Permission from NexAIS is not consent from the contact. Every text must name NexAIS and offer STOP.', 'اجازهٔ NexAIS رضایت مخاطب نیست. هر پیامک باید نام NexAIS و گزینهٔ لغو (STOP) داشته باشد.') }));
    var d = el('details', {}, [el('summary', { text: t('Consent (texts, emails, AVA calls)', 'رضایت (پیامک، ایمیل، تماس AVA)') })].concat(body));
    d.addEventListener('toggle', function () { if (d.open) load(); });
    return d;
  };
  NX.when = function (iso) { try { return new Date(iso).toLocaleString(fa ? 'fa-IR' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; } };
  NX.describe = function (a) {
    var map = { request: ['registered', 'ثبت کرد'], approval: ['approved', 'تأیید کرد'], assignment: ['assigned', 'سپرد'], status_change: ['changed status', 'وضعیت را تغییر داد'],
      research_attached: ['attached research', 'تحقیق ضمیمه کرد'], proposal_attached: ['attached proposal', 'پروپوزال ضمیمه کرد'], call: ['call', 'تماس'], sms: ['SMS', 'پیامک'],
      email: ['email', 'ایمیل'], visit: ['visit', 'مراجعه'], note: ['note', 'یادداشت'], permission_change: ['changed permissions', 'دسترسی را تغییر داد'] };
    var d = map[a.action] || [a.action, a.action];
    var parts = [a.actor_name || '', NX.t(d[0], d[1])];
    if (a.from_value || a.to_value) parts.push((a.from_value ? a.from_value + ' → ' : '') + (a.to_value || ''));
    if (a.outcome) { var o = NX.OUTCOMES.filter(function (x) { return x[0] === a.outcome; })[0]; parts.push(o ? NX.t(o[1], o[2]) : a.outcome); }
    if (a.notes) parts.push('— ' + a.notes);
    if (a.consent_ok === false) parts.push(NX.t('(no consent on record)', '(رضایت ثبت‌شده‌ای نبود)'));
    return NX.when(a.created_at) + ' · ' + parts.join(' ');
  };
})();
