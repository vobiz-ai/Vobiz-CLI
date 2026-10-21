/**
 * Contract between the vendored spec, the command tree and the docs:
 *   - every spec operation is reached by some command (an `op("<id>")` reference in src/) or is listed in
 *     docs/SPEC-GAPS.md;
 *   - every command and option is documented, no command option shadows a global flag, and every leaf's
 *     --help works.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Option } from "commander";
import { buildProgram, findCommand, listCommandTree, type CommandNode } from "../src/cli.js";
import { OPERATIONS } from "../src/generated/operations.js";
import { op } from "../src/core/ops.js";
import { makeCtx, runCli } from "./helpers.js";
import { matchOp } from "./spec-fake.js";

const ROOT = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "generated" ? [] : sources(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

const SRC = sources(join(ROOT, "src")).map((file) => ({ file, text: readFileSync(file, "utf8") }));
const REFERENCED = new Set<string>();
for (const { text } of SRC) for (const m of text.matchAll(/\bop\("([^"]+)"\)/g)) REFERENCED.add(m[1]);
const GAPS = readFileSync(join(ROOT, "docs", "SPEC-GAPS.md"), "utf8");

const program = () => buildProgram(makeCtx().ctx);
const tree = listCommandTree(program());
const nodes: CommandNode[] = [];
(function walk(n: CommandNode) {
  if (n.path.length) nodes.push(n);
  n.subcommands.forEach(walk);
})(tree);
const leaves = nodes.filter((n) => !n.subcommands.length);

describe("spec coverage", () => {
  it("parses a sane number of op() references", () => {
    expect(REFERENCED.size).toBeGreaterThanOrEqual(OPERATIONS.length);
  });

  for (const o of OPERATIONS) {
    it(`${o.api}:${o.id} is reached by a command or listed in SPEC-GAPS.md`, () => {
      const used = REFERENCED.has(o.id) || REFERENCED.has(`${o.api}:${o.id}`);
      const gap = GAPS.includes(`\`${o.id}\``);
      expect(used || gap, `${o.method} ${o.path}`).toBe(true);
    });
  }

  it("every op() reference resolves to exactly one spec operation", () => {
    for (const id of REFERENCED) expect(() => op(id), id).not.toThrow();
  });

  it("operationIds are unique within each API", () => {
    for (const api of ["voice", "sms"] as const) {
      const ids = OPERATIONS.filter((o) => o.api === api).map((o) => o.id);
      expect(new Set(ids).size, api).toBe(ids.length);
    }
  });

  it("every operation has a method, a path starting with / and a summary", () => {
    for (const o of OPERATIONS) {
      expect(["GET", "POST", "PUT", "PATCH", "DELETE"], o.id).toContain(o.method);
      expect(o.path.startsWith("/"), o.id).toBe(true);
      expect(o.summary.trim(), o.id).not.toBe("");
    }
  });

  it("the spec fake maps every operation's own path back to it", () => {
    for (const o of OPERATIONS) {
      const path = o.path.replace(/\{(auth_id|account_id)\}/g, "MA_XXXXXXXX").replace(/\{[^}]+\}/g, "x1");
      const hit = matchOp(o.method, o.api, path);
      expect(hit, o.id).toBeDefined();
      // A literal sibling may win (e.g. /messages/cost-preview vs /messages/{id} with id=x1 does not collide).
      expect(hit!.method).toBe(o.method);
    }
  });

  it("account paths come only from credentials: no command takes auth_id or account_id as an argument", () => {
    for (const n of nodes) for (const a of n.args) expect(["auth-id", "account-id", "auth_id", "account_id"], n.path.join(" ")).not.toContain(a.name);
  });
});

describe("command tree", () => {
  const p = program();
  const globals = new Map<string, string>();
  for (const o of p.options as Option[]) {
    if (o.long) globals.set(o.long, o.flags);
    if (o.short) globals.set(o.short, o.flags);
  }
  // commander's --no-color produces long "--no-color"; its positive form must not be reused either.
  const globalNames = new Set(globals.keys());

  it("has a broad command surface", () => {
    expect(nodes.length).toBeGreaterThan(200);
    expect(leaves.length).toBeGreaterThan(170);
  });

  for (const n of nodes) {
    const name = n.path.join(" ");
    it(`${name}: described, options described, no global-flag collision`, () => {
      expect(n.description.trim(), name).not.toBe("");
      expect(n.description.length, name).toBeLessThan(220);
      for (const o of n.options) {
        expect(o.description.trim(), `${name} ${o.flags}`).not.toBe("");
        if (o.long) expect(globalNames.has(o.long), `${name} ${o.long} shadows a global flag`).toBe(false);
        if (o.short) expect(globals.has(o.short), `${name} ${o.short} shadows a global short flag`).toBe(false);
      }
      const longs = n.options.map((o) => o.long).filter(Boolean);
      expect(new Set(longs).size, `${name} has duplicate options`).toBe(longs.length);
    });
  }

  it("subcommand names and aliases are unique within each group", () => {
    for (const n of [tree, ...nodes]) {
      const names = n.subcommands.flatMap((s) => [s.name, ...s.aliases]);
      expect(new Set(names).size, n.path.join(" ") || "vobiz").toBe(names.length);
    }
  });

  it("command names are lower-case kebab words", () => {
    for (const n of nodes) expect(n.name, n.path.join(" ")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("option flags are lower-case kebab", () => {
    for (const n of nodes) for (const o of n.options) if (o.long) expect(o.long, n.path.join(" ")).toMatch(/^--[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("findCommand resolves every path and every alias", () => {
    for (const n of nodes) {
      expect(findCommand(p, n.path)?.name(), n.path.join(" ")).toBe(n.name);
      for (const a of n.aliases) expect(findCommand(p, [...n.path.slice(0, -1), a])?.name()).toBe(n.name);
    }
  });

  it("most list commands accept the ls alias", () => {
    const lists = nodes.filter((n) => n.name === "list");
    const aliased = lists.filter((n) => n.aliases.includes("ls"));
    expect(lists.length).toBeGreaterThan(30);
    expect(aliased.length / lists.length).toBeGreaterThan(0.5);
  });

  it("every option that takes a value names it", () => {
    for (const n of nodes) for (const o of n.options) if (o.takesValue) expect(o.flags, n.path.join(" ")).toMatch(/[<[]/);
  });

  it("choices are non-empty and unique", () => {
    for (const n of nodes)
      for (const o of n.options)
        if (o.choices) {
          expect(o.choices.length, `${n.path.join(" ")} ${o.long}`).toBeGreaterThan(0);
          expect(new Set(o.choices).size).toBe(o.choices.length);
        }
  });

  it("sms senders --color (accent colour) does not clash with the global --no-color", async () => {
    const r = await runCli(["--no-color", "sms", "senders", "create", "--provider", "google", "--sender-name", "acme", "--color", "#112233", "--dry-run", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json().body).toMatchObject({ color: "#112233" });
  });

  it("global options are all documented", () => {
    for (const o of p.options as Option[]) if (!(o as Option & { hidden?: boolean }).hidden) expect(o.description.trim(), o.flags).not.toBe("");
  });
});

describe("--help for every leaf command", () => {
  for (const n of leaves) {
    const name = n.path.join(" ");
    it(`vobiz ${name} --help`, async () => {
      const r = await runCli([...n.path, "--help"], { loggedOut: true });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`Usage: vobiz ${name}`);
      expect(r.err).toBe("");
    });
  }

  it("every group --help lists its subcommands", async () => {
    for (const n of nodes.filter((x) => x.subcommands.length)) {
      const r = await runCli([...n.path, "--help"], { loggedOut: true });
      expect(r.code, n.path.join(" ")).toBe(0);
      for (const s of n.subcommands) expect(r.out, `${n.path.join(" ")} lists ${s.name}`).toContain(s.name);
    }
  });
});

