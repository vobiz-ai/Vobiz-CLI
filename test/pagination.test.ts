import { describe, expect, it } from "vitest";
import { VobizClient } from "../src/core/client.js";
import { extractItems, pageMeta, pageStyle, paginate } from "../src/core/pagination.js";
import type { Operation } from "../src/generated/operations.js";
import { SMS_BASE, TEST_AUTH_ID, TEST_AUTH_TOKEN, VOICE_BASE, fakeFetch, type RecordedRequest } from "./helpers.js";

const creds = { authId: TEST_AUTH_ID, authToken: TEST_AUTH_TOKEN, voiceBaseUrl: VOICE_BASE, smsBaseUrl: SMS_BASE, source: "env" as const };
const param = (name: string, extra = {}) => ({ name, required: false, type: "integer", description: "", ...extra });
const fakeOp = (q: ReturnType<typeof param>[]): Operation => ({
  id: "x",
  api: "voice",
  baseUrl: VOICE_BASE,
  method: "GET",
  path: "/list",
  tag: "T",
  summary: "",
  description: "",
  deprecated: false,
  pathParams: [],
  queryParams: q,
  body: { required: false, props: [] },
});

describe("pagination", () => {
  it("detects items and meta in the shapes the spec uses", () => {
    expect(extractItems({ objects: [1], meta: {} })).toEqual([1]);
    expect(extractItems({ data: null })).toEqual([]);
    expect(extractItems({ data: { items: [2] } })).toEqual([2]);
    expect(extractItems([3])).toEqual([3]);
    expect(extractItems({ calls: [4] })).toEqual([4]);
    expect(pageMeta({ pagination: { has_next: true, total: 9 } })).toEqual({ total: 9, hasMore: true });
    expect(pageMeta({ meta: { total_count: 3, next: null } })).toEqual({ total: 3, hasMore: false });
    expect(pageMeta({ hasMore: false })).toEqual({ total: undefined, hasMore: false });
  });

  it("picks the paging style from the operation's params", () => {
    expect(pageStyle(fakeOp([param("page", { default: 1 }), param("per_page")]))).toMatchObject({ kind: "page", sizeParam: "per_page", first: 1 });
    expect(pageStyle(fakeOp([param("page", { description: "Zero-based page index" }), param("limit")]))).toMatchObject({ kind: "page", first: 0 });
    expect(pageStyle(fakeOp([param("limit"), param("offset")]))).toEqual({ kind: "offset", sizeParam: "limit" });
    expect(pageStyle(fakeOp([]))).toEqual({ kind: "none" });
    expect(pageStyle(fakeOp([param("limit")]))).toEqual({ kind: "none", sizeParam: "limit" });
  });

  it("--all follows page/per_page until has_next is false", async () => {
    const api = fakeFetch({
      "GET /list": (req: RecordedRequest) => {
        const page = Number(req.query.page);
        return { data: [{ id: page }], pagination: { has_next: page < 3, total: 3 } };
      },
    });
    const r = await paginate(new VobizClient({ creds, fetch: api.fetch }), fakeOp([param("page", { default: 1 }), param("per_page")]), {}, { all: true });
    expect(r.items.map((i) => (i as { id: number }).id)).toEqual([1, 2, 3]);
    expect(r.hasMore).toBe(false);
    expect(api.calls.map((c) => c.query.per_page)).toEqual(["100", "100", "100"]);
  });

  it("--limit stops early on offset endpoints", async () => {
    const api = fakeFetch({
      "GET /list": (req: RecordedRequest) => {
        const off = Number(req.query.offset);
        const n = Number(req.query.limit);
        return { objects: Array.from({ length: n }, (_, i) => ({ id: off + i })), meta: { total_count: 50, next: "/more" } };
      },
    });
    const r = await paginate(new VobizClient({ creds, fetch: api.fetch }), fakeOp([param("limit"), param("offset")]), {}, { limit: 5 });
    expect(r.items).toHaveLength(5);
    expect(r.hasMore).toBe(true);
    expect(r.total).toBe(50);
    expect(api.calls).toHaveLength(1);
  });
});

