import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/core/config.js";
import { Ctx, openUrlGuarded } from "../src/core/context.js";
import { capture, fakeFetch, runCli } from "./helpers.js";

describe("vobiz feedback", () => {
  it("prints a prefilled issue URL without any request when stdout is not a terminal", async () => {
    const api = fakeFetch();
    const r = await runCli(["feedback", "-m", "calls watch should show the hangup cause"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    const url = new URL(r.json().url);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/vobiz-ai/Vobiz-CLI/issues/new");
    expect(url.searchParams.get("title")).toBe("calls watch should show the hangup cause");
    expect(url.searchParams.get("body")).toContain("calls watch should show the hangup cause");
    expect(url.searchParams.get("body")).toContain("vobiz CLI ");
    expect(url.searchParams.get("body")).not.toContain("MA_XXXXXXXX");
    expect(url.searchParams.get("body")).not.toContain("YOUR_AUTH_TOKEN");
    expect(r.opened).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  it("opens the browser on a terminal, unless --print", async () => {
    let r = await runCli(["feedback", "--title", "Bug"], { stdoutTTY: true });
    expect(r.opened).toHaveLength(1);
    expect(new URL(r.opened[0]).searchParams.get("title")).toBe("Bug");
    r = await runCli(["feedback", "--print", "--output", "plain"], { stdoutTTY: true });
    expect(r.opened).toEqual([]);
    expect(r.out).toContain("issues/new?");
  });

  it("gives {url, opened} with --json and rejects an empty message", async () => {
    let r = await runCli(["feedback", "--json"]);
    expect(r.json()).toMatchObject({ opened: false });
    expect(r.json().url).toContain("labels=feedback");
    r = await runCli(["feedback", "-m", "  "]);
    expect(r.code).toBe(2);
  });
});

describe("default openUrl (openUrlGuarded)", () => {
  const url = "https://github.com/vobiz-ai/Vobiz-CLI/issues/new";
  const run = async (env: NodeJS.ProcessEnv, stdoutTTY: boolean) => {
    const spawned: string[] = [];
    const fakeSpawn = ((cmd: string) => {
      spawned.push(cmd);
      return { on() {}, unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    const stderr = capture();
    await openUrlGuarded(url, { env, stdout: capture(stdoutTTY), stderr }, fakeSpawn);
    return { spawned, err: stderr.text };
  };

  it("never spawns a browser when stdout is not a terminal, CI is set or VOBIZ_NO_BROWSER is set", async () => {
    for (const [env, tty] of [[{}, false], [{ CI: "1" }, true], [{ VOBIZ_NO_BROWSER: "1" }, true]] as const) {
      const r = await run(env, tty);
      expect(r.spawned).toEqual([]);
      expect(r.err).toBe(`Open: ${url}\n`);
    }
  });

  it("spawns the platform opener only on an interactive terminal", async () => {
    const r = await run({}, true);
    expect(r.spawned).toHaveLength(1);
    expect(r.err).toBe("");
  });

  it("is the Ctx default", () => {
    const stderr = capture();
    const ctx = new Ctx({ env: {}, stdout: capture(false), stderr, store: new ConfigStore(mkdtempSync(join(tmpdir(), "vobiz-open-"))) });
    return ctx.openUrl(url).then(() => expect(stderr.text).toBe(`Open: ${url}\n`));
  });
});
