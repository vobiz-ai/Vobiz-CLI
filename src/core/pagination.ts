/**
 * `--limit` / `--all` over the API's list endpoints. The spec uses three shapes and this helper hides them:
 *   page style    `page` + `per_page` (or `size`/`limit`), meta in `pagination.{has_next,total}` (CDRs, transactions)
 *   offset style  `limit` + `offset`, meta in `meta.{total_count|total,next}` (applications, endpoints, trunks)
 *   single page   anything else (one request)
 * Items are read from `objects`, `items`, `data`, `results`, `numbers`, `messages` (or the body itself when it
 * is an array). Go services serialise empty lists as `null`, which counts as no items.
 */
import type { CallArgs, VobizClient } from "./client.js";
import type { Operation } from "../generated/operations.js";

export interface PaginateOptions {
  /** Stop after this many items. */
  limit?: number;
  /** Fetch every page (bounded by maxPages). */
  all?: boolean;
  /** Page size to request; defaults to min(limit, 100) or the server default. */
  pageSize?: number;
  /** Where the list lives when auto-detection is wrong (dot path). */
  itemsKey?: string;
  /** Safety bound for --all. */
  maxPages?: number;
}

export interface PageResult<T> {
  items: T[];
  /** Total reported by the API, when it reports one. */
  total?: number;
  /** True when more items exist beyond what was returned. */
  hasMore: boolean;
  pages: number;
  /** The last raw response (for summary fields such as CDR totals). */
  last: unknown;
}

const ITEM_KEYS = ["objects", "items", "data", "results", "numbers", "messages"];
const MAX_PAGE_SIZE = 100;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** The list inside a response body, or undefined when there is none. */
export function extractItems(body: unknown, itemsKey?: string): unknown[] | undefined {
  if (Array.isArray(body)) return body;
  if (!isRec(body)) return undefined;
  if (itemsKey) {
    let cur: unknown = body;
    for (const p of itemsKey.split(".")) cur = isRec(cur) ? cur[p] : undefined;
    return cur === null ? [] : Array.isArray(cur) ? cur : undefined;
  }
  for (const k of ITEM_KEYS) {
    const v = body[k];
    if (Array.isArray(v)) return v;
    if (v === null && k in body) return [];
    if (k === "data" && isRec(v)) {
      const inner = extractItems(v);
      if (inner) return inner;
    }
  }
  const arrays = Object.values(body).filter(Array.isArray);
  return arrays.length === 1 ? (arrays[0] as unknown[]) : undefined;
}

