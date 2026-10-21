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

type Style = { kind: "page"; pageParam: string; sizeParam?: string; first: number } | { kind: "offset"; sizeParam: string } | { kind: "none" };

export function pageStyle(op: Operation): Style {
  const names = new Set(op.queryParams.map((p) => p.name));
  const size = ["per_page", "size", "limit"].find((n) => names.has(n));
  if (names.has("page")) {
    const def = op.queryParams.find((p) => p.name === "page")?.default;
    const zeroBased = /zero-based/i.test(op.queryParams.find((p) => p.name === "page")?.description ?? "");
    return { kind: "page", pageParam: "page", sizeParam: size, first: typeof def === "number" ? def : zeroBased ? 0 : 1 };
  }
  if (names.has("offset") && names.has("limit")) return { kind: "offset", sizeParam: "limit" };
  return { kind: "none" };
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

  for (let i = 0; i < maxPages; i++) {
    if (style.kind === "page") {
      query[style.pageParam] = style.first + i;
      if (style.sizeParam && size !== undefined) query[style.sizeParam] = size;
    } else if (style.kind === "offset") {
      if (size !== undefined) query[style.sizeParam] = size;
      query.offset = items.length;
    }
    last = await client.call(op, { ...args, query });
    pages++;
    const got = (extractItems(last, opts.itemsKey) ?? []) as T[];
    items.push(...got);
    const meta = pageMeta(last);
    total = meta.total ?? total;
    hasMore = meta.hasMore ?? (total !== undefined ? items.length < total : size !== undefined && got.length >= size);
    if (style.kind === "none" || !got.length || !hasMore) break;
    if (want === undefined || items.length >= want) break;
  }
  if (want !== undefined && want !== Infinity && items.length > want) {
    items.length = want;
    hasMore = true;
  }
  return { items, total, hasMore, pages, last };
}
