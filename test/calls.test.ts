import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { playXml, sayXml } from "../src/commands/calls.js";
import { TEST_AUTH_ID, TEST_AUTH_TOKEN, fakeFetch, makeCtx, networkError, reply, runCli } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const TO = "+919876543210";
const FROM = "+918012345678";
const UUID = "2ded13fe-4f9b-4958-9bfb-093ea2f29f91";
const base = ["calls", "create", "--to", TO, "--from", FROM];

describe("vobiz calls create", () => {
  const made = { api_id: "a1", message: "Call fired", request_uuid: UUID };

  it("places a call with --answer-url and --yes", async () => {
    const api = fakeFetch({ [`POST ${A}/Call/`]: made });
    const r = await runCli([...base, "--answer-url", "https://example.com/answer", "--yes", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({
      method: "POST",
      path: `${A}/Call/`,
      body: { from: FROM, to: TO, answer_url: "https://example.com/answer", answer_method: "POST" },
    });
    expect(r.json()).toMatchObject({ request_uuid: UUID });
    expect(r.err).toContain("caller ID: +918012345678");
    expect(r.err).toContain("answer URL host: example.com");
  });

  it("normalises numbers, keeps SIP URIs and fans out with <", async () => {
    const api = fakeFetch({ [`POST ${A}/Call/`]: made });
    const r = await runCli(
      ["calls", "create", "--to", "+91 98765-43210<sip:agent@example.com", "--from", "0091 8012345678", "--answer-url", "https://e.com/a", "--answer-method", "GET", "-y", "--json"],
      { fetch: api.fetch },
    );
    expect(r.code).toBe(0);
    expect(api.last().body).toMatchObject({ to: `${TO}<sip:agent@example.com`, from: FROM, answer_method: "GET" });
    expect(r.err).toContain("Place 2 calls");
  });

  it("refuses without --yes when stdin is not a TTY, and on a TTY 'no'", async () => {
    const api = fakeFetch({ [`POST ${A}/Call/`]: made });
    expect((await runCli([...base, "--answer-url", "https://e.com/a"], { fetch: api.fetch })).code).toBe(6);
    expect((await runCli([...base, "--answer-url", "https://e.com/a"], { fetch: api.fetch, stdinTTY: true, prompts: { confirm: false } })).code).toBe(6);
    expect(api.calls).toHaveLength(0);
    const ok = await runCli([...base, "--answer-url", "https://e.com/a", "--json"], { fetch: api.fetch, stdinTTY: true, prompts: { confirm: true } });
    expect(ok.code).toBe(0);
    expect(api.calls).toHaveLength(1);
  });

  it("--dry-run sends nothing", async () => {
    const api = fakeFetch();
    const r = await runCli([...base, "--answer-url", "https://e.com/a", "--dry-run", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(r.json()).toMatchObject({ dry_run: true, method: "POST", operation: "make-call", body: { to: TO } });
    expect(r.out + r.err).not.toContain(TEST_AUTH_TOKEN);
  });

  it("validates input", async () => {
    const api = fakeFetch();
    const cases = [
      [...base],
      [...base, "--answer-url", "https://e.com/a", "--say", "hi"],
      [...base, "--answer-url", "http://e.com/a"],
      [...base, "--answer-url", "http://localhost:3000/a"],
      [...base, "--answer-url", "ftp://e.com/a"],
      ["calls", "create", "--to", "12", "--from", FROM, "--answer-url", "https://e.com/a"],
      ["calls", "create", "--from", FROM, "--answer-url", "https://e.com/a"],
      [...base, "--say", "hello"],
      [...base, "--say", "hello", "--serve"],
      ["calls", "create", "--to", "+919876543210<+919876543211", "--from", FROM, "--say", "hello", "--serve", "--public-url", "https://t.example.com/a"],
      [...base, "--answer-url", "https://e.com/a", "--no-token"],
      [...base, "--answer-url", "https://e.com/a", "--voice", "MAN"],
      [...base, "--answer-url", "https://e.com/a", "--answer-method", "PUT"],
      ["calls", "create", "--answer-url", "https://e.com/a", "--xml-only"],
    ];
    for (const argv of cases) expect((await runCli([...argv, "-y"], { fetch: api.fetch })).code, argv.join(" ")).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("allows http on localhost only with --allow-insecure-url", async () => {
    const api = fakeFetch({ [`POST ${A}/Call/`]: made });
    const r = await runCli([...base, "--answer-url", "http://localhost:3000/a", "--allow-insecure-url", "-y", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect((await runCli([...base, "--answer-url", "http://e.com/a", "--allow-insecure-url", "-y"], { fetch: api.fetch })).code).toBe(2);
  });

  it("--xml-only prints VobizXML for --say, --play and --xml-file without calling", async () => {
    const api = fakeFetch();
    let r = await runCli(["calls", "create", "--say", "Hi & <bye>", "--voice", "MAN", "--language", "en-GB", "--xml-only"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toBe(sayXml("Hi & <bye>", "MAN", "en-GB"));
    expect(r.out).toContain('<Speak voice="MAN" language="en-GB">Hi &amp; &lt;bye&gt;</Speak>');
    r = await runCli(["calls", "create", "--play", "https://e.com/a.mp3", "--xml-only"], { fetch: api.fetch });
    expect(r.out).toBe(playXml("https://e.com/a.mp3"));
    const dir = mkdtempSync(join(tmpdir(), "vobiz-xml-"));
    writeFileSync(join(dir, "ok.xml"), "<Response><Hangup/></Response>");
    writeFileSync(join(dir, "bad.xml"), "<html></html>");
    r = await runCli(["calls", "create", "--xml-file", join(dir, "ok.xml"), "--xml-only"], { fetch: api.fetch });
    expect(r.out).toBe("<Response><Hangup/></Response>");
    expect((await runCli(["calls", "create", "--xml-file", join(dir, "bad.xml"), "--xml-only"], { fetch: api.fetch })).code).toBe(2);
    expect((await runCli(["calls", "create", "--xml-file", join(dir, "missing.xml"), "--xml-only"], { fetch: api.fetch })).code).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("--serve hosts the XML locally for the call and waits for it to end", async () => {
    let served = "";
    let answerPath = "";
    let bare = 0;
    let wrongMethod = 0;
    let liveHits = 0;
    const t = makeCtx({
      fetch: fakeFetch({
        [`POST ${A}/Call/`]: async (req) => {
          const port = /127\.0\.0\.1:(\d+)/.exec(t.stderr.text)?.[1];
          const answer = new URL(String((req.body as Record<string, unknown>).answer_url));
          answerPath = answer.pathname;
          const local = `http://127.0.0.1:${port}`;
          bare = (await globalThis.fetch(`${local}/answer`, { method: "POST" })).status;
          wrongMethod = (await globalThis.fetch(`${local}${answer.pathname}`, { method: "PUT" })).status;
          served = await (await globalThis.fetch(`${local}${answer.pathname}`, { method: "POST" })).text();
          return made;
        },
        [`GET ${A}/Call/${UUID}`]: () => (++liveHits < 2 ? { call_uuid: UUID, call_status: "in-progress" } : reply(404, { error: "not found" })),
        [`GET ${A}/Call/${UUID}/`]: reply(404, { error: "not found" }),
        [`GET ${A}/cdr/${UUID}`]: { data: { uuid: UUID, duration: 7, hangup_cause: "NORMAL_CLEARING" } },
      }).fetch,
    });
    const code = await run(
      [...base, "--say", "Hello from Vobiz", "--serve", "--port", "0", "--public-url", "https://tunnel.example.com/answer", "--interval", "0.01", "-y", "--json"],
      t.ctx,
    );
    expect(code, t.stderr.text).toBe(0);
    expect(served).toBe(sayXml("Hello from Vobiz"));
    // the answer URL gets a random path token; the bare path and other methods are refused
    expect(answerPath).toMatch(/^\/answer\/[A-Za-z0-9_-]{22}$/);
    expect(bare).toBe(404);
    expect(wrongMethod).toBe(405);
    expect(t.stderr.text).not.toContain(answerPath.split("/")[2]);
    expect(t.stderr.text).toContain("answer URL host: tunnel.example.com");
    expect(t.stderr.text).toContain("in-progress");
    expect(JSON.parse(t.stdout.text)).toMatchObject({ request_uuid: UUID, status: "ended", cdr: { duration: 7 } });
  });

  it("--wait polls live, then queued, then the CDR", async () => {
    let n = 0;
    const api = fakeFetch({
      [`POST ${A}/Call/`]: made,
      [`GET ${A}/Call/${UUID}`]: () => (++n === 1 ? reply(404, {}) : n === 2 ? { call_status: "ringing" } : reply(404, {})),
      [`GET ${A}/Call/${UUID}/`]: () => (n === 1 ? { call_status: "queued" } : reply(404, {})),
      [`GET ${A}/cdr/${UUID}`]: () => (n < 4 ? reply(404, {}) : { data: { uuid: UUID, hangup_cause: "NO_ANSWER" } }),
    });
    const r = await runCli([...base, "--answer-url", "https://e.com/a", "--wait", "--interval", "0.01", "-y", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/queued[\s\S]*ringing[\s\S]*ended/);
    expect(r.json()).toMatchObject({ status: "ended", cdr: { hangup_cause: "NO_ANSWER" } });
    expect(api.calls.filter((c) => c.path === `${A}/Call/${UUID}`).every((c) => c.query.status === "live")).toBe(true);
    expect(api.calls.filter((c) => c.path === `${A}/Call/${UUID}/`).every((c) => c.query.status === "queued")).toBe(true);
  });

  it("--wait gives up after --max-wait with exit 8", async () => {
    const api = fakeFetch({ [`POST ${A}/Call/`]: made, [`GET ${A}/Call/${UUID}`]: { call_status: "in-progress" } });
    const r = await runCli([...base, "--answer-url", "https://e.com/a", "--wait", "--interval", "0.01", "--max-wait", "0.05", "-y"], { fetch: api.fetch });
    expect(r.code).toBe(8);
    expect(r.err).toContain("did not reach a final state");
  });

  it("a network failure while placing the call is outcome_unknown (exit 7)", async () => {
    const api = fakeFetch({ [`POST ${A}/Call/`]: networkError() });
    const r = await runCli([...base, "--answer-url", "https://e.com/a", "-y"], { fetch: api.fetch });
    expect(r.code).toBe(7);
  });
});

describe("vobiz calls list / get / watch / hangup", () => {
  it("list shows live calls, --queued the queued ones", async () => {
    const api = fakeFetch({
      [`GET ${A}/Call`]: { api_id: "x", calls: ["c1", "c2"] },
      [`GET ${A}/Call/`]: { api_id: "y", calls: ["q1"] },
    });
    let r = await runCli(["calls", "list", "--json"], { fetch: api.fetch });
    expect(r.json()).toEqual({ api_id: "x", calls: ["c1", "c2"] });
    expect(api.last()).toMatchObject({ path: `${A}/Call`, query: { status: "live" } });
    r = await runCli(["calls", "list", "--queued", "--output", "plain"], { fetch: api.fetch });
    expect(r.out).toBe("q1\n");
    expect(api.last()).toMatchObject({ path: `${A}/Call/`, query: { status: "queued" } });
  });

  it("list --limit trims the single-page response on the client; --all and no flag return every call", async () => {
    const api = fakeFetch({ [`GET ${A}/Call`]: { api_id: "x", calls: ["c1", "c2", "c3"] } });
    let r = await runCli(["calls", "list", "--limit", "2", "--json"], { fetch: api.fetch });
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toEqual({ api_id: "x", calls: ["c1", "c2"] });
    expect(api.last().query).toEqual({ status: "live" });
    r = await runCli(["calls", "list", "--limit", "1", "--output", "plain"], { fetch: api.fetch });
    expect(r.out).toBe("c1\n");
    r = await runCli(["calls", "list", "--all", "--json"], { fetch: api.fetch });
    expect(r.json()).toEqual({ api_id: "x", calls: ["c1", "c2", "c3"] });
    r = await runCli(["calls", "list", "--limit", "0"], { fetch: api.fetch });
    expect(r.code).toBe(2);
  });

  it("list --details --limit fetches details for the first calls only", async () => {
    const api = fakeFetch({
      [`GET ${A}/Call`]: { calls: ["c1", "c2"] },
      [`GET ${A}/Call/c1`]: { call_uuid: "c1", call_status: "in-progress" },
    });
    const r = await runCli(["calls", "list", "--details", "--limit", "1", "--json"], { fetch: api.fetch });
    expect(r.json()).toEqual([{ call_uuid: "c1", call_status: "in-progress" }]);
    expect(api.calls).toHaveLength(2);
  });

  it("list --details fetches each call", async () => {
    const api = fakeFetch({
      [`GET ${A}/Call`]: { calls: ["c1", "gone"] },
      [`GET ${A}/Call/c1`]: { call_uuid: "c1", call_status: "in-progress" },
      [`GET ${A}/Call/gone`]: reply(404, {}),
    });
    const r = await runCli(["calls", "list", "--details", "--json"], { fetch: api.fetch });
    expect(r.json()).toEqual([{ call_uuid: "c1", call_status: "in-progress" }]);
  });

  it("get reads the live or queued record", async () => {
    const api = fakeFetch({ [`GET ${A}/Call/${UUID}`]: { call_status: "in-progress" }, [`GET ${A}/Call/${UUID}/`]: { call_status: "queued" } });
    expect((await runCli(["calls", "get", UUID, "--json"], { fetch: api.fetch })).json()).toMatchObject({ call_status: "in-progress" });
    expect(api.last().query).toEqual({ status: "live" });
    expect((await runCli(["calls", "get", UUID, "--queued", "--json"], { fetch: api.fetch })).json()).toMatchObject({ call_status: "queued" });
    expect(api.last().query).toEqual({ status: "queued" });
    expect((await runCli(["calls", "get", "nope"], { fetch: api.fetch })).code).toBe(4);
  });

  it("watch follows an existing call to its CDR", async () => {
    const api = fakeFetch({
      [`GET ${A}/Call/${UUID}`]: { call_status: "completed" },
      [`GET ${A}/cdr/${UUID}`]: { data: { uuid: UUID, billsec: 3 } },
    });
    const r = await runCli(["calls", "watch", UUID, "--interval", "0.01", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ call_uuid: UUID, status: "ended", cdr: { billsec: 3 } });
  });

  it("hangup confirms, then DELETEs", async () => {
    const api = fakeFetch({ [`DELETE ${A}/Call/${UUID}`]: reply(204) });
    expect((await runCli(["calls", "hangup", UUID], { fetch: api.fetch })).code).toBe(6);
    expect(api.calls).toHaveLength(0);
    expect((await runCli(["calls", "hangup", UUID, "--dry-run"], { fetch: api.fetch })).code).toBe(0);
    expect(api.calls).toHaveLength(0);
    const r = await runCli(["calls", "hangup", UUID, "-y", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ method: "DELETE", path: `${A}/Call/${UUID}` });
    expect(r.json()).toEqual({ call_uuid: UUID, hung_up: true });
  });
});

describe("vobiz calls in-call control", () => {
  const C = `${A}/Call/${UUID}`;
  const cases: { argv: string[]; method: string; path: string; body?: unknown }[] = [
    {
      argv: ["record", "start", UUID, "--time-limit", "120", "--format", "wav", "--channels", "stereo", "--transcribe", "--callback-url", "https://e.com/rec"],
      method: "POST",
      path: `${C}/Record/`,
      body: { time_limit: 120, file_format: "wav", record_channel_type: "stereo", transcription_type: "auto", callback_url: "https://e.com/rec" },
    },
    { argv: ["record", "stop", UUID], method: "DELETE", path: `${C}/Record/` },
    { argv: ["play", UUID, "--url", "https://e.com/a.mp3", "--legs", "both", "--loop"], method: "POST", path: `${C}/Play/`, body: { urls: "https://e.com/a.mp3", legs: "both", loop: true } },
    { argv: ["play", "stop", UUID], method: "DELETE", path: `${C}/Play/` },
    { argv: ["speak", UUID, "--text", "Hello", "--voice", "MAN", "--language", "hi-IN", "--legs", "bleg"], method: "POST", path: `${C}/Speak/`, body: { text: "Hello", voice: "MAN", language: "hi-IN", legs: "bleg" } },
    { argv: ["speak", "stop", UUID], method: "DELETE", path: `${C}/Speak/` },
    { argv: ["dtmf", UUID, "--digits", "1w2W#", "--leg", "aleg"], method: "POST", path: `${C}/DTMF/`, body: { digits: "1w2W#", leg: "aleg" } },
    {
      argv: ["stream", "start", UUID, "--url", "wss://agent.example.com/ws", "--bidirectional", "--track", "inbound", "--format", "pcm"],
      method: "POST",
      path: `${C}/Stream/`,
      body: { service_url: "wss://agent.example.com/ws", bidirectional: true, audio_track: "inbound", audio_format: "pcm" },
    },
    { argv: ["stream", "stop", UUID, "str_1"], method: "DELETE", path: `${C}/Stream/str_1/` },
  ];

  for (const c of cases) {
    it(`${c.argv.slice(0, 2).join(" ")} → ${c.method} ${c.path.slice(A.length)}`, async () => {
      const api = fakeFetch({ [`${c.method} ${c.path}`]: c.method === "DELETE" ? reply(204) : { message: "ok" } });
      const refused = await runCli(["calls", ...c.argv], { fetch: api.fetch });
      expect(refused.code).toBe(6);
      const dry = await runCli(["calls", ...c.argv, "--dry-run", "--json"], { fetch: api.fetch });
      expect(dry.code).toBe(0);
      expect(dry.json()).toMatchObject({ dry_run: true, method: c.method });
      expect(api.calls).toHaveLength(0);
      const r = await runCli(["calls", ...c.argv, "--yes", "--json"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(0);
      expect(api.calls).toHaveLength(1);
      expect(api.last()).toMatchObject({ method: c.method, path: c.path });
      if (c.body) expect(api.last().body).toEqual(c.body);
    });
  }

  it("rejects bad arguments", async () => {
    const api = fakeFetch();
    for (const argv of [
      ["play", UUID],
      ["play", UUID, "--url", "http://e.com/a.mp3"],
      ["play", UUID, "--url", "https://e.com/a.mp3", "--legs", "cleg"],
      ["speak", UUID],
      ["speak", UUID, "--text", "  "],
      ["dtmf", UUID, "--digits", "12x"],
      ["dtmf", UUID],
      ["stream", "start", UUID, "--url", "https://e.com/ws"],
      ["stream", "start", UUID, "--url", "ws://e.com/ws"],
      ["record", "start", UUID, "--format", "ogg"],
      ["record", "start", UUID, "--time-limit", "-1"],
      ["record", "start", UUID, "--callback-url", "http://e.com/cb"],
    ])
      expect((await runCli(["calls", ...argv, "-y"], { fetch: api.fetch })).code, argv.join(" ")).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it("allows ws://localhost streams with --allow-insecure-url", async () => {
    const api = fakeFetch({ [`POST ${A}/Call/${UUID}/Stream/`]: { stream_id: "s1" } });
    const r = await runCli(["calls", "stream", "start", UUID, "--url", "ws://localhost:8080/ws", "--allow-insecure-url", "-y", "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ stream_id: "s1" });
  });

  it("stream list and get", async () => {
    const api = fakeFetch({
      [`GET ${A}/Call/${UUID}/Stream/`]: { objects: [{ stream_id: "s1" }] },
      [`GET ${A}/Call/${UUID}/Stream/s1/`]: { stream_id: "s1", status: "streaming" },
    });
    expect((await runCli(["calls", "stream", "list", UUID, "--json"], { fetch: api.fetch })).json()).toEqual({ objects: [{ stream_id: "s1" }] });
    expect((await runCli(["calls", "stream", "get", UUID, "s1", "--json"], { fetch: api.fetch })).json()).toMatchObject({ status: "streaming" });
    expect(api.last().path).toBe(`${A}/Call/${UUID}/Stream/s1/`);
  });
});
