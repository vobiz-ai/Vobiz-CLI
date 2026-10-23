/**
 * scripts/live-verify.mjs: the planner, the exclusion list, the executor and its exit-code contract, driven
 * against the fake transport (test/helpers.ts). Nothing here reaches the network.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM script without type declarations
import * as lv from "../scripts/live-verify.mjs";
import { fakeFetch, reply, runCli, TEST_AUTH_ID, TEST_AUTH_TOKEN, type FakeApi } from "./helpers.js";

const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const FILES = { pw1: "$TMP/pw1", pw2: "$TMP/pw2", epPw: "$TMP/ep-pw", whSecret: "$TMP/wh-secret", dir: "$TMP" };

interface Res {
  code: number;
  stdout: string;
  stderr: string;
}
type Runner = (argv: string[], o: { env: NodeJS.ProcessEnv }) => Promise<Res>;

/** The CLI in-process against a fake API, as the live run would spawn it. */
const cliRunner =
  (api: FakeApi): Runner =>
  async (argv) => {
    const r = await runCli(argv, { fetch: api.fetch });
    return { code: r.code, stdout: r.out, stderr: r.err };
  };

/** A stateful fake of the Application endpoints: one real app, one leftover of an earlier run. */
function appsApi(o: { deleteFails?: boolean; getAfterDelete?: "404" | "200" } = {}) {
  const apps = new Map<string, Record<string, unknown>>([
    ["111", { app_id: "111", app_name: "Production IVR" }],
    ["999", { app_id: "999", app_name: "cli-verify-app" }],
  ]);
  let next = 500;
  const one = (req: { path: string }) => req.path.split("/").filter(Boolean).pop()!;
  return fakeFetch({
    [`GET ${A}/Application/`]: () => ({ meta: { total_count: apps.size, next: null }, objects: [...apps.values()] }),
    [`POST ${A}/Application/`]: (req) => {
      const id = String(next++);
      apps.set(id, { app_id: id, ...(req.body as object) });
      return reply(201, { api_id: "x", app_id: id, message: "created" });
    },
    ...Object.fromEntries(
      ["111", "999", "500", "501"].flatMap((id) => [
        [`GET ${A}/Application/${id}/`, () => (apps.has(id) ? apps.get(id) : o.getAfterDelete === "200" ? { app_id: id } : reply(404, { error: "not found" }))],
        [`POST ${A}/Application/${id}/`, () => ({ message: "changed" })],
        [
          `DELETE ${A}/Application/${id}/`,
          (req: { path: string }) => {
            if (o.deleteFails && id !== "999") return reply(500, { error: "boom" });
            apps.delete(one(req));
            return reply(204);
          },
        ],
      ]),
    ),
  });
}

const plan = (only: string[]) => lv.buildPlan({ only, files: FILES });

describe("live-verify planner", () => {
  it("--dry-run prints a stable plan with no forbidden command", async () => {
    const out: string[] = [];
    const io = { log: (l: string) => out.push(l), error: (l: string) => out.push(l) };
    expect(await lv.main(["--dry-run"], io)).toBe(0);
    const again: string[] = [];
    await lv.main(["--dry-run"], { log: (l: string) => again.push(l), error: () => {} });
    expect(again).toEqual(out);
    expect(out.join("\n")).not.toContain("REFUSED");
    expect(out.join("\n")).toMatchSnapshot();
    for (const step of plan([])) expect(lv.forbiddenReason(step.args(new Proxy({}, { get: (_t, k) => `<${String(k)}>` })))).toBeNull();
  });

  it("covers every group and filters with --only", () => {
    expect(new Set(plan([]).map((s: { group: string }) => s.group))).toEqual(new Set(lv.GROUPS));
    expect(new Set(plan(["apps", "sms"]).map((s: { group: string }) => s.group))).toEqual(new Set(["apps", "sms"]));
    expect(lv.parseArgs(["--only", "apps,trunks", "--only", "sms"]).only).toEqual(["apps", "trunks", "sms"]);
    expect(() => lv.parseArgs(["--only", "billing"])).toThrow(/unknown group/);
  });

  it("every write uses the cli-verify prefix or an id from the account, and never is_active", () => {
    const text = lv.renderPlan(plan([]));
    expect(text).not.toContain("is_active");
    for (const line of text.split("\n").filter((l: string) => / write  vobiz \S+ (\S+ )?create /.test(l))) expect(line).toMatch(/cli-verify|cliverify/);
  });
});

