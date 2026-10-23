/**
 * Property-style loops over the whole command tree, against the spec fake (test/spec-fake.ts):
 *   - every list command with --all walks a two-page listing and returns both items;
 *   - every list command with --limit 1 makes one request and returns one item;
 *   - every read-only command sends only GETs; every list output mode is parseable.
 */
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { buildProgram, listCommandTree, type CommandNode } from "../src/cli.js";
import { pageStyle } from "../src/core/pagination.js";
import { OPERATIONS } from "../src/generated/operations.js";
import { TEST_AUTH_TOKEN, makeCtx, runCli } from "./helpers.js";
import { specFake } from "./spec-fake.js";

const tree = listCommandTree(buildProgram(makeCtx().ctx));
const nodes: CommandNode[] = [];
(function walk(n: CommandNode) {
  if (n.path.length) nodes.push(n);
  n.subcommands.forEach(walk);
})(tree);

/** Positional arguments for a command: placeholders that are valid ids. */
const argsFor = (n: CommandNode) => n.args.filter((a) => a.required).map(() => "x1");
const has = (n: CommandNode, flag: string) => n.options.some((o) => o.long === flag);

const pagedLists = nodes.filter((n) => has(n, "--all") && has(n, "--limit"));
/** --limit without --all: commands that need more than ids to run, or talk to another service, are skipped. */
const NEEDS_MORE: Record<string, string[]> = { "sms numbers search": ["--country", "US"] };
const limitOnly = nodes.filter((n) => has(n, "--limit") && !has(n, "--all") && n.path[0] !== "docs");

describe("every list command pages", () => {
  it("there are many paged list commands", () => {
    expect(pagedLists.length).toBeGreaterThanOrEqual(27);
  });

  for (const n of pagedLists) {
    const name = n.path.join(" ");
    it(`${name} --all collects every page`, async () => {
      const api = specFake({ pages: 2 });
      const r = await runCli([...n.path, ...argsFor(n), "--all", "--json"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(0);
      expect(api.calls.every((c) => c.method === "GET"), name).toBe(true);
      const op = OPERATIONS.find((o) => o.id === api.ops().at(-1))!;
      const pages = pageStyle(op).kind === "none" ? 1 : 2;
      expect(api.calls.length, `${name} (${op.id})`).toBe(pages);
      expect(r.out).toContain("item-1");
      if (pages === 2) expect(r.out).toContain("item-2");
      expect(r.out + r.err).not.toContain(TEST_AUTH_TOKEN);
    });

    it(`${name} --limit 1 asks for one item`, async () => {
      const api = specFake({ pages: 2 });
      const r = await runCli([...n.path, ...argsFor(n), "--limit", "1", "--json"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(0);
      expect(api.calls).toHaveLength(1);
      expect(r.out).toContain("item-1");
      expect(r.out).not.toContain("item-2");
      const op = OPERATIONS.find((o) => o.id === api.ops()[0])!;
      const style = pageStyle(op);
      if (style.kind === "offset") expect(api.last().query.limit, op.id).toBe("1");
      if (style.kind === "page" && style.sizeParam) expect(api.last().query[style.sizeParam], op.id).toBe("1");
    });

    it(`${name} rejects --limit 0 and --limit abc`, async () => {
      const api = specFake();
      for (const bad of ["0", "abc", "-3"]) {
        const r = await runCli([...n.path, ...argsFor(n), "--limit", bad], { fetch: api.fetch });
        expect(r.code, `${name} --limit ${bad}`).toBe(2);
      }
      expect(api.calls).toHaveLength(0);
    });
  }

  for (const n of limitOnly) {
    const name = n.path.join(" ");
    it(`${name} --limit 1 is accepted`, async () => {
      const api = specFake({ pages: 1 });
      const r = await runCli([...n.path, ...argsFor(n), ...(NEEDS_MORE[name] ?? []), "--limit", "1", "--json"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(0);
      expect(api.calls.every((c) => c.method === "GET")).toBe(true);
    });
  }
});

describe("list output modes", () => {
  const lists = pagedLists.slice(0, 40);
  for (const n of lists) {
    const name = n.path.join(" ");
    it(`${name}: json, yaml, tsv, plain, table and --quiet all render`, async () => {
      const api = specFake({ pages: 1 });
      const base = [...n.path, ...argsFor(n), "--limit", "1"];
      const j = await runCli([...base, "--output", "json"], { fetch: api.fetch });
      expect(j.code, j.err).toBe(0);
      expect(() => JSON.parse(j.out)).not.toThrow();
      const y = await runCli([...base, "--output", "yaml"], { fetch: api.fetch });
      expect(y.code).toBe(0);
      expect(() => YAML.parse(y.out)).not.toThrow();
      for (const mode of ["tsv", "plain", "table"]) {
        const r = await runCli([...base, "--output", mode], { fetch: api.fetch });
        expect(r.code, `${name} ${mode}: ${r.err}`).toBe(0);
        expect(r.out.length, `${name} ${mode}`).toBeGreaterThan(0);
      }
      const q = await runCli([...base, "--quiet"], { fetch: api.fetch });
      expect(q.code).toBe(0);
      expect(q.out.trim().split("\n")).toHaveLength(1);
    });
  }
});

describe("regression: sms lists without an explicit items key keep every page with --all --json", () => {
  for (const argv of [
    ["sms", "conversations", "list"],
    ["sms", "conversations", "messages", "c1"],
    ["sms", "opt-outs", "list"],
    ["sms", "senders", "list"],
    ["sms", "senders", "templates", "list", "s1"],
  ]) {
    it(argv.join(" "), async () => {
      const api = specFake({ pages: 3, answer: (op, req) => (op.method === "GET" ? { results: [{ id: `p${req.query.offset}` }], total: 3 } : undefined) });
      const r = await runCli([...argv, "--all", "--json"], { fetch: api.fetch });
      expect(r.code, r.err).toBe(0);
      expect(api.calls).toHaveLength(3);
      expect(r.json()).toEqual({ results: [{ id: "p0" }, { id: "p1" }, { id: "p2" }], total: 3 });
    });
  }
});
