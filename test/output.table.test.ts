/**
 * Printer and table rendering edge cases: wide, unicode, empty and null values, terminal-width truncation,
 * --fields dot paths (into arrays too), --quiet id selection, YAML/TSV escaping and empty lists.
 */
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { Printer, cell, flatten, getPath, project, type PrinterHost } from "../src/core/output.js";
import { renderTable, truncate } from "../src/core/table.js";
import { capture, runCli, TEST_AUTH_ID } from "./helpers.js";
import { specFake } from "./spec-fake.js";

function printer(flags: PrinterHost["flags"] = {}, o: { tty?: boolean; columns?: number; env?: NodeJS.ProcessEnv } = {}) {
  const stdout = capture(!!o.tty, o.columns);
  const stderr = capture(false);
  return { p: new Printer({ flags: { color: false, ...flags }, env: o.env ?? {}, stdout, stderr }), stdout, stderr };
}
const cp = (s: string) => [...s].length;

describe("truncate", () => {
  const cases: [string, number, string][] = [
    ["hello", 10, "hello"],
    ["hello", 5, "hello"],
    ["hello", 4, "hel…"],
    ["hello", 2, "h…"],
    ["hello", 1, "h"],
    ["hello", 0, ""],
    ["", 3, ""],
    ["héllo wörld", 6, "héllo…"],
    ["😀😀😀😀", 3, "😀😀…"],
    ["日本語テキスト", 4, "日本語…"],
  ];
  for (const [s, w, want] of cases) it(`truncate(${JSON.stringify(s)}, ${w}) = ${JSON.stringify(want)}`, () => expect(truncate(s, w)).toBe(want));

  it("never splits a surrogate pair", () => {
    for (let w = 1; w < 6; w++) expect(truncate("😀😀😀😀😀😀", w)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("renderTable", () => {
  it("pads every column but the last and trims trailing spaces", () => {
    const t = renderTable(["A", "LONGER"], [["xxxxxx", ""], ["y", "z"]]);
    expect(t).toBe("A       LONGER\nxxxxxx\ny       z\n");
  });

  it("empty and missing cells render as blanks", () => {
    expect(renderTable(["A", "B", "C"], [["1"], ["", "2", ""]])).toBe("A  B  C\n1\n   2\n");
  });

  it("no rows prints only the header", () => {
    expect(renderTable(["ID", "NAME"], [])).toBe("ID  NAME\n");
  });

  it("newlines, tabs and carriage returns inside cells become spaces", () => {
    const t = renderTable(["A", "B"], [["line1\nline2", "a\tb\r\nc"]]);
    expect(t.split("\n")).toHaveLength(3);
    expect(t).toContain("line1 line2");
    expect(t).toContain("a b c");
  });

  it("caps any column at maxColumn (default 60) even without a terminal", () => {
    const t = renderTable(["X"], [["y".repeat(200)]]);
    expect(cp(t.split("\n")[1])).toBe(60);
    expect(t).toContain("…");
    expect(cp(renderTable(["X"], [["y".repeat(200)]], { maxColumn: 10 }).split("\n")[1])).toBe(10);
  });

  for (const width of [20, 30, 40, 60, 80, 120]) {
    it(`fits a ${width}-column terminal`, () => {
      const rows = [
        ["a".repeat(50), "b".repeat(30), "c".repeat(70), "d"],
        ["short", "x", "y", "z"],
      ];
      const t = renderTable(["ALPHA", "BETA", "GAMMA", "D"], rows, { width });
      for (const line of t.trimEnd().split("\n")) expect(cp(line), line).toBeLessThanOrEqual(Math.max(width, 4 * 6 + 3 * 2));
    });
  }

  it("shrinks the widest column first and never below 6 characters", () => {
    const t = renderTable(["ID", "DESCRIPTION"], [["abc", "z".repeat(100)]], { width: 20 });
    const [h, r] = t.trimEnd().split("\n");
    expect(h.startsWith("ID   DESCRIPTION".slice(0, 5))).toBe(true);
    expect(r.startsWith("abc  ")).toBe(true);
    expect(cp(r)).toBeLessThanOrEqual(20);
    const tiny = renderTable(["A", "B", "C", "D", "E"], [["x".repeat(20), "x".repeat(20), "x".repeat(20), "x".repeat(20), "x".repeat(20)]], { width: 10 });
    for (const line of tiny.trimEnd().split("\n").slice(1)) for (const c of line.split(/\s{2,}/)) expect(cp(c)).toBeGreaterThanOrEqual(6);
  });

  it("the header style is applied after layout so ANSI codes do not shift columns", () => {
    const plain = renderTable(["ID", "NAME"], [["1", "x"]]);
    const styled = renderTable(["ID", "NAME"], [["1", "x"]], { header: (s) => `\u001b[1m${s}\u001b[22m` });
    expect(styled.replace(/\u001b\[\d+m/g, "")).toBe(plain);
  });

  it("unicode cells are measured in code points", () => {
    const t = renderTable(["NAME", "N"], [["Zoë", "1"], ["😀😀", "2"], ["日本", "3"]]);
    // Every row's second column starts at the same code-point offset: width("NAME") + 2.
    for (const l of t.trimEnd().split("\n")) expect([...l].length - 1, l).toBe(6);
  });
});

describe("cell and flatten", () => {
  it("cell renders every JSON type", () => {
    expect(cell(null)).toBe("");
    expect(cell(undefined)).toBe("");
    expect(cell("")).toBe("");
    expect(cell(0)).toBe("0");
    expect(cell(false)).toBe("false");
    expect(cell(12345678901234567890n)).toBe("12345678901234567890");
    expect(cell([1, "a", null, true])).toBe("1, a, , true");
    expect(cell([])).toBe("");
    expect(cell([{ a: 1 }])).toBe('[{"a":1}]');
    expect(cell({ a: { b: 1 } })).toBe('{"a":{"b":1}}');
  });

  it("flatten keeps empty objects, arrays and nulls", () => {
    expect(flatten({ a: {}, b: [], c: null, d: { e: {} } })).toEqual({ a: {}, b: [], c: null, "d.e": {} });
    expect(flatten(null)).toEqual({ value: null });
    expect(flatten([1, 2])).toEqual({ value: [1, 2] });
    expect(flatten("x", "p")).toEqual({ p: "x" });
  });

  it("getPath walks objects and array indexes", () => {
    const v = { items: [{ id: "a", tags: ["x", "y"] }, { id: "b" }], meta: { n: 0 } };
    expect(getPath(v, "items.0.id")).toBe("a");
    expect(getPath(v, "items.1.id")).toBe("b");
    expect(getPath(v, "items.0.tags.1")).toBe("y");
    expect(getPath(v, "items.5.id")).toBeUndefined();
    expect(getPath(v, "meta.n")).toBe(0);
    expect(getPath(v, "meta.n.deeper")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
  });

  it("project keeps falsy values and skips missing ones", () => {
    expect(project({ a: 0, b: "", c: false, d: null }, ["a", "b", "c", "d", "e"])).toEqual({ a: 0, b: "", c: false, d: null });
    expect(project({ items: [{ id: "x" }] }, ["items.0.id"])).toEqual({ items: { "0": { id: "x" } } });
    expect(project("scalar", ["a"])).toBe("scalar");
  });
});

describe("Printer edge cases", () => {
  const rows = [
    { id: "a1", name: "Zoë 😀", region: null, tags: ["x", "y"], meta: { n: 1, deep: { k: "v" } } },
    { id: "b2", name: "", region: "Mumbai", tags: [], meta: { n: 2 } },
  ];

  it("table: null and empty values are blank, arrays joined, nested flattened", () => {
    const { p, stdout } = printer({ output: "table" });
    p.print(rows);
    const [h, r1, r2] = stdout.text.trimEnd().split("\n");
    expect(h).toMatch(/^ID\s+NAME\s+REGION\s+TAGS\s+META\.N\s+META\.DEEP\.K$/);
    expect(r1).toContain("x, y");
    expect(r1).toContain("Zoë 😀");
    expect(r2).toMatch(/^b2\s+Mumbai\s+2$/);
  });

  it("table: default columns can name dot paths and missing columns stay blank", () => {
    const { p, stdout } = printer({ output: "table" });
    p.print(rows, { columns: ["id", "meta.deep.k", "nope"] });
    expect(stdout.text).toBe("ID  META.DEEP.K  NOPE\na1  v\nb2\n");
  });

  it("table on a narrow terminal fits every line", () => {
    const { p, stdout } = printer({ output: "table" }, { tty: true, columns: 40 });
    p.print([{ uuid: "2ded13fe-4f9b-4958-9bfb-093ea2f29f91", from: "+919876543210", to: "+918012345678", hangup_cause: "NORMAL_CLEARING", cost: 0.12 }]);
    for (const l of stdout.text.trimEnd().split("\n")) expect(cp(l)).toBeLessThanOrEqual(40);
    expect(stdout.text).toContain("…");
  });

  it("table when piped (no TTY) is not width-truncated beyond the column cap", () => {
    const { p, stdout } = printer({ output: "table" }, { tty: false });
    p.print([{ id: "x".repeat(55), v: "y" }]);
    expect(stdout.text).toContain("x".repeat(55));
  });

  it("a single record renders FIELD/VALUE with long values capped at 100", () => {
    const { p, stdout } = printer({ output: "table" });
    p.print({ id: "a", text: "t".repeat(300), empty: "", nil: null });
    const lines = stdout.text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^FIELD\s+VALUE$/);
    expect(cp(lines.find((l) => l.startsWith("text"))!.replace(/^text\s+/, ""))).toBe(100);
    expect(lines.find((l) => l.startsWith("nil"))!.trim()).toBe("nil");
  });

  it("scalars print bare in every human mode", () => {
    for (const mode of ["table", "plain", "tsv"] as const) {
      const { p, stdout } = printer({ output: mode });
      p.print("hello");
      expect(stdout.text, mode).toBe("hello\n");
    }
    const { p, stdout } = printer({ output: "table" });
    p.print(null);
    expect(stdout.text).toBe("\n");
  });

  it("a list of scalars prints one per line", () => {
    for (const mode of ["table", "plain", "tsv"] as const) {
      const { p, stdout } = printer({ output: mode });
      p.print(["Standup", "My Room", 3, null]);
      expect(stdout.text, mode).toBe("Standup\nMy Room\n3\n\n");
    }
  });

  it("empty lists: [] in json, [] in yaml, header only in tsv with columns, a note in table/plain", () => {
    let t = printer({ output: "json" });
    t.p.print([], { columns: ["id"] });
    expect(t.stdout.text).toBe("[]\n");
    t = printer({ output: "yaml" });
    t.p.print([]);
    expect(YAML.parse(t.stdout.text)).toEqual([]);
    t = printer({ output: "tsv" });
    t.p.print([], { columns: ["id", "name"] });
    expect(t.stdout.text).toBe("id\tname\n");
    t = printer({ output: "tsv" });
    t.p.print([]);
    expect(t.stdout.text).toBe("");
    for (const mode of ["table", "plain"] as const) {
      t = printer({ output: mode });
      t.p.print([], { empty: "No trunks." });
      expect(t.stdout.text).toBe("");
      expect(t.stderr.text).toBe("No trunks.\n");
    }
    t = printer({ output: "table" });
    t.p.print([]);
    expect(t.stderr.text).toBe("No results.\n");
    t = printer({ output: "table", quiet: true });
    t.p.print([], { empty: "No trunks." });
    expect(t.stderr.text).toBe("");
  });

  it("tsv escapes backslashes, tabs and newlines in headers and cells", () => {
    const { p, stdout } = printer({ output: "tsv" });
    p.print([{ "a\tb": "x\\y", c: "line1\nline2", d: "cr\r\nlf" }]);
    expect(stdout.text).toBe("a\\tb\tc\td\nx\\\\y\tline1\\nline2\tcr\\nlf\n");
    expect(stdout.text.trimEnd().split("\n")).toHaveLength(2);
  });

  it("tsv for a single record is a header row and a value row", () => {
    const { p, stdout } = printer({ output: "tsv" });
    p.print({ id: "a", meta: { n: 1 } });
    expect(stdout.text).toBe("id\tmeta.n\na\t1\n");
  });

  it("yaml round-trips awkward strings", () => {
    const awkward = { colon: "a: b", hash: "# not a comment", yes: "yes", no: "no", num: "0123", multi: "l1\nl2", quote: "it's \"q\"", empty: "", nil: null, e164: "+919876543210", emoji: "😀" };
    const { p, stdout } = printer({ output: "yaml" });
    p.print(awkward);
    expect(YAML.parse(stdout.text)).toEqual(awkward);
  });

  it("json keeps types and unicode as is", () => {
    const { p, stdout } = printer({ output: "json" });
    p.print(rows);
    expect(JSON.parse(stdout.text)).toEqual(rows);
    expect(stdout.text).toContain("😀");
  });

  it("plain prints key: value for a record and space-joined rows for a list", () => {
    let t = printer({ output: "plain" });
    t.p.print({ id: "a", meta: { n: 1 }, tags: ["x", "y"] });
    expect(t.stdout.text).toBe("id: a\nmeta.n: 1\ntags: x, y\n");
    t = printer({ output: "plain" });
    t.p.print([{ id: "a", v: "" }, { id: "b", v: "z" }]);
    expect(t.stdout.text).toBe("a\nb  z\n");
  });

  describe("--fields", () => {
    it("projects dot paths into arrays by index", () => {
      const data = [{ id: "a", numbers: [{ e164: "+1" }, { e164: "+2" }] }];
      let t = printer({ output: "json", fields: ["id", "numbers.0.e164"] });
      t.p.print(data);
      expect(JSON.parse(t.stdout.text)).toEqual([{ id: "a", numbers: { "0": { e164: "+1" } } }]);
      t = printer({ output: "tsv", fields: ["numbers.1.e164", "id"] });
      t.p.print(data);
      expect(t.stdout.text).toBe("numbers.1.e164\tid\n+2\ta\n");
    });

    it("unknown fields give empty columns in tsv and are dropped in json", () => {
      let t = printer({ output: "tsv", fields: ["id", "missing"] });
      t.p.print([{ id: "a" }]);
      expect(t.stdout.text).toBe("id\tmissing\na\t\n");
      t = printer({ output: "json", fields: ["missing"] });
      t.p.print([{ id: "a" }]);
      expect(JSON.parse(t.stdout.text)).toEqual([{}]);
    });

    it("applies to single records too", () => {
      const t = printer({ output: "yaml", fields: ["a.b"] });
      t.p.print({ a: { b: 1, c: 2 }, d: 3 });
      expect(YAML.parse(t.stdout.text)).toEqual({ a: { b: 1 } });
    });

    it("cannot be used to pull a redacted secret back out", () => {
      const t = printer({ output: "json", fields: ["auth_token", "nested.password"] });
      t.p.print([{ auth_token: "tok-1", nested: { password: "pw-1" } }]);
      expect(t.stdout.text).not.toContain("tok-1");
      expect(t.stdout.text).not.toContain("pw-1");
    });
  });

  describe("--quiet", () => {
    const pick = (rows: unknown[], idKey?: string) => {
      const { p, stdout, stderr } = printer({ quiet: true, output: "table" });
      p.print(rows, idKey ? { idKey } : {});
      return { out: stdout.text, err: stderr.text };
    };

    it("follows the primary-key order id > uuid > call_uuid > request_uuid > message_uuid > auth_id > e164 > number > phone_number > name", () => {
      const keys = ["id", "uuid", "call_uuid", "request_uuid", "message_uuid", "auth_id", "e164", "number", "phone_number", "name"];
      for (let i = 0; i < keys.length; i++) {
        const row = Object.fromEntries(keys.slice(i).map((k) => [k, `${k}-v`]));
        expect(pick([row]).out, keys[i]).toBe(`${keys[i]}-v\n`);
      }
    });

    it("skips rows without an id, empty and null ids", () => {
      expect(pick([{ x: 1 }, { id: "" }, { id: null, uuid: "u" }, { id: 0 }]).out).toBe("u\n0\n");
    });

    it("idKey can be a dot path", () => {
      expect(pick([{ number: { e164: "+1" } }, { number: { e164: "+2" } }], "number.e164").out).toBe("+1\n+2\n");
    });

    it("prints scalars of a scalar list and a single record's id", () => {
      expect(pick(["a", "b"]).out).toBe("a\nb\n");
      const { p, stdout } = printer({ quiet: true });
      p.print({ name: "only" });
      expect(stdout.text).toBe("only\n");
    });

    it("wins over --output and --fields, and silences status lines", () => {
      const { p, stdout, stderr } = printer({ quiet: true, output: "json", fields: ["name"] });
      p.print([{ id: "a", name: "n" }]);
      p.status("working…");
      expect(stdout.text).toBe("a\n");
      expect(stderr.text).toBe("");
    });
  });
});

describe("list output through real commands", () => {
  const trunks = {
    objects: [
      { trunk_id: "t-1", name: "Office PBX 😀", trunk_direction: "outbound", trunk_status: "enabled", transport: "udp", trunk_domain: null, concurrent_calls_limit: 10 },
      { trunk_id: "t-2", name: "", trunk_direction: "inbound", trunk_status: "disabled", transport: "tls", trunk_domain: "x.sip.vobiz.ai", concurrent_calls_limit: null },
    ],
    meta: { total: 2 },
  };
  const fetch = specFake({ answer: (op) => (op.id === "list-trunks" ? trunks : undefined) }).fetch;

  it("table uses the default columns and blanks nulls", async () => {
    const r = await runCli(["trunks", "list", "-o", "table"], { fetch });
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^TRUNK_ID\s+NAME\s+TRUNK_DIRECTION\s+TRUNK_STATUS\s+TRANSPORT\s+TRUNK_DOMAIN\s+CONCURRENT_CALLS_LIMIT$/);
    expect(lines[1]).toMatch(/^t-1\s+Office PBX 😀\s+outbound\s+enabled\s+udp\s+10$/);
    expect(lines).toHaveLength(3);
  });

  it("--fields picks columns in order, --quiet prints trunk ids", async () => {
    expect((await runCli(["trunks", "list", "--fields", "trunk_status,trunk_id", "-o", "tsv"], { fetch })).out).toBe("trunk_status\ttrunk_id\nenabled\tt-1\ndisabled\tt-2\n");
    expect((await runCli(["trunks", "list", "-q"], { fetch })).out).toBe("t-1\nt-2\n");
    expect((await runCli(["trunks", "list", "-o", "plain", "--fields", "trunk_id"], { fetch })).out).toBe("t-1\nt-2\n");
  });

  it("yaml and json keep the raw body", async () => {
    expect(YAML.parse((await runCli(["trunks", "list", "-o", "yaml"], { fetch })).out)).toEqual(trunks);
    expect((await runCli(["trunks", "list", "--json"], { fetch })).json()).toEqual(trunks);
  });

  it("an empty list prints the empty note on stderr only", async () => {
    const empty = specFake({ answer: (op) => (op.id === "list-trunks" ? { objects: null, meta: { total: 0 } } : undefined) }).fetch;
    const r = await runCli(["trunks", "list", "-o", "table"], { fetch: empty });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("No trunks.");
    expect((await runCli(["trunks", "list", "--json"], { fetch: empty })).json()).toEqual({ objects: null, meta: { total: 0 } });
  });

  it("VOBIZ_OUTPUT picks the mode; --json overrides it; config output applies only on a TTY", async () => {
    expect((await runCli(["trunks", "list"], { fetch, env: { VOBIZ_OUTPUT: "tsv" } })).out.split("\n")[0]).toContain("trunk_id\t");
    const j = await runCli(["trunks", "list", "--json"], { fetch, env: { VOBIZ_OUTPUT: "tsv" } });
    expect(j.json()).toEqual(trunks);
    const piped = await runCli(["trunks", "list"], { fetch });
    expect(piped.json()).toEqual(trunks);
    const tty = await runCli(["trunks", "list"], { fetch, stdoutTTY: true, columns: 200 });
    expect(tty.out.split("\n")[0]).toMatch(/^\u001b\[1mTRUNK_ID/);
  });

  it("table headers are bold on a TTY unless --no-color or NO_COLOR, and never when piped", async () => {
    const plainHeader = /^TRUNK_ID\s/;
    expect((await runCli(["trunks", "list", "--no-color"], { fetch, stdoutTTY: true, columns: 200 })).out).toMatch(plainHeader);
    expect((await runCli(["trunks", "list"], { fetch, stdoutTTY: true, columns: 200, env: { NO_COLOR: "1" } })).out).toMatch(plainHeader);
    expect((await runCli(["trunks", "list", "-o", "table"], { fetch })).out).toMatch(plainHeader);
    expect((await runCli(["trunks", "list", "-o", "table"], { fetch, env: { FORCE_COLOR: "1" } })).out).toMatch(/^\u001b\[1m/);
  });

  it("whoami renders as FIELD/VALUE in a table and key: value in plain", async () => {
    const t = await runCli(["whoami", "-o", "table"]);
    expect(t.out.split("\n")[0]).toMatch(/^FIELD\s+VALUE$/);
    const p = await runCli(["whoami", "-o", "plain"]);
    expect(p.out).toContain(`auth_id: ${TEST_AUTH_ID}`);
  });
});
