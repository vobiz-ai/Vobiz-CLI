# Spec gaps

Operations the CLI does not expose yet, or API behaviour the vendored spec does not describe. Add an entry instead of
guessing. Format: `operationId` (api) — why — what is needed.

- number tags (voice) — the Vobiz MCP server replaces a number's tags with `PATCH /api/v1/Account/{auth_id}/numbers/{e164}` (`{tags}`), but the spec has no `update-number` operation, so `vobiz numbers update` has no `--tags`. Needed: that operation in `openapi.yaml`.

### Voice (W2: account, calls, conferences, recordings, cdr)

- `calls transfer` (voice) — the docs describe transfer as `POST /api/v1/Account/{auth_id}/Call/{call_uuid}/` (`legs`, `aleg_url`, `aleg_method`, `bleg_url`, `bleg_method`, returns 202), but the spec defines only `GET` on that path (`get-queued-call`). Needs a `transfer-call` operation in `openapi-voice.yaml` before the CLI exposes it.
- `make-call` (voice) — the request schema lists only `from`, `to`, `answer_url`, `answer_method`; the example also sends `time_limit`, and the docs mention `ring_url`/`hangup_url`. The CLI sends only the four schema fields. Needs the optional fields in the schema to add `--time-limit`, `--ring-url`, `--hangup-url` and friends.
- `make-call` idempotency (voice) — PLAN §3 asks `calls create` to send a per-invocation idempotency key (`--idempotency-key`), but the voice spec defines no idempotency header or field, so the CLI sends none. Needs the header name and replay semantics.
- `calls create --say/--play` hosted XML (voice) — there is no Vobiz endpoint that hosts an answer XML document, so the CLI offers `--xml-only` (print it) and `--serve --public-url` (local server behind the user's tunnel). Follow-up: a hosted option once Vobiz offers one (or reuse an Application's answer URL).
- `list-streams`, `get-stream` (voice) — no response schema; the CLI prints the body as returned.
- `cdr list --status` (voice) — PLAN §4 lists `--status`, but `list-cdrs` has no status filter; the CLI offers `--hangup-cause` and `--disposition` instead.
- `export-cdrs` (voice) — the description says not to send `Accept: application/json`; the CLI streams this endpoint itself with `Accept: text/csv` instead of using the JSON client.
- `list-numbers` (voice) — there is no single-number `GET /numbers/{e164}`; `vobiz numbers get` calls list-numbers with `search=<e164>` and keeps the exact match. Needed: a retrieve-number operation.
- `unrent-number` (voice) — PLAN §4 asks for `numbers release --at-period-end`; the spec only offers the default 24-hour cancellable cooldown or `immediate=true`, so the CLI exposes `--immediate` instead. Needed: an end-of-billing-period release option, if the API has one.
- `list-inventory-numbers` (voice) — no number-type (local/mobile/toll-free) or capability (voice/sms) filter, so `numbers search` has only `--country`, `--contains` and `--exclude`. Needed: `type` / `features` query params, if the API supports them.
- `list-customer-cdrs` (voice) — has `per_page` but no `page`/`offset`, so only the first page is reachable and `--all` cannot page. Needed: the paging parameter the endpoint accepts.
- `list-trunks`, `list-credentials`, `list-ip-acls`, `list-origination-uris`, `list-subaccounts` (voice) — responses carry `meta.limit/offset/total` but no `limit`/`offset` query params are declared, so the CLI fetches one page. Needed: the paging params, if the endpoints accept them.
- `create-credential`, `create-endpoint` (voice) — the spec examples return `password: "<redacted>"`; whether the API ever echoes the password in clear is undocumented. The CLI shows a returned password once on stderr only when it is not already redacted. Needed: document the create response.

### Agent ops (W9: diagnose, streams, setup)

- `list-recordings` (voice) — declares only `limit`/`offset`, no `call_uuid` filter, so `vobiz diagnose call` scans the newest recordings (`--scan`, default 200) and matches `call_uuid` itself. Needed: a `call_uuid` query param (the bulk export body already has one).
- `list-streams` (voice) — on a finished call the endpoint answered an error instead of the stopped streams the docs describe ("active + stopped"), so `diagnose call` lists streams only for live/queued calls and reports `streaming_cost` from the call record otherwise. Needed: confirm whether stopped streams stay listable after hangup, and a response schema.
- Stream WebSocket `clearedAudio` (docs) — `xml/stream/stream-events` shows `{event, streamId}`, while the `vobiz-audio-streams` skill lists `{event, streamId, sequenceNumber}`. `vobiz streams test` sends the page's shape. Needed: one documented shape (and whether `playedStream`, documented as `{event, name}`, also carries `sequenceNumber`).
- Stream WebSocket end of stream (docs, not a gap) — Vobiz sends no inbound `stop` event; the socket close is the end-of-stream signal, so `streams test` closes the socket after the last `media` frame instead of sending a `stop`.

