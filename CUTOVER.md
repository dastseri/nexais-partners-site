# partner.nexais.ca — cutover to server login

Until cutover, `main` keeps deploying the hub as a public Static Site. This branch adds a
Node server that serves the hub **only after sign-in** with a CRM account. The hub page
(`index.html`) is not modified; the server injects `/app/hub-bridge.js`.

## Who can enter
| Role | Rule (decided by the CRM's row-level security) | Sees |
|---|---|---|
| admin | platform admin in the CRM | everything |
| team | company staff of NexAIS (e.g. `sales_manager`) | all NexAIS missions and activity |
| partner | active NexAIS `sales_agents` row | only own missions; call/SMS only when an admin grants it |
| anyone else | — | login page / "No access", never the hub |

## Cutover steps (owner approval required)
1. Supabase → Authentication → URL configuration: add `https://partner.nexais.ca/reset` to the redirect allow-list.
2. Render → New → Web Service from `dastseri/nexais-partners-site` (or apply `render.yaml`). Set env vars:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key), `PARTNER_COMPANY_ID`, `PUBLIC_ORIGIN=https://partner.nexais.ca`.
3. Deploy, open the `*.onrender.com` URL, sign in as admin, team and a test partner; log one call.
4. Move the custom domain `partner.nexais.ca` from the Static Site to the Web Service; then suspend the Static Site.
5. Confirm the public URL shows the login page when signed out.
6. Make the GitHub repository private (Render keeps deploying from a private repo).

## Data on cutover day
- Results logged on each device before cutover stay in the device log and in the Google Sheet. They are imported into the CRM once, by the admin, keeping the original typed names as notes. The bridge only sends entries created after sign-in, under the signed-in person's name.
- The Google Sheet sync keeps working as a secondary copy; its URL and token are no longer public because the page is behind login.

## Local run
```bash
npm ci
SUPABASE_URL=… SUPABASE_ANON_KEY=… PARTNER_COMPANY_ID=… PUBLIC_ORIGIN=http://localhost:3000 INSECURE_COOKIES=1 npm start
npm test
```
