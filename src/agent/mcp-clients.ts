/**
 * Where and how each MCP client stores its server list, for `vobiz mcp install|config`. File paths, shapes and
 * placeholder syntax follow the Vobiz MCP server's docs/INSTALL.md.
 *
 *   hosted  the Vobiz connector https://mcp.vobiz.ai/mcp; the client signs in with OAuth, no secret in the file
 *   local   `npx -y @vobiz/mcp` over stdio, with the Auth ID / Auth Token read from the environment where the
 *           client supports that (placeholders otherwise), or copied in with --with-credentials
 */
import { join } from "node:path";
import { VobizError } from "../core/errors.js";

export const HOSTED_URL = "https://mcp.vobiz.ai/mcp";
export const LOCAL_PACKAGE = "@vobiz/mcp";
export const PLACEHOLDER_ID = "MA_XXXXXXXX";
export const PLACEHOLDER_TOKEN = "YOUR_AUTH_TOKEN";

export const CLIENTS = ["claude", "claude-code", "cursor", "codex", "windsurf", "vscode", "gemini", "zed"] as const;
export type ClientId = (typeof CLIENTS)[number];
export type Mode = "hosted" | "local";

export interface Credentials {
  authId: string;
  authToken: string;
}

interface Env {
  [k: string]: string | undefined;
}

export interface ClientSpec {
  id: ClientId;
  title: string;
  format: "json" | "toml";
  /** Key that holds the server map (mcpServers, servers, context_servers, mcp_servers). */
  container: string;
  /** Whether --project (a config file in the current directory) is supported. */
  project: boolean;
  /** Config file path; undefined when the client has no such file for this mode (Claude hosted: UI only). */
  path(o: { env: Env; platform: NodeJS.Platform; cwd: string; project: boolean; mode: Mode }): string | undefined;
  /** The server entry for this mode. `creds` given means write them literally (--with-credentials). */
  entry(mode: Mode, creds?: Credentials): Record<string, unknown>;
  /** True when the local entry resolves credentials itself (env vars or a prompt), so no literal values are needed. */
  envAware: boolean;
  /** Extra top-level keys to merge (VS Code input prompts). */
  extra?(mode: Mode, creds?: Credentials): Record<string, unknown> | undefined;
  /** What to do after the file is written. */
  next(mode: Mode): string;
}

function home(env: Env, platform: NodeJS.Platform): string {
  const h = platform === "win32" ? (env.USERPROFILE ?? env.HOME) : env.HOME;
  if (!h) throw new VobizError("invalid_input", "Cannot find your home directory (HOME is not set).");
  return h;
}
const appData = (env: Env, platform: NodeJS.Platform) => env.APPDATA ?? join(home(env, platform), "AppData", "Roaming");
const xdgConfig = (env: Env, platform: NodeJS.Platform) => env.XDG_CONFIG_HOME ?? join(home(env, platform), ".config");

const npxArgs = () => ["-y", LOCAL_PACKAGE];
const envBlock = (creds: Credentials | undefined, id: string, token: string) =>
  creds ? { VOBIZ_AUTH_ID: creds.authId, VOBIZ_AUTH_TOKEN: creds.authToken } : { VOBIZ_AUTH_ID: id, VOBIZ_AUTH_TOKEN: token };

