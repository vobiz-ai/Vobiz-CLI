import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };

describe("package.json files", () => {
  it("ships the README, CHANGELOG and LICENSE, and never dist/internal", () => {
    for (const f of ["README.md", "CHANGELOG.md", "LICENSE"]) expect(pkg.files).toContain(f);
    expect(pkg.files).toContain("!dist/internal/**");
  });
});

describe("release workflow", () => {
  it("publishes the packed tarball by an explicit relative path, not a bare owner/name spec", async () => {
    const { readFileSync } = await import("node:fs");
    const yml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    // npm treats a bare `pack/vobiz-cli-1.2.3.tgz` as a GitHub shorthand and tries to git-clone it.
    expect(yml).toMatch(/TGZ="\.\/pack\/vobiz-cli-\$V\.tgz"/);
    expect(yml).not.toMatch(/TGZ="pack\//);
  });
});
