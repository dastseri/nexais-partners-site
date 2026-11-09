/* NexAIS Partners Hub — read-only HQ send history. No CRM, Sheet write, or signup. */
(function () {
  "use strict";
  const API = "/api/sends";
  const STAGES = ["proposal", "stage2", "stage3", "letter", "other"];
  const STATUSES = ["sent", "delivered", "bounced", "replied"];
  // Confirmed historical Jarvis short names; no fuzzy matches or guessed identity.
  const KNOWN_ALIASES = {
    "ascottparceventcentre": ["ascottparc"],
    "bayviewgolfandcountryclub": ["bayviewgcc"],
    "mississauguagolfandcountryclub": ["mississauguagcc"],
    "ladiesgolfcluboftoronto": ["ladiesgcoftoronto"],
    "terrarestaurant": ["terra"],
    "viaallegroristorante": ["viaallegro"],
    "chefrezapersiangrill": ["chefreza"],
    "vinelandestateswinery": ["vinelandestates"],
    "angusglengolfclub": ["angusglen"],
    "eaglesnestgolfclub": ["eaglesnest"],
    "islingtongolfclub": ["islingtongc"]
  };
  const words = {
    en: {
      sends: "Sends", title: "Sends — HQ correspondence", intro: "Emails sent by NexAIS headquarters. Manual partner actions remain in Action history.",
      toBusiness: "Sent to this business", empty: "No sends recorded for this business.",
      noPhone: "No phone on file", stages: "Stage", status: "Status", search: "Search by business name…",
      allStages: "All stages", allStatuses: "All statuses", view: "View text", copy: "Copy text",
      copied: "Copied", unavailable: "Full text not archived for this send",
      loading: "Loading secure send history…", failed: "Send history unavailable. Sign in or contact the administrator.",
      noResults: "No matching sends.", count: "sends", last: "last", from: "From", to: "To",
      subject: "Subject", missingSubject: "Subject not archived", attachment: "Attachment", reply: "Reply", channel: "Channel",
      proposal: "Proposal", stage2: "Stage 2", stage3: "Stage 3", letter: "Letter", other: "Other",
      sent: "Sent", delivered: "Delivered", bounced: "Bounced", replied: "Replied",
      all: "All", directory: "Businesses not in the call list"
    },
    fa: {
      sends: "ارسال‌ها", title: "ارسال‌ها — مکاتبات دفتر مرکزی", intro: "ایمیل‌های ارسال‌شده از دفتر مرکزی NexAIS. اقدامات دستی همکاران جداگانه ثبت می‌شوند.",
      toBusiness: "ارسال‌شده به این کسب‌وکار", empty: "برای این کسب‌وکار ارسالی ثبت نشده است.",
      noPhone: "شماره تلفن ثبت نشده", stages: "مرحله", status: "وضعیت", search: "جست‌وجو با نام کسب‌وکار…",
      allStages: "همه مراحل", allStatuses: "همه وضعیت‌ها", view: "مشاهده متن", copy: "کپی متن",
      copied: "کپی شد", unavailable: "متن کامل برای این ارسال آرشیو نشده است",
      loading: "در حال بارگذاری امن سوابق ارسال…", failed: "سوابق ارسال در دسترس نیست. وارد شوید یا با مدیر تماس بگیرید.",
      noResults: "ارسالی مطابق فیلتر پیدا نشد.", count: "ارسال", last: "آخرین", from: "فرستنده", to: "گیرنده",
      subject: "موضوع", missingSubject: "موضوع ایمیل آرشیو نشده", attachment: "پیوست", reply: "پاسخ", channel: "کانال",
      proposal: "پروپوزال", stage2: "مرحله ۲", stage3: "مرحله ۳", letter: "نامه", other: "سایر",
      sent: "ارسال شد", delivered: "تحویل شد", bounced: "برگشت خورد", replied: "پاسخ داده شد",
      all: "همه", directory: "کسب‌وکارهای خارج از لیست تماس"
    }
  };
  let records = [], state = "loading", stageFilter = "", statusFilter = "", searchFilter = "";
  const $ = (q, root = document) => root.querySelector(q);
  const all = (q, root = document) => Array.from(root.querySelectorAll(q));
  const tr = (k) => (words[window.LANG === "fa" ? "fa" : "en"][k] || k);
  const normalize = (s) => String(s || "").normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
  function cardName(card) {
    const h = $("h4", card);
    return h ? h.textContent.replace(/^\s*\d+\s*/, "").trim() : "";
  }
  function validPhone(raw) {
    const text = String(raw || "").trim();
    const digits = text.replace(/\D/g, "");
    if (!/^[\d\s().+\-xextEXT;]+$/.test(text) || digits.length < 10 || digits.length > 18) return null;
    return text;
  }
  function timeText(rec) {
    if (!rec.sent_at || !Number.isFinite(new Date(rec.sent_at).getTime())) return "";
    const opts = { timeZone:"America/Toronto", year:"numeric", month:"short", day:"numeric" };
    if (rec.time_precision !== "date") { opts.hour = "2-digit"; opts.minute = "2-digit"; }
    return new Intl.DateTimeFormat(window.LANG === "fa" ? "fa-IR" : "en-CA", opts).format(new Date(rec.sent_at));
  }
  function node(tag, cls, value) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (value != null) el.textContent = value;
    return el;
  }
  function addText(parent, cls, label, value) {
    if (value == null || String(value).trim() === "") return;
    const p = node("p", cls);
    p.append(node("strong", "", label + ": "), document.createTextNode(String(value)));
    parent.append(p);
  }
  async function copyText(value, button) {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); }
    catch (_) {
      const textarea = node("textarea", "");
      textarea.value = value; textarea.style.position = "fixed"; textarea.style.opacity = "0";
      document.body.append(textarea); textarea.select();
      const ok = document.execCommand("copy"); textarea.remove();
      if (!ok) return;
    }
    button.textContent = tr("copied");
  }
  function entry(rec) {
    const panel = node("details", "send-entry");
    const summary = node("summary", "send-summary");
    const pill = node("span", "send-chip", tr(rec.stage));
    pill.dataset.stage = rec.stage;
    summary.append(pill, node("span", "send-subject", rec.subject || tr("missingSubject")),
      node("time", "send-time", timeText(rec)), node("span", "send-status", tr(rec.status)));
    panel.append(summary);
    const body = node("div", "send-entry-body");
    addText(body, "send-line", tr("from"), [rec.channel || "email", rec.from || ""].filter(Boolean).join(" · "));
    addText(body, "send-line", tr("to"), rec.to_email);
    addText(body, "send-line", tr("attachment"), rec.attachment);
    if (rec.status_note) addText(body, "send-line", tr("status"), rec.status_note);
    if (rec.reply_note) addText(body, "send-line", tr("reply"),
      [rec.replied_at ? timeText({sent_at:rec.replied_at}) : "", rec.reply_note].filter(Boolean).join(" · "));
    const full = node("details", "send-full");
    full.append(node("summary", "", tr("view")));
    if (rec.body_text) {
      const pre = node("pre", "send-raw", rec.body_text);
      pre.setAttribute("dir", "auto");
      full.append(pre);
      const btn = node("button", "copy-btn", tr("copy")); btn.type = "button";
      btn.addEventListener("click", () => copyText(rec.body_text, btn));
      full.append(btn);
    } else full.append(node("p", "send-unavailable", tr("unavailable")));
    body.append(full); panel.append(body);
    return panel;
  }
  function keysForName(name) {
    const key = normalize(name);
    return new Set([key].concat(KNOWN_ALIASES[key] || []));
  }
  function forCard(card) {
    const name = cardName(card);
    const keys = keysForName(name);
    if (card.dataset.businessSlug) keys.add(normalize(card.dataset.businessSlug));
    return records.filter(r => keys.has(normalize(r.business_slug)) ||
      keys.has(normalize(r.business_name)));
  }
  function renderCards() {
    all("#cards .card").forEach(card => {
      const sends = forCard(card);
      let head = $(".send-card-head", card);
      if (!head) {
        head = node("div", "send-card-head");
        const top = $(".card-top > div", card) || $(".card-top", card);
        if (top) top.append(head);
      }
      head.replaceChildren();
      const original = $(".facts dd.phone a", card);
      const raw = (original && (original.textContent || original.getAttribute("href").replace(/^tel:/, ""))) ||
        (sends.find(r => r.phone) || {}).phone;
      const phone = validPhone(raw);
      if (phone) {
        const link = node("a", "send-phone", phone);
        link.setAttribute("href", original && /^tel:\+?[\d;=x]+$/i.test(original.getAttribute("href") || "") ?
          original.getAttribute("href") : "tel:" + phone.replace(/[^\d+]/g, ""));
        head.append(link);
      } else head.append(node("span", "send-missing-phone", tr("noPhone")));
      {
        const line = node("div", "send-card-count",
          STAGES.map(stage => tr(stage) + " " + (sends.some(s => s.stage === stage) ? "✓" : "—")).join(" · "));
        line.append(node("span", "", " · " + sends.length + " " + tr("count") + " · " + tr("last") + " " + timeText(sends[0])));
        head.append(line);
      }
      const more = $("details.card-more", card);
      if (!more) return;
      let section = $(".sent-business-history", more);
      if (!section) {
        section = node("div", "sent-business-history");
        const manual = $(".act-hist", more);
        if (manual) more.insertBefore(section, manual); else more.append(section);
      }
      section.replaceChildren(node("h5", "", tr("toBusiness")));
      if (state === "error") section.append(node("p", "send-unavailable", tr("failed")));
      else if (state === "loading") section.append(node("p", "send-unavailable", tr("loading")));
      else if (!sends.length) section.append(node("p", "send-unavailable", tr("empty")));
      else sends.forEach(rec => section.append(entry(rec)));
    });
  }
  function createGlobal() {
    if ($("#sends")) return;
    const section = node("section", "soft"); section.id = "sends";
    const wrap = node("div", "wrap");
    const details = node("details", "sec-panel"); details.open = false;
    const summary = node("summary", "");
    const h = node("h2", "", tr("title")); h.id = "send-feed-title"; summary.append(h);
    details.append(summary);
    const intro = node("p", "send-intro", tr("intro")); intro.id = "send-feed-intro";
    details.append(intro);
    const controls = node("div", "send-controls");
    const stage = node("select", "send-filter-stage"); stage.id = "send-stage-filter";
    stage.setAttribute("aria-label", tr("stages"));
    stage.addEventListener("change", e => { stageFilter = e.target.value; renderFeed(); });
    const status = node("select", "send-filter-status"); status.id = "send-status-filter";
    status.setAttribute("aria-label", tr("status"));
    status.addEventListener("change", e => { statusFilter = e.target.value; renderFeed(); });
    const search = node("input", "send-filter-search");
    search.id = "send-search"; search.type = "search";
    search.placeholder = tr("search");
    search.addEventListener("input", e => { searchFilter = e.target.value.toLowerCase().trim(); renderFeed(); });
    controls.append(stage, status, search);
    details.append(controls);
    const feed = node("div", "send-global-feed"); feed.id = "send-global-feed";
    details.append(feed);
    const directory = node("details", "send-extra-businesses");
    directory.id = "send-extra-businesses";
    directory.append(node("summary", "send-directory-title", tr("directory")));
    directory.append(node("div", "send-directory-grid"));
    details.append(directory);
    wrap.append(details); section.append(wrap);
    const before = $("#research");
    if (before) before.before(section); else document.querySelector("main")?.append(section) || document.body.append(section);
    const nav = $(".topnav");
    if (nav) {
      const link = node("a", "", tr("sends"));
      link.id = "send-nav"; link.href = "#sends";
      const researchLink = nav.querySelector('a[href="#research"]');
      if (researchLink) researchLink.before(link); else nav.append(link);
    }
    const css = node("style", ""); css.textContent = `
      .send-card-head{margin-top:5px;display:flex;flex-direction:column;align-items:flex-start;gap:2px}
      .send-phone{font-weight:800;font-size:14px;direction:ltr;unicode-bidi:isolate}
      .send-missing-phone{color:var(--ink-3);font-size:13px}
      .send-card-count{font-size:12px;line-height:1.5;color:var(--ink-2);overflow-wrap:anywhere}
      .sent-business-history{margin:18px 0;border-block-start:1px solid var(--panel-line);padding-top:12px}
      .sent-business-history h5{font-size:16px;margin:0 0 8px;color:var(--blue-dark)}
      .send-entry{border:1px solid var(--panel-line);border-radius:10px;background:var(--panel);margin:9px 0;overflow:hidden}
      .send-summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:11px;font-size:13px}
      .send-summary:focus-visible,.send-full>summary:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
      .send-chip{background:var(--blue-soft);color:var(--blue-dark);font-weight:800;padding:2px 8px;border-radius:999px}
      .send-subject{flex:1 1 140px;font-weight:700;overflow-wrap:anywhere}
      .send-time,.send-status{font-size:12px;color:var(--ink-2)}
      .send-entry-body{padding:12px 14px;border-block-start:1px solid var(--panel-line);overflow-wrap:anywhere}
      .send-line{font-size:13px;margin:0 0 7px;color:var(--ink-2)}
      .send-line strong{color:var(--ink)}
      .send-full{margin-top:12px}
      .send-full>summary{font-weight:700;color:var(--blue-dark);cursor:pointer}
      .send-raw{font-family:inherit;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.65;max-height:none;background:var(--bg-soft);border-radius:8px;padding:12px;margin-top:10px}
      .send-unavailable{font-size:13px;color:var(--ink-3);margin:10px 0}
      .send-intro{margin:12px 0 18px;color:var(--ink-2)}
      .send-controls{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
      .send-controls select,.send-controls input{min-width:120px;flex:1 1 160px;padding:10px;border:1px solid var(--panel-line);background:var(--panel);color:var(--ink);font:inherit;border-radius:9px}
      .send-global-feed .send-entry{margin:10px 0}
      .send-extra-businesses{margin-top:22px;border-top:1px solid var(--panel-line);padding-top:15px}
      .send-directory-title{font-weight:800;cursor:pointer;color:var(--blue-dark)}
      .send-directory-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px;margin-top:15px}
      .send-directory-card{border:1px solid var(--panel-line);background:var(--panel);border-radius:12px;padding:14px;min-width:0}
      .send-directory-card h4{font-size:16px;overflow-wrap:anywhere}
      .send-directory-card .send-phone{display:block;margin-top:6px}
      .send-directory-card>details{margin-top:8px}
      .send-directory-card>details>summary{color:var(--blue-dark);font-size:13px;font-weight:700;cursor:pointer}
      @media(max-width:600px){.send-controls>*{width:100%}.send-summary{gap:5px}.send-entry-body{padding:10px}}
    `;
    document.head.append(css);
  }
  function updateFilters() {
    const s = $("#send-stage-filter"), t = $("#send-status-filter");
    if (!s || !t) return;
    s.replaceChildren();
    s.append(new Option(tr("allStages"), ""));
    STAGES.forEach(v => s.append(new Option(tr(v), v)));
    s.value = stageFilter;
    t.replaceChildren(); t.append(new Option(tr("allStatuses"), ""));
    STATUSES.forEach(v => t.append(new Option(tr(v), v))); t.value = statusFilter;
    s.setAttribute("aria-label", tr("stages")); t.setAttribute("aria-label", tr("status"));
    const search = $("#send-search"); if (search) search.placeholder = tr("search");
  }
  function renderFeed() {
    const feed = $("#send-global-feed"); if (!feed) return;
    feed.replaceChildren();
    if (state !== "ready") { feed.append(node("p", "send-unavailable", tr(state === "error" ? "failed" : "loading"))); return; }
    const subset = records.filter(r => (!stageFilter || r.stage === stageFilter) &&
      (!statusFilter || r.status === statusFilter) &&
      (!searchFilter || String(r.business_name || "").toLowerCase().includes(searchFilter)));
    if (!subset.length) { feed.append(node("p", "send-unavailable", tr("noResults"))); return; }
    subset.forEach(rec => {
      const box = node("div", "send-global-item");
      const name = node("h3", "", rec.business_name || rec.business_slug || "");
      name.style.cssText = "font-size:15px;margin:15px 0 5px";
      box.append(name);
      const knownPhone = validPhone(rec.phone);
      if (knownPhone) {
        const tel = node("a", "send-phone", knownPhone);
        tel.href = "tel:" + knownPhone.replace(/[^\d+]/g, "");
        box.append(tel);
      } else box.append(node("p", "send-missing-phone", tr("noPhone")));
      box.append(entry(rec)); feed.append(box);
    });
  }
  function renderDirectory() {
    const outer = $("#send-extra-businesses");
    if (!outer) return;
    const grid = $(".send-directory-grid", outer);
    grid.replaceChildren();
    outer.querySelector("summary").textContent = tr("directory");
    if (state !== "ready") { outer.hidden = true; return; }
    const known = new Set();
    all("#cards .card").forEach(c => keysForName(cardName(c)).forEach(key => known.add(key)));
    const byBusiness = new Map();
    records.forEach(rec => {
      const key = normalize(rec.business_name);
      if (!key || known.has(key)) return;
      if (!byBusiness.has(key)) byBusiness.set(key, []);
      byBusiness.get(key).push(rec);
    });
    outer.hidden = byBusiness.size === 0;
    for (const sends of byBusiness.values()) {
      const first = sends[0];
      const card = node("article", "send-directory-card");
      card.append(node("h4", "", first.business_name));
      const phoneRecord = sends.find(x => validPhone(x.phone));
      const phone = phoneRecord && validPhone(phoneRecord.phone);
      if (phone) {
        const link = node("a", "send-phone", phone);
        link.href = "tel:" + phone.replace(/[^\d+]/g, "");
        card.append(link);
      } else card.append(node("p", "send-missing-phone", tr("noPhone")));
      card.append(node("p", "send-card-count", STAGES.map(stage =>
        tr(stage)+" "+(sends.some(x => x.stage === stage) ? "✓" : "—")).join(" · ")));
      const details = node("details", "");
      details.append(node("summary", "", tr("toBusiness")+" · "+sends.length+" "+tr("count")));
      sends.forEach(x => details.append(entry(x)));
      card.append(details);
      grid.append(card);
    }
  }
  function renderAll() {
    createGlobal();
    $("#send-feed-title").textContent = tr("title");
    $("#send-feed-intro").textContent = tr("intro");
    const link = $("#send-nav"); if (link) link.textContent = tr("sends");
    updateFilters(); renderCards(); renderFeed(); renderDirectory();
  }
  function checkRecord(r) {
    return r && typeof r.id === "string" && typeof r.business_name === "string" &&
      STAGES.includes(r.stage) && STATUSES.includes(r.status) && typeof r.sent_at === "string";
  }
  async function load() {
    if (!window.NEXAIS_hubAuthenticated) return;
    try {
      const response = await fetch(API, { credentials:"same-origin", cache:"no-store", headers:{ Accept:"application/json" } });
      if (!response.ok) throw new Error("Sends unavailable");
      const result = await response.json();
      if (!Array.isArray(result.sends)) throw new Error("Bad sends response");
      const seenId = new Set(), seenMessage = new Set();
      records = result.sends.filter(r => {
        if (!checkRecord(r) || seenId.has(r.id) || (r.message_id && seenMessage.has(r.message_id))) return false;
        seenId.add(r.id); if (r.message_id) seenMessage.add(r.message_id); return true;
      }).sort((a,b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
      state = "ready";
    } catch (_) { records = []; state = "error"; }
    renderAll();
  }
  function install() {
    renderAll();
    const original = window.NEXAIS_setLang;
    if (typeof original === "function" && !window.__nexaisSendsLangPatched) {
      window.__nexaisSendsLangPatched = true;
      window.NEXAIS_setLang = function(lang) { original(lang); renderAll(); };
    }
    if (window.NEXAIS_hubAuthenticated) load();
    window.addEventListener("nexais:authenticated", load);
    const parent = $("#cards");
    if (parent && "MutationObserver" in window) {
      const observer = new MutationObserver(mutations => {
        if (mutations.some(m => Array.from(m.addedNodes).some(n => n.nodeType === 1 && (n.matches?.(".card") || n.querySelector?.(".card"))))) renderCards();
      });
      observer.observe(parent, { childList:true, subtree:false });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
