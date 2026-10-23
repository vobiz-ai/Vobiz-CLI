import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_SPECS, mergeToml, stripJsonc, tomlKeyPath } from "../src/agent/mcp-clients.js";
import { runCli, TEST_AUTH_ID, TEST_AUTH_TOKEN } from "./helpers.js";

const tempHome = () => mkdtempSync(join(tmpdir(), "vobiz-home-"));
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("mcp install", () => {
  it("cursor: writes the hosted connector, then reports unchanged on a re-run", async () => {
    const HOME = tempHome();
    const r = await runCli(["mcp", "install", "cursor", "--yes", "--json"], { env: { HOME }, loggedOut: true });
    expect(r.code).toBe(0);
    const file = join(HOME, ".cursor", "mcp.json");
    expect(readJson(file)).toEqual({ mcpServers: { vobiz: { url: "https://mcp.vobiz.ai/mcp" } } });
    expect(r.json()).toMatchObject({ client: "cursor", mode: "hosted", status: "added", backup: null });

    const again = await runCli(["mcp", "install", "cursor", "--json"], { env: { HOME } });
    expect(again.code).toBe(0);
    expect(again.json().status).toBe("unchanged");
    expect(existsSync(`${file}.bak`)).toBe(false);
  });

  it("claude-code: merges into ~/.claude.json keeping other keys and servers, with a backup", async () => {
    const HOME = tempHome();
    const file = join(HOME, ".claude.json");
    const original = { numStartups: 3, mcpServers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp/" } } };
    writeFileSync(file, JSON.stringify(original));
    const r = await runCli(["mcp", "install", "claude-code", "--local", "--yes"], { env: { HOME } });
    expect(r.code).toBe(0);
    expect(readJson(file)).toEqual({
      numStartups: 3,
      mcpServers: {
        github: original.mcpServers.github,
        vobiz: { type: "stdio", command: "npx", args: ["-y", "@vobiz/mcp"], env: { VOBIZ_AUTH_ID: "${VOBIZ_AUTH_ID}", VOBIZ_AUTH_TOKEN: "${VOBIZ_AUTH_TOKEN}" } },
      },
    });
    expect(readJson(`${file}.bak`)).toEqual(original);
    expect(readFileSync(file, "utf8")).not.toContain(TEST_AUTH_TOKEN);

    // Switching to hosted replaces the entry.
    const hosted = await runCli(["mcp", "install", "claude-code", "--yes", "--json"], { env: { HOME } });
    expect(hosted.json().status).toBe("replaced");
    expect(readJson(file).mcpServers.vobiz).toEqual({ type: "http", url: "https://mcp.vobiz.ai/mcp" });
  });

  it("vscode --project --local: adds the input prompts once and keeps existing inputs", async () => {
    const HOME = tempHome();
    const dir = mkdtempSync(join(tmpdir(), "vobiz-proj-"));
    mkdirSync(join(dir, ".vscode"));
    const file = join(dir, ".vscode", "mcp.json");
    writeFileSync(file, JSON.stringify({ inputs: [{ type: "promptString", id: "other" }], servers: {} }));
    for (let i = 0; i < 2; i++) expect((await runCli(["mcp", "install", "vscode", "--local", "--project", "--dir", dir, "--yes"], { env: { HOME } })).code).toBe(0);
    const doc = readJson(file);
    expect(doc.inputs.map((x: { id: string }) => x.id)).toEqual(["other", "vobiz-auth-id", "vobiz-auth-token"]);
    expect(doc.servers.vobiz.env).toEqual({ VOBIZ_AUTH_ID: "${input:vobiz-auth-id}", VOBIZ_AUTH_TOKEN: "${input:vobiz-auth-token}" });
  });

  it("codex: writes TOML, keeps other tables and replaces its own", async () => {
    const HOME = tempHome();
    mkdirSync(join(HOME, ".codex"));
    const file = join(HOME, ".codex", "config.toml");
    writeFileSync(file, 'model = "o3"\n\n[mcp_servers.vobiz]\nurl = "https://old.example.com"\n\n[mcp_servers.vobiz.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "x"\n');
    const r = await runCli(["mcp", "install", "codex", "--local", "--yes"], { env: { HOME } });
    expect(r.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.vobiz]\ncommand = "npx"\nargs = ["-y", "@vobiz/mcp"]\nenv_vars = ["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN"]\n',
    );
    expect(mergeToml(readFileSync(file, "utf8"), "mcp_servers", "vobiz", { command: "npx", args: ["-y", "@vobiz/mcp"], env_vars: ["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN"] }).status).toBe("unchanged");
  });

  it("gemini and windsurf use their own keys", async () => {
    const HOME = tempHome();
    expect((await runCli(["mcp", "install", "gemini", "--yes"], { env: { HOME } })).code).toBe(0);
    expect(readJson(join(HOME, ".gemini", "settings.json"))).toEqual({ mcpServers: { vobiz: { httpUrl: "https://mcp.vobiz.ai/mcp" } } });
    if (process.platform !== "win32") {
      expect((await runCli(["mcp", "install", "windsurf", "--yes"], { env: { HOME } })).code).toBe(0);
      expect(readJson(join(HOME, ".config", "devin", "mcp_config.json"))).toEqual({ mcpServers: { vobiz: { serverUrl: "https://mcp.vobiz.ai/mcp" } } });
    }
  });

  it("claude --local --with-credentials needs confirmation and writes a 0600 file", async () => {
    const HOME = tempHome();
    const env = { HOME, XDG_CONFIG_HOME: join(HOME, ".config"), APPDATA: join(HOME, "AppData") };
    const refused = await runCli(["mcp", "install", "claude", "--local", "--with-credentials"], { env });
    expect(refused.code).toBe(6);
    const file = CLIENT_SPECS.claude.path({ env, platform: process.platform, cwd: HOME, project: false, mode: "local" })!;
    expect(existsSync(file)).toBe(false);

    const r = await runCli(["mcp", "install", "claude", "--local", "--with-credentials", "--yes"], { env });
    expect(r.code).toBe(0);
    expect(r.err).toContain(`Auth ID ${TEST_AUTH_ID} and your Auth Token, in plain text in this file`);
    expect(readJson(file).mcpServers.vobiz.env).toEqual({ VOBIZ_AUTH_ID: TEST_AUTH_ID, VOBIZ_AUTH_TOKEN: TEST_AUTH_TOKEN });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("claude --local without credentials writes placeholders and says so", async () => {
    const HOME = tempHome();
    const env = { HOME, XDG_CONFIG_HOME: join(HOME, ".config"), APPDATA: join(HOME, "AppData") };
    const r = await runCli(["mcp", "install", "claude", "--local", "--yes"], { env, loggedOut: true });
    expect(r.code).toBe(0);
    expect(r.err).toContain("Replace MA_XXXXXXXX and YOUR_AUTH_TOKEN");
  });

  it("claude --hosted prints the Connectors steps and writes nothing", async () => {
    const HOME = tempHome();
    const r = await runCli(["mcp", "install", "claude"], { env: { HOME }, loggedOut: true });
    expect(r.code).toBe(0);
    expect(r.err).toContain("Settings → Connectors → Add custom connector");
  });

  it("--dry-run prints the snippet and writes nothing", async () => {
    const HOME = tempHome();
    const r = await runCli(["mcp", "install", "cursor", "--dry-run"], { env: { HOME } });
    expect(r.code).toBe(0);
    expect(r.err).toContain("[dry-run] Add the Vobiz MCP server");
    expect(JSON.parse(r.out)).toEqual({ mcpServers: { vobiz: { url: "https://mcp.vobiz.ai/mcp" } } });
    expect(existsSync(join(HOME, ".cursor"))).toBe(false);
  });

  it("refuses to rewrite a settings file with comments and prints the snippet instead", async () => {
    const HOME = tempHome();
    const env = { HOME, XDG_CONFIG_HOME: join(HOME, ".config"), APPDATA: join(HOME, "AppData") };
    const file = CLIENT_SPECS.zed.path({ env, platform: process.platform, cwd: HOME, project: false, mode: "hosted" })!;
    mkdirSync(join(file, ".."), { recursive: true });
    const original = '// Zed settings\n{\n  "theme": "One Dark", // mine\n}\n';
    writeFileSync(file, original);
    const r = await runCli(["mcp", "install", "zed", "--yes"], { env });
    expect(r.code).toBe(2);
    expect(r.err).toContain("has comments");
    expect(JSON.parse(r.out)).toEqual({ context_servers: { vobiz: { url: "https://mcp.vobiz.ai/mcp" } } });
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(JSON.parse(stripJsonc(original))).toEqual({ theme: "One Dark" });
  });

  it("--with-credentials never prints the real Auth Token (dry-run or the comments refusal)", async () => {
    const HOME = tempHome();
    const secret = "tok_REAL_LOOKING_SECRET_123";
    const env = { HOME, XDG_CONFIG_HOME: join(HOME, ".config"), APPDATA: join(HOME, "AppData"), VOBIZ_AUTH_TOKEN: secret };
    const dry = await runCli(["mcp", "install", "claude", "--local", "--with-credentials", "--dry-run", "--yes"], { env });
    expect(dry.code).toBe(0);
    expect(dry.out + dry.err).not.toContain(secret);
    expect(dry.out).toContain("YOUR_AUTH_TOKEN");
    expect(dry.out).toContain(TEST_AUTH_ID);

    const file = CLIENT_SPECS.zed.path({ env, platform: process.platform, cwd: HOME, project: false, mode: "local" })!;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "// mine\n{}\n");
    const refused = await runCli(["mcp", "install", "zed", "--local", "--with-credentials", "--yes"], { env });
    expect(refused.code).toBe(2);
    expect(refused.out + refused.err).not.toContain(secret);
    expect(refused.out).toContain("YOUR_AUTH_TOKEN");

    const real = await runCli(["mcp", "install", "claude", "--local", "--with-credentials", "--yes"], { env });
    expect(real.code).toBe(0);
    expect(real.out + real.err).not.toContain(secret);
    const written = CLIENT_SPECS.claude.path({ env, platform: process.platform, cwd: HOME, project: false, mode: "local" })!;
    expect(readJson(written).mcpServers.vobiz.env.VOBIZ_AUTH_TOKEN).toBe(secret);
  });

  it.each([
    [["mcp", "install", "cursor", "--with-credentials"], "needs --local"],
    [["mcp", "install", "codex", "--project"], "no project-level config"],
    [["mcp", "install", "notepad"], 'Unknown client "notepad"'],
    [["mcp", "install", "cursor", "--name", "a b"], "--name"],
  ])("usage error %j", async (argv, message) => {
    const r = await runCli(argv, { env: { HOME: tempHome() }, stdoutTTY: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });

  it("--hosted and --local conflict", async () => {
    const r = await runCli(["mcp", "install", "cursor", "--hosted", "--local"], { env: { HOME: tempHome() } });
    expect(r.code).toBe(2);
  });
});

describe("mcp config", () => {
  it("prints the snippet without credentials, logged out", async () => {
    const r = await runCli(["mcp", "config", "cursor", "--local"], { env: { HOME: tempHome() }, loggedOut: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).mcpServers.vobiz.env).toEqual({ VOBIZ_AUTH_ID: "${env:VOBIZ_AUTH_ID}", VOBIZ_AUTH_TOKEN: "${env:VOBIZ_AUTH_TOKEN}" });
    expect(r.err).toContain(".cursor");
  });

  it("prints TOML for codex", async () => {
    const r = await runCli(["mcp", "config", "codex"], { env: { HOME: tempHome() } });
    expect(r.out).toBe('[mcp_servers.vobiz]\nurl = "https://mcp.vobiz.ai/mcp"\n');
  });
});

describe("client config paths", () => {
  const env = { HOME: "/home/u", USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming" };
  it.each([
    ["claude", "darwin", "/home/u/Library/Application Support/Claude/claude_desktop_config.json"],
    ["claude", "linux", "/home/u/.config/Claude/claude_desktop_config.json"],
    ["vscode", "darwin", "/home/u/Library/Application Support/Code/User/mcp.json"],
    ["vscode", "linux", "/home/u/.config/Code/User/mcp.json"],
    ["zed", "linux", "/home/u/.config/zed/settings.json"],
    ["codex", "linux", "/home/u/.codex/config.toml"],
  ] as const)("%s on %s", (client, platform, expected) => {
    if (process.platform === "win32") return;
    expect(CLIENT_SPECS[client].path({ env, platform, cwd: "/p", project: false, mode: "local" })).toBe(expected);
  });
});

describe("mcp install path safety", () => {
  const posix = process.platform !== "win32";

  it.runIf(posix)("refuses a symlinked config and never reads or replaces it", async () => {
    const HOME = tempHome();
    const proj = mkdtempSync(join(tmpdir(), "vobiz-proj-"));
    const home = join(HOME, ".claude.json");
    writeFileSync(home, JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: "secret-home-token" } } } }));
    symlinkSync(home, join(proj, ".mcp.json"));
    const r = await runCli(["mcp", "install", "claude-code", "--project", "--dir", proj, "--yes"], { env: { HOME } });
    expect(r.code).toBe(2);
    expect(r.err).toContain("symbolic link");
    expect(lstatSync(join(proj, ".mcp.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(proj, ".mcp.json.bak"))).toBe(false);
  });

  it.runIf(posix)("refuses a symlinked .bak, so a planted link cannot overwrite another file", async () => {
    const HOME = tempHome();
    const proj = mkdtempSync(join(tmpdir(), "vobiz-proj-"));
    const victim = join(HOME, "victim.json");
    writeFileSync(victim, '{"mine":true}');
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh" } } }));
    symlinkSync(victim, join(proj, ".mcp.json.bak"));
    const r = await runCli(["mcp", "install", "claude-code", "--project", "--dir", proj, "--yes"], { env: { HOME } });
    expect(r.code).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe('{"mine":true}');
  });

  it.runIf(posix)("--project refuses a config folder that is a symlink out of the project", async () => {
    const HOME = tempHome();
    const proj = mkdtempSync(join(tmpdir(), "vobiz-proj-"));
    mkdirSync(join(HOME, ".cursor"));
    symlinkSync(join(HOME, ".cursor"), join(proj, ".cursor"));
    const r = await runCli(["mcp", "install", "cursor", "--project", "--dir", proj, "--yes"], { env: { HOME } });
    expect(r.code).toBe(2);
    expect(r.err).toContain("outside the project directory");
    expect(existsSync(join(HOME, ".cursor", "mcp.json"))).toBe(false);
  });

  it("aborts when the file changes while the confirmation waits", async () => {
    const HOME = tempHome();
    const file = join(HOME, ".claude.json");
    writeFileSync(file, JSON.stringify({ numStartups: 1 }));
    const prompts = {
      async confirm() {
        writeFileSync(file, JSON.stringify({ numStartups: 2 }));
        return true;
      },
      async input() {
        return "";
      },
      async password() {
        return "";
      },
    };
    const r = await runCli(["mcp", "install", "claude-code"], { env: { HOME }, stdinTTY: true, stdoutTTY: true, stderrTTY: true, prompts });
    expect(r.code).toBe(2);
    expect(r.err).toContain("changed while waiting");
    expect(readJson(file)).toEqual({ numStartups: 2 });
  });

  it("leaves no temp files behind and writes a regular .bak", async () => {
    const HOME = tempHome();
    const file = join(HOME, ".claude.json");
    writeFileSync(file, "{}");
    expect((await runCli(["mcp", "install", "claude-code", "--yes"], { env: { HOME } })).code).toBe(0);
    expect(readdirSync(HOME).filter((f) => f.includes(".tmp") || f.includes(".part"))).toEqual([]);
    expect(lstatSync(`${file}.bak`).isFile()).toBe(true);
  });

  it("rejects prototype names for --name", async () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const r = await runCli(["mcp", "install", "cursor", "--name", name, "--yes"], { env: { HOME: tempHome() } });
      expect(r.code).toBe(2);
    }
  });

  it("mergeToml treats a quoted-key header as the same table", () => {
    const r = mergeToml('model = "x"\n\n[mcp_servers."vobiz"]\nurl = "https://old"\n', "mcp_servers", "vobiz", { url: "https://mcp.vobiz.ai/mcp" });
    expect(r.status).toBe("replaced");
    expect(r.text).toBe('model = "x"\n\n[mcp_servers.vobiz]\nurl = "https://mcp.vobiz.ai/mcp"\n');
    expect(tomlKeyPath(`mcp_servers.'vobiz'.env`)).toEqual(["mcp_servers", "vobiz", "env"]);
  });

  it("mergeToml refuses a file with multi-line strings instead of corrupting it", async () => {
    expect(() => mergeToml('prompt = """\n[mcp_servers.vobiz]\n"""\nmodel = "x"\n', "mcp_servers", "vobiz", { url: "u" })).toThrow(/multi-line/);
    const HOME = tempHome();
    mkdirSync(join(HOME, ".codex"));
    const file = join(HOME, ".codex", "config.toml");
    const original = 'prompt = """\n[mcp_servers.vobiz]\n"""\nmodel = "x"\n';
    writeFileSync(file, original);
    const r = await runCli(["mcp", "install", "codex", "--yes"], { env: { HOME } });
    expect(r.code).toBe(2);
    expect(r.out).toContain("[mcp_servers.vobiz]");
    expect(readFileSync(file, "utf8")).toBe(original);
  });
});
