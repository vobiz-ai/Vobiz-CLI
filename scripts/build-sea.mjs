#!/usr/bin/env node
// Builds a Node.js single executable application (SEA) of the Vobiz CLI for the platform this script runs on.
//
//   npm run build && node scripts/build-sea.mjs [--out bin] [--no-smoke] [--keep]
//
// Output (in --out, default bin/):
//   vobiz-<version>-<os>-<arch>[.exe]          the standalone binary (os: darwin | linux | win, arch: x64 | arm64)
//   vobiz-<version>-<os>-<arch>.tar.gz | .zip  archive with the binary as `vobiz[.exe]`, LICENSE, README, completions, man
//   SHA256SUMS                                 sha256 of every archive in --out (sha256sum format)
//
// Steps (https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html):
//   1. Stage dist/ and replace the package.json require in dist/core/version.js with an inline literal: inside a SEA,
//      `require` reaches only built-in modules and there is no package.json beside the binary.
//   2. Bundle to one CommonJS file with esbuild (Node 22/24 SEAs run a CommonJS main script). esbuild runs through
//      `npx -y esbuild@<pinned>` so it is never a dependency of the package.
//   3. `node --experimental-sea-config` writes the preparation blob. package.json and spec/*.yaml (and skills/** when
//      present) are embedded as SEA assets, readable with require("node:sea").getAsset(key).
//   4. Copy this node binary, strip its signature (macOS: codesign, Windows: signtool when available), inject the blob
//      with postject, and re-sign ad hoc on macOS (Apple Silicon refuses to run unsigned binaries).
//   5. Smoke-test `--version`, archive, and write SHA256SUMS.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ESBUILD_VERSION = "0.28.2";
const POSTJECT_VERSION = "1.0.0-alpha.6";
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const outDir = resolve(root, option("--out", "bin"));
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const osName = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform];
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (!osName || !arch) fail(`unsupported platform ${process.platform}-${process.arch}`);

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 9)) fail(`Node ${process.versions.node} is too old; SEA builds need Node 22.9+`);