describe("live-verify exclusions", () => {
  const forbidden = [
    ["calls", "create", "--from", "+14155550100", "--to", "+14155550101", "--answer-url", "https://example.com/a"],
    ["calls", "hangup", "abc"],
    ["calls", "transfer", "abc"],
    ["conferences", "kick", "room", "1"],
    ["sms", "send", "--to", "+14155550101", "--text", "hi"],
    ["numbers", "buy", "+14155550100"],
    ["numbers", "release", "+14155550100"],
    ["sms", "numbers", "buy", "+14155550100"],
    ["sms", "numbers", "release", "+14155550100"],
    ["partner", "accounts", "transfer-balance", "SA_XXXXXXXX", "--amount", "10"],
    ["sms", "broadcasts", "launch", "b1"],
    ["sms", "10dlc", "brands", "register", "b1"],
    ["sms", "10dlc", "campaigns", "register", "c1"],
    ["sub-accounts", "kyc", "session", "create", "SA_XXXXXXXX"],
    ["sub-accounts", "kyc", "--test", "session", "create", "SA_XXXXXXXX"],
    ["partner", "kyc-sessions", "create"],
    ["account", "channel-subscriptions", "create"],
    ["api", "POST", "/api/v1/Account/{auth_id}/Call/"],
    ["api", "DELETE", "/numbers/x"],
    ["sub-accounts", "update", "SA_XXXXXXXX", "--body", '{"is_active":false}'],
  ];
  it.each(forbidden.map((f) => [f.join(" "), f]))("refuses %s", (_name, argv) => {
    expect(lv.forbiddenReason(argv)).toEqual(expect.any(String));
  });

  it("allows the reads and reversible writes the plan uses", () => {
    for (const ok of [["calls", "list"], ["numbers", "update", "+1", "--app", "1", "--yes"], ["sms", "broadcasts", "create", "--name", "cli-verify-b"], ["api", "GET", "/api/v1/auth/me"], ["sub-accounts", "kyc", "status", "SA_X"]])
      expect(lv.forbiddenReason(ok)).toBeNull();
  });

  it("the executor refuses a forbidden step without running it, and that fails the run", async () => {
    let ran = 0;
    const runner: Runner = async () => {
      ran++;
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const step = { group: "sms", phase: "write", cmd: "sms send", args: () => ["sms", "send", "--to", "+14155550101", "--text", "x", "--yes"] };
    const res = await lv.execute([step], { runner, secrets: [] });
    expect(ran).toBe(0);
    expect(res.steps[0]).toMatchObject({ verdict: "fail", notes: expect.stringContaining("refused") });
    expect(lv.exitCodeFor(res)).toBe(1);
  });
});

describe("live-verify executor", () => {
  it("exit 0: the apps group works end to end, sweeps the old leftover and leaves nothing", async () => {
    const api = appsApi();
    const res = await lv.execute(plan(["apps"]), { runner: cliRunner(api), secrets: [TEST_AUTH_TOKEN] });
    expect(res.steps.filter((s: { verdict: string }) => s.verdict !== "works")).toEqual([]);
    expect(res.leftovers).toEqual([]);
    expect(lv.exitCodeFor(res)).toBe(0);
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === `${A}/Application/999/`)).toBe(true); // sweep
    expect(api.calls.some((c) => c.method === "DELETE" && c.path === `${A}/Application/111/`)).toBe(false); // never a real app
    const create = res.steps.find((s: { command: string }) => s.command === "apps create");
    expect(create).toMatchObject({ http: "201", exit: 0 });
    expect(res.steps.find((s: { command: string; phase: string }) => s.command === "apps update" && s.phase === "write").arguments).toContain("<app>");
  });

  it("exit 2: the API answers differently from the recording (get after delete is 200, not 404)", async () => {
    const res = await lv.execute(plan(["apps"]), { runner: cliRunner(appsApi({ getAfterDelete: "200" })), secrets: [TEST_AUTH_TOKEN] });
    const row = res.steps.find((s: { verdict: string }) => s.verdict !== "works");
    expect(row).toMatchObject({ command: "apps get", verdict: "api-differs", http: "200", exit: 0 });
    expect(lv.exitCodeFor(res)).toBe(2);
  });

  it("exit 1: a CLI failure (wrong exit with no API answer) and unusable output", async () => {
    const api = appsApi();
    const base = cliRunner(api);
    const runner: Runner = async (argv) => (argv[0] === "apps" && argv[1] === "get" ? { code: 2, stdout: "", stderr: '{"error":"invalid_input","message":"bad","status":null}\n' } : base(argv, { env: {} }));
    const res = await lv.execute(plan(["apps"]), { runner, secrets: [] });
    expect(res.steps.find((s: { verdict: string }) => s.verdict === "fail")).toMatchObject({ command: "apps get", exit: 2 });
    expect(lv.exitCodeFor(res)).toBe(1);
    const bad = lv.classify({ cmd: "x" }, { code: 0, stdout: "not json", stderr: "" }, [], {});
    expect(bad.verdict).toBe("fail");
  });

  it("cleanup runs after the run crashes and deletes what it created", async () => {
    const api = appsApi();
    const base = cliRunner(api);
    const runner: Runner = async (argv, o) => {
      if (argv[0] === "apps" && argv[1] === "update") throw new Error("runner died");
      return base(argv, o);
    };
    const res = await lv.execute(plan(["apps"]), { runner, secrets: [] });
    expect(res.crashed).toBe("runner died");
    const cleanup = res.steps.filter((s: { phase: string }) => s.phase === "cleanup");
    expect(cleanup).toEqual([expect.objectContaining({ command: "apps delete", verdict: "works" })]);
    expect(api.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toContain(`${A}/Application/500/`);
    expect(res.leftovers).toEqual([]);
    expect(lv.exitCodeFor(res)).toBe(1);
  });

  it("an undo that fails is listed as a leftover, and that fails the run", async () => {
    const res = await lv.execute(plan(["apps"]), { runner: cliRunner(appsApi({ deleteFails: true })), secrets: [] });
    expect(res.leftovers).toEqual([expect.objectContaining({ key: "app", command: expect.stringContaining("vobiz apps delete 500") })]);
    expect(lv.exitCodeFor(res)).toBe(1);
    expect(lv.renderSummary({ ...res, date: "2026-10-22", groups: ["apps"], exit: 1 })).toContain("## Leftovers");
  });

  it("skips steps whose input is missing (no app-linked number) without failing", async () => {
    const api = fakeFetch({ [`GET ${A}/numbers`]: { items: [{ e164: "+14155550100", application_id: null }] }, [`GET ${A}/inventory/numbers`]: { items: [] } });
    const res = await lv.execute(plan(["numbers"]), { runner: cliRunner(api), secrets: [] });
    expect(res.steps[0]).toMatchObject({ command: "numbers list", verdict: "works" });
    const skipped = res.steps.filter((s: { verdict: string }) => s.verdict === "skipped");
    expect(skipped.length).toBe(7);
    expect(skipped[0].notes).toContain("<number>");
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
    expect(lv.exitCodeFor(res)).toBe(0);
  });
});

