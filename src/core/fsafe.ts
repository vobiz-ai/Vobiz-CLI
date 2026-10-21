/**
 * Path-safe file writes. Every file the CLI creates from a user path (config merges, downloads, exports, one-time
 * secrets) goes through here so that a symlink or a pre-planted file in a shared or cloned directory can never
 * redirect the write somewhere else:
 *
 *   - symlinks are refused at the destination (and at its backup), never followed;
 *   - temporary files get a random name and are opened with O_CREAT|O_EXCL ("wx"), which also refuses a dangling link;
 *   - the finished file is moved into place with rename (or link, when overwriting is not allowed), so a reader never
 *     sees a half-written file;
 *   - files that can hold a secret (credentials.json, an MCP client config with a token) get their final mode with
 *     fchmod, and with `privateDir` the CLI's own config directory is created 0700, tightened to 0700 when this user
 *     owns it, and refused when someone else does (POSIX only; Windows relies on the profile's ACLs).
 *
 * This is the only atomic-write helper in the CLI (it absorbed the former core/atomic.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from "node:fs";
import { open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { VobizError } from "./errors.js";

/** lstat that returns undefined for a missing path (a dangling symlink still returns its own Stats). */
export function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw e;
  }
}

/** True when something (a file, a directory or any symlink, dangling or not) exists at `path`. */
export const pathExists = (path: string): boolean => lstatOrUndefined(path) !== undefined;

/** Throws invalid_input when `path` is a symlink. A missing path is fine. */
export function assertNotSymlink(path: string, what = "the file"): void {
  if (lstatOrUndefined(path)?.isSymbolicLink())
    throw new VobizError("invalid_input", `${path} is a symbolic link, so the CLI will not read or write ${what} through it. Replace it with a regular file or pick another path.`);
}

/**
 * Checks an output path before any network request: symlinks are always refused, and an existing path needs
 * `force`. Returns nothing; the real no-clobber guarantee comes from the exclusive write.
 */
export function assertWritableTarget(path: string, force: boolean, hint = "Pass --force to overwrite it."): void {
  const st = lstatOrUndefined(path);
  if (!st) return;
  if (st.isSymbolicLink()) assertNotSymlink(path, "the output");
  if (st.isDirectory()) throw new VobizError("invalid_input", `${path} is a directory.`);
  if (!force) throw new VobizError("invalid_input", `${path} already exists. ${hint}`);
}

/** A fresh temp name next to `file`: `<file>.<random>.<suffix>`. */
export const tempNameFor = (file: string, suffix = "tmp"): string => `${file}.${randomBytes(6).toString("hex")}.${suffix}`;

