import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pollSettings, rejectionCode } from "../src/commands/sms/messages.js";
import { VobizError } from "../src/core/errors.js";
import { OPERATIONS } from "../src/generated/operations.js";
import { fakeFetch, networkError, reply, runCli, textReply, type RecordedRequest } from "./helpers.js";

type Routes = Parameters<typeof fakeFetch>[0];

/** Runs a write/read with --yes --json and returns the CLI result plus the recorded requests. */
async function run(argv: string[], routes: Routes = {}, extra: string[] = ["--yes", "--json"]) {
  const api = fakeFetch(routes);
  const r = await runCli([...argv, ...extra], { fetch: api.fetch });
  return { r, api };
}

const MSG = { id: "msg_1", direction: "out", channel: "sms", from: "+14155550100", to: "+14155550123", status: "sent", createdAt: "2026-10-22T10:00:00Z" };

describe("sms send", () => {
  const preview = { channel: "sms", segmentCount: 1, unitCost: 0.0079, totalCost: 0.0079, currency: "USD", country: "US" };

  it("previews the cost, sends one request per recipient with idempotency keys and prints every message", async () => {
    let n = 0;
    const { r, api } = await run(
      ["sms", "send", "--from", "+1 (415) 555-0100", "--to", "+14155550123,+14155550124", "--text", "Hello", "--tag", "t1", "--idempotency-key", "k1"],
      {
        "GET /messages/cost-preview": preview,
        "POST /messages": (req: RecordedRequest) => reply(201, { ...MSG, id: `msg_${++n}`, to: (req.body as { to: string[] }).to[0] }),
      },
    );
    expect(r.code).toBe(0);
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ api: "sms", path: "/messages", body: { from: "+14155550100", to: ["+14155550123"], channel: "sms", text: "Hello", tag: "t1", idempotencyKey: "k1:1" } });
    expect(posts[1].body).toMatchObject({ to: ["+14155550124"], idempotencyKey: "k1:2" });
    expect(api.calls.filter((c) => c.method === "GET")[0].query).toEqual({ from: "+14155550100", to: "+14155550123", text: "Hello", channel: "sms" });
    expect(r.json()).toMatchObject({ idempotencyKey: "k1", messages: [{ id: "msg_1" }, { id: "msg_2" }] });
    expect(r.err).toContain("USD 0.0158 for 2 recipients (1 segment each)");
  });

  it("generates and prints an idempotency key; one recipient uses it as is", async () => {
    const { r, api } = await run(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi"], { "GET /messages/cost-preview": preview, "POST /messages": reply(201, MSG) });
    expect(r.code).toBe(0);
    const key = (api.last().body as { idempotencyKey: string }).idempotencyKey;
    expect(key).toMatch(/^cli-[0-9a-f-]{36}$/);
    expect(r.err).toContain(`Idempotency key: ${key}`);
  });

  it("sends MMS and RCS fields, DLT ids and a schedule", async () => {
    const { api } = await run(
      ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--type", "mms", "--media-url", "https://example.com/a.png", "--title", "Receipt", "--schedule-at", "2026-11-01T09:00:00+05:30"],
      { "GET /messages/cost-preview": preview, "POST /messages": reply(201, { ...MSG, status: "scheduled" }) },
    );
    expect(api.last().body).toMatchObject({ channel: "mms", mediaUrls: ["https://example.com/a.png"], title: "Receipt", scheduledAt: "2026-11-01T03:30:00.000Z" });

    const rcs = await run(
      ["sms", "send", "--from", "AcmeAgent", "--to", "+14155550123", "--type", "rcs", "--text", "Hi", "--failover-to-sms", "--rcs-suggestions", '[{"type":"reply","text":"Yes"}]'],
      { "POST /messages": reply(201, MSG) },
    );
    expect(rcs.api.calls).toHaveLength(1); // RCS is not previewed
    expect(rcs.api.last().body).toMatchObject({ from: "AcmeAgent", channel: "rcs", failoverToSms: true, rcsSuggestions: [{ type: "reply", text: "Yes" }] });

    const dlt = await run(
      ["sms", "send", "--from", "+919876543210", "--to", "+919812345678", "--text", "OTP 1", "--dlt-entity-id", "E1", "--dlt-header-id", "H1", "--dlt-template-id", "T1"],
      { "GET /messages/cost-preview": preview, "POST /messages": reply(201, MSG) },
    );
    expect(dlt.api.last().body).toMatchObject({ dltEntityId: "E1", dltHeaderId: "H1", dltTemplateId: "T1" });
  });

  it("validates input before any request", async () => {
    for (const argv of [
      ["sms", "send", "--from", "+14155550100", "--to", "+14155550123"],
      ["sms", "send", "--from", "+14155550100", "--to", "not-a-number", "--text", "x"],
      ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "x", "--media-url", "http://insecure.example/a.png"],
      ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "x", "--failover-to-sms"],
      ["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "x", "--schedule-at", "tomorrow"],
    ]) {
      const { r, api } = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(api.calls).toHaveLength(0);
    }
  });

  it("refuses without --yes when stdin is not a terminal and sends nothing", async () => {
    const { r, api } = await run(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi"], { "GET /messages/cost-preview": preview }, []);
    expect(r.code).toBe(6);
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("--dry-run prints the request and sends nothing", async () => {
    const { r, api } = await run(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi", "--dry-run"], { "GET /messages/cost-preview": preview }, ["--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ dry_run: true, method: "POST", operation: "send-message", api: "sms" });
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reports opted-out recipients of a multi-recipient send and exits 1", async () => {
    let n = 0;
    const { r } = await run(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--to", "+14155550124", "--text", "Hi"], {
      "GET /messages/cost-preview": preview,
      "POST /messages": () => (++n === 2 ? reply(422, { error: "recipient opted out" }) : reply(201, MSG)),
    });
    expect(r.code).toBe(1);
    expect(r.json().messages[1]).toMatchObject({ to: "+14155550124", status: "not_sent", errorCode: "opted_out" });
  });

  it("labels a 422 opted_out only when the backend says so", async () => {
    let n = 0;
    const { r } = await run(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--to", "+14155550124", "--text", "Hi"], {
      "GET /messages/cost-preview": preview,
      "POST /messages": () => (++n === 2 ? reply(422, { error: "invalid mms: mediaUrls[0] must use https" }) : reply(201, MSG)),
    });
    expect(r.json().messages[1]).toMatchObject({ status: "not_sent", errorCode: "rejected", errorMessage: "invalid mms: mediaUrls[0] must use https" });
    const e = (msg: string, details?: unknown) => new VobizError("invalid_input", msg, 422, details);
    expect(rejectionCode(e("recipient has opted out: +14155550123"))).toBe("opted_out");
    expect(rejectionCode(e("x", { error: "x", code: "number_blocked" }))).toBe("number_blocked");
    expect(rejectionCode(e("HTTP 422"))).toBe("opted_out");
  });

  it("a network failure on a send is outcome_unknown (exit 7)", async () => {
    const { r } = await run(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi"], { "GET /messages/cost-preview": preview, "POST /messages": networkError() });
    expect(r.code).toBe(7);
  });

  describe("--wait", () => {
    beforeEach(() => void (pollSettings.intervalMs = 1));
    afterEach(() => void (pollSettings.intervalMs = 2000));

    it("polls get-message until a final status", async () => {
      let polls = 0;
      const { r, api } = await run(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi", "--wait"], {
        "GET /messages/cost-preview": preview,
        "POST /messages": reply(201, MSG),
        "GET /messages/msg_1": () => ({ ...MSG, status: ++polls < 2 ? "sent" : "delivered" }),
      });
      expect(r.code).toBe(0);
      expect(api.calls.filter((c) => c.path === "/messages/msg_1")).toHaveLength(2);
      expect(r.json().messages[0].status).toBe("delivered");
    });

    it("exits 1 when a message fails", async () => {
      const { r } = await run(["sms", "send", "--from", "+14155550100", "--to", "+14155550123", "--text", "Hi", "--wait"], {
        "GET /messages/cost-preview": preview,
        "POST /messages": reply(201, MSG),
        "GET /messages/msg_1": { ...MSG, status: "failed", errorCode: "carrier_rejected" },
      });
      expect(r.code).toBe(1);
    });
  });
});