## Messaging API (`vobiz sms`, W4)

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
- `remove-campaign-numbers` (sms) — a DELETE with a JSON body. The core client sends bodies only with POST/PUT/PATCH,
  so the sms module sends this one request itself (`deleteWithBody` in `src/commands/sms/shared.ts`). Some proxies
  drop DELETE bodies; a POST alias (e.g. `/numbers/remove`) would be safer.
- `update-application` (voice) — the description says any subset of fields can be updated, but the request schema still marks `app_name` and `default_number_app` required, so `vobiz apps update` asks for both unless `--body` is used. Needed: confirm the partial-update behaviour and drop the `required` list.

### Live verification 2026-10-22 (W13, account B; details in `docs/internal/LIVE-REVIEW-2026-10-22.md`)

- `create-origination-uri` / `update-origination-uri` (voice) — the spec's request fields `sip_uri` and `name` are accepted with 200 but silently ignored (the URI is stored with `uri: ""`, `description: ""`); the live API reads `uri` and `description`, the names the response already uses. `vobiz trunks origination-uris create` therefore creates an empty URI unless `--body '{"uri":…,"description":…}'` is added. Needed: request schema `uri` / `description` (and `weight`, `transport` if settable).
- `create-endpoint` / `update-endpoint` (voice) — `application` is typed `integer`, but application ids are 17-digit strings (beyond 2^53, not representable as a JSON number), and a string `application` is ignored (endpoint created with `application: null`). The live API links the app through `app_id` (string). The CLI now explains the refusal and its help example uses `--body '{"app_id":"…"}'`. Needed: `app_id: string` in both request schemas.
- `update-application` (voice) — confirmed live: a body with only `answer_url` updates just that field. The `required: [app_name, default_number_app]` list is wrong; dropping it lets `vobiz apps update` accept single flags.
- `create-ip-acl` (voice) — the API refuses `203.0.113.0/24` with 400 "documentation-only test network", while the spec example uses that range; list responses carry `description`, not the request's `name` (likely the same mismatch as origination URIs; not verifiable without whitelisting a real IP). Needed: a non-reserved example and the real request field names.
- `create-trunk` / `update-trunk` (voice) — `trunk_status` takes `enabled` / `disabled` but responses report `active` / `suspended`. Needed: document the response enum and the mapping.
- `update-subaccount` (voice) — `enabled: false` is accepted with 200 and ignored. An undocumented `is_active: false` hides the sub-account (subsequent get/update/delete answer 404). Needed: the real field for disabling a sub-account, and whether `is_active` is a soft delete.
- `mock-*-subaccount-*` (voice, Test Mode KYC) — every `/api/v1/sub-accounts/test/{sub_auth_id}/kyc/*` route answers 404 `Not Found` on `api.vobiz.ai` (URLs match the spec exactly), so `vobiz sub-accounts kyc --test …` cannot be used. Needed: deploy the routes or document where Test Mode lives.
- `get-recording` / media download (voice) — `recording_url` points at `https://media.vobiz.ai/…`, which answers 401 without `X-Auth-ID`/`X-Auth-Token` and 200 with them, and serves a RIFF/WAVE body as `Content-Type: audio/mpeg`. The CLI now sends credentials to `media.vobiz.ai` only. Needed: document the auth requirement and the content type.
- `partner-me`, `partner-dashboard` (voice) — a valid non-partner account gets `401 Not authenticated`, indistinguishable from bad credentials. Needed: a 403 "not a partner".
- `create-webhook` (sms) — the create response has `createdAt: "0001-01-01T00:00:00Z"` (Go zero time); `list-webhooks` shows the real time. Needed: return the stored timestamp.
- `create-application` / `retrieve-application` (voice) — a GET right after create returned `created_at: null`, `sub_account` set and `fallback_answer_url: ""`; the next read returned the normal record. Needed: read-after-write consistency, or a note.
- `create-endpoint` (voice) — the API appends random digits to the requested `username` (`cliverifyep01` became `cliverifyep125672327435497`). Needed: document it, since SIP clients must use the returned username.
