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
