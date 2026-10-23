/**
 * Operation lookup by operationId. Commands resolve their HTTP operation here when they register, so a spec
 * rename or removal fails `buildProgram` (and the test suite) instead of failing a user at run time.
 *
 * `list-numbers` exists in both the voice and the SMS spec, so an id may be qualified as `voice:<id>` or
 * `sms:<id>`; an unqualified id that matches more than one operation throws.
 */
import { OPERATIONS, type Api, type Operation } from "../generated/operations.js";

export type { Api, Operation };

export function op(id: string): Operation {
  const [api, bare] = id.includes(":") ? (id.split(":", 2) as [Api, string]) : [undefined, id];
  const matches = OPERATIONS.filter((o) => o.id === bare && (!api || o.api === api));
  if (matches.length === 0) throw new Error(`Unknown operationId "${id}": it is not in spec/. Run \`npm run gen\` or fix the command.`);
  if (matches.length > 1)
    throw new Error(`operationId "${id}" is ambiguous (${matches.map((m) => m.api).join(", ")}); qualify it as "${matches[0].api}:${bare}".`);
  return matches[0];
}

/** Like `op` but returns undefined instead of throwing (for `vobiz api --describe`). */
export function findOp(id: string): Operation[] {
  const [api, bare] = id.includes(":") ? (id.split(":", 2) as [Api, string]) : [undefined, id];
  return OPERATIONS.filter((o) => o.id === bare && (!api || o.api === api));
}
