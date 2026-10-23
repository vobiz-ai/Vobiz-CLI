// Build-time flags. Committed with every flag off; `npm run build:internal` (scripts/build-internal.mjs) flips
// INTERNAL_BUILD to true for the duration of that build only and restores this file afterwards, so the public
// build and the published package never enable the internal command group.
export const INTERNAL_BUILD: boolean = false;
