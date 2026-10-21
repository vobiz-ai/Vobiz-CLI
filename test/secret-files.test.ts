/** S1 #1, #3, #6, #9, #12: files that hold the Auth Token. */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_SPECS } from "../src/agent/mcp-clients.js";
import { writeFileAtomicExclusive } from "../src/core/fsafe.js";
import { ConfigStore } from "../src/core/config.js";
import { literalTokens } from "../src/commands/mcp.js";
import { runCli, TEST_AUTH_ID } from "./helpers.js";

const posix = process.platform !== "win32";
const SECRET = "tok_REAL_LOOKING_SECRET_777";
const temp = (p = "vobiz-sec-") => mkdtempSync(join(tmpdir(), p));
const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("mcp install never prints the token when the merge fails (S1 #1)", () => {
  for (const dry of [false, true]) {
    for (const [label, content] of [["invalid JSON", "{ not json"], ["JSONC", "// mine\n{}\n"], ["not an object", "[1,2]"]] as const) {
      it(`${label}${dry ? " with --dry-run" : ""}`, async () => {
        const HOME = temp();
        const env = { HOME, XDG_CONFIG_HOME: join(HOME, ".config"), APPDATA: join(HOME, "AppData"), VOBIZ_AUTH_TOKEN: SECRET };
        const file = CLIENT_SPECS.claude.path({ env, platform: process.platform, cwd: HOME, project: false, mode: "local" })!;
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, content);
        const r = await runCli(["mcp", "install", "claude", "--local", "--with-credentials", "--yes", ...(dry ? ["--dry-run"] : [])], { env });
        expect(r.code).toBe(2);
        expect(r.out + r.err).not.toContain(SECRET);
        expect(r.out).toContain("YOUR_AUTH_TOKEN");
        expect(r.out).toContain(TEST_AUTH_ID);
        expect(readFileSync(file, "utf8")).toBe(content);
      });
    }
  }
});

describe.skipIf(!hasGit)("mcp install --with-credentials --project in a git work tree (S1 #3)", () => {
  const repo = () => {
    const dir = temp("vobiz-repo-");
    expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
    return dir;
  };
  const env = (HOME: string) => ({ HOME, VOBIZ_AUTH_TOKEN: SECRET });

  it("refuses a file git would commit, with the env-placeholder alternative", async () => {
    const dir = repo();
    const r = await runCli(["mcp", "install", "claude-code", "--local", "--with-credentials", "--project", "--dir", dir, "--yes"], { env: env(temp()) });
    expect(r.code).toBe(6);
    expect(r.err).toContain("git work tree");
    expect(r.err).toContain("${VOBIZ_AUTH_TOKEN}");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(r.out + r.err).not.toContain(SECRET);
    // Without --with-credentials the env-placeholder entry is written as before.
    const ok = await runCli(["mcp", "install", "claude-code", "--local", "--project", "--dir", dir, "--yes"], { env: env(temp()) });
    expect(ok.code, ok.err).toBe(0);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).not.toContain(SECRET);
  });

  it("allows a git-ignored file and a directory outside any work tree", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), ".mcp.json\n");
    const r = await runCli(["mcp", "install", "claude-code", "--local", "--with-credentials", "--project", "--dir", dir, "--yes"], { env: env(temp()) });
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toContain(SECRET);
    const plain = temp("vobiz-nogit-");
    const p = await runCli(["mcp", "install", "cursor", "--local", "--with-credentials", "--project", "--dir", plain, "--yes"], { env: env(temp()) });
    expect(p.code, p.err).toBe(0);
  });
});