export const CLIENT_SPECS: Record<ClientId, ClientSpec> = {
  claude: {
    id: "claude",
    title: "Claude Desktop",
    format: "json",
    container: "mcpServers",
    project: false,
    envAware: false,
    path: ({ env, platform, mode }) => {
      if (mode === "hosted") return undefined;
      if (platform === "darwin") return join(home(env, platform), "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") return join(appData(env, platform), "Claude", "claude_desktop_config.json");
      return join(xdgConfig(env, platform), "Claude", "claude_desktop_config.json");
    },
    entry: (_mode, creds) => ({ command: "npx", args: npxArgs(), env: envBlock(creds, PLACEHOLDER_ID, PLACEHOLDER_TOKEN) }),
    next: (mode) =>
      mode === "hosted"
        ? `In claude.ai or Claude Desktop open Settings → Connectors → Add custom connector, name it Vobiz, enter ${HOSTED_URL}, click Add, then Connect and sign in with your Auth ID and Auth Token.`
        : "Quit Claude Desktop completely and reopen it.",
  },
  "claude-code": {
    id: "claude-code",
    title: "Claude Code",
    format: "json",
    container: "mcpServers",
    project: true,
    envAware: true,
    path: ({ env, platform, cwd, project }) => (project ? join(cwd, ".mcp.json") : join(home(env, platform), ".claude.json")),
    entry: (mode, creds) =>
      mode === "hosted"
        ? { type: "http", url: HOSTED_URL }
        : { type: "stdio", command: "npx", args: npxArgs(), env: envBlock(creds, "${VOBIZ_AUTH_ID}", "${VOBIZ_AUTH_TOKEN}") },
    next: (mode) => (mode === "hosted" ? "In Claude Code run /mcp, pick vobiz and sign in." : "Export VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in your shell, then start Claude Code."),
  },
  cursor: {
    id: "cursor",
    title: "Cursor",
    format: "json",
    container: "mcpServers",
    project: true,
    envAware: true,
    path: ({ env, platform, cwd, project }) => join(project ? cwd : home(env, platform), ".cursor", "mcp.json"),
    entry: (mode, creds) =>
      mode === "hosted"
        ? { url: HOSTED_URL }
        : { type: "stdio", command: "npx", args: npxArgs(), env: envBlock(creds, "${env:VOBIZ_AUTH_ID}", "${env:VOBIZ_AUTH_TOKEN}") },
    next: (mode) => (mode === "hosted" ? "Open Cursor Settings → MCP and click Connect next to vobiz." : "Export VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN, then restart Cursor."),
  },
  codex: {
    id: "codex",
    title: "OpenAI Codex",
    format: "toml",
    container: "mcp_servers",
    project: false,
    envAware: true,
    path: ({ env, platform }) => join(env.CODEX_HOME ?? join(home(env, platform), ".codex"), "config.toml"),
    entry: (mode, creds) =>
      mode === "hosted"
        ? { url: HOSTED_URL }
        : creds
          ? { command: "npx", args: npxArgs(), env: envBlock(creds, "", "") }
          : { command: "npx", args: npxArgs(), env_vars: ["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN"] },
    next: (mode) => (mode === "hosted" ? "Run `codex mcp login vobiz` to sign in." : "Export VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN; Codex forwards them to the server."),
  },
  windsurf: {
    id: "windsurf",
    title: "Windsurf / Devin Desktop",
    format: "json",
    container: "mcpServers",
    project: false,
    envAware: true,
    path: ({ env, platform }) => (platform === "win32" ? join(appData(env, platform), "devin", "mcp_config.json") : join(home(env, platform), ".config", "devin", "mcp_config.json")),
    entry: (mode, creds) =>
      mode === "hosted"
        ? { serverUrl: HOSTED_URL }
        : { command: "npx", args: npxArgs(), env: envBlock(creds, "${env:VOBIZ_AUTH_ID}", "${env:VOBIZ_AUTH_TOKEN}") },
    next: (mode) => (mode === "hosted" ? "Restart Windsurf and sign in when vobiz asks (or run `devin mcp login vobiz`)." : "Export VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN, then restart Windsurf."),
  },
  vscode: {
    id: "vscode",
    title: "VS Code / GitHub Copilot",
    format: "json",
    container: "servers",
    project: true,
    envAware: true,
    path: ({ env, platform, cwd, project }) => {
      if (project) return join(cwd, ".vscode", "mcp.json");
      if (platform === "darwin") return join(home(env, platform), "Library", "Application Support", "Code", "User", "mcp.json");
      if (platform === "win32") return join(appData(env, platform), "Code", "User", "mcp.json");
      return join(xdgConfig(env, platform), "Code", "User", "mcp.json");
    },
    entry: (mode, creds) =>
      mode === "hosted"
        ? { type: "http", url: HOSTED_URL }
        : { type: "stdio", command: "npx", args: npxArgs(), env: envBlock(creds, "${input:vobiz-auth-id}", "${input:vobiz-auth-token}") },
    extra: (mode, creds) =>
      mode === "local" && !creds
        ? {
            inputs: [
              { type: "promptString", id: "vobiz-auth-id", description: "Vobiz Auth ID" },
              { type: "promptString", id: "vobiz-auth-token", description: "Vobiz Auth Token", password: true },
            ],
          }
        : undefined,
    next: (mode) => (mode === "hosted" ? "In VS Code open the MCP servers view, start vobiz and sign in." : "Start vobiz from the MCP servers view; VS Code asks for your Auth ID and Auth Token once and stores them securely."),
  },
  gemini: {
    id: "gemini",
    title: "Gemini CLI",
    format: "json",
    container: "mcpServers",
    project: true,
    envAware: true,
    path: ({ env, platform, cwd, project }) => join(project ? cwd : home(env, platform), ".gemini", "settings.json"),
    entry: (mode, creds) =>
      mode === "hosted" ? { httpUrl: HOSTED_URL } : { command: "npx", args: npxArgs(), env: envBlock(creds, "${VOBIZ_AUTH_ID}", "${VOBIZ_AUTH_TOKEN}") },
    next: (mode) => (mode === "hosted" ? "In Gemini CLI run /mcp auth vobiz." : "Export VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN, then start Gemini CLI."),
  },
  zed: {
    id: "zed",
    title: "Zed",
    format: "json",
    container: "context_servers",
    project: false,
    envAware: false,
    path: ({ env, platform }) => (platform === "win32" ? join(appData(env, platform), "Zed", "settings.json") : join(xdgConfig(env, platform), "zed", "settings.json")),
    entry: (mode, creds) => (mode === "hosted" ? { url: HOSTED_URL } : { command: "npx", args: npxArgs(), env: envBlock(creds, PLACEHOLDER_ID, PLACEHOLDER_TOKEN) }),
    next: (mode) => (mode === "hosted" ? "Zed starts the OAuth sign-in for vobiz the next time it loads the server." : "Zed reloads settings automatically."),
  },
};

