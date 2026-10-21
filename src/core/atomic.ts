/**
 * Safe file writes for files that can hold a secret (credentials.json, an MCP client config with a token).
 *
 * - The temp file has a random name and is created with O_CREAT|O_EXCL (`wx`) and the final mode, so a file or
 *   symlink planted at a guessable name makes the write fail instead of sending the content elsewhere.
 * - A symlink at the destination is refused: renaming over it would be fine, but following it on a later read or a
 *   chmod would not, and the CLI never creates one.
 * - With `privateDir`, the directory is created 0700, and an existing one owned by this user is tightened to 0700;
 *   a directory owned by someone else is refused (POSIX only; Windows relies on the profile's ACLs).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { VobizError } from "./errors.js";

export interface AtomicWriteOptions {
  mode: number;
  /** The directory belongs to the CLI (the config dir): create it 0700, tighten it to 0700, refuse a foreign owner. */
  privateDir?: boolean;
  platform?: NodeJS.Platform;
}

const isPosix = (platform: NodeJS.Platform) => platform !== "win32";

export function writeFileAtomic(file: string, text: string, o: AtomicWriteOptions): void {
  const platform = o.platform ?? process.platform;
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, ...(o.privateDir ? { mode: 0o700 } : {}) });
  if (o.privateDir && isPosix(platform)) {
    const st = statSync(dir);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new VobizError("not_allowed", `${dir} belongs to another user; refusing to write ${file} there. Set VOBIZ_CONFIG_DIR to a directory you own.`);
    if (st.mode & 0o077) chmodSync(dir, 0o700);
  }
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(file);
  } catch {
    existing = undefined;
  }
  if (existing?.isSymbolicLink()) throw new VobizError("not_allowed", `${file} is a symbolic link; refusing to write through it. Remove the link and try again.`);

  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", o.mode);
  try {
    try {
      writeSync(fd, text);
      if (isPosix(platform)) fchmodSync(fd, o.mode); // the umask may have narrowed it; never widen beyond `mode`
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already renamed or gone */
    }
    throw e;
  }
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
