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
