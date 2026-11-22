import test from 'node:test';
import assert from 'node:assert/strict';
import { findHook, ruleHook } from '../server/hookFinder.js';

const PLACE_RES = { places: [{ displayName: { text: 'Bistro Uno' }, formattedAddress: '1 King St, Toronto', rating: 4.1, userRatingCount: 212,
  regularOpeningHours: { weekdayDescriptions: ['Monday: Closed', 'Tuesday: 11:00 AM – 9:00 PM'] },
  reviews: [{ rating: 2, relativePublishTimeDescription: '2 weeks ago', text: { text: 'Great food but I called three times to book and nobody picked up the phone.' } },
            { rating: 5, relativePublishTimeDescription: 'a month ago', text: { text: 'Lovely patio.' } }] }] };
const fakeFetch = (routes) => async (url, init) => {
  const r = routes(url, init);
  return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
};

test('rules: phone complaint in a review becomes the hook, with the quote as evidence', async () => {
  const out = await findHook({ bizName: 'Bistro Uno', city: 'Toronto', crmNotes: '', env: { GOOGLE_PLACES_API_KEY: 'k' },
    fetchImpl: fakeFetch(() => ({ body: PLACE_RES })) });
  assert.match(out.hook, /trouble reaching Bistro Uno by phone/);
  assert.equal(out.by, 'rules'); assert.equal(out.confidence, 'high');
  assert.ok(out.evidence.some((e) => /nobody picked up/.test(e.detail)));
  assert.equal(out.place.rating, 4.1);
});

test('rules: no complaints → hours gap; nothing → null', () => {
  const h = ruleHook({ reviews: [], hours: ['Sunday: Closed'], rating: 4.5, reviews_count: 10 }, 'X');
  assert.match(h.hook, /closed Sunday/);
  assert.equal(ruleHook({ reviews: [], hours: ['Monday: 9:00 AM – 11:00 PM'], rating: 5 }, 'X'), null);
});

test('AVA: uses Claude when a key is set and parses its JSON; no keys and no notes → asks for the Google key', async () => {
  const out = await findHook({ bizName: 'Bistro Uno', city: 'Toronto', crmNotes: '', env: { GOOGLE_PLACES_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' },
    fetchImpl: fakeFetch((url, init) => url.includes('anthropic')
      ? (assert.match(JSON.parse(init.body).messages[0].content, /nobody picked up/), { body: { content: [{ text: '{"hook":"They miss booking calls","evidence":[{"source":"Google review","detail":"nobody picked up the phone"}],"opening":"I saw a review…","confidence":"high"}' }] } })
      : { body: PLACE_RES }) });
  assert.equal(out.by, 'ava'); assert.equal(out.hook, 'They miss booking calls');
  const none = await findHook({ bizName: 'X', city: '', crmNotes: '', env: {} });
  assert.equal(none.missing, 'google_key');
});
