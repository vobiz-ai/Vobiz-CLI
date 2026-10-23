import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { assertWritableTarget, backupFile, openExclusive, writeFileAtomicExclusive, writeStreamAtomicExclusive } from "../src/core/fsafe.js";

const dir = () => mkdtempSync(join(tmpdir(), "vobiz-fsafe-"));
const posix = process.platform !== "win32";

describe("fsafe", () => {
  it("writes atomically, refuses to clobber without overwrite and leaves no temp files", () => {
    const d = dir();
    const f = join(d, "a.txt");
    writeFileAtomicExclusive(f, "one");
    expect(readFileSync(f, "utf8")).toBe("one");
    expect(() => writeFileAtomicExclusive(f, "two")).toThrow(/already exists/);
    writeFileAtomicExclusive(f, "two", { overwrite: true });
    expect(readFileSync(f, "utf8")).toBe("two");
    expect(readdirSync(d)).toEqual(["a.txt"]);
  });

  it.runIf(posix)("never writes through a symlink, dangling or not", async () => {
    const d = dir();
    const victim = join(d, "victim");
    writeFileSync(victim, "safe");
    symlinkSync(victim, join(d, "live"));
    symlinkSync(join(d, "missing"), join(d, "dangling"));
    expect(() => writeFileAtomicExclusive(join(d, "live"), "x", { overwrite: true })).toThrow(/symbolic link/);
    expect(() => assertWritableTarget(join(d, "dangling"), true)).toThrow(/symbolic link/);
    expect(() => assertWritableTarget(join(d, "dangling"), false)).toThrow();
    await expect(writeStreamAtomicExclusive(join(d, "dangling"), Readable.from([Buffer.from("x")]), { overwrite: true })).rejects.toThrow(/symbolic link/);
    expect(() => openExclusive(join(d, "dangling"))).toThrow(/already exists/);
    expect(existsSync(join(d, "missing"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("safe");
    expect(() => backupFile(victim, join(d, "live"))).toThrow(/symbolic link/);
  });

  it("streams to a random .part file and renames it into place", async () => {
    const d = dir();
    const f = join(d, "out.csv");
    writeFileSync(`${f}.part`, "planted"); // the old fixed name is ignored
    await writeStreamAtomicExclusive(f, Readable.from([Buffer.from("a,b\n")]));
    expect(readFileSync(f, "utf8")).toBe("a,b\n");
    expect(lstatSync(f).isFile()).toBe(true);
    expect(readFileSync(`${f}.part`, "utf8")).toBe("planted");
    expect(readdirSync(d).sort()).toEqual(["out.csv", "out.csv.part"]);
  });
});
