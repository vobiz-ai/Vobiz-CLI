# Spec gaps

Operations the CLI does not expose yet, or API behaviour the vendored spec does not describe. Add an entry instead of
guessing. Format: `operationId` (api) — why — what is needed.

- `link-number-to-application` / `unlink-number-from-application` (voice) — `POST` and `DELETE /api/v1/Account/{auth_id}/numbers/{e164}/application` with body `{application_id}` are used in production by the Vobiz MCP server (`update_phone_number`) but are missing from `openapi.yaml`, so the CLI has no `numbers update --app` yet. Needed: add both operations (and the number tags update the same tool performs) to the docs repo's `openapi.yaml`, then `npm run spec:sync` and implement `numbers update`.
