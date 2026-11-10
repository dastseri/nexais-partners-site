# Partners Hub Send History — Implementation and Release Gate

**Date:** 2026-11-09 (America/Toronto)  
**Status:** IN REVIEW — not deployed. Draft PR #3, Issue #2.

## Actual data inventory (private archive; no records committed)
- 245 raw outbound correspondence candidates from the read-only Jarvis Hub workbook; 12 contain explicit failed, unconfirmed or pending DM evidence and are held separately. The safer feed contains 233 entries, pending source-level reconciliation.
- 85 distinct business names in the usable feed.
- In the original 245-row import, 207 had phone copied from known card data; 38 had no phone. **No missing number was invented.** Exact counts must be recalculated after quarantining 12 entries.
- 164 records in the usable feed have a recorded provider/Gmail message identifier.
- 0 duplicate send ids; 0 duplicate non-empty message ids.
- ISO 8601 Toronto offset confirmed on all 245 records.
- Do not treat absence of an explicit bounce as proof of delivery. Original 245-record extraction labeled 243 sent and 2 bounced, but 12 source entries were later found to be unconfirmed/failed DM attempts and are removed from the safer feed.
- No original verbatim email body or independently verified original subject in the current imported send-history data. The UI must explicitly show "not archived", not a fabricated message.
- Import source remains immutable; source metadata and unmatched/uncertain records stay in the private migration report.

## Code delivered on branch
- Authenticated read-only `/api/sends`, complete send detail per card, global filtered feed, explicit verified business-name aliases, all five stage indicators, EN/FA labels and mobile layout.
- Private append-only JSONL readers, status update sidecar, idempotent real-source importer accepting XLSX or CSV and optional raw `.eml` messages for actual exact plaintext.
- Privately provisioned standalone accounts; no CRM integration, no new self-signup, no UI writes or outbound sends.
- Existing manual action history and Google Sheet activity-sync payload have not been changed.
- GitHub Actions CI checks Node integration tests, Python import idempotency tests, syntax checks and private-file commit exclusion.

## Directly verified deployment facts
- The live Render service named `nexais-partners-site` is a **Static Site**, branch `main`; it cannot safely serve private send-history JSONL with true session authentication.
- The GitHub repository is **public**, and existing `index.html` already contains business contact data. New real sends were never added to this public repository.
- Separate PR #1 proposes a CRM-backed authentication system, incompatible with the current standalone/no-CRM instruction unless specifically redesigned.
- The Render Growth outbound database exists, but read-only tool access failed because of external database network/SSL restrictions. No allowlist or credentials were altered.

## Required release gates
1. **Privacy:** owner approves a private code/data strategy. The repository's existing business contact information must not remain exposed in publicly accessible Git history; a protected runtime alone cannot protect existing Git history. Do not put the actual archive in Git.
2. **Authentication:** standalone account provisioning for Zhaleh as admin and approved partners, successful login, logout, revocation and mobile session QA.
3. **Durable private storage:** approved persistent secure file store / database outside public assets, mounted to the web service, backup and recovery plan. Use the reconciled 233-row feed, not the raw 245-row candidate ledger. No new paid resource is authorized by this task.
4. **Live data:** import and verify the private 245-entry archive on the secured service, review access scope, and reconcile missing phone data; recover exact `.eml` or provider emails if available. Keep blank text and subject honest.
5. **Acceptance:** verify York Radiology Nov 9 record, stage/status metadata, date precision, attachment only if proven, body text only when genuinely archived; verify global filters, mobile RTL, 5-stage counts, zero duplicates and sheet-sync regression.
6. **Release authorization:** explicit owner approval before merge, DNS cutover or production deployment. Rollback to old static site only if privacy risk has been addressed; do not continue exposing confidential business information.

