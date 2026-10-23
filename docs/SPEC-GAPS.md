# Spec gaps

Operations the CLI does not expose yet, or API behaviour the vendored spec does not describe. Add an entry instead of
guessing. Format: `operationId` (api) — why — what is needed.

- number tags (voice) — the Vobiz MCP server replaces a number's tags with `PATCH /api/v1/Account/{auth_id}/numbers/{e164}` (`{tags}`), but the spec has no `update-number` operation, so `vobiz numbers update` has no `--tags`. Needed: that operation in `openapi.yaml`.

### Voice (account, calls, conferences, recordings, cdr)

- `calls transfer` (voice) — the docs describe transfer as `POST /api/v1/Account/{auth_id}/Call/{call_uuid}/` (`legs`, `aleg_url`, `aleg_method`, `bleg_url`, `bleg_method`, returns 202), but the spec defines only `GET` on that path (`get-queued-call`). Needs a `transfer-call` operation in `openapi-voice.yaml` before the CLI exposes it.
- `make-call` (voice) — the request schema lists only `from`, `to`, `answer_url`, `answer_method`; the example also sends `time_limit`, and the docs mention `ring_url`/`hangup_url`. The CLI sends only the four schema fields. Needs the optional fields in the schema to add `--time-limit`, `--ring-url`, `--hangup-url` and friends.
- `make-call` idempotency (voice) — `calls create` would send a per-invocation idempotency key (`--idempotency-key`, as `sms send` does), but the voice spec defines no idempotency header or field, so the CLI sends none. Needs the header name and replay semantics.
- `calls create --say/--play` hosted XML (voice) — there is no Vobiz endpoint that hosts an answer XML document, so the CLI offers `--xml-only` (print it) and `--serve --public-url` (local server behind the user's tunnel). Follow-up: a hosted option once Vobiz offers one (or reuse an Application's answer URL).
- `list-streams`, `get-stream` (voice) — no response schema; the CLI prints the body as returned.
- `cdr list --status` (voice) — `list-cdrs` has no status filter; the CLI offers `--hangup-cause` and `--disposition` instead.
- `export-cdrs` (voice) — the description says not to send `Accept: application/json`; the CLI streams this endpoint itself with `Accept: text/csv` instead of using the JSON client.
- `list-numbers` (voice) — there is no single-number `GET /numbers/{e164}`; `vobiz numbers get` calls list-numbers with `search=<e164>` and keeps the exact match. Needed: a retrieve-number operation.
- `unrent-number` (voice) — for a `numbers release --at-period-end`, the spec only offers the default 24-hour cancellable cooldown or `immediate=true`, so the CLI exposes `--immediate` instead. Needed: an end-of-billing-period release option, if the API has one.
- `list-inventory-numbers` (voice) — no number-type (local/mobile/toll-free) or capability (voice/sms) filter, so `numbers search` has only `--country`, `--contains` and `--exclude`. Needed: `type` / `features` query params, if the API supports them.
- `list-customer-cdrs` (voice) — has `per_page` but no `page`/`offset`, so only the first page is reachable and `--all` cannot page. Needed: the paging parameter the endpoint accepts.
- `list-trunks`, `list-credentials`, `list-ip-acls`, `list-origination-uris`, `list-subaccounts` (voice) — responses carry `meta.limit/offset/total` but no `limit`/`offset` query params are declared, so the CLI fetches one page. Needed: the paging params, if the endpoints accept them.
- `create-credential`, `create-endpoint` (voice) — the spec examples return `password: "<redacted>"`; whether the API ever echoes the password in clear is undocumented. The CLI shows a returned password once on stderr only when it is not already redacted. Needed: document the create response.

### Agent ops (diagnose, streams, setup)