/** Opens `path` for writing with O_CREAT|O_EXCL: fails when anything (even a dangling symlink) is already there. */
export function openExclusive(path: string, mode = 0o600): number {
  try {
    return openSync(path, "wx", mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new VobizError("invalid_input", `${path} already exists (or is a symbolic link); refusing to write through it.`);
    throw e;
  }
}

/**
 * Moves the finished temp file onto `file`. With `overwrite`, rename replaces a regular file (a symlink at `file`
 * is refused first). Without it, a hard link creates `file` only if nothing is there, atomically.
 */
function commit(tmp: string, file: string, overwrite: boolean): void {
  assertNotSymlink(file, "the output");
  if (overwrite) {
    renameSync(tmp, file);
    return;
  }
  try {
    linkSync(tmp, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new VobizError("invalid_input", `${file} already exists. Pass --force to overwrite it.`);
    // File systems without hard links (some network or FAT volumes): fall back to check-then-rename.
    if (pathExists(file)) throw new VobizError("invalid_input", `${file} already exists. Pass --force to overwrite it.`);
    renameSync(tmp, file);
    return;
  }
  rmSync(tmp, { force: true });
}

export interface AtomicWriteOptions {
  /** File mode for a new file (default 0600). On POSIX it is applied with fchmod, so the umask cannot change it. */
  mode?: number;
  /** Replace an existing regular file. Symlinks are refused either way. */
  overwrite?: boolean;
  /** Create the parent directory (recursively) when it is missing. */
  createDir?: boolean;
  /** The directory belongs to the CLI (the config dir): create it 0700, tighten it to 0700, refuse a foreign owner. */
  privateDir?: boolean;
  platform?: NodeJS.Platform;
}

const isPosix = (platform: NodeJS.Platform) => platform !== "win32";

function prepareDir(file: string, o: AtomicWriteOptions, platform: NodeJS.Platform): void {
  if (!o.createDir && !o.privateDir) return;
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, ...(o.privateDir ? { mode: 0o700 } : {}) });
  if (!o.privateDir || !isPosix(platform)) return;
  const st = statSync(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new VobizError("not_allowed", `${dir} belongs to another user; refusing to write ${file} there. Set VOBIZ_CONFIG_DIR to a directory you own.`);
  if (st.mode & 0o077) chmodSync(dir, 0o700);
}

/** Writes `data` to `file` through an exclusive random-suffix temp file and an atomic rename. Never follows symlinks. */
export function writeFileAtomicExclusive(file: string, data: string | Uint8Array, o: AtomicWriteOptions = {}): void {
  const platform = o.platform ?? process.platform;
  prepareDir(file, o, platform);
  assertNotSymlink(file, "the output");
  if (!o.overwrite && pathExists(file)) throw new VobizError("invalid_input", `${file} already exists. Pass --force to overwrite it.`);
  const tmp = tempNameFor(file);
  const mode = o.mode ?? 0o600;
  const fd = openExclusive(tmp, mode);
  try {
    try {
      if (isPosix(platform)) fchmodSync(fd, mode); // the umask may have narrowed it; never widen beyond `mode`
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      try {
        fsyncSync(fd);
      } catch {
        /* not supported everywhere */
      }
    } finally {
      closeSync(fd);
    }
    commit(tmp, file, !!o.overwrite);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Streams `source` to `file` through an exclusive random-suffix `.part` file, then moves it into place.
 * `transform` stages (counters, caps) run between the source and the file. The temp file is removed on failure.
 */
export async function writeStreamAtomicExclusive(
  file: string,
  source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
  o: AtomicWriteOptions & { transforms?: ((src: AsyncIterable<Uint8Array>) => AsyncIterable<Uint8Array>)[] } = {},
): Promise<void> {
  assertNotSymlink(file, "the output");
  if (!o.overwrite && pathExists(file)) throw new VobizError("invalid_input", `${file} already exists. Pass --force to overwrite it.`);
  const tmp = tempNameFor(file, "part");
  let handle;
  try {
    handle = await open(tmp, "wx", o.mode ?? 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new VobizError("invalid_input", `${tmp} already exists; refusing to write through it.`);
    throw e;
  }
  try {
    const sink = handle.createWriteStream();
    await (pipeline as (...s: unknown[]) => Promise<void>)(source, ...(o.transforms ?? []), sink);
    commit(tmp, file, !!o.overwrite);
  } catch (e) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Copies `file` to `backup` without following a symlink at either path. An existing regular backup is replaced
 * through a fresh exclusive copy and a rename, so a link planted at the backup path is never written through.
 */
export function backupFile(file: string, backup: string, mode?: number): void {
  assertNotSymlink(file, "the file");
  assertNotSymlink(backup, "the backup");
  const tmp = tempNameFor(backup);
  try {
    copyFileSync(file, tmp, constants.COPYFILE_EXCL);
    if (mode !== undefined && isPosix(process.platform)) chmodSync(tmp, mode); // our own fresh file, never a link
    renameSync(tmp, backup);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * True when `file` still holds `expected` (undefined meaning "did not exist"). Used to detect a concurrent edit
 * between reading a config, asking for confirmation and writing it back.
 */
export function sameContent(file: string, expected: string | undefined): boolean {
  assertNotSymlink(file, "the file");
  let now: string | undefined;
  try {
    now = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (now === undefined || expected === undefined) return now === expected;
  return sha256(now) === sha256(expected);
}

/** realpath of the nearest existing ancestor of `path`, plus the part that does not exist yet. */
function realpathLoose(path: string): string {
  let cur = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(cur), ...rest);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(path);
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Throws invalid_input unless `file` resolves (through any symlinked parent directory) to a path inside `dir`.
 * Stops a project checkout from redirecting `.cursor/mcp.json` into the home directory with a symlinked folder.
 */
export function assertInsideDir(file: string, dir: string): void {
  const root = realpathLoose(dir);
  const real = realpathLoose(file);
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new VobizError("invalid_input", `${file} resolves to ${real}, outside the project directory ${root}; refusing to write it.`);
}

/** A warning when `file` (credentials.json) can be read by group or others; undefined when fine, missing or on Windows. */
export function permissionProblem(file: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!isPosix(platform)) return undefined;
  let mode: number;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
  return mode & 0o077 ? `${file} is mode ${mode.toString(8)} and readable by other users; run: chmod 600 "${file}"` : undefined;
}
