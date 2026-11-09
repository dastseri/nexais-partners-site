# NexAIS Partners Hub — Secure Send History

**Standalone**: no CRM login, CRM data, new public signup or outbound sending. Owners centrally provision partner accounts using `tools/create-partner-user.js`. Existing manual activity log and its Google Sheet sync payload remain untouched.

## Why the server is required
This repo is **public**, and the old `index.html` shipped all phone numbers and a reusable browser-side shared key. Both the card HTML and new correspondence body text are private business information. `server.js` protects the entire hub page, images, and `GET /api/sends` with a signed HttpOnly session cookie. The new server, not the historical Render Static Site, must serve `partner.nexais.ca` after secure cutover.

**Never commit `private/sends.jsonl`, `private/users.json`, exported Jarvis CSV, raw `.eml`, or private status event files to any Git branch.** Git history is not a secure store even if a public repo is later made private. The `private/` directory is gitignored. Actual records and users must live in a persistent, nonpublic service directory (or an explicitly private mounted secret volume), outside the HTTP webroot.

## Production environment (no credentials in repo)
- `NODE_ENV=production`
- `PORT` from hosting provider
- `PARTNERS_SESSION_SECRET`: cryptographically random >= 32 bytes, retained between deploys (changing it signs everyone out)
- `PARTNERS_USERS_FILE=/secure/partners-users.json` (or `PARTNERS_USERS_JSON` environment JSON)
- `PARTNERS_SENDS_PATH=/secure/sends.jsonl`
- `PARTNERS_SEND_STATUS_PATH=/secure/send-status-events.jsonl` (optional; default is alongside sends)
- Serve only via HTTPS on your existing partner domain. No CRM URL or credentials.

Deploy a private instance with persistent encrypted storage. Provision accounts before cutover; no self-signup exists. Production must not use the shared team key, the Static Site host, or public GitHub data file. Configure network ACL and operations backups of the private ledger. The web app has no write endpoint; only signed-in users can read it.

## Import existing REAL correspondence
1. Use the original Jarvis Hub workbook (XLSX) or export only the original **مکاتبات** tab to a private UTF-8 CSV. The source stays read-only; do not change the Sheet or the existing activity sync.
2. Optional: make the original `correspondence-log.md` available locally, and supply a directory of actual outbound `.eml` files if full bodies must be recovered. Never reconstruct a body from a summary.
3. Run from a trusted machine:
   ```bash
   python3 tools/import-sends.py --xlsx /secure/jarvis-hub.xlsx --mirror /secure/correspondence-log.md --eml-dir /secure/sent-eml --out /secure/sends.jsonl --report /secure/sends-import-report.json
   ```
   Use `--csv /secure/jarvis-correspondence.csv` instead of `--xlsx` when the original workbook is unavailable. Omit `--mirror` or `--eml-dir` if those source files are not available. Both formats parse the same seven Jarvis fields; they must be tested against real source exports before a production migration. The importer is idempotent against existing `id`, provider `message_id`, and same-day business/stage/recipient fallback. Missing exact sent text stays `body_text:""`; the interface says it was not archived. Unknown or ambiguous dates and times are not presented as verified times.
4. Inspect report and unmatched business names. Records not matching existing cards still appear in global Sends; do not guess contact phones.

**Caution:** the Jarvis register includes communications for other businesses/projects; review approved audience and scope before importing them for partner visibility. By default the importer skips rows tagged ZhioStudio, Tibox, or mixed NexAIS/ZhioStudio and reports their count as excluded. Importing those other projects requires an explicit admin decision and the `--include-other-projects` flag. Review industry-tagged rows as well before partner access. Skipped rows remain unchanged in the original Jarvis register.

## Capture new sends at HQ
After an email is really sent, export an exact JSON record with the sent body (not a draft) using the schema from the issue. Append:
```bash
python3 tools/append-send.py --record /secure/actual-send.json --out /secure/sends.jsonl
```
Provider delivery/bounce/reply updates are separate append-only events:
```json
{"event_id":"provider-event-id","send_id":"existing-send-id","at":"2026-11-09T15:45:00-05:00","status":"replied","reply_note":"Meeting requested","replied_at":"2026-11-09T15:45:00-05:00"}
```
```bash
python3 tools/append-send.py --event /secure/status-event.json --out /secure/sends.jsonl
```
No automatic send from Partners Hub; no Sheet payload updates. Subsequent imports do not overwrite prior entries.

## Accounts
Owner/admin creates users outside the app:
```bash
PARTNERS_NEW_PASSWORD='[secure input]' node tools/create-partner-user.js --user zhaleh --role admin --file /secure/partners-users.json
PARTNERS_NEW_PASSWORD='[secure input]' node tools/create-partner-user.js --user salespartner --role partner --file /secure/partners-users.json
```
Do NOT put real passwords on shell command lines, in source control, or into logs. Prefer protected stdin or a securely injected environment secret.

## QA / rollout gates
`npm test` then verify authenticated EN/FA mobile screens, actual Nov 9 York Radiology source linkage, full verbatim body when archival EML exists, missing body empty state, dedupe on repeated import, and private data not downloadable anonymously. Validate current deployed behavior before changing routing. Do not merge or move the production domain until the owner approves cutover and real-data authorization.

Rollback: restore the prior service/domain target; keep the new private ledger securely, not as a public static asset. No customer emails should be sent by this release.

## Verified facts at task creation
As inspected on Nov 9, 2026: default `main` contains one large `index.html`, an embedded shared-key gate, and a separate Google Sheet activity sync; PR #1 proposes CRM-based authentication but is not merged. This feature uses no PR #1 CRM integration. The Jarvis `مکاتبات` tab has 259 nonheader rows in the inspected first 260 rows. Some entries include unrelated ZhioStudio mail, so migration must be reviewed for intended Partner Hub scope. The Nov 9 York Radiology register entry is present but not itself a source of the complete body text.
