import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledSkills } from "../src/commands/skills.js";
import { bundledSkillsDir } from "../src/core/bundled.js";
const BUNDLED_SKILLS_DIR = bundledSkillsDir();
import { runCli } from "./helpers.js";

const tempDir = () => join(mkdtempSync(join(tmpdir(), "vobiz-skills-")), ".claude", "skills");

describe("bundled skills", () => {
  it("ships the 17 Vobiz skills with valid front matter", () => {
    const all = bundledSkills();
    expect(all).toHaveLength(17);
    for (const s of all) {
      expect(s.name).toMatch(/^vobiz-[a-z0-9-]+$/);
      expect(s.description.length, s.name).toBeGreaterThan(20);
      expect(existsSync(join(BUNDLED_SKILLS_DIR, s.name, "SKILL.md"))).toBe(true);
    }
    expect(all.map((s) => s.name)).toEqual(expect.arrayContaining(["vobiz-api", "vobiz-voice-xml", "vobiz-sms", "vobiz-whatsapp"]));
  });
});

describe("skills list", () => {
  it("lists skills as JSON, logged out", async () => {
    const r = await runCli(["skills", "list", "--json"], { loggedOut: true });
    expect(r.code).toBe(0);
    const rows = r.json();
    expect(rows).toHaveLength(17);
    expect(rows[0]).toEqual({ name: "vobiz-ai-voice-agents", version: expect.any(String), description: expect.stringContaining("voice agents") });
  });

  it("--dir shows install state", async () => {
    const dir = tempDir();
    await runCli(["skills", "install", "--dir", dir, "--only", "vobiz-cdr", "--yes"]);
    const rows = (await runCli(["skills", "list", "--dir", dir, "--json"])).json();
    expect(rows.find((r: { name: string }) => r.name === "vobiz-cdr").installed).toBe("yes");
    expect(rows.find((r: { name: string }) => r.name === "vobiz-api").installed).toBe("no");
  });
});

describe("skills install", () => {
  it("copies every skill into the folder", async () => {
    const dir = tempDir();
    const r = await runCli(["skills", "install", "--dir", dir, "--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(bundledSkills().map((s) => s.name));
    expect(readFileSync(join(dir, "vobiz-voice-xml", "SKILL.md"), "utf8")).toBe(readFileSync(join(BUNDLED_SKILLS_DIR, "vobiz-voice-xml", "SKILL.md"), "utf8"));
    expect(r.json().every((row: { status: string }) => row.status === "installed")).toBe(true);
  });

  it("--only accepts spaces and commas; leaves changed copies alone", async () => {
    const dir = tempDir();
    expect((await runCli(["skills", "install", "--dir", dir, "--only", "vobiz-api,vobiz-cdr", "vobiz-sms", "--yes"])).code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["vobiz-api", "vobiz-cdr", "vobiz-sms"]);
    appendFileSync(join(dir, "vobiz-cdr", "SKILL.md"), "\nlocal edit\n");
    const again = await runCli(["skills", "install", "--dir", dir, "--only", "vobiz-api", "vobiz-cdr", "--json"]);
    expect(again.code).toBe(0);
    expect(again.json().map((r: { status: string }) => r.status)).toEqual(["up to date", "exists (run skills update)"]);
    expect(readFileSync(join(dir, "vobiz-cdr", "SKILL.md"), "utf8")).toContain("local edit");
  });

  it("needs --yes when stdin is not a terminal; --dry-run writes nothing", async () => {
    const dir = tempDir();
    expect((await runCli(["skills", "install", "--dir", dir])).code).toBe(6);
    const dry = await runCli(["skills", "install", "--dir", dir, "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    expect(dry.err).toContain("[dry-run] Install 17 Vobiz skills");
    expect(existsSync(dir)).toBe(false);
  });

  it("expands a leading ~ in --dir, which cmd.exe and Windows PowerShell 5.1 pass through literally", async () => {
    const { resolveSkillsDir } = await import("../src/commands/skills.js");
    const { homedir } = await import("node:os");
    expect(resolveSkillsDir("~/.claude/skills")).toBe(join(homedir(), ".claude", "skills"));
    expect(resolveSkillsDir("~\\.claude\\skills")).toBe(process.platform === "win32" ? join(homedir(), ".claude", "skills") : join(homedir(), "\\.claude\\skills"));
    expect(resolveSkillsDir("~")).toBe(homedir());
    expect(resolveSkillsDir("~user/skills")).toBe(resolve("~user/skills"));
    expect(resolveSkillsDir("a/~/b")).toBe(resolve("a/~/b"));
  });

  it("rejects unknown skill names", async () => {
    const r = await runCli(["skills", "install", "--dir", tempDir(), "--only", "vobiz-nope", "--yes"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown skill(s): vobiz-nope");
  });
});

describe("skills update", () => {
  it("re-copies only installed skills that changed", async () => {
    const dir = tempDir();
    await runCli(["skills", "install", "--dir", dir, "--only", "vobiz-api", "vobiz-cdr", "--yes"]);
    appendFileSync(join(dir, "vobiz-cdr", "SKILL.md"), "\nlocal edit\n");
    const r = await runCli(["skills", "update", "--dir", dir, "--yes", "--json"]);
    expect(r.code).toBe(0);
    const status = Object.fromEntries(r.json().map((row: { skill: string; status: string }) => [row.skill, row.status]));
    expect(status).toMatchObject({ "vobiz-api": "up to date", "vobiz-cdr": "updated", "vobiz-sms": "not installed" });
    expect(readFileSync(join(dir, "vobiz-cdr", "SKILL.md"), "utf8")).not.toContain("local edit");
    expect(existsSync(join(dir, "vobiz-sms"))).toBe(false);
  });

  it("fails when nothing is installed", async () => {
    const r = await runCli(["skills", "update", "--dir", tempDir(), "--yes"]);
    expect(r.code).toBe(4);
  });
});

describe("skills install hardening", async () => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { plan } = await import("../src/commands/skills.js");
  const fakeBundle = (name: string) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "vobiz-bundle-"));
    fs.mkdirSync(path.join(root, "good"));
    fs.writeFileSync(path.join(root, "good", "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
    return root;
  };

  it("rejects a bundled skill whose front-matter name is not a plain folder name", () => {
    expect(() => bundledSkills(fakeBundle("../../x"))).toThrow(/invalid name/);
    expect(() => bundledSkills(fakeBundle("Bad_Name"))).toThrow(/invalid name/);
    expect(bundledSkills(fakeBundle("good")).map((s) => s.name)).toEqual(["good"]);
  });

  it("never plans a write outside --dir", () => {
    expect(() => plan([{ name: "../x", version: "", description: "", path: "/tmp" }], "/tmp/skills", "install")).toThrow(/outside/);
  });
});