## QA evidence
- CI run [42704872849](https://github.com/dastseri/nexais-partners-site/actions/runs/42704872849) passed after implementing XLSX parsing and distinct-same-day idempotency tests.
- Latest code changes require corresponding CI review before release.
- No production login, end-to-end authenticated use or deployed commit verification has yet occurred.

**Decision:** BLOCKED for production; implementation remains IN REVIEW until storage, privacy, authorization and complete-source evidence gates are met.

## Follow-up correction
On re-audit, 12 historical Instagram DM attempts had explicit pending, failed or unknown delivery evidence. They were segregated into a separate protected verification-hold ledger; do not display them as confirmed sends. The Import script now quarantines these statuses on fresh imports, with tests. The 233 remaining entries are candidates for history display, **not** independent provider-delivery confirmations. Internal Jarvis notes are removed by the API field allowlist.

## Second-pass validation
- Source ledger remains unchanged at 245 candidate entries; 12 explicit DM non-deliveries/uncertain attempts are held outside the display ledger. The protected revised display ledger contains 233 entries across 85 businesses: 194 email, 37 Instagram DM, 2 web form.
- Known existing-card phones are present on 196 of these 233 entries. Full sent bodies and independently verified original subjects remain absent in all 233.
- The importer now preserves the `dm` channel and quarantines explicit non-confirmed sends, with a dedicated regression test.
- API responses omit imported internal `source_summary` and generic operational `status_note` for ordinary sends. It is still necessary to review status/reply notes before sharing with all partners.
- Latest code must continue to pass CI and real authenticated mobile QA; no production cutover is authorized.

## November 10, 2026 — access review
- Fixed the new sends API to enforce administrator-provisioned `business_slugs` for partner accounts; unassigned users get no send-history rows, admin role can read the entire approved feed, and changing assignments applies on the next request.
- Owner-side offline user-provisioning utility accepts validated `--business-slugs` without public self-registration. Auth stays standalone, no CRM endpoints.
- [GitHub Actions run 42902789139](https://github.com/dastseri/nexais-partners-site/actions/runs/42902789139) passed, including the scoped-data and revocation regression test.
- **Residual privacy risk:** pre-existing `index.html` still embeds a shared cross-partner call list, including phone numbers. Filtering the new send-history API does not isolate that legacy HTML. Protecting all business details per partner would need a separate design/authorization review before release.
- Repo remains public and live Render service remains a Static Site until separately approved cutover. No live account provisioning or real-data upload has been done.

## November 10 — legacy card HTML scoping (non-production branch)
- Server now removes unassigned `<article class="card">` blocks from the HTML before responding to partner sessions; administrator receives the full existing hub. It also removes the legacy static research queue script containing other business contact entries from partner HTML. Malformed or changed card extraction returns a 503, not an unfiltered HTML page.
- Test: [GitHub Actions 42907599875](https://github.com/dastseri/nexais-partners-site/actions/runs/42907599875), passed. A partner assigned only Copper Creek did not receive the Richmond Hill card or the known static research-queue email addresses.
- **Residual limitation:** this is a targeted hardening, NOT a complete noninterference audit of all legacy inline JS/static markup, locally cached activity, generated proposals or partner-owned leads. Full partner data segregation and site-wide manual activity authorization remain a release gate. No deployment or production credential changes.

## November 10 — browser activity isolation
- In the protected partner page, account identity and role are injected by the server before legacy scripts run. Partner-specific call-log, activity-log, selected user, Sheet retry queue and backfill marker use a distinct browser-storage namespace. Administrators retain existing legacy keys; no historical admin data is deleted or rewritten.
- HTML cards are filtered server-side and the static cross-business research queue script is stripped for partner sessions. These are targeted security hardenings; legacy in-page scripts and other data paths still require a full data-exposure audit before production.
- The Google Sheet activity JSON schema (`{token, entries: batch}`) was not altered.
- GitHub Actions [42907881182](https://github.com/dastseri/nexais-partners-site/actions/runs/42907881182) passed after account-state separation checks. No production auth, storage, domain or account settings were changed.
