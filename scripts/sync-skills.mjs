#!/usr/bin/env node
// Refreshes skills/ (the Vobiz Agent Skills shipped in the npm package) from the Vobiz MCP server repository.
//
//   npm run skills:sync                         the latest release tag of vobiz-ai/Vobiz-MCP-Server
//   npm run skills:sync -- --ref v1.4.1         a tag (or, deliberately, a branch such as main)
//   npm run skills:sync -- --from ../Vobiz-MCP-Server/skills   a local checkout (a repo root or its skills/ folder)
//
// Every folder with a SKILL.md whose front matter `name` matches the folder is copied; the rest is ignored.
// The ref is resolved to a commit SHA first, that exact commit is downloaded, and the SHA is written into
// skills/README.md, so every sync is reproducible and reviewable. Symlinks and other non-regular files in the
// source are refused (they would otherwise be copied, then embedded in the SEA or installed into projects).
// The download uses the `tar` that ships with macOS, Linux and Windows 10+.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "vobiz-ai/Vobiz-MCP-Server";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "skills");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const API = `https://api.github.com/repos/${REPO}`;
const apiHeaders = { "User-Agent": "vobiz-cli-sync-skills", Accept: "application/vnd.github+json" };

async function api(pathname) {
  const res = await fetch(`${API}${pathname}`, { headers: apiHeaders });
  if (!res.ok) throw new Error(`GET ${API}${pathname} answered HTTP ${res.status}`);
  return res.json();
}

/** The latest release tag (default), then the commit SHA the ref points at. */
async function resolveRef(ref) {
  const name = ref ?? (await api("/releases/latest")).tag_name;
  if (!name) throw new Error("could not find the latest release; pass --ref <tag>");
  const sha = (await api(`/commits/${encodeURIComponent(name)}`)).sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`could not resolve ${name} to a commit`);
  return { name, sha };
}

async function download(ref) {
  const { name, sha } = await resolveRef(ref);
  const url = `https://codeload.github.com/${REPO}/tar.gz/${sha}`;
  const res = await fetch(url, { headers: { "User-Agent": "vobiz-cli-sync-skills" } });
  if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`);
  const dir = mkdtempSync(path.join(tmpdir(), "vobiz-skills-"));
  const file = path.join(dir, "repo.tar.gz");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xzf", file, "-C", dir]);
  const top = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory());
  if (!top) throw new Error("the downloaded archive is empty");
  return {
    src: path.join(dir, top.name, "skills"),
    label: `github.com/${REPO}@${name} (${sha})`,
    pin: `\`${name}\`, commit \`${sha}\``,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function local(from) {
  const p = path.resolve(from);
  const src = existsSync(path.join(p, "skills")) && !existsSync(path.join(p, "SKILL.md")) && !readdirSync(p).some((n) => existsSync(path.join(p, n, "SKILL.md"))) ? path.join(p, "skills") : p;
  return { src, label: path.relative(root, src) || src, pin: "a local checkout", cleanup: () => {} };
}

const from = arg("--from");
/** Copies a skill folder, refusing symlinks and special files anywhere inside it. */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry);
    const st = lstatSync(s);
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw new Error(`${s}: symlinks and special files are not allowed in skills`);
    if (st.isDirectory()) copyTree(s, path.join(dst, entry));
    else copyFileSync(s, path.join(dst, entry));
  }
}

const source = from ? local(from) : await download(arg("--ref"));
try {
  if (!existsSync(source.src)) throw new Error(`skills folder not found: ${source.src}`);
  const found = [];
  for (const dir of readdirSync(source.src, { withFileTypes: true })) {
    if (dir.isSymbolicLink()) throw new Error(`${path.join(source.src, dir.name)}: symlinks are not allowed in skills`);
    if (!dir.isDirectory()) continue;
    const file = path.join(source.src, dir.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const name = /^name:\s*(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error(`${file}: missing or invalid name`);
    if (name !== dir.name) throw new Error(`${file}: name "${name}" does not match its folder "${dir.name}"`);
    found.push(name);
  }
  if (!found.length) throw new Error(`no skills (folders with SKILL.md) in ${source.src}`);
  // Copy into a staging dir first, so a refused symlink leaves skills/ untouched.
  const staging = mkdtempSync(path.join(tmpdir(), "vobiz-skills-stage-"));
  try {
    for (const name of found) copyTree(path.join(source.src, name), path.join(staging, name));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest);
    for (const name of found) copyTree(path.join(staging, name), path.join(dest, name));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  found.sort();
  writeFileSync(
    path.join(dest, "README.md"),
    `# Bundled Vobiz Agent Skills\n\nCopied from the Vobiz MCP server repository (\`${REPO}\`, \`skills/\`) by \`npm run skills:sync\`, pinned to ${source.pin}. Do not edit here; edit the source and re-sync. \`vobiz skills install\` copies these into a project.\n\n${found.map((n) => `- \`${n}\``).join("\n")}\n`,
  );
  console.log(`synced ${found.length} skills from ${source.label}`);
} finally {
  source.cleanup();
}
