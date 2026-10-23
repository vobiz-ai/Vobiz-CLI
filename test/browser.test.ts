import { describe, expect, it } from "vitest";
import { browserAllowed } from "../src/core/context.js";
import { runCli } from "./helpers.js";

describe("browser launching", () => {
  it("is refused in tests, CI, pipes and with VOBIZ_NO_BROWSER", () => {
    expect(browserAllowed({}, false)).toBe(false);
    expect(browserAllowed({ CI: "1" }, true)).toBe(false);
    expect(browserAllowed({ VOBIZ_NO_BROWSER: "1" }, true)).toBe(false);
    expect(browserAllowed({ VITEST: "true" }, true)).toBe(false);
    expect(browserAllowed({}, true)).toBe(true);
  });
  it("docs open prints the URL and never spawns a browser when not interactive", async () => {
    const r = await runCli(["docs", "open", "xml/gather"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("https://www.vobiz.ai/docs/xml/gather");
  });
});

describe("browser opener hardening", async () => {
  const { openInBrowser, openUrlProblem } = await import("../src/core/context.js");
  const { feedbackUrl } = await import("../src/commands/feedback.js");
  const fakeSpawn = () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const fn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { on() {}, unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    return { fn, calls };
  };

  it("Windows uses rundll32 with the URL as one argument, never cmd", async () => {
    const s = fakeSpawn();
    await openInBrowser("https://github.com/vobiz-ai/Vobiz-CLI/issues/new?title=a&body=b", s.fn, "win32");
    expect(s.calls).toEqual([
      { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", "https://github.com/vobiz-ai/Vobiz-CLI/issues/new?title=a&body=b"], opts: expect.objectContaining({ shell: false, windowsVerbatimArguments: false }) },
    ]);
  });

  it("refuses shell metacharacters on Windows and non-http schemes everywhere", async () => {
    for (const u of ['https://www.vobiz.ai/x"&calc', "https://www.vobiz.ai/x|calc", "https://www.vobiz.ai/x^y", "https://www.vobiz.ai/%7Ccalc"])
      expect(openUrlProblem(u, "win32"), u).toBeDefined();
    expect(openUrlProblem("file:///etc/passwd", "darwin")).toBeDefined();
    expect(openUrlProblem("javascript:alert(1)", "linux")).toBeDefined();
    expect(openUrlProblem("https://www.vobiz.ai/docs/xml/gather", "win32")).toBeUndefined();
    const s = fakeSpawn();
    await expect(openInBrowser("https://www.vobiz.ai/x|calc", s.fn, "win32")).rejects.toMatchObject({ kind: "invalid_input" });
    expect(s.calls).toEqual([]);
  });

  it("feedback only builds an https://github.com URL with fully encoded query values", () => {
    const url = feedbackUrl({ title: `it's "bad" & <x> | ^`, message: "a&b=c|calc\nline 2 (with) *stars*!" });
    expect(url.startsWith("https://github.com/vobiz-ai/Vobiz-CLI/issues/new?")).toBe(true);
    expect(url).not.toMatch(/[\s"'<>^|()*!]/);
    expect(url.split("?")[1].split("&").map((p) => p.split("=")[0])).toEqual(["title", "body", "labels"]);
    expect(openUrlProblem(url, "win32")).toBeUndefined();
  });
});
