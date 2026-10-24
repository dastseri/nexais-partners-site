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
    return NX.when(a.created_at) + ' · ' + parts.join(' ');
  };
})();
