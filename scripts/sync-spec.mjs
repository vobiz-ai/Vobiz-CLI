#!/usr/bin/env node
// Refreshes spec/ from the published Vobiz documentation (the same files Mintlify renders) and regenerates.
// Usage: node scripts/sync-spec.mjs [--from <path to the docs repo>]
// Downloaded content is untrusted: the HTTP status, content type and size are checked, the body must parse as an
// OpenAPI 3 document with paths, and it is written atomically to its fixed file under spec/ and nowhere else.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specDir = join(root, "spec");
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain", "application/octet-stream"];
const files = [["openapi.yaml", "openapi-voice.yaml"], ["openapi-sms.yaml", "openapi-sms.yaml"]];

/** Throws unless `p` resolves inside spec/. */
function inSpec(p) {
  const rel = relative(resolve(specDir), resolve(p));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing to write outside spec/: ${p}`);
  return p;
}

function validate(name, text) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`${name}: over the ${MAX_BYTES}-byte limit`);
  let doc;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`${name}: not valid YAML (${e.message})`);
  }
  if (!/^3\./.test(String(doc?.openapi ?? "")) || typeof doc.paths !== "object" || !doc.paths) throw new Error(`${name}: not an OpenAPI 3 document with paths`);
  return text;
}

async function download(src) {
  const url = `https://www.vobiz.ai/docs/${src}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`${src}: unexpected content type "${type}"`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error(`${src}: over the ${MAX_BYTES}-byte limit`);
  return validate(src, await res.text());
}

const i = process.argv.indexOf("--from");
for (const [src, dst] of files) {
  const text = i > 0 ? validate(src, readFileSync(join(process.argv[i + 1], src), "utf8")) : await download(src);
  const target = inSpec(join(specDir, dst));
  const tmp = inSpec(`${target}.tmp-${process.pid}`);
  // Intended write: a validated OpenAPI document replaces its vendored copy in spec/ (atomically, via rename).
  try {
    writeFileSync(tmp, text, { flag: "wx" });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}
execSync("node scripts/gen-operations.mjs", { cwd: root, stdio: "inherit" });