describe("mcp install backups never keep a dropped token (S1 #9)", () => {
  it("replaces the old token in <file>.bak when the new file no longer has it", async () => {
    const HOME = temp();
    const env = { HOME, VOBIZ_AUTH_TOKEN: SECRET };
    const withCreds = await runCli(["mcp", "install", "claude-code", "--local", "--with-credentials", "--yes"], { env });
    expect(withCreds.code, withCreds.err).toBe(0);
    const file = join(HOME, ".claude.json");
    expect(readFileSync(file, "utf8")).toContain(SECRET);
    const envBased = await runCli(["mcp", "install", "claude-code", "--local", "--yes"], { env });
    expect(envBased.code, envBased.err).toBe(0);
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    const bak = readFileSync(`${file}.bak`, "utf8");
    expect(bak).not.toContain(SECRET);
    expect(bak).toContain("YOUR_AUTH_TOKEN");
    expect(envBased.err).toContain("replaced by YOUR_AUTH_TOKEN");
  });

  it("finds literal tokens in JSON and TOML, not placeholders", () => {
    expect(literalTokens('{"VOBIZ_AUTH_TOKEN": "abc123", "x": "${VOBIZ_AUTH_TOKEN}"}')).toEqual(["abc123"]);
    expect(literalTokens('VOBIZ_AUTH_TOKEN = "t0k"\n')).toEqual(["t0k"]);
    expect(literalTokens('{"VOBIZ_AUTH_TOKEN": "${input:vobiz-auth-token}"}')).toEqual([]);
    expect(literalTokens('{"VOBIZ_AUTH_TOKEN": "YOUR_AUTH_TOKEN"}')).toEqual([]);
  });
});

describe.skipIf(!posix)("atomic secret-file writes (S1 #6)", () => {
  it("uses an exclusive random temp name, so a planted pid-named symlink receives nothing", () => {
    const dir = temp();
    const loot = join(temp(), "loot");
    writeFileSync(loot, "");
    const file = join(dir, "credentials.json");
    symlinkSync(loot, `${file}.${process.pid}.tmp`);
    new ConfigStore(dir).setProfile("default", { authId: TEST_AUTH_ID, authToken: SECRET });
    expect(readFileSync(loot, "utf8")).toBe("");
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp") && !f.includes(String(process.pid)))).toEqual([]);
  });

  it("refuses a symlink at the destination", () => {
    const dir = temp();
    const loot = join(temp(), "loot");
    const empty = '{"version":1,"profiles":{}}';
    writeFileSync(loot, empty);
    symlinkSync(loot, join(dir, "credentials.json"));
    expect(() => new ConfigStore(dir).setProfile("default", { authId: TEST_AUTH_ID, authToken: SECRET })).toThrow(/symbolic link/);
    expect(readFileSync(loot, "utf8")).toBe(empty);
    expect(() => writeFileAtomicExclusive(join(dir, "credentials.json"), "x", { mode: 0o600, overwrite: true })).toThrow(/symbolic link/);
  });

  it("tightens an existing config dir to 0700 on write", () => {
    const dir = temp();
    chmodSync(dir, 0o755);
    new ConfigStore(dir).setProfile("default", { authId: TEST_AUTH_ID, authToken: SECRET });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("mcp install writes the client config through the same path (symlink refused)", async () => {
    const HOME = temp();
    const loot = join(temp(), "loot");
    writeFileSync(loot, "");
    mkdirSync(join(HOME, ".cursor"));
    symlinkSync(loot, join(HOME, ".cursor", "mcp.json"));
    const r = await runCli(["mcp", "install", "cursor", "--local", "--with-credentials", "--yes"], { env: { HOME, VOBIZ_AUTH_TOKEN: SECRET } });
    expect(r.code).not.toBe(0);
    expect(readFileSync(loot, "utf8")).toBe("");
  });
});

describe.skipIf(!posix)("credentials.json permissions on read (S1 #12)", () => {
  it("warns when the file is readable by group or others, and not when it is 0600", async () => {
    const configDir = temp();
    const store = new ConfigStore(configDir);
    store.setProfile("default", { authId: TEST_AUTH_ID, authToken: SECRET });
    const ok = await runCli(["api", "GET", "/api/v1/x", "--dry-run", "--json"], { loggedOut: true, configDir });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.err).not.toContain("readable by other users");
    chmodSync(store.credentialsPath, 0o644);
    const loose = await runCli(["api", "GET", "/api/v1/x", "--dry-run", "--json"], { loggedOut: true, configDir });
    expect(loose.code).toBe(0);
    expect(loose.err).toContain("readable by other users");
    expect(loose.err).toContain("chmod 600");
    expect(loose.out + loose.err).not.toContain(SECRET);
  });
});
