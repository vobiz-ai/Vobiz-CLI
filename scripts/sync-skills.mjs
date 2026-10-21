#!/usr/bin/env node
// Refreshes skills/ (the Vobiz Agent Skills shipped in the npm package) from the Vobiz MCP server repository.
//
//   npm run skills:sync                         download vobiz-ai/Vobiz-MCP-Server@main from GitHub
//   npm run skills:sync -- --ref v1.4.1         a branch or tag instead of main
//   npm run skills:sync -- --from ../Vobiz-MCP-Server/skills   a local checkout (a repo root or its skills/ folder)
//
// Every folder with a SKILL.md whose front matter `name` matches the folder is copied; the rest is ignored.
// The download uses the `tar` that ships with macOS, Linux and Windows 10+.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function download(ref) {
  const url = `https://codeload.github.com/${REPO}/tar.gz/${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: { "User-Agent": "vobiz-cli-sync-skills" } });
  if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`);
  const dir = mkdtempSync(path.join(tmpdir(), "vobiz-skills-"));
  const file = path.join(dir, "repo.tar.gz");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xzf", file, "-C", dir]);
  const top = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory());
  if (!top) throw new Error("the downloaded archive is empty");
  return { src: path.join(dir, top.name, "skills"), label: `github.com/${REPO}@${ref}`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function local(from) {
  const p = path.resolve(from);
  const src = existsSync(path.join(p, "skills")) && !existsSync(path.join(p, "SKILL.md")) && !readdirSync(p).some((n) => existsSync(path.join(p, n, "SKILL.md"))) ? path.join(p, "skills") : p;
  return { src, label: path.relative(root, src) || src, cleanup: () => {} };
}

const from = arg("--from");
const source = from ? local(from) : await download(arg("--ref") ?? "main");
try {
  if (!existsSync(source.src)) throw new Error(`skills folder not found: ${source.src}`);
  const found = [];
  for (const dir of readdirSync(source.src, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(source.src, dir.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const name = /^name:\s*(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error(`${file}: missing or invalid name`);
    if (name !== dir.name) throw new Error(`${file}: name "${name}" does not match its folder "${dir.name}"`);
    found.push(name);
  }
  if (!found.length) throw new Error(`no skills (folders with SKILL.md) in ${source.src}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest);
  for (const name of found) cpSync(path.join(source.src, name), path.join(dest, name), { recursive: true });
  found.sort();
  writeFileSync(
    path.join(dest, "README.md"),
    `# Bundled Vobiz Agent Skills\n\nCopied from the Vobiz MCP server repository (\`${REPO}\`, \`skills/\`) by \`npm run skills:sync\`. Do not edit here; edit the source and re-sync. \`vobiz skills install\` copies these into a project.\n\n${found.map((n) => `- \`${n}\``).join("\n")}\n`,
  );
  console.log(`synced ${found.length} skills from ${source.label}`);
} finally {
  source.cleanup();
}
