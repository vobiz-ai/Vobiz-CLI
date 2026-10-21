import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cdrQuery } from "../src/commands/cdr.js";
import { defaultFileName } from "../src/commands/recordings.js";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, reply, runCli, textReply } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const NOW = () => new Date(2026, 9, 22, 12, 0, 0);
const row = (n: number) => ({
  uuid: `u${n}`,
  start_time: "2026-10-21T10:53:29Z",
  call_direction: "outbound",
  caller_id_number: "+918012345678",
  destination_number: "+919876543210",
  duration: 12,
  hangup_cause: "NORMAL_CLEARING",
  total_cost: 0.45,
});
const page = (rows: unknown[], p: number, hasNext: boolean, total: number) => ({
  account_id: TEST_AUTH_ID,
  count: rows.length,
  data: rows,
  pagination: { page: p, per_page: 2, total, pages: Math.ceil(total / 2), has_next: hasNext, has_prev: p > 1 },
  success: true,
  summary: { totalCalls: total, answeredCalls: 1, total_billable_seconds: 42, total_cost: 1.35 },
});

describe("vobiz cdr", () => {
  it("list maps every filter to the query", async () => {
    const api = fakeFetch({ [`GET ${A}/cdr`]: page([row(1)], 1, false, 1) });
    const r = await runCli(
      [
        "cdr", "list", "--from", "7d", "--to", "yesterday", "--direction", "outbound", "--from-number", "+918012345678", "--to-number", "919876543210",
        "--min-duration", "10", "--sip-call-id", "sip1", "--bridge-uuid", "b1", "--hangup-cause", "NO_ANSWER", "--disposition", "send_refuse",
        "--context", "voice-api", "--campaign-id", "camp", "--search", "abc", "--limit", "5", "--json",
      ],
      { fetch: api.fetch, now: NOW },
    );
    expect(r.code, r.err).toBe(0);
    expect(api.last()).toMatchObject({ method: "GET", path: `${A}/cdr` });
    expect(api.last().query).toEqual({
      start_date: "2026-10-15",
      end_date: "2026-10-21",
      call_direction: "outbound",
      from_number: "+918012345678",
      to_number: "919876543210",
      min_duration: "10",
      sip_call_id: "sip1",
      bridge_uuid: "b1",
      hangup_cause: "NO_ANSWER",
      hangup_disposition: "send_refuse",
      context: "voice-api",
      campaign_id: "camp",
      search: "abc",
      page: "1",
      per_page: "5",
    });
  });

  it("list --json keeps the API's response shape (snapshot)", async () => {
    const api = fakeFetch({ [`GET ${A}/cdr`]: (req) => (req.query.page === "1" ? page([row(1), row(2)], 1, true, 3) : page([row(3)], 2, false, 3)) });
    const r = await runCli(["cdr", "list", "--all", "--json"], { fetch: api.fetch, now: NOW });
    expect(r.code).toBe(0);
    expect(api.calls.map((c) => c.query.page)).toEqual(["1", "2"]);
    expect(r.json()).toMatchSnapshot();
  });

  it("list prints a table with a summary and a more-rows hint", async () => {
    const api = fakeFetch({ [`GET ${A}/cdr`]: page([row(1), row(2)], 1, true, 3) });
    const r = await runCli(["cdr", "list", "--limit", "2", "--output", "table"], { fetch: api.fetch });
    expect(r.out).toContain("DESTINATION_NUMBER");
    expect(r.out).toContain("u2");
    expect(r.err).toContain("Showing 2 of 3");
    expect(r.err).toContain("Summary: 3 calls, 1 answered, 42s billable, cost 1.35");
  });

  it("search uses the search endpoint", async () => {
    const api = fakeFetch({ [`GET ${A}/cdr/search`]: { ...page([row(1)], 1, false, 1), filters: { search: "abc" } } });
    const r = await runCli(["cdr", "search", "--search", "abc", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toMatchObject({ search: "abc", page: "1" });
    expect(r.json()).toMatchObject({ filters: { search: "abc" }, data: [{ uuid: "u1" }] });
  });

  it("date rules", () => {
    const now = NOW();
    expect(cdrQuery({ from: "2026-10-01" }, now)).toMatchObject({ start_date: "2026-10-01", end_date: "2026-10-22" });
    expect(cdrQuery({}, now)).toMatchObject({ start_date: undefined, end_date: undefined });
    expect(() => cdrQuery({ to: "today" }, now)).toThrow(/--to needs --from/);
    expect(() => cdrQuery({ from: "today", to: "7d" }, now)).toThrow(/after/);
  });

  it("rejects bad filters", async () => {
    const api = fakeFetch();
    for (const argv of [["--direction", "sideways"], ["--min-duration", "x"], ["--from", "someday"], ["--to", "today"], ["--limit", "0"]])
      expect((await runCli(["cdr", "list", ...argv], { fetch: api.fetch })).code, argv.join(" ")).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("recent", async () => {
    const api = fakeFetch({ [`GET ${A}/cdr/recent`]: { account_id: TEST_AUTH_ID, count: 1, data: [row(1)], success: true } });
    let r = await runCli(["cdr", "recent", "--limit", "50", "--json"], { fetch: api.fetch });
    expect(api.last().query).toEqual({ limit: "50" });
    expect(r.json()).toMatchObject({ data: [{ uuid: "u1" }] });
    r = await runCli(["cdr", "recent", "--quiet"], { fetch: api.fetch });
    expect(r.out).toBe("u1\n");
    expect(api.last().query).toEqual({ limit: "20" });
  });

  it("get", async () => {
    const api = fakeFetch({ [`GET ${A}/cdr/u1`]: { data: row(1) }, [`GET ${A}/cdr/missing`]: reply(404, { message: "CDR not found" }) });
    expect((await runCli(["cdr", "get", "u1", "--json"], { fetch: api.fetch })).json()).toEqual({ data: row(1) });
    expect((await runCli(["cdr", "get", "u1", "--output", "plain"], { fetch: api.fetch })).out).toContain("hangup_cause: NORMAL_CLEARING");
    expect((await runCli(["cdr", "get", "missing"], { fetch: api.fetch })).code).toBe(4);
  });

  describe("export", () => {
    const csv = "uuid,duration\nu1,12\nu2,30\n";

    it("streams CSV to stdout with Accept: text/csv", async () => {
      const api = fakeFetch({ [`GET ${A}/cdr/export`]: textReply(200, csv, { "content-type": "text/csv" }) });
      const r = await runCli(["cdr", "export", "--from", "2026-10-01", "--to", "2026-10-07", "--direction", "inbound"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toBe(csv);
      expect(api.last().query).toEqual({ start_date: "2026-10-01", end_date: "2026-10-07", call_direction: "inbound" });
      expect(api.last().headers.accept).toBe("text/csv");
      expect(api.last().headers["x-auth-id"]).toBe(TEST_AUTH_ID);
    });

    it("writes --out and refuses to overwrite without --force", async () => {
      const dir = mkdtempSync(join(tmpdir(), "vobiz-cdr-"));
      const out = join(dir, "cdr.csv");
      const api = fakeFetch({ [`GET ${A}/cdr/export`]: textReply(200, csv, { "content-type": "text/csv" }) });
      const r = await runCli(["cdr", "export", "--from", "7d", "--out", out, "--json"], { fetch: api.fetch, now: NOW });
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(csv);
      expect(r.json()).toEqual({ file: out, bytes: csv.length });
      expect((await runCli(["cdr", "export", "--out", out], { fetch: api.fetch })).code).toBe(2);
      expect((await runCli(["cdr", "export", "--out", out, "--force"], { fetch: api.fetch })).code).toBe(0);
    });

    it("maps API errors and leaves no partial file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "vobiz-cdr-"));
      const api = fakeFetch({ [`GET ${A}/cdr/export`]: reply(401, { message: "invalid credentials" }) });
      const r = await runCli(["cdr", "export", "--out", join(dir, "x.csv")], { fetch: api.fetch });
      expect(r.code).toBe(3);
      expect(r.err).toContain("invalid credentials");
      expect(existsSync(join(dir, "x.csv"))).toBe(false);
    });

    it("--dry-run prints the request and sends nothing", async () => {
      const api = fakeFetch();
      const r = await runCli(["cdr", "export", "--from", "2026-10-01", "--dry-run", "--json"], { fetch: api.fetch, now: NOW });
      expect(r.code).toBe(0);
      expect(api.calls).toHaveLength(0);
      expect(r.json()).toMatchObject({ dry_run: true, operation: "export-cdrs", headers: { Accept: "text/csv", "X-Auth-Token": "[redacted]" } });
      expect(r.out).not.toContain(TEST_AUTH_TOKEN);
    });
  });
});

describe("recordings default file name", () => {
  it("uses the record's format, then the URL extension, then mp3", () => {
    expect(defaultFileName("r1", { recording_format: "wav" }, new URL("https://x/a.mp3"))).toBe("r1.wav");
    expect(defaultFileName("r1", {}, new URL("https://x/a.MP3"))).toBe("r1.mp3");
    expect(defaultFileName("../r1", {}, new URL("https://x/a"))).toBe(".._r1.mp3");
  });
});