describe("sms messages, cost, rcs-reachability", () => {
  it("lists messages with filters and paging, and keeps the raw body in json", async () => {
    const { r, api } = await run(
      ["sms", "messages", "list", "--status", "delivered", "--channel", "sms", "--direction", "out", "--to", "+14155550123", "--from", "+14155550100", "--tag", "t1", "--since", "2026-10-01T00:00:00Z", "--until", "2026-10-02T00:00:00Z", "--limit", "5"],
      { "GET /messages": { messages: [MSG], total: 1, limit: 5, offset: 0 } },
      ["--json"],
    );
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({
      status: "delivered",
      channel: "sms",
      direction: "out",
      to: "+14155550123",
      from: "+14155550100",
      tag: "t1",
      startDate: "2026-10-01T00:00:00.000Z",
      endDate: "2026-10-02T00:00:00.000Z",
      limit: "5",
      offset: "0",
    });
    expect(r.json()).toMatchSnapshot();
  });

  it("--all pages through every message and merges them under `messages`", async () => {
    const page = (offset: number) => Array.from({ length: offset === 0 ? 100 : 30 }, (_, i) => ({ ...MSG, id: `m${offset + i}` }));
    const { r, api } = await run(["sms", "messages", "list", "--all"], { "GET /messages": (req: RecordedRequest) => ({ messages: page(Number(req.query.offset)), total: 130 }) }, ["--json"]);
    expect(api.calls.map((c) => c.query.offset)).toEqual(["0", "100"]);
    expect(r.json().messages).toHaveLength(130);
  });

  it("prints a table with the default columns", async () => {
    const { r } = await run(["sms", "messages", "list", "--limit", "1"], { "GET /messages": { messages: [MSG], total: 3 } }, ["--output", "table"]);
    expect(r.out.split("\n")[0]).toMatch(/^ID\s+DIRECTION\s+FROM\s+TO\s+STATUS\s+CREATEDAT/);
    expect(r.err).toContain("Showing 1 of 3");
  });

  it("gets one message", async () => {
    const { r, api } = await run(["sms", "messages", "get", "msg_1"], { "GET /messages/msg_1": { ...MSG, statusHistory: [] } }, ["--json"]);
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "GET", path: "/messages/msg_1" });
  });

  it("previews cost", async () => {
    const { r, api } = await run(["sms", "cost", "--from", "+14155550100", "--to", "+447700900123", "--text", "Hi", "--type", "mms"], { "GET /messages/cost-preview": { totalCost: 0.02 } }, ["--json"]);
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({ from: "+14155550100", to: "+447700900123", text: "Hi", channel: "mms" });
  });

  it("checks RCS reachability", async () => {
    const { r, api } = await run(["sms", "rcs-reachability", "+14155550123", "--from", "AcmeAgent"], { "GET /messages/rcs-reachability": { reachable: true } }, ["--json"]);
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({ from: "AcmeAgent", to: "+14155550123" });
  });
});

