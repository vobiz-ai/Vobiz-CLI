/**
 * The exit-code text lives once, in src/core/exit-codes.ts. `vobiz help exit-codes`, docs/COMMANDS.md and the
 * generated blocks in README.md, docs/AGENTS.md and docs/ARCHITECTURE.md must show it verbatim, and the README's
 * command count must match the command tree (`npm run docs:commands` refreshes all of them).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram, listCommandTree, type CommandNode } from "../src/cli.js";
import { EXIT_CODE_DOCS, exitCodesMarkdown, fillGeneratedBlocks } from "../src/core/exit-codes.js";
import { makeCtx, runCli } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("exit codes have one source", () => {
  for (const [rel, marker] of [
    ["README.md", "exit-codes"],
    ["docs/ARCHITECTURE.md", "exit-codes"],
    ["docs/AGENTS.md", "exit-codes-agents"],
  ]) {
    it(`${rel} carries the generated ${marker} block, up to date`, () => {
      const text = read(rel);
      expect(text).toContain(`<!-- BEGIN GENERATED ${marker} -->`);
      expect(fillGeneratedBlocks(text), "run npm run build && npm run docs:commands").toBe(text);
    });
  }

  it("docs/COMMANDS.md has the same table", () => {
    expect(read("docs/COMMANDS.md")).toContain(exitCodesMarkdown());
  });

  it("`vobiz help exit-codes` prints every meaning verbatim", async () => {
    const r = await runCli(["help", "exit-codes"]);
    for (const e of EXIT_CODE_DOCS) expect(r.out).toContain(`${String(e.code).padStart(3)}  ${e.meaning}`);
  });

  it("code 7 covers a lost connection and 5xx/408 on a write; code 8 is a read", () => {
    const seven = EXIT_CODE_DOCS.find((e) => e.code === 7)!.meaning;
    expect(seven).toMatch(/lost its connection/);
    expect(seven).toMatch(/5xx or 408 answer on a write/);
    expect(EXIT_CODE_DOCS.find((e) => e.code === 8)!.meaning).toMatch(/on a read/);
  });

  it("README's command count matches the command tree", () => {
    const tree = listCommandTree(buildProgram(makeCtx().ctx));
    let n = 0;
    (function walk(node: CommandNode) {
      for (const c of node.subcommands) {
        if (c.name === "help") continue;
        n++;
        walk(c);
      }
    })(tree);
    expect(read("README.md")).toContain(`${n} commands and command groups`);
  });
});
