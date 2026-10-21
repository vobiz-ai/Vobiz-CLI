import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardStream, isInternalHost } from "../src/commands/voice-shared.js";
import { TEST_AUTH_ID, fakeFetch, runCli, textReply } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const ID = "55667788-1234-5678-90ab-cdef12345678";
const posix = process.platform !== "win32";
const rec = (url = `https://recordings.vobiz.ai/example/${ID}.wav`) => ({ recording_id: ID, recording_format: "wav", recording_url: url });
const api = (url?: string) =>
  fakeFetch({ [`GET ${A}/Recording/${ID}/`]: rec(url), [`GET /example/${ID}.wav`]: textReply(200, "AUDIO", { "content-type": "audio/wav" }) });

describe("download writers (S3 #4)", () => {
  it.runIf(posix)("ignore a planted <out>.part symlink and never write through it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-dl-"));
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "original");
    const out = join(dir, "rec.wav");
    symlinkSync(victim, `${out}.part`);
    const r = await runCli(["recordings", "download", ID, "--out", out], { fetch: api().fetch });
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(lstatSync(out).isFile()).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("AUDIO");
    expect(readdirSync(dir).sort()).toEqual(["rec.wav", "rec.wav.part", "victim.txt"]);
  });

  it.runIf(posix)("treat a dangling --out symlink as existing and refuse it even with --force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-dl-"));
    const out = join(dir, "x.csv");
    symlinkSync(join(dir, "target-anywhere"), out);
    const a = fakeFetch({ [`GET ${A}/Recording/${ID}/`]: rec() });
    expect((await runCli(["recordings", "download", ID, "--out", out], { fetch: a.fetch })).code).toBe(2);
    const forced = await runCli(["recordings", "download", ID, "--out", out, "--force"], { fetch: a.fetch });
    expect(forced.code).toBe(2);
    expect(forced.err).toContain("symbolic link");
    expect(existsSync(join(dir, "target-anywhere"))).toBe(false);
    const cdr = await runCli(["cdr", "export", "--from", "7d", "--out", out, "--force"], { fetch: a.fetch });
    expect(cdr.code).toBe(2);
    expect(existsSync(join(dir, "target-anywhere"))).toBe(false);
  });
});

