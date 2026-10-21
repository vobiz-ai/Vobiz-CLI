# Spec gaps

Operations the CLI does not expose yet, or API behaviour the vendored spec does not describe. Add an entry instead of
guessing. Format: `operationId` (api) — why — what is needed.

- `link-number-to-application` / `unlink-number-from-application` (voice) — `POST` and `DELETE /api/v1/Account/{auth_id}/numbers/{e164}/application` with body `{application_id}` are used in production by the Vobiz MCP server (`update_phone_number`) but are missing from `openapi.yaml`, so the CLI has no `numbers update --app` yet. Needed: add both operations (and the number tags update the same tool performs) to the docs repo's `openapi.yaml`, then `npm run spec:sync` and implement `numbers update`.

### Voice (W2: account, calls, conferences, recordings, cdr)

- `calls transfer` (voice) — the docs describe transfer as `POST /api/v1/Account/{auth_id}/Call/{call_uuid}/` (`legs`, `aleg_url`, `aleg_method`, `bleg_url`, `bleg_method`, returns 202), but the spec defines only `GET` on that path (`get-queued-call`). Needs a `transfer-call` operation in `openapi-voice.yaml` before the CLI exposes it.
- `make-call` (voice) — the request schema lists only `from`, `to`, `answer_url`, `answer_method`; the example also sends `time_limit`, and the docs mention `ring_url`/`hangup_url`. The CLI sends only the four schema fields. Needs the optional fields in the schema to add `--time-limit`, `--ring-url`, `--hangup-url` and friends.
- `make-call` idempotency (voice) — PLAN §3 asks `calls create` to send a per-invocation idempotency key (`--idempotency-key`), but the voice spec defines no idempotency header or field, so the CLI sends none. Needs the header name and replay semantics.
- `calls create --say/--play` hosted XML (voice) — there is no Vobiz endpoint that hosts an answer XML document, so the CLI offers `--xml-only` (print it) and `--serve --public-url` (local server behind the user's tunnel). Follow-up: a hosted option once Vobiz offers one (or reuse an Application's answer URL).
- `list-streams`, `get-stream` (voice) — no response schema; the CLI prints the body as returned.
- `cdr list --status` (voice) — PLAN §4 lists `--status`, but `list-cdrs` has no status filter; the CLI offers `--hangup-cause` and `--disposition` instead.
- `export-cdrs` (voice) — the description says not to send `Accept: application/json`; the CLI streams this endpoint itself with `Accept: text/csv` instead of using the JSON client.
