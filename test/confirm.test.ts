import { describe, expect, it } from "vitest";
import { requireConfirmation } from "../src/core/confirm.js";
import { VobizError } from "../src/core/errors.js";
import { makeCtx } from "./helpers.js";

const summary = { action: "Release +14155550100", details: { number: "+14155550100" }, cost: "none" };

async function outcome(p: Promise<void>) {
  try {
    await p;
    return "continue";
  } catch (e) {
    return (e as VobizError).kind;
  }
}

describe("requireConfirmation", () => {
  it("--yes continues without prompting and still prints the summary", async () => {
    const t = makeCtx({ flags: { yes: true } });
    expect(await outcome(requireConfirmation(t.ctx, summary))).toBe("continue");
    expect(t.stderr.text).toContain("Release +14155550100");
    expect(t.stderr.text).toContain("cost: none");
  });

  it("VOBIZ_YES=1 counts as --yes", async () => {
    const t = makeCtx({ env: { VOBIZ_YES: "1" } });
    expect(await outcome(requireConfirmation(t.ctx, summary))).toBe("continue");
  });

  it("refuses without --yes when stdin is not a TTY", async () => {
    const t = makeCtx({ stdinTTY: false });
    expect(await outcome(requireConfirmation(t.ctx, summary))).toBe("confirmation_required");
  });

  it("asks on a TTY and honours the answer", async () => {
    expect(await outcome(requireConfirmation(makeCtx({ stdinTTY: true, prompts: { confirm: true } }).ctx, summary))).toBe("continue");
    expect(await outcome(requireConfirmation(makeCtx({ stdinTTY: true, prompts: { confirm: false } }).ctx, summary))).toBe("confirmation_required");
  });

  it("--dry-run prints and continues without prompting (the client then stops before sending)", async () => {
    const t = makeCtx({ flags: { dryRun: true }, stdinTTY: false });
    expect(await outcome(requireConfirmation(t.ctx, summary))).toBe("continue");
    expect(t.stderr.text).toContain("[dry-run] Release");
  });
});
