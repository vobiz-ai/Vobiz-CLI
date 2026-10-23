import { describe, expect, it } from "vitest";
import { Printer } from "../src/core/output.js";
import { cleanCell, cleanLogText, stripTerminalControls, tsvCell } from "../src/core/sanitize.js";
import { renderTable } from "../src/core/table.js";
import { capture, fakeFetch, reply, runCli } from "./helpers.js";

const ESC = "\x1b";
const EVIL = `a${ESC}[2Jb${ESC}]52;c;ZXZpbA==${ESC}\\c${ESC}]8;;https://evil.example${ESC}\\Click${ESC}]8;;\x07d\x9b31me f\x00g\x7fh`;

const printer = (output: "table" | "plain" | "tsv" | "json", flags: Record<string, unknown> = {}) => {
  const stdout = capture(false, 200);
  const stderr = capture();
  const p = new Printer({ flags: { output, ...flags }, env: {}, stdout, stderr });
  return { p, stdout, stderr };
};

describe("stripTerminalControls", () => {
  it("removes CSI, OSC 52, OSC 8, 8-bit CSI, C0/C1 controls and U+2028/2029, keeping tabs", () => {
    expect(stripTerminalControls(EVIL)).toBe("abcClickdefgh");
    expect(stripTerminalControls("x\ty")).toBe("x\ty");
    expect(stripTerminalControls("x\ny", { keepNewlines: true })).toBe("x\ny");
    expect(stripTerminalControls("x\ny")).toBe("xy");
  });
  it("drops an unterminated OSC to the end instead of leaving the terminal in string mode", () => {
    expect(stripTerminalControls(`ok${ESC}]0;title never ends`)).toBe("ok");
  });
  it("cleanCell turns line breaks into spaces", () => {
    expect(cleanCell("a\r\nb\nc")).toBe("a b c");
  });
});

describe("human output is sanitised; json stays verbatim", () => {
  const rows = [{ id: "1", from_number: EVIL }];
  it.each(["table", "plain", "tsv"] as const)("%s", (mode) => {
    const { p, stdout } = printer(mode);
    p.print(rows, { columns: ["id", "from_number"] });
    expect(stdout.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(stdout.text).toContain("Click");
  });
  it("single records, scalars and --quiet", () => {
    for (const mode of ["table", "plain", "tsv"] as const) {
      const { p, stdout } = printer(mode);
      p.print({ name: EVIL });
      p.print(EVIL);
      expect(stdout.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    }
    const q = printer("table", { quiet: true });
    q.p.print([{ id: `x${ESC}[2J` }]);
    expect(q.stdout.text).toBe("x\n");
  });
  it("json keeps the original string", () => {
    const { p, stdout } = printer("json");
    p.print(rows);
    expect(JSON.parse(stdout.text)[0].from_number).toBe(EVIL);
  });
  it("table truncation works on the sanitised text, never cutting a sequence", () => {
    const out = renderTable(["A"], [[`${ESC}]8;;https://evil${ESC}\\${"x".repeat(50)}`]], { width: 10 });
    expect(out).not.toContain(ESC);
    expect(out.split("\n")[1]).toBe("xxxxxxxxx…");
  });
  it("status, warnings and errors on stderr", async () => {
    const { p, stderr } = printer("table");
    p.status(`s${ESC}]0;pwned${ESC}\\`);
    p.warn(`w${ESC}[2J`);
    p.success(`ok${ESC}[2J`);
    expect(stderr.text).not.toContain(ESC);
    const api = fakeFetch({ "GET /api/v1/auth/me": reply(400, { message: `bad${ESC}]0;pwned title\x07 input` }) });
    const r = await runCli(["api", "GET", "/api/v1/auth/me"], { fetch: api.fetch, stdoutTTY: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("bad input");
    expect(r.err).not.toContain(ESC);
  });
});

describe("cleanLogText for the local servers", () => {
  it("removes sequences and line breaks and caps the length", () => {
    expect(cleanLogText(`GET /x${ESC}]0;pwned${ESC}\\\r\nforged: line`)).toBe("GET /x forged: line");
    expect(cleanLogText("a".repeat(50), 10)).toBe(`${"a".repeat(9)}…`);
    expect(cleanLogText(undefined)).toBe("");
  });
});

describe("tsv formula injection", () => {
  it("prefixes formula cells, escapes lone CR, leaves numbers and E.164 alone", () => {
    expect(tsvCell('=HYPERLINK("https://evil","x")')).toBe(`'=HYPERLINK("https://evil","x")`);
    expect(tsvCell("@SUM(1+1)")).toBe("'@SUM(1+1)");
    expect(tsvCell("+cmd|' /c calc'!A0")).toBe("'+cmd|' /c calc'!A0");
    expect(tsvCell("-2+3")).toBe("'-2+3");
    expect(tsvCell("a\rb")).toBe("a\\rb");
    expect(tsvCell("a\tb\nc")).toBe("a\\tb\\nc");
    expect(tsvCell("+919876543210")).toBe("+919876543210");
    expect(tsvCell("-1.5")).toBe("-1.5");
  });
  it("applies in --output tsv", () => {
    const { p, stdout } = printer("tsv");
    p.print([{ id: "1", body: "=1+1" }], { columns: ["id", "body"] });
    expect(stdout.text).toBe("id\tbody\n1\t'=1+1\n");
  });
});