/** The dot path of the list inside a response body (as extractItems finds it), or undefined. */
export function itemsPath(body: unknown, itemsKey?: string): string | undefined {
  if (!isRec(body)) return undefined;
  if (itemsKey) return itemsKey;
  for (const k of ITEM_KEYS) {
    const v = body[k];
    if (Array.isArray(v) || (v === null && k in body)) return k;
    if (k === "data" && isRec(v)) {
      const inner = itemsPath(v);
      if (inner) return `data.${inner}`;
    }
  }
  const keys = Object.keys(body).filter((k) => Array.isArray(body[k]));
  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * The body to print for --output json/yaml: the last response with `items` (every page collected, cut to --limit)
 * in place of its list, so the shape is the same for one page or many. A bare-array body becomes the items.
 */
export function listBody(body: unknown, items: unknown[], itemsKey?: string): unknown {
  const path = itemsPath(body, itemsKey);
  if (!isRec(body) || !path) return items;
  const parts = path.split(".");
  const copy: Rec = { ...body };
  let cur = copy;
  for (const p of parts.slice(0, -1)) {
    const next = isRec(cur[p]) ? { ...(cur[p] as Rec) } : {};
    cur[p] = next;
    cur = next;
  }
  cur[parts[parts.length - 1]!] = items;
  return copy;
}

/** Total count and "is there a next page" from whichever meta block the endpoint uses. */
export function pageMeta(body: unknown): { total?: number; hasMore?: boolean } {
  if (!isRec(body)) return {};
  const blocks = [body, body.pagination, body.meta, isRec(body.data) ? body.data : undefined].filter(isRec);
  let total: number | undefined;
  let hasMore: boolean | undefined;
  for (const b of blocks) {
    for (const k of ["total_count", "total", "totalCount"]) if (total === undefined && typeof b[k] === "number") total = b[k] as number;
    for (const k of ["has_next", "has_more", "hasMore", "hasNext"]) if (hasMore === undefined && typeof b[k] === "boolean") hasMore = b[k] as boolean;
    if (hasMore === undefined && "next" in b && (typeof b.next === "string" || b.next === null)) hasMore = typeof b.next === "string" && b.next !== "";
  }
  return { total, hasMore };
}

type Style = { kind: "page"; pageParam: string; sizeParam?: string; first: number } | { kind: "offset"; sizeParam: string } | { kind: "none"; sizeParam?: string };

export function pageStyle(op: Operation): Style {
  const names = new Set(op.queryParams.map((p) => p.name));
  const size = ["per_page", "size", "limit"].find((n) => names.has(n));
  if (names.has("page")) {
    const def = op.queryParams.find((p) => p.name === "page")?.default;
    const zeroBased = /zero-based/i.test(op.queryParams.find((p) => p.name === "page")?.description ?? "");
    return { kind: "page", pageParam: "page", sizeParam: size, first: typeof def === "number" ? def : zeroBased ? 0 : 1 };
  }
  if (names.has("offset") && names.has("limit")) return { kind: "offset", sizeParam: "limit" };
  // One request, but a size param (e.g. `limit` without `offset`) still caps it so --limit is honoured.
  return size ? { kind: "none", sizeParam: size } : { kind: "none" };
}

export async function paginate<T = Rec>(client: VobizClient, op: Operation, args: CallArgs = {}, opts: PaginateOptions = {}): Promise<PageResult<T>> {
  const style = pageStyle(op);
  const want = opts.all ? Infinity : opts.limit ?? undefined;
  const size = opts.pageSize ?? (want !== undefined ? Math.min(want === Infinity ? MAX_PAGE_SIZE : want, MAX_PAGE_SIZE) : undefined);
  const maxPages = opts.maxPages ?? 1000;
  const items: T[] = [];
  let total: number | undefined;
  let hasMore = false;
  let pages = 0;
  let last: unknown;
  const query = { ...args.query };
  let previous: string | undefined;
  let stoppedEarly: string | undefined;

  for (let i = 0; ; i++) {
    if (i >= maxPages) {
      stoppedEarly = `stopped after ${maxPages} pages`;
      break;
    }
    if (style.kind === "page") {
      query[style.pageParam] = style.first + i;
      if (style.sizeParam && size !== undefined) query[style.sizeParam] = size;
    } else if (style.kind === "offset") {
      if (size !== undefined) query[style.sizeParam] = size;
      query.offset = items.length;
    } else if (style.sizeParam && size !== undefined) query[style.sizeParam] = size;
    last = await client.call(op, { ...args, query });
    pages++;
    const got = (extractItems(last, opts.itemsKey) ?? []) as T[];
    // A server that ignores the page parameter returns the same page forever: stop instead of looping.
    const fingerprint = got.length ? JSON.stringify(got) : undefined;
    if (fingerprint !== undefined && fingerprint === previous) {
      stoppedEarly = "the server returned the same page twice";
      hasMore = true;
      break;
    }
    previous = fingerprint;
    items.push(...got);
    const meta = pageMeta(last);
    total = meta.total ?? total;
    hasMore = meta.hasMore ?? (total !== undefined ? items.length < total : size !== undefined && got.length >= size);
    if (style.kind === "none" || !got.length || !hasMore) {
      // Without paging info a short page ends the walk, but a server that caps the page size below the one
      // requested looks the same.
      if (opts.all && style.kind !== "none" && meta.hasMore === undefined && total === undefined && size !== undefined && got.length > 0 && got.length < size)
        client.warn(`The server returned ${got.length} items for a page size of ${size} and no paging info; results may be truncated.`);
      break;
    }
    if (want === undefined || items.length >= want) break;
  }
  if (stoppedEarly && opts.all) client.warn(`Listing ${stoppedEarly}; results may be truncated.`);
  if (want !== undefined && want !== Infinity && items.length > want) {
    items.length = want;
    hasMore = true;
  }
  return { items, total, hasMore, pages, last };
}
