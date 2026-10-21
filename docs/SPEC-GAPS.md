# Spec gaps

Operations the CLI does not expose yet, or API behaviour the vendored spec does not describe. Add an entry instead of
guessing. Format: `operationId` (api) — why — what is needed.

- (none yet)

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