- `list-recordings` (voice) — declares only `limit`/`offset`, no `call_uuid` filter, so `vobiz diagnose call` scans the newest recordings (`--scan`, default 200) and matches `call_uuid` itself. Needed: a `call_uuid` query param (the bulk export body already has one).
- `list-streams` (voice) — on a finished call the endpoint answered an error instead of the stopped streams the docs describe ("active + stopped"), so `diagnose call` lists streams only for live/queued calls and reports `streaming_cost` from the call record otherwise. Needed: confirm whether stopped streams stay listable after hangup, and a response schema.
- Stream WebSocket `clearedAudio` (docs) — `xml/stream/stream-events` shows `{event, streamId}`, while the `vobiz-audio-streams` skill lists `{event, streamId, sequenceNumber}`. `vobiz streams test` sends the page's shape. Needed: one documented shape (and whether `playedStream`, documented as `{event, name}`, also carries `sequenceNumber`).
- Stream WebSocket end of stream (docs, not a gap) — Vobiz sends no inbound `stop` event; the socket close is the end-of-stream signal, so `streams test` closes the socket after the last `media` frame instead of sending a `stop`.

## Messaging API (`vobiz sms`)

All 78 sms operations have a command. Gaps and behaviour the spec does not fully describe:

- `upload-recipients` (sms) — the description says the endpoint also takes JSON `{numbers, defaultCountry}`, but the
  requestBody declares only `multipart/form-data`. `sms broadcasts recipients upload --number …` sends that JSON
  form on the strength of the description. Needed: an `application/json` alternative in the requestBody.
- `purchase-number` (sms) — there is no way to price one known number: `search-available-numbers` returns at most 10
  numbers, so `sms numbers buy` re-searches (by country, plus area code for US/CA) and shows the price only when the
  number appears; otherwise the confirmation says the price was not found. Needed: an `e164` filter on
  `GET /numbers/available` or a quote endpoint.
- `launch-broadcast` (sms) — no cost estimate for a broadcast; the launch confirmation shows pending recipients and
  `estimatedSegments` from `preview-broadcast`, not a price. Needed: a cost field on preview (or a broadcast
  cost-preview).
- `update-brand` / `update-campaign` (sms) — full replacements, but `get-brand` returns `address` as an object while
  the request takes a string, so a GET cannot be fed back into the PUT unchanged. The CLI asks for the whole body
  (`--body @brand.json`) and warns that omitted fields are cleared. Needed: matching request/response shapes or a
  PATCH.
- `remove-campaign-numbers` (sms) — a DELETE with a JSON body (the core client sends a body on DELETE only when the
  operation is given one). Some proxies drop DELETE bodies; a POST alias (e.g. `/numbers/remove`) would be safer.

### Live verification 2026-10-22

Closed by later spec corrections: origination URI `uri`/`description`, endpoint `app_id` and username suffix, partial `update-application`, trunk status `active`/`suspended`, recording download auth and content type, partner 401 for non-partners, SMS webhook zero `createdAt`. Still open:

- `create-ip-acl` / `update-ip-acl` (voice) — the spec example now avoids the refused documentation range and responses document `description`, but the request label field is still `name` in the spec and unverified live (create was refused before an entry existed). Needed: confirm whether the API reads `name` or `description` on create/update.
- `update-subaccount` (voice) — the spec now documents `is_active` (and `vobiz sub-accounts update --no-active` sends it), but a sub-account with `is_active: false` answers 404 on get/update/delete and leaves the list, so it cannot be reactivated through the API. Needed: whether this is a soft delete, and a way to reactivate.
- `mock-*-subaccount-*` (voice, Test Mode KYC) — every `/api/v1/sub-accounts/test/{sub_auth_id}/kyc/*` route answers 404 `Not Found` on `api.vobiz.ai` (URLs match the spec exactly), so `vobiz sub-accounts kyc --test …` cannot be used. Needed: deploy the routes or document where Test Mode lives.
- `create-application` / `retrieve-application` (voice) — a GET right after create returned `created_at: null`, `sub_account` set and `fallback_answer_url: ""`; the next read returned the normal record. Needed: read-after-write consistency, or a note.
