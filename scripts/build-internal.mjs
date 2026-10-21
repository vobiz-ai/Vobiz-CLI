#!/usr/bin/env node
// Internal build: compiles the CLI with the `vobiz internal …` group enabled (src/internal, present only in the
// private vobiz-ai/the internal repository repository). It sets INTERNAL_BUILD=true in src/generated/build-flags.ts,
// runs `npm run build`, and always restores the committed file (INTERNAL_BUILD=false) afterwards, so the working
// tree stays clean and a later plain `npm run build` is public again.
// Usage: npm run build:internal        (equivalent at runtime without rebuilding: VOBIZ_INTERNAL=1 vobiz …)
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flags = join(root, "src", "generated", "build-flags.ts");
if (!existsSync(join(root, "src", "internal", "commands", "index.ts"))) {
  console.error("build:internal: src/internal/ is missing (it exists only in the internal repository).");
  process.exit(1);
}
const original = readFileSync(flags, "utf8");
if (!/INTERNAL_BUILD: boolean = false;/.test(original)) {
  console.error("build:internal: src/generated/build-flags.ts does not have INTERNAL_BUILD = false; restore it with git checkout.");
  process.exit(1);
}
writeFileSync(flags, original.replace("INTERNAL_BUILD: boolean = false;", "INTERNAL_BUILD: boolean = true;"));
try {
  execSync("npm run build", { cwd: root, stdio: "inherit" });
  console.error("build:internal: dist/ includes the `vobiz internal` group (run `npm run build` to go back to the public build).");
} finally {
  writeFileSync(flags, original);
}