describe("listBody", () => {
  it("puts the collected items under the body's list key, nested or not", async () => {
    const { listBody } = await import("../src/core/pagination.js");
    expect(listBody({ meta: { total_count: 3 }, objects: [1] }, [1, 2, 3], undefined, 3)).toEqual({ meta: { total_count: 3 }, objects: [1, 2, 3] });
    expect(listBody({ data: { items: [1] }, ok: true }, [1, 2], undefined, 2)).toEqual({ data: { items: [1, 2] }, ok: true });
    expect(listBody({ accounts: null, total: 0 }, [], "accounts", 2)).toEqual({ accounts: [], total: 0 });
    // A single page is the API's body untouched, null list included.
    expect(listBody({ accounts: null, total: 0 }, [], "accounts")).toEqual({ accounts: null, total: 0 });
    expect(listBody([1], [1, 2], undefined, 2)).toEqual([1, 2]);
  });
});

describe("paginate guards", () => {
  const client = (fetch: typeof globalThis.fetch, warnings: string[]) => new VobizClient({ creds, fetch, log: (level, msg) => level === "warn" && warnings.push(msg) });

  it("sends the size param on a single-request endpoint so --limit is honoured", async () => {
    const api = fakeFetch({ "GET /list": (req: RecordedRequest) => ({ data: Array.from({ length: Number(req.query.per_page ?? 50) }, (_, i) => i) }) });
    const r = await paginate(client(api.fetch, []), fakeOp([param("per_page"), param("start_date")]), {}, { limit: 7 });
    expect(api.calls).toHaveLength(1);
    expect(api.last().query.per_page).toBe("7");
    expect(r.items).toHaveLength(7);
  });

  it("stops at maxPages and warns that --all may be truncated", async () => {
    const warnings: string[] = [];
    const api = fakeFetch({ "GET /list": (req: RecordedRequest) => ({ data: [{ id: req.query.page }], pagination: { has_next: true } }) });
    const r = await paginate(client(api.fetch, warnings), fakeOp([param("page", { default: 1 }), param("per_page")]), {}, { all: true, maxPages: 3 });
    expect(api.calls).toHaveLength(3);
    expect(r.items).toHaveLength(3);
    expect(warnings.join("\n")).toContain("stopped after 3 pages; results may be truncated");
  });

  it("warns when a server caps the page size below the one requested and sends no paging info", async () => {
    const warnings: string[] = [];
    const api = fakeFetch({ "GET /list": (req: RecordedRequest) => ({ data: req.query.page === "1" ? Array.from({ length: 50 }, (_, i) => i) : [] }) });
    const r = await paginate(client(api.fetch, warnings), fakeOp([param("page", { default: 1 }), param("per_page")]), {}, { all: true });
    expect(api.last().query.per_page).toBe("100");
    expect(r.items).toHaveLength(50);
    expect(warnings.join("\n")).toContain("returned 50 items for a page size of 100 and no paging info; results may be truncated");

    const quiet: string[] = [];
    await paginate(client(api.fetch, quiet), fakeOp([param("page", { default: 1 }), param("per_page")]), {}, { limit: 20 });
    expect(quiet).toEqual([]);
  });

  it("stops when the server ignores the page parameter and returns the same page again", async () => {
    const warnings: string[] = [];
    const api = fakeFetch({ "GET /list": () => ({ data: [{ id: 1 }, { id: 2 }], pagination: { has_next: true } }) });
    const r = await paginate(client(api.fetch, warnings), fakeOp([param("page", { default: 1 }), param("per_page")]), {}, { all: true });
    expect(api.calls).toHaveLength(2);
    expect(r.items).toHaveLength(2);
    expect(r.hasMore).toBe(true);
    expect(warnings.join("\n")).toContain("the server returned the same page twice");
  });
});
