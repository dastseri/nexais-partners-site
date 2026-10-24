# partner.nexais.ca — cutover to server login

Until cutover, `main` keeps deploying the hub as a public Static Site. This branch adds a
Node server that serves the hub **only after sign-in** with a CRM account. The hub page
(`index.html`) is not modified; the server injects `/app/hub-bridge.js`.

## Who can enter
| Role | Rule (decided by the CRM's row-level security) | Sees |
|---|---|---|
| admin | platform admin in the CRM | everything |
| team | company staff of NexAIS (e.g. `sales_manager`) | the call hub (full prospect list), `/team` console, all NexAIS missions and activity |
| partner | active NexAIS `sales_agents` row | `/my` only: own missions; call/SMS only when an admin grants it; never the hub prospect list |
| anyone else | — | login page / "No access", never the hub |

## Cutover steps (owner approval required)
0. Apply CRM PR #316 (consent records, commission link, trusted import rule) to production.
1. Supabase → Authentication → URL configuration: add `https://partner.nexais.ca/reset` to the redirect allow-list.
2. Render → New → Web Service from `dastseri/nexais-partners-site` (or apply `render.yaml`). Set env vars:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key), `PARTNER_COMPANY_ID`, `PUBLIC_ORIGIN=https://partner.nexais.ca`.
3. Deploy, open the `*.onrender.com` URL, sign in as admin, team and a test partner; log one call.
4. Move the custom domain `partner.nexais.ca` from the Static Site to the Web Service; then suspend the Static Site.
5. Confirm the public URL shows the login page when signed out.
6. Make the GitHub repository private (Render keeps deploying from a private repo).

## Data on cutover day
- **Import the 57 call cards as missions** (after step 3, before inviting partners):
  `python3 tools/import-hub-cards.py index.html out e46c9020-1e73-4322-9aef-7292df930215` writes `out/hub-cards.json` (review) and `out/hub-cards.sql`.
  The SQL is idempotent (skips businesses that already have an open mission). Dry run on 2026-10-24: 57 cards → 57 missions (M-0001…M-0057), 0 duplicates, 57 with phone, 54 with proposal link. Tested twice on a copy: second run adds nothing.
  Contact names go into `partner_summary`, readable only by the team and the assigned partner.
- **Import calls logged before cutover** (after the card import): download the Sheet's *Activity* tab as CSV, then
  `python3 tools/import-sheet-activity.py activity.csv names.json e46c9020-1e73-4322-9aef-7292df930215 out` and run `out/sheet-activity.sql` as admin.
  `names.json` maps typed names to CRM users, e.g. `{"Sogol": "<user id>"}`. The tool drops duplicates and test rows, keeps only the final note of each typing burst, and collapses status mis-clicks within 2 minutes. On the 2026-10-24 Sheet: 16 rows became 6 clean entries on M-0001/M-0002, with the original person and device time. Idempotent (tested twice on a copy).
  Needs CRM PR #316 applied first (trusted imports keep the original person and time).
- After sign-in, the bridge sends each entry under the signed-in person's name. Notes are held 20 seconds and only the final version is sent, so half-typed notes never reach the CRM.
- The Google Sheet sync keeps working as a secondary copy; its URL and token are no longer public because the page is behind login.

## Local run
```bash
npm ci
SUPABASE_URL=… SUPABASE_ANON_KEY=… PARTNER_COMPANY_ID=… PUBLIC_ORIGIN=http://localhost:3000 INSECURE_COOKIES=1 npm start
npm test
```
