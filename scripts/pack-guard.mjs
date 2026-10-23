#!/usr/bin/env node
// Runs before `npm pack` / `npm publish` (prepack, prepublishOnly). It only checks; it builds nothing and loads no
// dev dependency, so a publish job never runs the test toolchain with its OIDC token (the full `npm run check`
// runs in the unprivileged CI/verify jobs).
//   1. dist/index.js exists (`npm run build` ran).
//   2. No dist/internal/** file would be packed: a maintainer build may compile src/internal, and the
//      `vobiz internal …` group must never ship. package.json `files` excludes it; this re-checks the real pack list.
//   3. The documents every package must carry (README, CHANGELOG, LICENSE) are in the pack list.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  process.stderr.write(`pack-guard: ${msg}\n`);
  process.exit(1);
};

if (!existsSync(join(root, "dist", "index.js"))) fail("dist/index.js is missing: run `npm run build` first.");

const isWin = process.platform === "win32";
// --ignore-scripts: listing the pack contents must not re-run prepack (and this script) recursively.
const out = execFileSync(isWin ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: isWin, stdio: ["ignore", "pipe", "pipe"] });
const files = JSON.parse(out)[0]?.files?.map((f) => f.path) ?? [];
if (!files.length) fail("npm pack --dry-run listed no files.");
const internal = files.filter((p) => p.startsWith("dist/internal/") || p.startsWith("src/"));
if (internal.length) fail(`refusing to pack internal files:\n  ${internal.join("\n  ")}\nKeep "!dist/internal/**" in package.json "files".`);
if (files.some((p) => /(^|\/)\.env(\.|$)/.test(p))) fail("refusing to pack a .env file.");
const missing = ["README.md", "CHANGELOG.md", "LICENSE", "dist/index.js"].filter((p) => !files.includes(p));
if (missing.length) fail(`the package would not include ${missing.join(", ")}; add it to package.json "files".`);
process.stderr.write(`pack-guard: ok (${files.length} files, no dist/internal)\n`);