export function clientSpec(id: string): ClientSpec {
  const spec = (CLIENT_SPECS as Record<string, ClientSpec>)[id];
  if (!spec) throw new VobizError("invalid_input", `Unknown client "${id}". Use one of: ${CLIENTS.join(", ")}.`);
  return spec;
}

/** The fragment a client needs: { <container>: { <name>: entry }, ...extra }. */
export function fragment(spec: ClientSpec, mode: Mode, name: string, creds?: Credentials): Record<string, unknown> {
  return { ...(spec.extra?.(mode, creds) ?? {}), [spec.container]: { [name]: spec.entry(mode, creds) } };
}

// ─────────────────────────────── JSON merge ───────────────────────────────

/** Removes // and /* *\/ comments and trailing commas outside strings (JSONC, as used by VS Code and Zed). */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export type MergeResult = { status: "unchanged" | "added" | "replaced"; text: string };

/**
 * Merges a fragment into an existing JSON config, keeping every other key. Throws invalid_input when the file is
 * not JSON, or has comments (rewriting would lose them), so the caller can print the snippet instead.
 */
export function mergeJson(existing: string | undefined, frag: Record<string, unknown>, file: string): MergeResult {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim()) {
    try {
      doc = JSON.parse(existing);
    } catch {
      let jsonc = false;
      try {
        JSON.parse(stripJsonc(existing));
        jsonc = true;
      } catch {
        // not JSONC either
      }
      throw new VobizError(
        "invalid_input",
        jsonc
          ? `${file} has comments that rewriting it would lose, so it was not changed. Add the snippet below by hand.`
          : `${file} is not valid JSON, so it was not changed. Add the snippet below by hand.`,
      );
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new VobizError("invalid_input", `${file} does not hold a JSON object, so it was not changed.`);
  }
  let changed = false;
  let replaced = false;
  for (const [key, value] of Object.entries(frag)) {
    if (key === "inputs" && Array.isArray(value)) {
      const list = Array.isArray(doc.inputs) ? [...(doc.inputs as { id?: string }[])] : [];
      for (const input of value as { id: string }[]) {
        if (!list.some((x) => x?.id === input.id)) {
          list.push(input);
          changed = true;
        }
      }
      doc.inputs = list;
      continue;
    }
    const servers = (doc[key] && typeof doc[key] === "object" && !Array.isArray(doc[key]) ? doc[key] : {}) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      if (Object.hasOwn(servers, name)) {
        if (JSON.stringify(servers[name]) === JSON.stringify(entry)) continue;
        replaced = true;
      }
      servers[name] = entry;
      changed = true;
    }
    doc[key] = servers;
  }
  if (!changed) return { status: "unchanged", text: existing ?? "" };
  return { status: replaced ? "replaced" : "added", text: JSON.stringify(doc, null, 2) + "\n" };
}

