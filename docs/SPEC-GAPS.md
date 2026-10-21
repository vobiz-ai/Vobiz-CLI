# Spec gaps

Operations the CLI does not expose yet, or API behaviour the vendored spec does not describe. Add an entry instead of
guessing. Format: `operationId` (api) — why — what is needed.

- `list-numbers` (voice) — there is no single-number `GET /numbers/{e164}`; `vobiz numbers get` calls list-numbers with `search=<e164>` and keeps the exact match. Needed: a retrieve-number operation.
- `unrent-number` (voice) — PLAN §4 asks for `numbers release --at-period-end`; the spec only offers the default 24-hour cancellable cooldown or `immediate=true`, so the CLI exposes `--immediate` instead. Needed: an end-of-billing-period release option, if the API has one.
- `list-inventory-numbers` (voice) — no number-type (local/mobile/toll-free) or capability (voice/sms) filter, so `numbers search` has only `--country`, `--contains` and `--exclude`. Needed: `type` / `features` query params, if the API supports them.
- `list-customer-cdrs` (voice) — has `per_page` but no `page`/`offset`, so only the first page is reachable and `--all` cannot page. Needed: the paging parameter the endpoint accepts.
- `list-trunks`, `list-credentials`, `list-ip-acls`, `list-origination-uris`, `list-subaccounts` (voice) — responses carry `meta.limit/offset/total` but no `limit`/`offset` query params are declared, so the CLI fetches one page. Needed: the paging params, if the endpoints accept them.
- `create-credential`, `create-endpoint` (voice) — the spec examples return `password: "<redacted>"`; whether the API ever echoes the password in clear is undocumented. The CLI shows a returned password once on stderr only when it is not already redacted. Needed: document the create response.
