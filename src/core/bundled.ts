/**
 * Files shipped with the CLI (the Vobiz Agent Skills in skills/). From npm or a git checkout they sit next to
 * dist/; inside a single-executable binary (scripts/build-sea.mjs) they are SEA assets, which node:sea can read
 * one key at a time but not list, so the build embeds skills.manifest.json. In that case the assets are unpacked
 * once per CLI version into the user's cache dir and used from there, so the rest of the code only ever sees a folder.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_VERSION } from "./version.js";

const require = createRequire(import.meta.url);

interface Sea {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
  getAsset(key: string, encoding: "utf8"): string;
}

function sea(): Sea | undefined {
  try {
    const mod = require("node:sea") as Sea;
    return mod.isSea() ? mod : undefined;
  } catch {
    return undefined;
  }
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VOBIZ_CACHE_DIR) return env.VOBIZ_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "vobiz");
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "vobiz", "cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "vobiz");
  return join(homedir(), ".cache", "vobiz");
}

/** The skills/ folder: the package's own, or the unpacked SEA assets. */
export function bundledSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const s = sea();
  if (!s) return fileURLToPath(new URL("../../skills/", import.meta.url));
  const dir = join(cacheDir(env), `skills-${CLI_VERSION}`);
  if (existsSync(join(dir, ".complete"))) return dir;
  const keys = JSON.parse(s.getAsset("skills.manifest.json", "utf8")) as string[];
  const tmp = `${dir}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  for (const key of keys) {
    const target = join(tmp, key.slice("skills/".length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(s.getAsset(key)));
  }
  writeFileSync(join(tmp, ".complete"), new Date().toISOString());
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}