describe("sms numbers and coverage", () => {
  it("lists numbers, countries and purchases", async () => {
    const a = await run(["sms", "numbers", "list"], { "GET /numbers": { numbers: [{ e164: "+14155550100" }] } }, ["--json"]);
    expect(a.r.json()).toEqual({ numbers: [{ e164: "+14155550100" }] });
    expect(a.api.last()).toMatchObject({ api: "sms", path: "/numbers" });
    const b = await run(["sms", "numbers", "countries"], { "GET /numbers/countries": { countries: [{ country: "US" }] } }, ["--quiet"]);
    expect(b.r.out).toBe("US\n");
    const c = await run(["sms", "numbers", "purchases"], { "GET /numbers/purchases": { purchases: [{ id: "p1" }] } }, ["--quiet"]);
    expect(c.r.out).toBe("p1\n");
  });

  it("searches available numbers", async () => {
    const { r, api } = await run(["sms", "numbers", "search", "--country", "us", "--capabilities", "SMS,MMS", "--area-code", "415", "--limit", "5"], { "GET /numbers/available": { numbers: [] } }, ["--json"]);
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({ country: "US", capabilities: "SMS,MMS", areaCode: "415", limit: "5" });
  });

  it("buys a number after showing the price from a fresh search", async () => {
    const { r, api } = await run(["sms", "numbers", "buy", "+14155550100", "--country", "US"], {
      "GET /numbers/available": { numbers: [{ e164: "+14155550100", numberKey: "", setupPrice: 1, monthlyPrice: 1.5, currency: "USD" }] },
      "POST /numbers/purchase": reply(201, { purchase: { id: "p1", status: "active" } }),
    });
    expect(r.code).toBe(0);
    expect(api.calls[0].query).toMatchObject({ country: "US", areaCode: "415" });
    expect(api.last()).toMatchObject({ method: "POST", path: "/numbers/purchase", body: { e164: "+14155550100", country: "US" } });
    expect(r.err).toContain("USD 1 setup + 1.5/month");
  });

  it("buy fills the numberKey from search and refuses without --yes", async () => {
    const routes = { "GET /numbers/available": { numbers: [{ e164: "+442071234567", numberKey: "NK1", setupPrice: 2, monthlyPrice: 2, currency: "GBP" }] }, "POST /numbers/purchase": reply(201, {}) };
    const ok = await run(["sms", "numbers", "buy", "+442071234567", "--country", "GB"], routes);
    expect(ok.api.last().body).toEqual({ e164: "+442071234567", country: "GB", numberKey: "NK1" });
    const refused = await run(["sms", "numbers", "buy", "+442071234567", "--country", "GB"], routes, []);
    expect(refused.r.code).toBe(6);
    expect(refused.api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("releases a number with %2B in the path", async () => {
    const { r, api } = await run(["sms", "numbers", "release", "+14155550100"], { "POST /numbers/+14155550100/release": { purchase: { status: "released" } } });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "POST", path: "/numbers/%2B14155550100/release" });
  });

  it("lists coverage with filters and gets one country", async () => {
    const a = await run(["sms", "coverage", "list", "--search", "united", "--region", "Western Europe", "--no-two-way", "--registration-required"], { "GET /coverage": { countries: [] } }, ["--json"]);
    expect(a.api.last().query).toEqual({ q: "united", region: "Western Europe", twoWay: "false", registrationRequired: "true" });
    const none = await run(["sms", "coverage", "list"], { "GET /coverage": { countries: [] } }, ["--json"]);
    expect(none.api.last().query).toEqual({});
    const b = await run(["sms", "coverage", "get", "gb"], { "GET /coverage/GB": { country: "GB" } }, ["--json"]);
    expect(b.r.json()).toEqual({ country: "GB" });
  });
});

describe("sms conversations, opt-outs, webhooks", () => {
  it("conversations list|get|messages|read|unread-count", async () => {
    const routes = {
      "GET /conversations": [{ id: "c1", unreadCount: 2 }],
      "GET /conversations/c1": { id: "c1" },
      "GET /conversations/c1/messages": [MSG],
      "POST /conversations/c1/read": { status: "ok" },
      "GET /conversations/unread-count": { totalUnread: 2 },
    };
    const list = await run(["sms", "conversations", "list", "--limit", "10"], routes, ["--json"]);
    expect(list.api.last().query).toEqual({ limit: "10", offset: "0" });
    expect(list.r.json()).toEqual([{ id: "c1", unreadCount: 2 }]);
    expect((await run(["sms", "conversations", "get", "c1"], routes, ["--json"])).r.json()).toEqual({ id: "c1" });
    const msgs = await run(["sms", "conversations", "messages", "c1"], routes, ["--json"]);
    expect(msgs.api.last().query).toEqual({ limit: "50", offset: "0" });
    const read = await run(["sms", "conversations", "read", "c1"], routes);
    expect(read.api.last()).toMatchObject({ method: "POST", path: "/conversations/c1/read" });
    expect((await run(["sms", "conversations", "read", "c1"], routes, [])).r.code).toBe(6);
    expect((await run(["sms", "conversations", "unread-count"], routes, ["--json"])).r.json()).toEqual({ totalUnread: 2 });
  });

  it("opt-outs list|add|check|remove", async () => {
    const routes = {
      "GET /opt-outs": null,
      "POST /opt-outs": reply(201, { status: "ok" }),
      "GET /opt-outs/+14155550123": { optedOut: true },
      "DELETE /opt-outs/+14155550123": { status: "ok" },
    };
    const list = await run(["sms", "opt-outs", "list"], routes, ["--json"]);
    expect(list.api.last().query).toEqual({ limit: "20", offset: "0" });
    expect(list.r.json()).toEqual([]);
    const add = await run(["sms", "opt-outs", "add", "+1 415 555 0123", "--channel", "rcs", "--reason", "asked"], routes);
    expect(add.api.last().body).toEqual({ phoneNumber: "+14155550123", channel: "rcs", reason: "asked" });
    expect((await run(["sms", "opt-outs", "add", "+14155550123"], routes, [])).r.code).toBe(6);
    const check = await run(["sms", "opt-outs", "check", "+14155550123"], routes, ["--json"]);
    expect(check.api.last()).toMatchObject({ path: "/opt-outs/%2B14155550123", query: { channel: "sms" } });
    expect(check.r.json()).toEqual({ phoneNumber: "+14155550123", channel: "sms", optedOut: true });
    const rm = await run(["sms", "opt-outs", "remove", "+14155550123", "--channel", "sms"], routes);
    expect(rm.api.last()).toMatchObject({ method: "DELETE", path: "/opt-outs/%2B14155550123", query: { channel: "sms" } });
    const dry = await run(["sms", "opt-outs", "remove", "+14155550123", "--dry-run"], routes, ["--json"]);
    expect(dry.api.calls).toHaveLength(0);
  });

  it("webhooks list|get|create|update|delete and the secret is redacted", async () => {
    const hook = { id: "w1", url: "https://example.com/h", secret: "s3cret-value", events: ["message.received"], active: true };
    const routes = {
      "GET /webhooks": [hook],
      "GET /webhooks/w1": hook,
      "POST /webhooks": reply(201, hook),
      "PUT /webhooks/w1": { status: "ok" },
      "DELETE /webhooks/w1": { status: "ok" },
    };
    const list = await run(["sms", "webhooks", "list"], routes, ["--json"]);
    expect(list.r.out).not.toContain("s3cret-value");
    expect((await run(["sms", "webhooks", "get", "w1"], routes, ["--json"])).r.out).not.toContain("s3cret-value");
    const create = await run(["sms", "webhooks", "create", "--url", "https://example.com/h", "--secret", "abc", "--event", "message.received,message.failed"], routes);
    expect(create.api.last().body).toEqual({ url: "https://example.com/h", secret: "abc", events: ["message.received", "message.failed"] });
    expect((await run(["sms", "webhooks", "create", "--url", "http://example.com/h"], routes)).r.code).toBe(2);
    const update = await run(["sms", "webhooks", "update", "w1", "--no-active"], routes);
    expect(update.api.last()).toMatchObject({ method: "PUT", path: "/webhooks/w1", body: { active: false } });
    expect((await run(["sms", "webhooks", "update", "w1"], routes)).r.code).toBe(2);
    const del = await run(["sms", "webhooks", "delete", "w1"], routes);
    expect(del.api.last()).toMatchObject({ method: "DELETE", path: "/webhooks/w1" });
    expect((await run(["sms", "webhooks", "delete", "w1"], routes, [])).r.code).toBe(6);
  });
});

describe("sms broadcasts", () => {
  const BC = { id: "b1", name: "Oct", from: "+14155550100", status: "draft", stats: { total: 3, pending: 3, sent: 0 } };
  const routes = {
    "GET /broadcasts": { broadcasts: [BC], total: 1 },
    "GET /broadcasts/b1": BC,
    "POST /broadcasts": reply(201, BC),
    "PUT /broadcasts/b1": BC,
    "DELETE /broadcasts/b1": reply(204),
    "GET /broadcasts/b1/recipients": { recipients: [{ row: 1, to: "+14155550123", status: "pending" }], total: 1 },
    "POST /broadcasts/b1/recipients": { total: 2, valid: 2 },
    "GET /broadcasts/b1/preview": { samples: [{ to: "+14155550123", text: "Hi Ann", segments: 1 }], missingVariables: [], estimatedSegments: 3 },
    "GET /broadcasts/b1/export": textReply(200, "to,status\n+14155550123,sent\n", { "content-type": "text/csv" }),
    "POST /broadcasts/b1/launch": { ...BC, status: "running" },
    "POST /broadcasts/b1/pause": { ...BC, status: "paused" },
    "POST /broadcasts/b1/resume": { ...BC, status: "running" },
    "POST /broadcasts/b1/cancel": { ...BC, status: "cancelled" },
  };

  it("list, get, create, update, delete", async () => {
    const list = await run(["sms", "broadcasts", "list", "--limit", "10"], routes, ["--output", "table"]);
    expect(list.r.out.split("\n")[0]).toMatch(/^ID\s+NAME\s+STATUS\s+STATS\.TOTAL\s+STATS\.SENT/);
    expect(list.api.last().query).toEqual({ limit: "10", offset: "0" });
    expect((await run(["sms", "broadcasts", "get", "b1"], routes, ["--json"])).api.last().path).toBe("/broadcasts/b1");
    const create = await run(["sms", "broadcasts", "create", "--name", "Oct", "--from", "+1 415 555 0100", "--template", "Hi {{name}}", "--rate", "10", "--tag", "oct", "--dlt-entity-id", "E1"], routes);
    expect(create.api.last().body).toEqual({ name: "Oct", from: "+14155550100", template: "Hi {{name}}", ratePerSecond: 10, tag: "oct", dltEntityId: "E1" });
    const alpha = await run(["sms", "broadcasts", "create", "--name", "Oct", "--from", "ACME"], routes);
    expect(alpha.api.last().body).toEqual({ name: "Oct", from: "ACME" });
    expect((await run(["sms", "broadcasts", "create", "--name", "Oct"], routes)).r.code).toBe(2);
    const update = await run(["sms", "broadcasts", "update", "b1", "--clear-schedule", "--name", "New"], routes);
    expect(update.api.last()).toMatchObject({ method: "PUT", path: "/broadcasts/b1", body: { name: "New", scheduledAt: null } });
    const del = await run(["sms", "broadcasts", "delete", "b1"], routes);
    expect(del.r.code).toBe(0);
    expect(del.api.last()).toMatchObject({ method: "DELETE", path: "/broadcasts/b1" });
  });

  it("uploads recipients as a multipart file or a JSON list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-sms-"));
    const csv = join(dir, "people.csv");
    writeFileSync(csv, "phone,name\n+14155550123,Ann\n");
    const file = await run(["sms", "broadcasts", "recipients", "upload", "b1", "--file", csv, "--default-country", "GB"], routes);
    expect(file.r.code).toBe(0);
    const form = file.api.last().body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as File).name).toBe("people.csv");
    expect(await (form.get("file") as File).text()).toContain("Ann");
    expect(form.get("defaultCountry")).toBe("GB");
    expect(file.api.last().headers["content-type"]).toBeUndefined(); // fetch sets the multipart boundary itself
    const list = await run(["sms", "broadcasts", "recipients", "upload", "b1", "--number", "+14155550123,+14155550124"], routes);
    expect(list.api.last().body).toEqual({ numbers: ["+14155550123", "+14155550124"] });
    expect((await run(["sms", "broadcasts", "recipients", "upload", "b1"], routes)).r.code).toBe(2);
  });

  it("lists recipients, previews and exports", async () => {
    const rec = await run(["sms", "broadcasts", "recipients", "list", "b1", "--status", "failed"], routes, ["--json"]);
    expect(rec.api.last().query).toEqual({ status: "failed", limit: "50", offset: "0" });
    const prev = await run(["sms", "broadcasts", "preview", "b1", "--limit", "2"], routes, ["--json"]);
    expect(prev.api.last().query).toEqual({ limit: "2" });
    expect(prev.r.json()).toMatchObject({ estimatedSegments: 3 });
    const exp = await run(["sms", "broadcasts", "export", "b1"], routes, []);
    expect(exp.r.out).toBe("to,status\n+14155550123,sent\n");
    const out = join(mkdtempSync(join(tmpdir(), "vobiz-sms-")), "r.csv");
    await run(["sms", "broadcasts", "export", "b1", "--out", out], routes, []);
    expect(readFileSync(out, "utf8")).toContain("+14155550123,sent");
    expect((await run(["sms", "broadcasts", "export", "b1", "--out", out], routes, [])).r.code).toBe(2);
  });

  it("launch shows the recipient count and segments, refuses without --yes, and sends nothing on --dry-run", async () => {
    const ok = await run(["sms", "broadcasts", "launch", "b1"], routes);
    expect(ok.r.code).toBe(0);
    expect(ok.r.err).toContain("3 pending of 3");
    expect(ok.r.err).toContain("estimated segments: 3");
    expect(ok.api.last()).toMatchObject({ method: "POST", path: "/broadcasts/b1/launch" });
    const refused = await run(["sms", "broadcasts", "launch", "b1"], routes, []);
    expect(refused.r.code).toBe(6);
    expect(refused.api.calls.some((c) => c.method === "POST")).toBe(false);
    const dry = await run(["sms", "broadcasts", "launch", "b1", "--dry-run"], routes, ["--json"]);
    expect(dry.r.json()).toMatchObject({ dry_run: true, operation: "launch-broadcast" });
    expect(dry.api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("pause, resume, cancel", async () => {
    for (const verb of ["pause", "resume", "cancel"]) {
      const { r, api } = await run(["sms", "broadcasts", verb, "b1"], routes);
      expect(r.code, verb).toBe(0);
      expect(api.last()).toMatchObject({ method: "POST", path: `/broadcasts/b1/${verb}` });
    }
  });
});

describe("sms senders and templates", () => {
  const S = { id: "s1", senderName: "acme", status: "pending" };
  const T = { templateName: "t1", type: "RICH_CARD", status: "pending" };
  const routes = {
    "GET /senders": [S],
    "POST /senders": reply(201, S),
    "GET /senders/s1": S,
    "PUT /senders/s1": S,
    "GET /senders/s1/status": S,
    "GET /senders/s1/templates": [T],
    "POST /senders/s1/templates": reply(201, T),
    "GET /senders/s1/templates/t1": T,
    "DELETE /senders/s1/templates/t1": reply(204),
    "GET /senders/s1/templates/t1/status": T,
  };

  it("senders list|get|create|update|status", async () => {
    expect((await run(["sms", "senders", "list"], routes, ["--json"])).api.last().query).toEqual({ limit: "20", offset: "0" });
    expect((await run(["sms", "senders", "get", "s1"], routes, ["--json"])).r.json()).toEqual(S);
    const create = await run(
      ["sms", "senders", "create", "--provider", "P1", "--sender-name", "acme", "--display-name", "Acme", "--phones", '[{"phoneNumber":"+14155550100","label":"Support"}]', "--body", '{"color":"#000000","displayName":"Old"}'],
      routes,
    );
    expect(create.api.last().body).toEqual({ provider: "P1", senderName: "acme", displayName: "Acme", color: "#000000", phones: [{ phoneNumber: "+14155550100", label: "Support" }] });
    expect((await run(["sms", "senders", "create", "--provider", "P1"], routes)).r.code).toBe(2);
    const update = await run(["sms", "senders", "update", "s1", "--description", "Alerts"], routes);
    expect(update.api.last()).toMatchObject({ method: "PUT", path: "/senders/s1", body: { description: "Alerts" } });
    expect((await run(["sms", "senders", "status", "s1"], routes, ["--json"])).api.last().path).toBe("/senders/s1/status");
  });

  it("templates list|get|create|delete|status", async () => {
    expect((await run(["sms", "senders", "templates", "list", "s1"], routes, ["--json"])).api.last().path).toBe("/senders/s1/templates");
    expect((await run(["sms", "senders", "templates", "get", "s1", "t1"], routes, ["--json"])).api.last().path).toBe("/senders/s1/templates/t1");
    const create = await run(["sms", "senders", "templates", "create", "s1", "--name", "t1", "--type", "RICH_CARD", "--content", '{"title":"Hi"}'], routes);
    expect(create.api.last().body).toEqual({ templateName: "t1", type: "RICH_CARD", content: { title: "Hi" } });
    const del = await run(["sms", "senders", "templates", "delete", "s1", "t1"], routes);
    expect(del.api.last()).toMatchObject({ method: "DELETE", path: "/senders/s1/templates/t1" });
    expect((await run(["sms", "senders", "templates", "status", "s1", "t1"], routes, ["--json"])).api.last().path).toBe("/senders/s1/templates/t1/status");
  });
});

describe("sms 10dlc", () => {
  const BR = { id: "br1", name: "Acme", brandType: "TENDLC_PRIVATE_COMPANY" };
  const CA = { id: "ca1", name: "Alerts", brandId: "br1" };
  const routes = {
    "GET /10dlc/brands": [BR],
    "POST /10dlc/brands": reply(201, BR),
    "GET /10dlc/brands/br1": BR,
    "PUT /10dlc/brands/br1": BR,
    "DELETE /10dlc/brands/br1": reply(204),
    "POST /10dlc/brands/br1/register": BR,
    "GET /10dlc/brands/br1/registrar-statuses": [{ registrar: "TCR", state: "OK" }],
    "POST /10dlc/brands/br1/brand-auth-verification": reply(202, { status: "requested" }),
    "POST /10dlc/brands/br1/resend-2fa": reply(202, { status: "requested" }),
    "POST /10dlc/brands/br1/vet": { vetId: "v1" },
    "GET /10dlc/brands/br1/vets": { results: [{ vetId: "v1" }], paging: { page: 0, size: 20, totalResults: 1 } },
    "GET /10dlc/campaigns": [CA],
    "POST /10dlc/campaigns": reply(201, CA),
    "POST /10dlc/campaigns/toll-free": reply(201, CA),
    "GET /10dlc/campaigns/priorities": [{ id: "pr1" }],
    "GET /10dlc/campaigns/ca1": CA,
    "PUT /10dlc/campaigns/ca1": CA,
    "DELETE /10dlc/campaigns/ca1": reply(204),
    "POST /10dlc/campaigns/ca1/register": CA,
    "POST /10dlc/campaigns/ca1/deregister": CA,
    "POST /10dlc/campaigns/ca1/appeal": CA,
    "POST /10dlc/campaigns/ca1/update-registration": CA,
    "GET /10dlc/campaigns/ca1/network-statuses": [{ network: "ATT", state: "OK" }],
    "GET /10dlc/campaigns/ca1/numbers": { numberPreviews: [{ number: "14155550100", numberKey: "k1" }] },
    "POST /10dlc/campaigns/ca1/numbers": { status: "ok" },
    "DELETE /10dlc/campaigns/ca1/numbers": { status: "ok" },
    "POST /10dlc/documents": reply(201, { id: "d1", documentId: "doc1" }),
    "GET /10dlc/documents/doc1": textReply(200, "%PDF-fake", { "content-type": "application/pdf", "content-disposition": 'attachment; filename="optin.pdf"' }),
  };

  it("brands: list, get, create, update, delete", async () => {
    expect((await run(["sms", "10dlc", "brands", "list"], routes, ["--json"])).r.json()).toEqual([BR]);
    expect((await run(["sms", "10dlc", "brands", "get", "br1"], routes, ["--json"])).api.last().path).toBe("/10dlc/brands/br1");
    const create = await run(
      ["sms", "10dlc", "brands", "create", "--name", "Acme", "--brand-type", "TENDLC_PRIVATE_COMPANY", "--support-phone", "+1 415 555 0100", "--entity-type", "PRIVATE_COMPANY", "--reference-id", "r1", "--alternate-business-id", '{"type":"DUNS","value":"1"}'],
      routes,
    );
    expect(create.api.last().body).toEqual({
      name: "Acme",
      brandType: "TENDLC_PRIVATE_COMPANY",
      supportPhone: "+14155550100",
      legalEntityType: "PRIVATE_COMPANY",
      referenceId: "r1",
      alternateBusinessId: { type: "DUNS", value: "1" },
    });
    expect((await run(["sms", "10dlc", "brands", "create", "--name", "Acme"], routes)).r.code).toBe(2);
    expect((await run(["sms", "10dlc", "brands", "create", "--name", "Acme", "--brand-type", "NOPE"], routes)).r.code).toBe(2);
    const update = await run(["sms", "10dlc", "brands", "update", "br1", "--body", JSON.stringify(BR), "--website", "https://acme.example"], routes);
    expect(update.api.last()).toMatchObject({ method: "PUT", body: { ...BR, website: "https://acme.example" } });
    expect(update.r.err).toContain("fields not sent are cleared");
    const del = await run(["sms", "10dlc", "brands", "delete", "br1"], routes);
    expect(del.api.last()).toMatchObject({ method: "DELETE", path: "/10dlc/brands/br1" });
    expect((await run(["sms", "10dlc", "brands", "delete", "br1"], routes, [])).r.code).toBe(6);
  });

  it("brands: register, statuses, verify, resend-2fa, vet, vets", async () => {
    expect((await run(["sms", "10dlc", "brands", "register", "br1"], routes)).api.last()).toMatchObject({ method: "POST", path: "/10dlc/brands/br1/register" });
    expect((await run(["sms", "10dlc", "brands", "register", "br1"], routes, [])).r.code).toBe(6);
    expect((await run(["sms", "10dlc", "brands", "statuses", "br1"], routes, ["--json"])).api.last().path).toBe("/10dlc/brands/br1/registrar-statuses");
    expect((await run(["sms", "10dlc", "brands", "verify", "br1"], routes)).api.last().path).toBe("/10dlc/brands/br1/brand-auth-verification");
    expect((await run(["sms", "10dlc", "brands", "resend-2fa", "br1"], routes)).api.last().path).toBe("/10dlc/brands/br1/resend-2fa");
    const vet = await run(["sms", "10dlc", "brands", "vet", "br1", "--type", "ENHANCED"], routes);
    expect(vet.api.last()).toMatchObject({ method: "POST", path: "/10dlc/brands/br1/vet", body: { type: "ENHANCED" } });
    const vets = await run(["sms", "10dlc", "brands", "vets", "br1"], routes, ["--json"]);
    expect(vets.api.last().query).toEqual({ page: "0", size: "20" });
    expect(vets.r.json()).toMatchObject({ results: [{ vetId: "v1" }] });
  });

  it("campaigns: list, get, create, create-toll-free, priorities, update, delete", async () => {
    expect((await run(["sms", "10dlc", "campaigns", "list"], routes, ["--json"])).r.json()).toEqual([CA]);
    expect((await run(["sms", "10dlc", "campaigns", "get", "ca1"], routes, ["--json"])).api.last().path).toBe("/10dlc/campaigns/ca1");
    const create = await run(
      ["sms", "10dlc", "campaigns", "create", "--brand", "br1", "--name", "Alerts", "--use-case", "ALERTS,TWO_FACTOR_AUTH", "--example", "Acme: hi, reply STOP to opt out.", "--example", "Acme: code 1", "--number", "+14155550100", "--low-volume", "--opt-ins", '{"web":{"url":"https://acme.example"}}'],
      routes,
    );
    expect(create.api.last().body).toEqual({
      brandId: "br1",
      name: "Alerts",
      useCases: ["ALERTS", "TWO_FACTOR_AUTH"],
      exampleMessages: ["Acme: hi, reply STOP to opt out.", "Acme: code 1"],
      numbers: ["14155550100"],
      lowVolume: true,
      optIns: { web: { url: "https://acme.example" } },
    });
    expect((await run(["sms", "10dlc", "campaigns", "create", "--name", "Alerts"], routes)).r.code).toBe(2);
    const tf = await run(["sms", "10dlc", "campaigns", "create-toll-free", "--name", "TF", "--number", "+18885550100", "--dba", "Acme", "--priority", "pr1"], routes);
    expect(tf.api.last()).toMatchObject({ path: "/10dlc/campaigns/toll-free", body: { name: "TF", numbers: ["+18885550100"], businessDBA: "Acme", priorityId: "pr1" } });
    expect((await run(["sms", "10dlc", "campaigns", "priorities"], routes, ["--json"])).r.json()).toEqual([{ id: "pr1" }]);
    const update = await run(["sms", "10dlc", "campaigns", "update", "ca1", "--name", "Alerts 2", "--help-message", "Help"], routes);
    expect(update.api.last()).toMatchObject({ method: "PUT", body: { name: "Alerts 2", helpMessage: "Help" } });
    const del = await run(["sms", "10dlc", "campaigns", "delete", "ca1"], routes);
    expect(del.api.last()).toMatchObject({ method: "DELETE", path: "/10dlc/campaigns/ca1" });
  });

  it("campaigns: register, deregister, appeal, update-registration, statuses", async () => {
    const reg = await run(["sms", "10dlc", "campaigns", "register", "ca1", "--priority", "pr1"], routes);
    expect(reg.api.last()).toMatchObject({ path: "/10dlc/campaigns/ca1/register", body: { priorityId: "pr1" } });
    expect((await run(["sms", "10dlc", "campaigns", "register", "ca1"], routes)).api.last().body).toEqual({});
    expect((await run(["sms", "10dlc", "campaigns", "register", "ca1"], routes, [])).r.code).toBe(6);
    expect((await run(["sms", "10dlc", "campaigns", "deregister", "ca1"], routes)).api.last().path).toBe("/10dlc/campaigns/ca1/deregister");
    const appeal = await run(["sms", "10dlc", "campaigns", "appeal", "ca1", "--reason", "Fixed opt-in"], routes);
    expect(appeal.api.last().body).toEqual({ reason: "Fixed opt-in" });
    const upd = await run(["sms", "10dlc", "campaigns", "update-registration", "ca1", "--number", "+14155550100", "--number-key", "k1"], routes);
    expect(upd.api.last().body).toEqual({ numbers: ["14155550100"], numberKeys: ["k1"] });
    expect((await run(["sms", "10dlc", "campaigns", "update-registration", "ca1"], routes)).r.code).toBe(2);
    expect((await run(["sms", "10dlc", "campaigns", "statuses", "ca1"], routes, ["--json"])).api.last().path).toBe("/10dlc/campaigns/ca1/network-statuses");
  });

  it("campaign numbers list|add|remove (remove sends a DELETE with a JSON body)", async () => {
    const list = await run(["sms", "10dlc", "campaigns", "numbers", "list", "ca1"], routes, ["--quiet"]);
    expect(list.r.out).toBe("14155550100\n");
    const add = await run(["sms", "10dlc", "campaigns", "numbers", "add", "ca1", "--number", "+14155550100,+14155550101"], routes);
    expect(add.api.last()).toMatchObject({ method: "POST", body: { numbers: ["14155550100", "14155550101"] } });
    const rm = await run(["sms", "10dlc", "campaigns", "numbers", "remove", "ca1", "--number-key", "k1"], routes);
    expect(rm.r.code).toBe(0);
    expect(rm.api.last()).toMatchObject({ method: "DELETE", path: "/10dlc/campaigns/ca1/numbers", body: { numberKeys: ["k1"] } });
    expect(rm.api.last().headers).toMatchObject({ "content-type": "application/json", "x-auth-id": "MA_XXXXXXXX", "x-auth-token": "YOUR_AUTH_TOKEN" });
    const refused = await run(["sms", "10dlc", "campaigns", "numbers", "remove", "ca1", "--number-key", "k1"], routes, []);
    expect(refused.r.code).toBe(6);
    expect(refused.api.calls).toHaveLength(0);
    const dry = await run(["sms", "10dlc", "campaigns", "numbers", "remove", "ca1", "--number-key", "k1", "--dry-run"], routes, ["--json"]);
    expect(dry.r.json()).toMatchObject({ dry_run: true, method: "DELETE", body: { numberKeys: ["k1"] }, headers: { "X-Auth-Token": "[redacted]" } });
    expect(dry.api.calls).toHaveLength(0);
    const err = await run(["sms", "10dlc", "campaigns", "numbers", "remove", "ca1", "--number-key", "k1"], { "DELETE /10dlc/campaigns/ca1/numbers": reply(404, { error: "campaign not found" }) });
    expect(err.r.code).toBe(4);
    expect(err.r.err).toContain("campaign not found");
    const net = await run(["sms", "10dlc", "campaigns", "numbers", "remove", "ca1", "--number-key", "k1"], { "DELETE /10dlc/campaigns/ca1/numbers": networkError() });
    expect(net.r.code).toBe(7);
  });

  it("documents upload (multipart) and get (download)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-sms-"));
    const file = join(dir, "optin.png");
    writeFileSync(file, Buffer.from([1, 2, 3]));
    const up = await run(["sms", "10dlc", "documents", "upload", "--file", file], routes);
    expect(up.r.code).toBe(0);
    const form = up.api.last().body as FormData;
    expect((form.get("document") as File).name).toBe("optin.png");
    expect((await run(["sms", "10dlc", "documents", "upload", "--file", join(dir, "missing.png")], routes)).r.code).toBe(2);
    const out = join(dir, "saved.pdf");
    const get = await run(["sms", "10dlc", "documents", "get", "doc1", "--out", out], routes);
    expect(get.r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("%PDF-fake");
    expect((await run(["sms", "10dlc", "documents", "get", "doc1", "--out", out], routes)).r.code).toBe(2);
  });
});

describe("coverage of the Messaging API spec", () => {
  it("every sms operation is used by a command", () => {
    const src = ["messages", "numbers", "inbox", "broadcasts", "senders", "tendlc"]
      .map((f) => readFileSync(join(__dirname, "..", "src", "commands", "sms", `${f}.ts`), "utf8"))
      .join("\n");
    const missing = OPERATIONS.filter((o) => o.api === "sms").filter((o) => !src.includes(`op("${o.id}")`) && !src.includes(`op("sms:${o.id}")`));
    expect(missing.map((o) => o.id)).toEqual([]);
  });
});
