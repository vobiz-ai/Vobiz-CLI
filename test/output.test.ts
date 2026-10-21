import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { Printer, flatten, project, type PrinterHost } from "../src/core/output.js";
import { VobizError } from "../src/core/errors.js";
import { redact } from "../src/core/redact.js";
import { renderTable } from "../src/core/table.js";
import { capture } from "./helpers.js";

function printer(flags: PrinterHost["flags"] = {}, opts: { tty?: boolean; columns?: number; env?: NodeJS.ProcessEnv } = {}) {
  const stdout = capture(!!opts.tty, opts.columns);
  const stderr = capture(false);
  const p = new Printer({ flags: { color: false, ...flags }, env: opts.env ?? {}, stdout, stderr });
  return { p, stdout, stderr };
}

const ME = { name: "Acme", auth_id: "MA_XXXXXXXX", auth_secret: "S3CRET-VALUE", nested: { password: "pw", token: "t", client_secret: "c", private_key: "k", authToken: "a", auth_token: "b", secret: "s" } };

describe("redaction", () => {
  it("redacts every secret key at any depth, including inside arrays", () => {
    const r = redact({ list: [ME], keep: "x", empty: "", nil: null, password: "" });
    const text = JSON.stringify(r);
    for (const v of ["S3CRET-VALUE", '"pw"', '"t"', '"c"', '"k"', '"a"', '"b"', '"s"']) expect(text).not.toContain(v);
    expect(r.keep).toBe("x");
    expect(r.password).toBe("");
  });

  it("applies in every output mode", () => {
    for (const mode of ["table", "json", "yaml", "tsv", "plain"] as const) {
      const { p, stdout } = printer({ output: mode });
      p.print(ME);
      expect(stdout.text, mode).not.toContain("S3CRET-VALUE");
      expect(stdout.text, mode).toContain("[redacted]");
    }
  });

  it("only --debug --show-secrets shows secrets", () => {
    let t = printer({ output: "json", showSecrets: true });
    t.p.print(ME);
    expect(t.stdout.text).not.toContain("S3CRET-VALUE");
    t = printer({ output: "json", showSecrets: true, debug: true });
    t.p.print(ME);
    expect(t.stdout.text).toContain("S3CRET-VALUE");
  });
});

describe("output modes", () => {
  const rows = [
    { id: "a1", name: "one", meta: { n: 1 } },
    { id: "b2", name: "two\tx", meta: { n: 2 } },
  ];

  it("auto-detects table on a TTY and json when piped; VOBIZ_OUTPUT and --json override", () => {
    expect(printer({}, { tty: true }).p.mode).toBe("table");
    expect(printer({}, { tty: false }).p.mode).toBe("json");
    expect(printer({}, { tty: true, env: { VOBIZ_OUTPUT: "yaml" } }).p.mode).toBe("yaml");
    expect(printer({ json: true, output: "table" }).p.mode).toBe("json");
  });

  it("json and yaml", () => {
    let t = printer({ output: "json" });
    t.p.print(rows);
    expect(JSON.parse(t.stdout.text)).toEqual(rows);
    t = printer({ output: "yaml" });
    t.p.print(rows);
    expect(YAML.parse(t.stdout.text)).toEqual(rows);
  });

  it("tsv has a header, escapes tabs and flattens nesting", () => {
    const t = printer({ output: "tsv" });
    t.p.print(rows);
    expect(t.stdout.text).toBe("id\tname\tmeta.n\na1\tone\t1\nb2\ttwo\\tx\t2\n");
  });

  it("plain has no header", () => {
    const t = printer({ output: "plain" });
    t.p.print(rows, { columns: ["id", "name"] });
    expect(t.stdout.text).toBe("a1  one\nb2  two\tx\n");
  });

  it("table shows upper-case headers and fits the terminal width", () => {
    const t = printer({ output: "table" }, { tty: true, columns: 30 });
    t.p.print([{ id: "x".repeat(40), description: "y".repeat(40) }]);
    const lines = t.stdout.text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+DESCRIPTION/);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(30);
    expect(lines[1]).toContain("…");
  });

  it("single objects render as FIELD/VALUE in table mode", () => {
    const t = printer({ output: "table" });
    t.p.print({ a: 1, b: { c: "d" } });
    expect(t.stdout.text).toMatch(/FIELD\s+VALUE\na\s+1\nb\.c\s+d\n/);
  });

  it("--fields projects dot paths (nested in json, columns in tsv)", () => {
    let t = printer({ output: "json", fields: ["id", "meta.n"] });
    t.p.print(rows);
    expect(JSON.parse(t.stdout.text)).toEqual([
      { id: "a1", meta: { n: 1 } },
      { id: "b2", meta: { n: 2 } },
    ]);
    t = printer({ output: "tsv", fields: ["meta.n", "id"] });
    t.p.print(rows);
    expect(t.stdout.text).toBe("meta.n\tid\n1\ta1\n2\tb2\n");
  });

  it("--quiet prints the primary id per row", () => {
    let t = printer({ quiet: true });
    t.p.print(rows);
    expect(t.stdout.text).toBe("a1\nb2\n");
    t = printer({ quiet: true });
    t.p.print([{ call_uuid: "c-1" }, { name: "n" }]);
    expect(t.stdout.text).toBe("c-1\nn\n");
    t = printer({ quiet: true });
    t.p.print([{ id: 1, e164: "+1" }], { idKey: "e164" });
    expect(t.stdout.text).toBe("+1\n");
  });

  it("empty lists print a note to stderr in human modes and [] in json", () => {
    let t = printer({ output: "table" });
    t.p.print([], { empty: "Nothing here." });
    expect(t.stdout.text).toBe("");
    expect(t.stderr.text).toBe("Nothing here.\n");
    t = printer({ output: "json" });
    t.p.print([]);
    expect(t.stdout.text).toBe("[]\n");
  });

  it("success prints data in machine modes and a sentence on stderr otherwise", () => {
    let t = printer({ output: "json" });
    t.p.success("Done.", { id: 1 });
    expect(JSON.parse(t.stdout.text)).toEqual({ id: 1 });
    t = printer({ output: "table" });
    t.p.success("Done.", { id: 1 });
    expect(t.stdout.text).toBe("");
    expect(t.stderr.text).toContain("Done.");
  });

  it("printError formats text and JSON", () => {
    let t = printer({});
    t.p.printError(new VobizError("rate_limited", "slow down", 429));
    expect(t.stderr.text).toBe("vobiz: rate_limited: slow down\nWait a moment and try again.\n");
    t = printer({ json: true });
    t.p.printError(new VobizError("rate_limited", "slow down", 429));
    expect(JSON.parse(t.stderr.text)).toMatchObject({ error: "rate_limited", message: "slow down", status: 429, retryable: true });
    t = printer({});
    t.p.printError(new Error("boom"));
    expect(t.stderr.text).toContain("vobiz: internal_error: boom");
  });
});

describe("helpers", () => {
  it("flatten and project", () => {
    expect(flatten({ a: { b: { c: 1 } }, d: [1, 2] })).toEqual({ "a.b.c": 1, d: [1, 2] });
    expect(project({ a: { b: 1, c: 2 }, d: 3 }, ["a.b", "x"])).toEqual({ a: { b: 1 } });
  });
  it("renderTable pads columns", () => {
    expect(renderTable(["A", "B"], [["xx", "y"]])).toBe("A   B\nxx  y\n");
  });
});
