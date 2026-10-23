import { describe, expect, it } from "vitest";
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
    expect(completionScript("bash", program)).toContain('"vobiz profiles") words="list ls use remove rm rename');
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