const entry = join(root, "dist", "index.js");
if (!existsSync(entry)) fail("dist/index.js is missing: run `npm run build` first");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const name = `vobiz-${version}-${osName}-${arch}`;
const binary = join(outDir, name + (isWin ? ".exe" : ""));
const stage = join(outDir, ".sea-build");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. Stage dist/ and inline the package.json the version module requires.
log(`staging dist/ for ${name}`);
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
const versionFile = join(stage, "dist", "core", "version.js");
if (existsSync(versionFile)) {
  const src = readFileSync(versionFile, "utf8");
  const pattern = /require\(\s*["'](?:\.\.\/)+package\.json["']\s*\)/g;
  if (!pattern.test(src)) {
    fail("dist/core/version.js no longer requires ../../package.json; update the inlining step in scripts/build-sea.mjs");
  }
  const literal = JSON.stringify({ name: pkg.name, version: pkg.version });
  writeFileSync(versionFile, src.replace(pattern, `(${literal})`));
}

// 2. Bundle to a single CommonJS script.
const bundle = join(stage, "vobiz.cjs");
log(`bundling with esbuild ${ESBUILD_VERSION}`);
npx(`esbuild@${ESBUILD_VERSION}`, [
  join(stage, "dist", "index.js"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  `--outfile=${bundle}`,
  "--legal-comments=none",
  "--log-level=warning",
  // CommonJS has no import.meta; point import.meta.url at the executable so createRequire()/URL math still works.
  "--define:import.meta.url=__vobiz_import_meta_url",
  "--banner:js=const __vobiz_import_meta_url = require(\"node:url\").pathToFileURL(__filename).href;",
]);

// 3. SEA configuration and preparation blob.
const assets = { "package.json": join(root, "package.json") };
for (const f of listFiles(join(root, "spec"))) if (f.endsWith(".yaml")) assets[`spec/${relative(join(root, "spec"), f).split("\\").join("/")}`] = f;
for (const f of listFiles(join(root, "skills"))) assets[`skills/${relative(join(root, "skills"), f).split("\\").join("/")}`] = f;
const blob = join(stage, "sea-prep.blob");
const seaConfig = join(stage, "sea-config.json");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2),
);
log(`writing the SEA blob (${Object.keys(assets).length} assets)`);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 4. Copy node, strip the signature, inject, re-sign.
mkdirSync(outDir, { recursive: true });
rmSync(binary, { force: true });
copyFileSync(process.execPath, binary);
chmodSync(binary, 0o755);
if (isMac) {
  run("codesign", ["--remove-signature", binary]);
} else if (isWin) {
  if (hasCommand("signtool")) run("signtool", ["remove", "/s", binary]);
  else log("signtool not found: the copied node.exe signature is left in place (postject still works; the binary is unsigned)");
}
log(`injecting with postject ${POSTJECT_VERSION}`);
npx(`postject@${POSTJECT_VERSION}`, [
  binary, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SEA_FUSE, ...(isMac ? ["--macho-segment-name", "NODE_SEA"] : []),
]);
if (isMac) run("codesign", ["--sign", "-", binary]);

// 5. Smoke test, archive, checksums.
if (!flag("--no-smoke")) {
  const out = execFileSync(binary, ["--version"], { encoding: "utf8", env: { ...process.env, VOBIZ_NO_UPDATE_CHECK: "1" } }).trim();
  if (!out.includes(version)) fail(`smoke test: \`${name} --version\` printed "${out}", expected ${version}`);
  log(`smoke test ok: ${out}`);
}

const pack = join(stage, name);
mkdirSync(pack, { recursive: true });
copyFileSync(binary, join(pack, isWin ? "vobiz.exe" : "vobiz"));
chmodSync(join(pack, isWin ? "vobiz.exe" : "vobiz"), 0o755);
for (const f of ["LICENSE", "README.md", "CHANGELOG.md"]) if (existsSync(join(root, f))) copyFileSync(join(root, f), join(pack, f));
for (const d of ["completions", "man"]) if (existsSync(join(root, d))) cpSync(join(root, d), join(pack, d), { recursive: true });

const archive = join(outDir, name + (isWin ? ".zip" : ".tar.gz"));
rmSync(archive, { force: true });
// bsdtar (macOS, Windows 10+) and GNU tar both write .tar.gz; on Windows `tar -a` picks zip from the extension.
if (isWin) run("tar", ["-a", "-c", "-f", archive, "-C", stage, name]);
else run("tar", ["-czf", archive, "-C", stage, name]);

const sums = readdirSync(outDir)
  .filter((f) => /^vobiz-.*\.(tar\.gz|zip)$/.test(f))
  .sort()
  .map((f) => `${sha256(join(outDir, f))}  ${f}`);
writeFileSync(join(outDir, "SHA256SUMS"), sums.join("\n") + "\n");

if (!flag("--keep")) rmSync(stage, { recursive: true, force: true });
log(`done:\n  ${relative(root, binary)}\n  ${relative(root, archive)}\n  ${relative(root, join(outDir, "SHA256SUMS"))}`);

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}
function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function run(cmd, argv) {
  execFileSync(cmd, argv, { stdio: "inherit", cwd: root, shell: isWin && !cmd.includes("\\") && cmd !== process.execPath });
}
function npx(spec, argv) {
  const quoted = isWin ? argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : argv;
  execFileSync(isWin ? "npx.cmd" : "npx", ["-y", spec, ...quoted], { stdio: "inherit", cwd: root, shell: isWin });
}
function hasCommand(cmd) {
  try {
    execFileSync(isWin ? "where" : "which", [cmd], { stdio: "ignore", shell: isWin });
    return true;
  } catch {
    return false;
  }
}
function log(msg) {
  process.stderr.write(`build-sea: ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`build-sea: error: ${msg}\n`);
  process.exit(1);
}
