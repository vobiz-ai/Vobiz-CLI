import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram, listCommandTree } from "../src/cli.js";
import { completionScript, SHELLS } from "../src/commands/completion.js";
import { makeCtx, runCli } from "./helpers.js";

describe("help", () => {
  it("root --help is stable", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchSnapshot();
  });

  it("no arguments prints help and exits 0", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: vobiz");
  });

  it("help topics", async () => {
    for (const topic of ["exit-codes", "env", "output"]) {
      const r = await runCli(["help", topic]);
      expect(r.code, topic).toBe(0);
      expect(r.out.length).toBeGreaterThan(100);
    }
    expect((await runCli(["help", "exit-codes"])).out).toContain("7  outcome_unknown");
    expect((await runCli(["help", "profiles", "use"])).out).toContain("Usage: vobiz profiles use");
    expect((await runCli(["help", "nothing-here"])).code).toBe(2);
  });

  it("every command has a description", () => {
    const tree = listCommandTree(buildProgram(makeCtx().ctx));
    const walk = (n: typeof tree): void => {
      if (n.path.length) expect(n.description, n.path.join(" ")).not.toBe("");
      n.subcommands.forEach(walk);
    };
    walk(tree);
    expect(tree.subcommands.map((s) => s.name)).toEqual(
      expect.arrayContaining(["login", "logout", "whoami", "profiles", "config", "doctor", "api", "completion", "help", "update"]),
    );
  });
});

describe("completion", () => {
  it("generates a script for every shell from the command tree", async () => {
    const program = buildProgram(makeCtx().ctx);
    for (const shell of SHELLS) {
      const s = completionScript(shell, program);
      expect(s, shell).toContain("vobiz");
      expect(s, shell).toContain("profiles");
      expect(s, shell).toContain("--output");
    }
    expect(completionScript("bash", program)).toContain('"vobiz profiles") words="list ls use remove rm delete rename');
    const r = await runCli(["completion", "zsh"]);
    expect(r.code).toBe(0);
    expect(r.out.startsWith("#compdef vobiz")).toBe(true);
    expect((await runCli(["completion", "tcsh"])).code).toBe(2);
    // Windows PowerShell 5.1 decodes piped output in the console code page: keep the script ASCII, and never
    // suggest `>> $PROFILE`, which appends UTF-16 to a UTF-8 profile in 5.1.
    const ps = completionScript("powershell", program);
    expect(ps).toMatch(/^[\x00-\x7f]*$/);
    expect(ps).not.toContain(">> $PROFILE");
    expect((await runCli(["completion", "--help"])).out).toContain("| Out-String | Invoke-Expression");
  });
});

/** Labels of the arms of every `case … esac` block, per block (nested blocks are their own). */
function caseArms(script: string): string[][] {
  const blocks: string[][] = [];
  const stack: string[][] = [];
  for (const line of script.split("\n")) {
    if (/\bcase\b.*\bin\s*$/.test(line)) {
      stack.push([]);
      continue;
    }
    if (/^\s*esac\b/.test(line)) {
      blocks.push(stack.pop() ?? []);
      continue;
    }
    const arm = /^\s*("[^"]*"|'[^']*'|[^\s()]+)\)/.exec(line);
    if (arm && stack.length) stack[stack.length - 1]!.push(arm[1]!);
  }
  return blocks;
}

const duplicates = (arms: string[]) => arms.filter((a, i) => arms.indexOf(a) !== i);

describe("bash completion case arms", () => {
  it("`vobiz completion bash` has no duplicate case arms (value choices are scoped per command)", () => {
    const s = completionScript("bash", buildProgram(makeCtx().ctx));
    for (const arms of caseArms(s)) expect(duplicates(arms)).toEqual([]);
  });

  it.skipIf(!existsSync(join(__dirname, "..", "completions", "vobiz.bash")))("completions/vobiz.bash has no duplicate case arms", () => {
    const s = readFileSync(join(__dirname, "..", "completions", "vobiz.bash"), "utf8");
    for (const arms of caseArms(s)) expect(duplicates(arms)).toEqual([]);
  });

  const bash = spawnSync("bash", ["--version"]).status === 0;
  it.skipIf(!bash || process.platform === "win32")("offers each command's own values for a shared flag name", () => {
    const file = join(mkdtempSync(join(tmpdir(), "vobiz-compl-")), "vobiz.bash");
    writeFileSync(file, completionScript("bash", buildProgram(makeCtx().ctx)));
    const complete = (line: string) => {
      const words = line.split(" ");
      const script = `source "${file}"; COMP_WORDS=(${words.map((w) => `"${w}"`).join(" ")}); COMP_CWORD=${words.length - 1}; _vobiz_complete; printf '%s\\n' "\${COMPREPLY[@]}"`;
      return spawnSync("bash", ["-c", script], { encoding: "utf8" }).stdout.trim().split("\n").sort();
    };
    expect(complete("vobiz account transactions list --status ")).toEqual(["cancelled", "completed", "failed", "pending"]);
    expect(complete("vobiz partner accounts cdrs --status ")).toEqual(["answered", "busy", "failed", "no_answer"]);
    expect(complete("vobiz calls list --output ")).toContain("jsonl");
  });
});
