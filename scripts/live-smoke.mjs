#!/usr/bin/env node
// Read-only smoke test against a REAL Vobiz account. Run with `npm run test:live` (node --env-file=.env).
// It never places calls, sends messages, buys numbers or changes anything: only GET requests.
// Output is pass/fail per check; response bodies are never printed, and the run fails if the Auth Token
// (or any value of a secret field) shows up anywhere in the CLI's stdout or stderr.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "dist", "index.js");
const token = process.env.VOBIZ_AUTH_TOKEN;
if (!process.env.VOBIZ_AUTH_ID || !token || token === "YOUR_AUTH_TOKEN") {
  console.error("live-smoke: set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in .env (see .env.example).");
  process.exit(2);
}

// A throwaway config dir so a saved profile on this machine never interferes, and no update check.
const configDir = mkdtempSync(join(tmpdir(), "vobiz-live-"));
const env = { ...process.env, VOBIZ_CONFIG_DIR: configDir, VOBIZ_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };

const checks = [
  { name: "whoami --check", args: ["whoami", "--check", "--output", "json"], expect: (j) => j.verified === true && j.source === "env" },
  { name: "api GET /api/v1/auth/me", args: ["api", "GET", "/api/v1/auth/me", "--output", "json"], expect: (j) => typeof j.auth_id === "string" && (j.auth_secret === undefined || j.auth_secret === "[redacted]") },
  { name: "api --list", args: ["api", "--list", "--output", "json"], expect: (j) => Array.isArray(j) && j.length > 100 },
  { name: "doctor", args: ["doctor", "--output", "json"], expect: (j) => Array.isArray(j) && !j.some((c) => c.status === "fail") },
];

let failed = 0;
for (const c of checks) {
  const r = spawnSync(process.execPath, [bin, ...c.args], { env, encoding: "utf8", timeout: 60_000 });
  const all = `${r.stdout}\n${r.stderr}`;
  let ok = r.status === 0;
  let why = ok ? "" : `exit ${r.status}`;
  if (all.includes(token)) {
    ok = false;
    why = "the Auth Token appeared in the output";
  } else if (ok) {
    try {
      if (!c.expect(JSON.parse(r.stdout))) {
        ok = false;
        why = "unexpected output shape";
      }
    } catch {
      ok = false;
      why = "stdout is not JSON";
    }
  }
  if (!ok) failed++;
  // Only the first stderr line on failure: it is the CLI's own error message, which never contains secrets.
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}${why ? ` (${why}${!ok && r.stderr ? `: ${r.stderr.split("\n")[0].replaceAll(token, "[redacted]")}` : ""})` : ""}`);
}
rmSync(configDir, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : "all live checks passed");
process.exit(failed ? 1 : 0);