describe("live-verify secrets", () => {
  it("fails a step whose output contains the token, and the token never reaches the report or summary", async () => {
    const api = appsApi();
    const base = cliRunner(api);
    const runner: Runner = async (argv, o) => {
      const r = await base(argv, o);
      return argv[1] === "list" ? { ...r, stdout: r.stdout.replace("Production IVR", TEST_AUTH_TOKEN), stderr: `${r.stderr}token=${TEST_AUTH_TOKEN}\n` } : r;
    };
    const res = await lv.execute(plan(["apps"]), { runner, secrets: [TEST_AUTH_TOKEN] });
    expect(res.steps.filter((s: { verdict: string }) => s.verdict === "fail").map((s: { notes: string }) => s.notes)).toEqual([expect.stringContaining("a secret appeared"), expect.stringContaining("a secret appeared")]);
    const report = JSON.stringify({ ...res, steps: res.steps });
    expect(report).not.toContain(TEST_AUTH_TOKEN);
    expect(lv.renderSummary({ ...res, date: "2026-10-22", groups: ["apps"], exit: 1 })).not.toContain(TEST_AUTH_TOKEN);
  });

  it("main refuses to run without credentials (exit 3) and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lv-"));
    const saved = { id: process.env.VOBIZ_AUTH_ID, tok: process.env.VOBIZ_AUTH_TOKEN };
    delete process.env.VOBIZ_AUTH_ID;
    delete process.env.VOBIZ_AUTH_TOKEN;
    try {
      const err: string[] = [];
      expect(await lv.main(["--report", join(dir, "r.json")], { log: () => {}, error: (l: string) => err.push(l) })).toBe(3);
      expect(err.join("")).toContain("VOBIZ_AUTH_ID");
      expect(() => readFileSync(join(dir, "r.json"))).toThrow();
      expect(await lv.main(["--only", "nope"], { log: () => {}, error: () => {} })).toBe(3);
    } finally {
      if (saved.id !== undefined) process.env.VOBIZ_AUTH_ID = saved.id;
      if (saved.tok !== undefined) process.env.VOBIZ_AUTH_TOKEN = saved.tok;
    }
  });
});
