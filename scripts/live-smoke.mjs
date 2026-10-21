#!/usr/bin/env node
// Read-only smoke test against a REAL Vobiz account. Run with `npm run test:live` (node --env-file=.env).
// It never places calls, sends messages, buys numbers or changes anything: only GET requests.
// Output is pass/fail per check; response bodies are never printed, and the run fails if the Auth Token, or the
// value of any secret-named field of GET /api/v1/auth/me (auth_secret, ...; fetched once here, never printed),
// shows up anywhere in the CLI's stdout or stderr.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "dist", "index.js");
const token = process.env.VOBIZ_AUTH_TOKEN;
if (!process.env.VOBIZ_AUTH_ID || !token || token === "YOUR_AUTH_TOKEN") {
  console.error("live-smoke: set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in .env (see .env.example).");
  process.exit(2);
}

// A throwaway config dir so a saved profile on this machine never interferes, and no update check.
// Every secret value this run knows: the token, plus each secret-named field of /auth/me read straight from the API
// (with the CLI's own isSecretKey rule), so a leak of auth_secret under any key is caught too.
const { isSecretKey } = await import(pathToFileURL(join(root, "dist", "core", "redact.js")).href);
const secrets = new Set([token]);
try {
  const base = (process.env.VOBIZ_BASE_URL ?? "https://api.vobiz.ai").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/v1/auth/me`, { headers: { "X-Auth-ID": process.env.VOBIZ_AUTH_ID, "X-Auth-Token": token, Accept: "application/json" } });
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (isSecretKey(k) && typeof x === "string" && x.length >= 4 ? secrets.add(x) : walk(x));
  };
  if (res.ok) walk(await res.json());
  else console.log(`note: GET /api/v1/auth/me answered ${res.status}; checking the Auth Token value only`);
} catch {
  console.log("note: could not read /api/v1/auth/me directly; checking the Auth Token value only");
}
const redactAll = (text) => [...secrets].reduce((t, s) => t.replaceAll(s, "[redacted]"), text);

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
  if ([...secrets].some((s) => all.includes(s))) {
    ok = false;
    why = all.includes(token) ? "the Auth Token appeared in the output" : "a secret field value (e.g. auth_secret) appeared in the output";
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
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}${why ? ` (${why}${!ok && r.stderr ? `: ${redactAll(r.stderr.split("\n")[0])}` : ""})` : ""}`);
}
rmSync(configDir, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : "all live checks passed");
process.exit(failed ? 1 : 0);