describe("streamed body limits (S2 #9)", () => {
  it("fails when the body stalls longer than the idle timeout", async () => {
    async function* stall() {
      yield new Uint8Array([1]);
      await new Promise((r) => setTimeout(r, 200));
      yield new Uint8Array([2]);
    }
    const out: number[] = [];
    await expect(
      (async () => {
        for await (const c of guardStream("GET x", 50, 100, () => undefined)(stall())) out.push(...c);
      })(),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(out).toEqual([1]);
  });
  it("fails past the size cap", async () => {
    async function* big() {
      for (let i = 0; i < 10; i++) yield new Uint8Array(10);
    }
    await expect(
      (async () => {
        for await (const _ of guardStream("GET x", 1000, 25, () => undefined)(big())) void _;
      })(),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
  });
});

describe("recording_url host checks (S2 #14)", () => {
  it("classifies internal hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:7f00:1]", "metadata.google.internal", "0.0.0.0"])
      expect(isInternalHost(h), h).toBe(true);
    for (const h of ["recordings.vobiz.ai", "8.8.8.8", "172.32.0.1", "[2606:4700::1]"]) expect(isInternalHost(h), h).toBe(false);
  });
  it("refuses a recording_url on an internal host unless --allow-insecure-url", async () => {
    const a = fakeFetch({ [`GET ${A}/Recording/${ID}/`]: rec("https://169.254.169.254/latest/meta-data"), "GET /latest/meta-data": textReply(200, "x") });
    const dir = mkdtempSync(join(tmpdir(), "vobiz-dl-"));
    const r = await runCli(["recordings", "download", ID, "--out", join(dir, "a.wav")], { fetch: a.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("internal host");
    expect(a.calls).toHaveLength(1);
    const ok = await runCli(["recordings", "download", ID, "--out", join(dir, "b.wav"), "--allow-insecure-url"], { fetch: a.fetch });
    expect(ok.code, ok.err).toBe(0);
  });
});

describe("10dlc documents get file name (S3 #7) and SMS writers (S3 #4)", () => {
  it("derives a safe name from Content-Disposition", async () => {
    const { documentFileName } = await import("../src/commands/sms/tendlc.js");
    expect(documentFileName("optin.pdf", "doc1")).toBe("optin.pdf");
    expect(documentFileName("..%2F..%2F.npmrc", "doc1", "application/pdf")).toBe("document-doc1.pdf");
    expect(documentFileName(".envrc", "doc1")).toBe("document-doc1");
    expect(documentFileName("%E0%A4%A", "doc1")).toBe("document-doc1");
    expect(documentFileName("a\x1b[2Jb.pdf", "d/../x")).toBe("document-d____x");
    expect(documentFileName("dir\\evil.pdf", "doc1")).toBe("evil.pdf");
  });

  it("writes document-<id> in the cwd instead of a server-chosen dotfile, and survives bad escapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-doc-"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      for (const disp of ['attachment; filename="..%2F..%2F.npmrc"', "attachment; filename=%E0%A4%A"]) {
        const a = fakeFetch({ "GET /10dlc/documents/doc1": textReply(200, "%PDF", { "content-type": "application/pdf", "content-disposition": disp }) });
        const r = await runCli(["sms", "10dlc", "documents", "get", "doc1", "--force"], { fetch: a.fetch });
        expect(r.code, r.err).toBe(0);
      }
      expect(readdirSync(dir)).toEqual(["document-doc1.pdf"]);
    } finally {
      process.chdir(cwd);
    }
  });

  it.runIf(posix)("broadcasts export and documents get refuse a dangling --out symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-doc-"));
    const out = join(dir, "x.csv");
    symlinkSync(join(dir, "elsewhere"), out);
    const a = fakeFetch({
      "GET /broadcasts/b1/export": textReply(200, "to,status\n", { "content-type": "text/csv" }),
      "GET /10dlc/documents/doc1": textReply(200, "%PDF", { "content-type": "application/pdf" }),
    });
    for (const argv of [["sms", "broadcasts", "export", "b1", "--out", out], ["sms", "10dlc", "documents", "get", "doc1", "--out", out]]) {
      expect((await runCli(argv, { fetch: a.fetch })).code).toBe(2);
      expect((await runCli([...argv, "--force"], { fetch: a.fetch })).code).toBe(2);
    }
    expect(existsSync(join(dir, "elsewhere"))).toBe(false);
  });
});

describe("forwarders need TLS for remote targets (S2 #6)", async () => {
  const { checkForwardUrl } = await import("../src/commands/voice-shared.js");
  it("accepts wss/https anywhere and ws/http only on loopback without the flag", () => {
    expect(checkForwardUrl("wss://agent.example.com/media", "--to", { websocket: true })).toBe("wss://agent.example.com/media");
    expect(checkForwardUrl("ws://localhost:8080/media", "--to", { websocket: true })).toBe("ws://localhost:8080/media");
    expect(checkForwardUrl("http://127.0.0.1:3000/x", "--forward")).toBe("http://127.0.0.1:3000/x");
    expect(checkForwardUrl("http://[::1]:3000/x", "--forward")).toBe("http://[::1]:3000/x");
    expect(() => checkForwardUrl("ws://agent.example.com/media", "--to", { websocket: true })).toThrow(/unencrypted/);
    expect(() => checkForwardUrl("http://10.0.0.5/hook", "--forward")).toThrow(/unencrypted/);
    expect(checkForwardUrl("http://10.0.0.5/hook", "--forward", { allowInsecure: true })).toBe("http://10.0.0.5/hook");
    expect(() => checkForwardUrl("ftp://x", "--forward")).toThrow(/https:\/\/ or http:\/\//);
  });
  it("streams forward and webhooks listen refuse a remote cleartext target before listening", async () => {
    const s = await runCli(["streams", "forward", "--to", "ws://agent.example.com/media", "--dry-run"]);
    expect(s.code).toBe(2);
    expect(s.err).toContain("--allow-insecure-url");
    const ok = await runCli(["streams", "forward", "--to", "ws://agent.example.com/media", "--allow-insecure-url", "--dry-run", "--json"]);
    expect(ok.code, ok.err).toBe(0);
    const w = await runCli(["webhooks", "listen", "--forward", "http://app.example.com/hook", "--port", "0"]);
    expect(w.code).toBe(2);
  });
});
