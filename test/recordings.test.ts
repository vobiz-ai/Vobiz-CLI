import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_AUTH_ID, fakeFetch, reply, runCli, textReply } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const ID = "55667788-1234-5678-90ab-cdef12345678";
const NOW = () => new Date(2026, 9, 22, 12, 0, 0);
const rec = (id: string) => ({ recording_id: id, call_uuid: "c1", recording_format: "wav", recording_url: `https://recordings.vobiz.ai/example/${id}.wav` });

describe("vobiz recordings", () => {
  it("list pages with limit/offset and keeps the raw shape in JSON", async () => {
    const api = fakeFetch({
      [`GET ${A}/Recording/`]: (req) => {
        const offset = Number(req.query.offset);
        return { api_id: "x", meta: { limit: 2, offset, total_count: 3, next: offset + 2 < 3 ? "/next" : null }, objects: offset ? [rec("r3")] : [rec("r1"), rec("r2")] };
      },
    });
    const r = await runCli(["recordings", "list", "--limit", "2", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last().query).toEqual({ limit: "2", offset: "0" });
    expect(r.json()).toMatchObject({ meta: { total_count: 3 }, objects: [{ recording_id: "r1" }, { recording_id: "r2" }] });

    const all = await runCli(["recordings", "list", "--all", "--quiet"], { fetch: api.fetch });
    expect(all.out).toBe("r1\nr2\nr3\n");
    const table = await runCli(["recordings", "list", "--limit", "2", "--output", "table"], { fetch: api.fetch });
    expect(table.err).toContain("Showing 2 of 3");
  });

  it("get", async () => {
    const api = fakeFetch({ [`GET ${A}/Recording/${ID}/`]: rec(ID) });
    expect((await runCli(["recordings", "get", ID, "--json"], { fetch: api.fetch })).json()).toMatchObject({ recording_id: ID });
  });

  it("delete confirms, supports --dry-run, then DELETEs", async () => {
    const api = fakeFetch({ [`DELETE ${A}/Recording/${ID}/`]: reply(204) });
    expect((await runCli(["recordings", "delete", ID], { fetch: api.fetch })).code).toBe(6);
    expect((await runCli(["recordings", "delete", ID, "--dry-run"], { fetch: api.fetch })).code).toBe(0);
    expect(api.calls).toHaveLength(0);
    const r = await runCli(["recordings", "delete", ID, "-y", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${A}/Recording/${ID}/` });
  });

  it("download follows recording_url without sending credentials to the storage host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-rec-"));
    const out = join(dir, "call.wav");
    const api = fakeFetch({
      [`GET ${A}/Recording/${ID}/`]: rec(ID),
      [`GET /example/${ID}.wav`]: textReply(200, "RIFFxxxxWAVE", { "content-type": "audio/wav" }),
    });
    const r = await runCli(["recordings", "download", ID, "--out", out, "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("RIFFxxxxWAVE");
    expect(existsSync(`${out}.part`)).toBe(false);
    expect(r.json()).toEqual({ recording_id: ID, file: out, bytes: 12 });
    const dl = api.last();
    expect(dl.url).toBe(`https://recordings.vobiz.ai/example/${ID}.wav`);
    expect(dl.headers["x-auth-token"]).toBeUndefined();
    expect(dl.headers["x-auth-id"]).toBeUndefined();

    expect((await runCli(["recordings", "download", ID, "--out", out], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["recordings", "download", ID, "--out", out, "--force"], { fetch: api.fetch })).code).toBe(0);
    const stdout = await runCli(["recordings", "download", ID, "--out", "-"], { fetch: api.fetch });
    expect(stdout.out).toBe("RIFFxxxxWAVE");
  });

  it("download refuses a missing or non-https recording_url and reports storage errors", async () => {
    let api = fakeFetch({ [`GET ${A}/Recording/${ID}/`]: { recording_id: ID, recording_url: "" } });
    expect((await runCli(["recordings", "download", ID], { fetch: api.fetch })).code).toBe(1);
    api = fakeFetch({ [`GET ${A}/Recording/${ID}/`]: { recording_id: ID, recording_url: "http://recordings.vobiz.ai/a.mp3" } });
    expect((await runCli(["recordings", "download", ID], { fetch: api.fetch })).code).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "vobiz-rec-"));
    api = fakeFetch({ [`GET ${A}/Recording/${ID}/`]: rec(ID), [`GET /example/${ID}.wav`]: reply(403, { message: "expired" }) });
    const r = await runCli(["recordings", "download", ID, "--out", join(dir, "x.wav")], { fetch: api.fetch });
    expect(r.code).toBe(3);
    expect(existsSync(join(dir, "x.wav"))).toBe(false);
  });

  describe("export", () => {
    const route = { [`POST ${A}/export/recording/`]: reply(202, { api_id: "x", status: "success" }) };

    it("sends a date window and filters", async () => {
      const api = fakeFetch(route);
      const r = await runCli(
        ["recordings", "export", "--email", "ops@example.com", "--email", "b@example.com", "--from", "2026-09-01", "--to", "2026-09-30", "--from-number", "+91 98765 43210", "--format", "mp3", "--conference", "Standup", "-y", "--json"],
        { fetch: api.fetch, now: NOW },
      );
      expect(r.code, r.err).toBe(0);
      expect(api.last()).toMatchObject({ method: "POST", path: `${A}/export/recording/` });
      expect(api.last().body).toEqual({
        recipient: { customer_account: ["ops@example.com", "b@example.com"] },
        from: "2026-09-01 00:00:00",
        to: "2026-09-30 23:59:59",
        from_number: "+919876543210",
        recording_format: "mp3",
        conference_name: "Standup",
      });
      expect(r.json()).toEqual({ api_id: "x", status: "success" });
    });

    it("sends storage-age filters", async () => {
      const api = fakeFetch(route);
      await runCli(["recordings", "export", "--email", "a@b.co", "--min-age-days", "7", "--max-age-days", "30", "-y"], { fetch: api.fetch });
      expect(api.last().body).toEqual({ recipient: { customer_account: ["a@b.co"] }, recording_storage_duration__gte: "7", recording_storage_duration__lte: "30" });
      await runCli(["recordings", "export", "--email", "a@b.co", "--age-days", "7", "-y"], { fetch: api.fetch });
      expect(api.last().body).toEqual({ recipient: { customer_account: ["a@b.co"] }, recording_storage_duration: "7" });
    });

    it("validates and confirms", async () => {
      const api = fakeFetch(route);
      for (const argv of [
        ["--email", "nope"],
        ["--email", "a@b.co", "--from", "7d", "--age-days", "3"],
        ["--email", "a@b.co", "--min-age-days", "3"],
        ["--email", "a@b.co", "--min-age-days", "1", "--max-age-days", "40"],
        ["--email", "a@b.co", "--age-days", "1", "--min-age-days", "1", "--max-age-days", "2"],
        ["--email", "a@b.co", "--from", "2024-01-01", "--to", "2026-01-01"],
        ["--email", "a@b.co", "--format", "ogg"],
        [],
      ])
        expect((await runCli(["recordings", "export", ...argv, "-y"], { fetch: api.fetch, now: NOW })).code, argv.join(" ")).toBe(2);
      expect((await runCli(["recordings", "export", "--email", "a@b.co"], { fetch: api.fetch })).code).toBe(6);
      expect((await runCli(["recordings", "export", "--email", "a@b.co", "--dry-run"], { fetch: api.fetch })).code).toBe(0);
      expect(api.calls).toHaveLength(0);
    });
  });

  it("refuses to overwrite a file it did not create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-rec-"));
    writeFileSync(join(dir, "x.wav"), "keep");
    const api = fakeFetch({ [`GET ${A}/Recording/${ID}/`]: rec(ID) });
    expect((await runCli(["recordings", "download", ID, "--out", join(dir, "x.wav")], { fetch: api.fetch })).code).toBe(2);
    expect(readFileSync(join(dir, "x.wav"), "utf8")).toBe("keep");
  });
});
