/**
 * Review probe: runs every leaf command of the built CLI (dist/) in-process with a fake fetch, non-TTY stdin and
 * placeholder credentials, twice (without --yes, then with --dry-run --yes), and prints any command that sent a
 * write (non-GET request), leaked the fake Auth Token to stdout/stderr, or hung. A third pass runs every command
 * with --yes against a fetch that fails, and prints any write that did not exit 7 (transport failure).
 *
 *   npm run build && node scripts/review-probe.mjs        # V=1 for a line per command
 *
 * It runs in a fresh temporary HOME; it never touches the network or your real config.
 */
const D = new URL("../dist", import.meta.url).pathname;
const { run, buildProgram, listCommandTree } = await import(D + "/cli.js");
const { Ctx } = await import(D + "/core/context.js");
const { ConfigStore } = await import(D + "/core/config.js");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = mkdtempSync(join(tmpdir(), "vobiz-probe-"));
writeFileSync(join(base, "f.csv"), "to,text\n+14155550123,hi\n");
process.env.HOME = base;
process.chdir(base); // commands that write project files (skills install, xml) land in the temp dir
// POSTs that are reads (the public docs search); allowed without --yes, but never under --dry-run.
const READ_POST = /^POST https:\/\/www\.vobiz\.ai\/docs\/mcp/;
const SKIP = /^(webhooks listen|xml serve|update|calls watch)$/
const VAL = {
  to: "+14155550123", from: "+14155550100", text: "hi", url: "https://example.com/a.mp3", "answer-url": "https://example.com/a",
  digits: "1", email: "a@b.co", name: "n", file: join(base, "f.csv"), number: "+14155550123", country: "US", amount: "5", currency: "INR",
  pan: "ABCDE1234F", trunk: "t1", "sub-account": "SA_X", secret: "s3cr3tvalue", signature: "a".repeat(64), body: "{}", template: "hi",
  username: "u", password: "pw123456", event: "message.received", reason: "r", type: undefined,
};
function argsFor(node) {
  const a = [...node.path];
  for (const arg of node.args) if (arg.required) a.push(arg.name.includes("e164") || arg.name === "to" ? "+14155550123" : arg.name === "client" ? "cursor" : arg.name === "file" ? join(base, "f.csv") : arg.name === "method" ? "POST" : arg.name === "path" ? "/api/v1/x" : "X1");
  for (const o of node.options) {
    const k = o.long?.slice(2);
    if (k && VAL[k] !== undefined && o.takesValue) a.push(o.long, VAL[k]);
  }
  return a;
}
function leaves(n, out = []) { if (!n.subcommands.length || n.args.length) out.push(n); for (const c of n.subcommands) leaves(c, out); return out; }
const mk = (fetchLog, failWrites = false) => new Ctx({
  env: { VOBIZ_AUTH_ID: "MA_XXXXXXXX", VOBIZ_AUTH_TOKEN: "YOUR_AUTH_TOKEN_SECRET", CI: "1", VOBIZ_CONFIG_DIR: mkdtempSync(join(base, "cfg")), HOME: base },
  store: undefined, stdin: { isTTY: false, read: async () => "" },
  stdout: { write: (s) => { fetchLog.out += s; }, isTTY: false }, stderr: { write: (s) => { fetchLog.err += s; }, isTTY: false },
  fetch: async (url, init) => { fetchLog.calls.push(`${init?.method ?? "GET"} ${url}`); if (failWrites && (init?.method ?? "GET") !== "GET") throw new TypeError("fetch failed"); return new Response(JSON.stringify({ items: [], numbers: [], request_uuid: "r1", id: "m1", status: "sent" }), { status: 200, headers: { "content-type": "application/json" } }); },
  prompts: { confirm: async () => { throw new Error("PROMPT"); }, input: async () => { throw new Error("PROMPT"); }, password: async () => { throw new Error("PROMPT"); } },
});
const tree = listCommandTree(buildProgram(mk({ calls: [], out: "", err: "" })));
const L = leaves(tree).filter((n) => n.path.length && !SKIP.test(n.path.join(" ")));
console.log("leaves", L.length);
for (const extra of [[], ["--dry-run", "--yes"]]) {
  for (const n of L) {
    const log = { calls: [], out: "", err: "" };
    const ctx = mk(log);
    const argv = [...argsFor(n), ...extra];
    let code;
    try { code = await Promise.race([run(argv, ctx), new Promise((r) => setTimeout(() => r("HANG"), 1500))]); } catch (e) { code = "THROW " + e.message; }
    const writes = log.calls.filter((c) => !c.startsWith("GET ") && (extra.length || !READ_POST.test(c)));
    const leak = (log.out + log.err).includes("YOUR_AUTH_TOKEN_SECRET");
    if (writes.length || leak || code === "HANG") console.log(extra.join(" ") || "(no --yes)", "|", argv.join(" "), "| code", code, "| writes", writes, leak ? "| TOKEN LEAK" : "");
    if (process.env.V) console.log(code, argv.join(" "), log.calls.join(";"), log.err.split("\n")[0]);
  }
}
// Pass 3: every write that reaches the network must exit 7 when the transport fails.
for (const n of L) {
  const log = { calls: [], out: "", err: "" };
  const argv = [...argsFor(n), "--yes"];
  let code;
  try { code = await Promise.race([run(argv, mk(log, true)), new Promise((r) => setTimeout(() => r("HANG"), 1500))]); } catch (e) { code = "THROW " + e.message; }
  const writes = log.calls.filter((c) => !c.startsWith("GET ") && !READ_POST.test(c));
  if (writes.length && code !== 7) console.log("transport-fail", "|", argv.join(" "), "| code", code, "| writes", writes);
}
// Credentials copied into an MCP client config must never reach stdout/stderr (dry-run or not).
for (const extra of [["--dry-run"], []]) {
  const log = { calls: [], out: "", err: "" };
  const argv = ["mcp", "install", "claude", "--local", "--with-credentials", "--yes", ...extra];
  const code = await run(argv, mk(log));
  if ((log.out + log.err).includes("YOUR_AUTH_TOKEN_SECRET")) console.log("TOKEN LEAK |", argv.join(" "), "| code", code);
}
console.log("done");
