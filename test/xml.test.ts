import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildResponseXml, parseXml, validateXml } from "../src/agent/xml.js";
import { startXmlServer } from "../src/commands/xml.js";
import { run } from "../src/cli.js";
import { makeCtx, runCli } from "./helpers.js";

const fixture = (name: string) => join(__dirname, "fixtures", "xml", name);

describe("xml build", () => {
  it("emits elements in flag order with --attr and --prompt (MCP generate_answer_xml output)", async () => {
    const r = await runCli([
      "xml", "build",
      "--say", "Hello & welcome", "--attr", "voice=MAN",
      "--gather", "https://example.com/menu", "--attr", "numDigits=1", "--attr", "execution_timeout=10",
      "--prompt", "Press 1", "--attr", "language=en-IN",
      "--prompt-play", "https://example.com/menu.mp3",
      "--pause", "2",
      "--dial", "+919876543210", "--attr", "callerId=+918000000000", "--attr", "timeout=30",
      "--dial", "sip:alice@example.com",
      "--record", "https://example.com/rec", "--attr", "maxLength=60",
      "--hangup", "busy",
    ]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="MAN">Hello &amp; welcome</Speak>
    <Gather action="https://example.com/menu" method="POST" inputType="dtmf" numDigits="1" executionTimeout="10">
        <Speak language="en-IN">Press 1</Speak>
        <Play>https://example.com/menu.mp3</Play>
    </Gather>
    <Wait length="2"/>
    <Dial callerId="+918000000000" timeout="30">
        <Number>+919876543210</Number>
    </Dial>
    <Dial>
        <User>sip:alice@example.com</User>
    </Dial>
    <Record action="https://example.com/rec" method="POST" maxLength="60" redirect="false"/>
    <Hangup reason="busy"/>
</Response>
`);
    expect(validateXml(r.out).filter((i) => i.level === "error")).toEqual([]);
  });

  it("prints raw XML even when piped, and {xml} with --json", async () => {
    const plain = await runCli(["xml", "build", "--say", "Hi", "--hangup"]);
    expect(plain.out.startsWith("<?xml")).toBe(true);
    const json = await runCli(["xml", "build", "--say", "Hi", "--redirect", "https://example.com/next", "--json"]);
    expect(json.json().xml).toContain('<Redirect method="POST">https://example.com/next</Redirect>');
  });

  it("works without credentials", async () => {
    const r = await runCli(["xml", "build", "--say", "Hi"], { loggedOut: true });
    expect(r.code).toBe(0);
  });

  it.each([
    [["--hangup", "--say", "x"], "ends the flow"],
    [["--play", "https://example.com/a.ogg"], ".mp3 or .wav"],
    [["--redirect", "http://example.com/x"], "https"],
    [["--say", "x", "--attr", "volume=3"], 'no attribute "volume"'],
    [["--gather", "https://e.com/g", "--attr", "numDigits=abc"], "whole number"],
    [["--prompt", "x"], "after --gather"],
    [["--attr", "voice=MAN"], "applies to the element before it"],
    [[], "at least one element"],
    [["--pause", "1.5"], "whole number"],
  ])("rejects %j", async (args, message) => {
    const r = await runCli(["xml", "build", ...args]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });

  it("buildResponseXml keeps the MCP model's limits", () => {
    expect(() => buildResponseXml([{ type: "dial" }])).toThrow(/exactly one of number or sip_uri/);
    expect(() => buildResponseXml([{ type: "wait", length: 1, min_silence_ms: 500 }])).toThrow(/silence: true/);
    expect(() => buildResponseXml([{ type: "gather" }])).toThrow(/action_url is required/);
    expect(buildResponseXml([{ type: "gather" }], { defaultGatherAction: "https://h/cb" })).toContain('action="https://h/cb"');
  });
});

describe("xml parser", () => {
  it("decodes entities, CDATA and comments", () => {
    const n = parseXml(`<?xml version="1.0"?><!-- c --><Response a='1 &lt; 2'><Speak>&#x41;&amp;<![CDATA[<b>]]></Speak></Response>`);
    expect(n.attrs.a).toBe("1 < 2");
    expect(n.children[0].text).toBe("A&<b>");
  });
  it.each([
    ["<Response><Speak>x</Response>", "does not match"],
    ["<Response a=1/>", "must be quoted"],
    ["<Response a='1' a='2'/>", "duplicate attribute"],
    ["<Response/><Response/>", "content after the root"],
    ["<!DOCTYPE x><Response/>", "DOCTYPE"],
    ["", "empty"],
    ["<Response>&nbsp;</Response>", "unknown entity"],
  ])("rejects %j", (src, message) => {
    expect(() => parseXml(src)).toThrow(message);
  });
});

describe("xml validate", () => {
  it("accepts a document using every documented element", async () => {
    const r = await runCli(["xml", "validate", fixture("ivr.xml"), "-o", "table"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("is valid VobizXML");
  });

  it("reports errors and warnings with line numbers", async () => {
    const r = await runCli(["xml", "validate", fixture("broken.xml"), "--json"]);
    expect(r.code).toBe(2);
    const body = r.json();
    expect(body).toMatchObject({ valid: false, errors: 7, warnings: 3 });
    const msgs = body.issues.map((i: { line: number; level: string; message: string }) => `${i.line} ${i.level} ${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        '3 warning "volume" is not a documented <Speak> attribute',
        '4 error Gather has no "timeout" attribute; use executionTimeout (5–60 seconds)',
        '4 error finishOnKey="" ends the call (hangup cause 8011); use finishOnKey="none"',
        "6 error <Dial> is not allowed inside <Gather> (allowed: Speak, Play)",
        "9 error <play> is not a VobizXML element (element names are case-sensitive: use <Play>)",
        "9 warning <Hangup> on line 8 ends the flow, so this element never runs",
        '10 error bidirectional="yes" must be true or false',
      ]),
    );
  });

  it("reads stdin with - and fails on malformed XML", async () => {
    const r = await runCli(["xml", "validate", "-", "--json"], { stdin: "<Response><Speak>a & b</Speak></Response>" });
    expect(r.code).toBe(2);
    expect(r.json().issues[0].message).toContain('"&" must be escaped');
  });

  it("--strict fails on warnings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-xml-"));
    const file = join(dir, "w.xml");
    writeFileSync(file, '<Response><Speak volume="2">Hi</Speak></Response>');
    expect((await runCli(["xml", "validate", file])).code).toBe(0);
    expect((await runCli(["xml", "validate", file, "--strict"])).code).toBe(2);
  });

  it("missing file is not_found", async () => {
    const r = await runCli(["xml", "validate", "/nonexistent/answer.xml"]);
    expect(r.code).toBe(4);
  });
});

describe("xml serve", () => {
  it("answers every request with the current file content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vobiz-xml-"));
    const file = join(dir, "answer.xml");
    writeFileSync(file, "<Response><Speak>One</Speak></Response>");
    const t = makeCtx();
    const server = await startXmlServer(t.ctx, file, { port: 0, host: "127.0.0.1" });
    try {
      const res = await fetch(`${server.url}/answer`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "CallUUID=abc&From=%2B919876543210&To=%2B918000000000",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/xml");
      expect(await res.text()).toBe("<Response><Speak>One</Speak></Response>");
      expect(t.stderr.text).toContain("POST /answer  CallUUID=abc From=+919876543210 To=+918000000000");

      writeFileSync(file, "<Response><Speak>Two</Speak></Response>");
      expect(await (await fetch(server.url)).text()).toContain("Two");
    } finally {
      await server.close();
    }
  });

  it("`xml serve -` reads stdin once and serves that text on every request", async () => {
    let reads = 0;
    const t = makeCtx();
    const ctx = t.ctx;
    (ctx as unknown as { stdin: { isTTY: boolean; read: () => Promise<string> } }).stdin = {
      isTTY: false,
      read: async () => (++reads, "<Response><Speak>Piped</Speak></Response>"),
    };
    const done = run(["xml", "serve", "-", "--port", "0"], ctx);
    let url = "";
    for (let i = 0; i < 100 && !url; i++) {
      await new Promise((r) => setTimeout(r, 10));
      url = t.stdout.text.trim();
    }
    try {
      for (const _ of [1, 2]) {
        const res = await fetch(url);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("<Response><Speak>Piped</Speak></Response>");
      }
      expect(reads).toBe(1);
    } finally {
      process.emit("SIGINT");
      expect(await done).toBe(0);
    }
  });
});

describe("xml hardening (S3 #9, #18)", async () => {
  const { parseXml, escapeXml } = await import("../src/agent/xml.js");
  it("xml build rejects C0 control characters in text and attributes", async () => {
    expect(() => escapeXml("hi\x01")).toThrow(/U\+0001/);
    expect(() => escapeXml("a\x1b[31m")).toThrow(/U\+001B/);
    expect(escapeXml("tab\tand\nnewline")).toBe("tab\tand\nnewline");
    const r = await runCli(["xml", "build", "--say", "hi\x1b[31m"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
  });
  it("parses large documents in linear time with correct line numbers", () => {
    const n = 80_000;
    const doc = `<Response>\n${'<Wait length="1"/>\n'.repeat(n)}</Response>\n`;
    const t = Date.now();
    const root = parseXml(doc);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(root.children).toHaveLength(n);
    expect(root.children[n - 1].line).toBe(n + 1);
    expect(() => parseXml("<Response>\n\n<Wait>\n")).toThrow(/line \d+/);
  });
});
