// Finds a business's weak spot / sales hook when the hub has none.
// Sources, in order: (1) what the CRM already holds for the mission (research notes, partner summary),
// (2) its public Google Maps listing (Places API: rating, hours, reviews, website), then
// (3) AVA (Claude) turns those facts into one honest hook + an opening line. Without an AI key a
// plain rule-based reading of the same facts is used. Nothing is invented: every hook must cite evidence.

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.rating', 'places.userRatingCount',
  'places.nationalPhoneNumber', 'places.websiteUri', 'places.googleMapsUri', 'places.regularOpeningHours', 'places.reviews',
  'places.primaryTypeDisplayName',
].join(',');

const PHONE_WORDS = /(phone|call(ed|ing)?|answer(ed)?|voicemail|voice mail|no one picked|nobody picked|hold|line was busy|couldn'?t reach|can'?t reach|never called back|didn'?t call back|unreachable)/i;
const BOOK_WORDS = /(book(ing)?|reservation|reserve|appointment|schedul(e|ing)|walk-?in|wait(ed|ing)? list|availability)/i;

export async function findPlace({ name, city, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(PLACES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACES_FIELDS },
    body: JSON.stringify({ textQuery: [name, city].filter(Boolean).join(', '), maxResultCount: 1, languageCode: 'en', regionCode: 'CA' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Maps: ${data?.error?.message || res.status}`);
  const p = data.places?.[0];
  if (!p) return null;
  return {
    name: p.displayName?.text || name,
    address: p.formattedAddress || '',
    type: p.primaryTypeDisplayName?.text || '',
    rating: p.rating ?? null,
    reviews_count: p.userRatingCount ?? null,
    phone: p.nationalPhoneNumber || '',
    website: p.websiteUri || '',
    maps_url: p.googleMapsUri || '',
    hours: p.regularOpeningHours?.weekdayDescriptions || [],
    reviews: (p.reviews || []).map((r) => ({
      rating: r.rating ?? null,
      when: r.relativePublishTimeDescription || '',
      text: String(r.text?.text || r.originalText?.text || '').slice(0, 700),
    })).filter((r) => r.text),
  };
}

// Rule-based reading of the same facts (no AI key): phone / booking complaints first, then hours gaps.
export function ruleHook(place, bizName) {
  if (!place) return null;
  const evidence = [];
  const phone = place.reviews.filter((r) => PHONE_WORDS.test(r.text));
  const book = place.reviews.filter((r) => BOOK_WORDS.test(r.text) && (r.rating ?? 5) <= 3);
  for (const r of phone.slice(0, 2)) evidence.push({ source: 'Google review', detail: `${r.rating ?? '?'}★ ${r.when}: “${snippet(r.text, PHONE_WORDS)}”` });
  for (const r of book.slice(0, 1)) evidence.push({ source: 'Google review', detail: `${r.rating ?? '?'}★ ${r.when}: “${snippet(r.text, BOOK_WORDS)}”` });
  const closed = place.hours.filter((h) => /closed/i.test(h));
  const earlyClose = place.hours.filter((h) => /(?:^|[^\d])[1-6](:\d\d)?\s?(PM|p\.m\.)\s*$/i.test(h));
  let hook = '';
  if (phone.length) hook = `Customers mention trouble reaching ${bizName} by phone — AVA answers every call, 24/7.`;
  else if (book.length) hook = `Reviews show friction around bookings — AVA takes bookings by phone and text, day and night.`;
  else if (closed.length || earlyClose.length) {
    hook = `${bizName} is closed ${closed.length ? closed.map((h) => h.split(':')[0]).join(', ') : 'in the evenings'} — calls in those hours go unanswered; AVA covers them.`;
    evidence.push({ source: 'Google Maps hours', detail: (closed.length ? closed : earlyClose).join(' · ') });
  }
  if (!hook) return null;
  if (place.rating != null) evidence.push({ source: 'Google Maps', detail: `${place.rating}★ from ${place.reviews_count ?? 0} reviews` });
  return { hook, evidence, opening: '', confidence: phone.length ? 'high' : 'medium', by: 'rules' };
}

function snippet(text, re) {
  const i = text.search(re);
  const start = Math.max(0, i - 60);
  const s = text.slice(start, start + 160).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + (start + 160 < text.length ? '…' : '');
}

const SYSTEM = `You are AVA, the research assistant of NexAIS. NexAIS sells AVA, an AI receptionist that answers every phone call 24/7, takes bookings and messages, and texts the owner a summary.
From the FACTS about one business, find the single most useful weak spot a salesperson can open a phone call with.
Rules:
- Use ONLY the facts given. Never invent numbers, reviews, quotes, staff names or problems.
- Prefer, in this order: complaints about phones / unanswered calls / call-backs; booking or reservation friction; hours when calls go unanswered (evenings, closed days); growth signals (busy, many reviews) that make missed calls costly.
- If the facts show no real weak spot, say so: set "hook" to "" and "confidence" to "none".
- Quotes in evidence must be copied exactly from the facts and be under 20 words.
- Write in plain, friendly Canadian English. No hype.
Return ONLY JSON: {"hook": "one sentence", "evidence": [{"source": "Google review|Google Maps hours|Google Maps|CRM notes|Website", "detail": "..."}], "opening": "one natural sentence the caller can say after introducing themselves", "confidence": "high|medium|low|none"}`;

export async function aiHook({ bizName, place, crmNotes, apiKey, model, fetchImpl = fetch }) {
  const facts = { business: bizName, crm_notes: crmNotes || '', google_maps: place || 'not found on Google Maps' };
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 700, system: SYSTEM, messages: [{ role: 'user', content: `FACTS:\n${JSON.stringify(facts, null, 1).slice(0, 12000)}` }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AVA: ${data?.error?.message || res.status}`);
  const text = (data.content || []).map((c) => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AVA returned no result');
  const out = JSON.parse(m[0]);
  return {
    hook: String(out.hook || '').slice(0, 400),
    evidence: (Array.isArray(out.evidence) ? out.evidence : []).slice(0, 5).map((e) => ({ source: String(e.source || '').slice(0, 40), detail: String(e.detail || '').slice(0, 300) })),
    opening: String(out.opening || '').slice(0, 400),
    confidence: ['high', 'medium', 'low', 'none'].includes(out.confidence) ? out.confidence : 'low',
    by: 'ava',
  };
}

export async function findHook({ bizName, city, crmNotes, env, fetchImpl = fetch }) {
  const sources = [];
  let place = null;
  if (env.GOOGLE_PLACES_API_KEY) {
    place = await findPlace({ name: bizName, city, apiKey: env.GOOGLE_PLACES_API_KEY, fetchImpl });
    sources.push(place ? 'google_maps' : 'google_maps_not_found');
  }
  if (crmNotes) sources.push('crm');
  if (!place && !crmNotes) return { hook: '', evidence: [], opening: '', confidence: 'none', by: 'none', sources, place: null,
    missing: env.GOOGLE_PLACES_API_KEY ? 'not_found' : 'google_key' };
  let result = null;
  if (env.ANTHROPIC_API_KEY) {
    result = await aiHook({ bizName, place, crmNotes, apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', fetchImpl });
  } else {
    result = ruleHook(place, bizName) || { hook: '', evidence: [], opening: '', confidence: 'none', by: 'rules' };
  }
  const placeSummary = place ? { name: place.name, address: place.address, rating: place.rating, reviews_count: place.reviews_count,
    phone: place.phone, website: place.website, maps_url: place.maps_url, hours: place.hours } : null;
  return { ...result, sources, place: placeSummary };
}
