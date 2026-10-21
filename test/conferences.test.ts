import { describe, expect, it } from "vitest";
import { TEST_AUTH_ID, fakeFetch, reply, runCli } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const ROOM = "My Room";
const R = `${A}/Conference/My%20Room`;

describe("vobiz conferences", () => {
  it("list prints names, raw body in JSON", async () => {
    const api = fakeFetch({ [`GET ${A}/Conference/`]: { api_id: "x", conferences: ["Standup", ROOM] } });
    expect((await runCli(["conferences", "list", "--json"], { fetch: api.fetch })).json()).toEqual({ api_id: "x", conferences: ["Standup", ROOM] });
    expect((await runCli(["conferences", "list", "--output", "plain"], { fetch: api.fetch })).out).toBe("Standup\nMy Room\n");
  });

  it("get encodes the room name and shows members", async () => {
    const body = {
      conference_name: ROOM,
      conference_run_time: "590",
      conference_member_count: "1",
      members: [{ member_id: "17", call_uuid: "c1", muted: false, deaf: false }],
      api_id: "x",
    };
    const api = fakeFetch({ [`GET ${R}/`]: body });
    const r = await runCli(["conferences", "get", ROOM, "--json"], { fetch: api.fetch });
    expect(r.json()).toEqual(body);
    expect(api.last().path).toBe(`${R}/`);
    const t = await runCli(["conferences", "get", ROOM, "--output", "table"], { fetch: api.fetch });
    expect(t.err).toContain('Conference "My Room": 1 member(s)');
    expect(t.out).toContain("MEMBER_ID");
  });

  it("get reports the live-retrieval failure payload as an error", async () => {
    const api = fakeFetch({ [`GET ${R}/`]: { error: "failed", api_id: "x" } });
    const r = await runCli(["conferences", "get", ROOM], { fetch: api.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not read conference");
    expect((await runCli(["conferences", "get", "Nope"], { fetch: fakeFetch({ [`GET ${A}/Conference/Nope/`]: reply(404, { error: "conference not found" }) }).fetch })).code).toBe(4);
  });

  const writes: { argv: string[]; method: string; path: string; body?: unknown }[] = [
    { argv: ["end", ROOM], method: "DELETE", path: `${R}/` },
    { argv: ["end-all"], method: "DELETE", path: `${A}/Conference/` },
    { argv: ["members", "mute", ROOM, "all"], method: "POST", path: `${R}/Member/all/Mute/` },
    { argv: ["members", "unmute", ROOM, "17"], method: "DELETE", path: `${R}/Member/17/Mute/` },
    { argv: ["members", "deaf", ROOM, "10,15"], method: "POST", path: `${R}/Member/10%2C15/Deaf/` },
    { argv: ["members", "undeaf", ROOM, "17"], method: "DELETE", path: `${R}/Member/17/Deaf/` },
    { argv: ["members", "kick", ROOM, "17"], method: "POST", path: `${R}/Member/17/Kick/` },
    { argv: ["members", "hangup", ROOM, "17"], method: "DELETE", path: `${R}/Member/17/` },
    { argv: ["members", "play", ROOM, "17", "--url", "https://e.com/a.mp3"], method: "POST", path: `${R}/Member/17/Play/`, body: { url: "https://e.com/a.mp3" } },
    { argv: ["members", "play", "stop", ROOM, "17"], method: "DELETE", path: `${R}/Member/17/Play/` },
    { argv: ["record", "start", ROOM, "--format", "wav", "--callback-url", "https://e.com/cb"], method: "POST", path: `${R}/Record/`, body: { file_format: "wav", callback_url: "https://e.com/cb" } },
    { argv: ["record", "stop", ROOM], method: "DELETE", path: `${R}/Record/` },
  ];

  for (const w of writes) {
    it(`${w.argv.slice(0, 2).join(" ")} → ${w.method} ${w.path.slice(A.length)}`, async () => {
      const api = fakeFetch({ [`${w.method} ${w.path}`]: w.method === "DELETE" ? reply(204) : reply(202, { message: "ok", member_id: ["17"] }) });
      expect((await runCli(["conferences", ...w.argv], { fetch: api.fetch })).code).toBe(6);
      const dry = await runCli(["conferences", ...w.argv, "--dry-run", "--json"], { fetch: api.fetch });
      expect(dry.code).toBe(0);
      expect(dry.json()).toMatchObject({ dry_run: true, method: w.method });
      expect(api.calls).toHaveLength(0);
      const r = await runCli(["conferences", ...w.argv, "--yes", "--json"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(0);
      expect(api.last()).toMatchObject({ method: w.method, path: w.path });
      if (w.body) expect(api.last().body).toEqual(w.body);
    });
  }

  it("rejects bad member ids and URLs", async () => {
    const api = fakeFetch();
    for (const argv of [
      ["members", "mute", ROOM, "17;drop"],
      ["members", "mute", ROOM, "1,,2"],
      ["members", "play", ROOM, "17"],
      ["members", "play", ROOM, "17", "--url", "http://e.com/a.mp3"],
      ["record", "start", ROOM, "--format", "ogg"],
    ])
      expect((await runCli(["conferences", ...argv, "-y"], { fetch: api.fetch })).code, argv.join(" ")).toBe(2);
    expect(api.calls).toHaveLength(0);
  });
});
