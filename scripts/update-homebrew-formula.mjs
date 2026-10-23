#!/usr/bin/env node
// Fills the version, release URLs and sha256 values in the Homebrew formula and the Scoop manifest from a
// release's SHA256SUMS file. Used by release.yml; safe to run by hand.
//
//   node scripts/update-homebrew-formula.mjs --version 0.1.0 --sums dist-release/SHA256SUMS \
//     [--formula packaging/homebrew/vobiz.rb] [--scoop packaging/scoop/vobiz.json] [--only homebrew|scoop]
//     [--repo vobiz-ai/Vobiz-CLI]
//
// Every platform archive the files reference must be listed in SHA256SUMS, otherwise the script fails and
// writes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const version = (opt("--version", "") || "").replace(/^v/, "");
const sumsPath = opt("--sums", "");
const repo = opt("--repo", "vobiz-ai/Vobiz-CLI");
const only = opt("--only", "");
const formulaPath = resolve(root, opt("--formula", "packaging/homebrew/vobiz.rb"));
const scoopPath = resolve(root, opt("--scoop", "packaging/scoop/vobiz.json"));

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail("--version must be a semver version such as 0.1.0");
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail("--repo must be owner/name");
if (!sumsPath) fail("--sums <path to SHA256SUMS> is required");

const sums = new Map();
for (const line of readFileSync(resolve(sumsPath), "utf8").split(/\r?\n/)) {
  const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
  if (m) sums.set(m[2], m[1]);
}

const base = `https://github.com/${repo}/releases/download/v${version}`;
const asset = (target, ext) => `vobiz-${version}-${target}.${ext}`;
const hash = (file) => sums.get(file) ?? fail(`${file} is not listed in ${sumsPath}`);

const writes = [];

if (only !== "scoop") {
  let rb = readFileSync(formulaPath, "utf8");
  rb = rb.replace(/^(\s*version\s+)"[^"]*"/m, `$1"${version}"`);
  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    const file = asset(target, "tar.gz");
    const re = new RegExp(`(url\\s+)"[^"]*-${target}\\.tar\\.gz"(\\s*\\n\\s*sha256\\s+)"[^"]*"`);
    if (!re.test(rb)) fail(`${formulaPath}: no url/sha256 pair for ${target}`);
    rb = rb.replace(re, `$1"${base}/${file}"$2"${hash(file)}"`);
  }
  writes.push([formulaPath, rb]);
}

if (only !== "homebrew") {
  const manifest = JSON.parse(readFileSync(scoopPath, "utf8"));
  const file = asset("win-x64", "zip");
  manifest.version = version;
  manifest.architecture["64bit"].url = `${base}/${file}`;
  manifest.architecture["64bit"].hash = hash(file);
  manifest.architecture["64bit"].extract_dir = `vobiz-${version}-win-x64`;
  writes.push([scoopPath, JSON.stringify(manifest, null, 2) + "\n"]);
}

for (const [path, content] of writes) {
  writeFileSync(path, content);
  process.stderr.write(`updated ${path}\n`);
}

function fail(msg) {
  process.stderr.write(`update-homebrew-formula: error: ${msg}\n`);
  process.exit(1);
}
