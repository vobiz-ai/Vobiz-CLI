import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };

describe("package.json files", () => {
  it("ships the README, CHANGELOG and LICENSE, and never dist/internal", () => {
    for (const f of ["README.md", "CHANGELOG.md", "LICENSE"]) expect(pkg.files).toContain(f);
    expect(pkg.files).toContain("!dist/internal/**");
  });
});