// ─────────────────────────────── TOML (Codex) ───────────────────────────────

const tomlValue = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`cannot write ${typeof v} to TOML`);
};
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

/** Renders `[container.name]` with scalar/array keys and nested tables as `[container.name.sub]`. */
export function tomlTable(container: string, name: string, entry: Record<string, unknown>): string {
  const head = `${container}.${tomlKey(name)}`;
  const lines = [`[${head}]`];
  const subs: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      subs.push(`\n[${head}.${tomlKey(k)}]`, ...Object.entries(v as Record<string, unknown>).map(([sk, sv]) => `${tomlKey(sk)} = ${tomlValue(sv)}`));
    } else lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  return [...lines, ...subs].join("\n") + "\n";
}

/**
 * Splits a TOML table header (`mcp_servers."vobiz".env`) into its keys, unquoting basic ("…") and literal ('…')
 * keys, so a quoted header names the same table as a bare one. Returns undefined for a header it cannot read.
 */
export function tomlKeyPath(header: string): string[] | undefined {
  const keys: string[] = [];
  let i = 0;
  const src = header.trim();
  const ws = () => {
    while (src[i] === " " || src[i] === "\t") i++;
  };
  for (;;) {
    ws();
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return undefined;
      try {
        keys.push(JSON.parse(src.slice(i, j + 1)) as string);
      } catch {
        return undefined;
      }
      i = j + 1;
    } else if (src[i] === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return undefined;
      keys.push(src.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
      if (!m) return undefined;
      keys.push(m[0]);
      i += m[0].length;
    }
    ws();
    if (i >= src.length) return keys;
    if (src[i] !== ".") return undefined;
    i++;
  }
}

/** Replaces (or appends) the `[container.name]` table and its sub-tables in a TOML file, leaving the rest as is. */
export function mergeToml(existing: string | undefined, container: string, name: string, entry: Record<string, unknown>): MergeResult {
  const table = tomlTable(container, name, entry);
  const text = existing ?? "";
  if (/"""|'''/.test(text))
    throw new VobizError("invalid_input", "The Codex config uses multi-line strings, which this merge cannot edit safely, so it was not changed. Add the snippet below by hand.");
  const isOurs = (line: string) => {
    const m = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (!m) return undefined;
    const keys = tomlKeyPath(m[1]);
    if (!keys) throw new VobizError("invalid_input", `Cannot read the TOML table header "${line.trim()}", so the Codex config was not changed. Add the snippet below by hand.`);
    return keys.length >= 2 && keys[0] === container && keys[1] === name;
  };
  const lines = text.split("\n");
  const kept: string[] = [];
  const removed: string[] = [];
  let inOurs = false;
  for (const line of lines) {
    const header = isOurs(line);
    if (header !== undefined) inOurs = header;
    (inOurs ? removed : kept).push(line);
  }
  if (removed.length) {
    const before = removed.join("\n").trim();
    if (before === table.trim()) return { status: "unchanged", text };
  }
  let body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  body = body ? body + "\n\n" + table : table;
  return { status: removed.length ? "replaced" : "added", text: body };
}
