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
// The download uses the `tar` that ships with macOS, Linux and Windows 10+. Downloaded content is untrusted: the
// HTTP status, content type and size are checked, a tag must resolve to the same commit through the refs API and the
// commits API, the archive's top folder must carry that SHA, every archive member is listed and vetted before
// extraction, and every write is checked to land inside skills/.
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
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Throws unless `p` resolves inside `dir` (a write target must never escape it). */
function inside(dir, p) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to write outside ${dir}: ${p}`);
  return p;
}

/** The response body as bytes, refusing a non-2xx status, an unexpected content type or more than `max` bytes. */
async function readCapped(res, url, max, types) {
  if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!types.includes(type)) throw new Error(`GET ${url} answered content type "${type}", expected ${types.join(" or ")}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new Error(`GET ${url} is ${declared} bytes, over the ${max}-byte limit`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > max) throw new Error(`GET ${url} is over the ${max}-byte limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
const apiHeaders = { "User-Agent": "vobiz-cli-sync-skills", Accept: "application/vnd.github+json" };

async function api(pathname) {
  const url = `${API}${pathname}`;
  const res = await fetch(url, { headers: apiHeaders });
  return JSON.parse((await readCapped(res, url, 5 * 1024 * 1024, ["application/json"])).toString("utf8"));
}

/** The latest release tag (default), then the commit SHA the ref points at. */
async function resolveRef(ref) {
  const name = ref ?? (await api("/releases/latest")).tag_name;
  if (!name) throw new Error("could not find the latest release; pass --ref <tag>");
  const sha = (await api(`/commits/${encodeURIComponent(name)}`)).sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`could not resolve ${name} to a commit`);
  // A tag is verified a second way: the refs API (dereferencing an annotated tag) must name the same commit.
  const tagRef = await fetch(`${API}/git/ref/tags/${encodeURIComponent(name)}`, { headers: apiHeaders });
  if (tagRef.status === 404) {
    if (!ref) throw new Error(`the latest release ${name} has no tag`);
    console.warn(`sync-skills: ${name} is not a tag; syncing branch ${name} at ${sha}`);
  } else {
    let obj = JSON.parse((await readCapped(tagRef, `${API}/git/ref/tags/${name}`, 1024 * 1024, ["application/json"])).toString("utf8")).object;
    for (let hops = 0; obj?.type === "tag" && hops < 5; hops++) obj = (await api(`/git/tags/${obj.sha}`)).object;
    if (obj?.type !== "commit" || obj.sha !== sha) throw new Error(`tag ${name} points at ${obj?.sha ?? "nothing"}, but the commits API answered ${sha}; refusing to sync`);
  }
  return { name, sha };
}

async function download(ref) {
  const { name, sha } = await resolveRef(ref);
  const url = `https://codeload.github.com/${REPO}/tar.gz/${sha}`;
  const res = await fetch(url, { headers: { "User-Agent": "vobiz-cli-sync-skills" } });
  const archive = await readCapped(res, url, MAX_ARCHIVE_BYTES, ["application/x-gzip", "application/gzip"]);
  const dir = mkdtempSync(path.join(tmpdir(), "vobiz-skills-"));
  const file = inside(dir, path.join(dir, "repo.tar.gz"));
  // The archive is written into a fresh private temp folder only, and vetted below before anything is extracted.
  writeFileSync(file, archive, { flag: "wx", mode: 0o600 });
  const expectedTop = `${REPO.split("/")[1]}-${sha}`;
  const members = execFileSync("tar", ["-tzvf", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
  for (const line of members) {
    // Only regular files and folders: a symlink (l), hard link (h) or device would escape or alias on extraction.
    if (!/^[-d]/.test(line)) throw new Error(`the archive contains a link or special file: ${line}`);
  }
  for (const name of execFileSync("tar", ["-tzf", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || name.split("/")[0] !== expectedTop) throw new Error(`unexpected archive member: ${name}`);
  }
  execFileSync("tar", ["-xzf", file, "-C", dir]);
  const top = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory());
  if (!top) throw new Error("the downloaded archive is empty");
  if (top.name !== expectedTop) throw new Error(`the archive is for ${top.name}, expected ${expectedTop}`);
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
/** Copies a skill folder under `base`, refusing symlinks, special files, oversized files and any path outside `base`. */
let copiedBytes = 0;
function copyTree(src, dst, base) {
  mkdirSync(inside(base, dst), { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry);
    const st = lstatSync(s);
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw new Error(`${s}: symlinks and special files are not allowed in skills`);
    if (st.isDirectory()) copyTree(s, path.join(dst, entry), base);
    else {
      if (st.size > MAX_FILE_BYTES) throw new Error(`${s}: ${st.size} bytes is over the ${MAX_FILE_BYTES}-byte limit for a skill file`);
      copiedBytes += st.size;
      if (copiedBytes > MAX_TOTAL_BYTES) throw new Error(`the skills are over the ${MAX_TOTAL_BYTES}-byte limit in total`);
      copyFileSync(s, inside(base, path.join(dst, entry)));
    }
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
    for (const name of found) copyTree(path.join(source.src, name), path.join(staging, name), staging);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest);
    copiedBytes = 0;
    for (const name of found) copyTree(path.join(staging, name), path.join(dest, name), dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  found.sort();
  // Intended write: the index of the vetted skills, inside skills/.
  writeFileSync(
    inside(dest, path.join(dest, "README.md")),
    `# Bundled Vobiz Agent Skills\n\nCopied from the Vobiz MCP server repository (\`${REPO}\`, \`skills/\`) by \`npm run skills:sync\`, pinned to ${source.pin}. Do not edit here; edit the source and re-sync. \`vobiz skills install\` copies these into a project.\n\n${found.map((n) => `- \`${n}\``).join("\n")}\n`,
  );
  console.log(`synced ${found.length} skills from ${source.label}`);
} finally {
  source.cleanup();
}
