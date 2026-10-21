#!/usr/bin/env node
// Refreshes spec/ from the published Vobiz documentation (the same files Mintlify renders) and regenerates.
// Usage: node scripts/sync-spec.mjs [--from <path to the docs repo>]
import { copyFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--from");
const files = [["openapi.yaml", "spec/openapi-voice.yaml"], ["openapi-sms.yaml", "spec/openapi-sms.yaml"]];
if (i > 0) {
  for (const [src, dst] of files) copyFileSync(join(process.argv[i + 1], src), join(root, dst));
} else {
  for (const [src, dst] of files) {
    const res = await fetch(`https://www.vobiz.ai/docs/${src}`);
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
    writeFileSync(join(root, dst), await res.text());
  }
}
execSync("node scripts/gen-operations.mjs", { cwd: root, stdio: "inherit" });
