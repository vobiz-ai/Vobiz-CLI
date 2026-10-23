/**
 * A fake Vobiz API that answers ANY operation in the vendored spec, for broad property-style tests (every list
 * command pages, every write supports --dry-run, ...). Requests are matched to an operation by method and path
 * template; literal templates win over parameterised ones (`/messages/cost-preview` before `/messages/{id}`).
 *
 *   const api = specFake({ pages: 2 });                       // generic bodies, lists span two pages
 *   const api = specFake({ answer: (op, req) => ... });       // custom body per operation (undefined = default)
 *   api.ops()  -> operationIds hit, in order
 */
import { OPERATIONS, type Operation } from "../src/generated/operations.js";
import { pageStyle } from "../src/core/pagination.js";
import { TEST_AUTH_ID, fakeFetch, type FakeApi, type RecordedRequest } from "./helpers.js";

const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");

interface Compiled {
  op: Operation;
  re: RegExp;
  params: number;
}

const COMPILED: Compiled[] = OPERATIONS.map((op) => {
  const parts = op.path.split(/(\{[^}]+\})/);
  const src = parts
    .map((p) => {
      if (p === "{auth_id}" || p === "{account_id}") return escape(TEST_AUTH_ID);
      if (/^\{[^}]+\}$/.test(p)) return "[^/]+";
      return escape(p);
    })
    .join("");
  return { op, re: new RegExp(`^${src}$`), params: (op.path.match(/\{/g) ?? []).length };
}).sort((a, b) => a.params - b.params);

/** The spec operation a recorded request was sent to. */
export function matchOp(method: string, api: "voice" | "sms", path: string): Operation | undefined {
  return COMPILED.find((c) => c.op.method === method && c.op.api === api && c.re.test(path))?.op;
}

export interface SpecFakeOptions {
  /** How many pages list endpoints report (default 2). Each page holds one item. */
  pages?: number;
  /** Custom body per request; return undefined to use the generic body. */
  answer?: (op: Operation, req: RecordedRequest) => unknown;
}

export interface SpecFake extends FakeApi {
  /** operationIds of the requests made, in order. */
  ops(): string[];
}

const ITEM_KEYS = ["objects", "items", "data", "results", "numbers", "messages", "accounts", "sessions", "transactions", "sub_accounts", "broadcasts", "recipients", "purchases", "countries"];

/** Which 1-based page a request asks for, from the operation's paging style. */
export function pageOf(op: Operation, req: RecordedRequest): number {
  const style = pageStyle(op);
  if (style.kind === "page") return Number(req.query[style.pageParam] ?? style.first) - style.first + 1;
  if (style.kind === "offset") return Number(req.query.offset ?? 0) + 1;
  return 1;
}

export function genericBody(op: Operation, req: RecordedRequest, pages: number): unknown {
  if (op.method !== "GET") return { id: "new-1", message: "ok", api_id: "api-1" };
  const page = pageOf(op, req);
  const item = { id: `item-${page}`, uuid: `item-${page}`, name: `item-${page}`, e164: `+1415555010${page}`, status: "active" };
  const items = page <= pages ? [item] : [];
  const more = page < pages;
  const body: Record<string, unknown> = {
    pagination: { has_next: more, total: pages },
    meta: { total_count: pages, next: more ? "/next" : null },
    hasMore: more,
    total: pages,
  };
  for (const k of ITEM_KEYS) body[k] = items;
  return body;
}

export function specFake(o: SpecFakeOptions = {}): SpecFake {
  const pages = o.pages ?? 2;
  const hits: string[] = [];
  const resolve = (key: string): Operation | undefined => {
    const sp = key.indexOf(" ");
    const method = key.slice(0, sp);
    const path = key.slice(sp + 1);
    // fakeFetch also offers the full URL pathname; sms paths are relative to /api/v1/sms.
    if (path.startsWith("/api/v1/sms/") || path === "/api/v1/sms") return undefined;
    return matchOp(method, "voice", path) ?? matchOp(method, "sms", path);
  };
  const routes = new Proxy({} as Record<string, unknown>, {
    has: (_t, key) => typeof key === "string" && !!resolve(key),
    get: (_t, key) => {
      if (typeof key !== "string") return undefined;
      return (req: RecordedRequest) => {
        const op = matchOp(req.method, req.api, req.path) ?? resolve(key)!;
        hits.push(op.id);
        const custom = o.answer?.(op, req);
        return custom !== undefined ? custom : genericBody(op, req, pages);
      };
    },
  });
  const api = fakeFetch(routes);
  return { ...api, fetch: api.fetch, calls: api.calls, last: api.last, ops: () => [...hits] };
}
