/**
 * Daily "a newer version exists" notice. Asks the npm registry at most once a day (cached in config.json),
 * prints one stderr line, and never delays a command by more than 1.5s. Off under CI, --no-update-check,
 * VOBIZ_NO_UPDATE_CHECK, `vobiz config set updateCheck false`, or when stderr is not a terminal.
 */
import type { Ctx } from "./context.js";
import { CLI_NAME, CLI_VERSION } from "./version.js";

export const REGISTRY_URL = `https://registry.npmjs.org/-/package/${CLI_NAME.replace("/", "%2f")}/dist-tags`;
const DAY_MS = 86_400_000;
export const UPDATE_TIMEOUT_MS = 1500;

/** Numeric semver comparison (pre-release suffixes sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return (x.pre ?? "").localeCompare(y.pre ?? "");
}

export function updateCheckEnabled(ctx: Ctx): boolean {
  const env = ctx.env;
  if (!ctx.flags.updateCheck || env.CI || env.VOBIZ_NO_UPDATE_CHECK) return false;
  if (!ctx.isTTY.stderr) return false;
  try {
    return ctx.store.settings().updateCheck !== false;
  } catch {
    return false;
  }
}

/** Fetches the latest published version (no cache). Undefined on any failure or after `timeoutMs`. */
export async function fetchLatestVersion(fetchImpl: typeof fetch, timeoutMs = UPDATE_TIMEOUT_MS): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(REGISTRY_URL, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { latest?: unknown };
    return typeof body.latest === "string" ? body.latest : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the notice line to print, or undefined. Uses the cached version when the last check is under a day
 * old; otherwise asks the registry (bounded by UPDATE_TIMEOUT_MS) and caches the answer.
 */
export async function checkForUpdate(ctx: Ctx): Promise<string | undefined> {
  if (!updateCheckEnabled(ctx)) return undefined;
  let latest: string | undefined;
  try {
    const s = ctx.store.settings();
    const last = s.lastUpdateCheck ? Date.parse(s.lastUpdateCheck) : 0;
    if (Number.isFinite(last) && ctx.now().getTime() - last < DAY_MS) {
      latest = s.latestKnownVersion;
    } else {
      latest = await fetchLatestVersion(ctx.fetch);
      ctx.store.patchSettings({ lastUpdateCheck: ctx.now().toISOString(), ...(latest ? { latestKnownVersion: latest } : {}) });
    }
  } catch {
    return undefined;
  }
  if (!latest || compareVersions(latest, CLI_VERSION) <= 0) return undefined;
  return `A new version of the Vobiz CLI is available: ${CLI_VERSION} -> ${latest}. Run \`vobiz update\` for how to upgrade.`;
}

/** Starts the check without blocking; `finish()` waits at most UPDATE_TIMEOUT_MS and prints the notice. */
export function startUpdateCheck(ctx: Ctx): { finish(): Promise<void> } {
  const pending = checkForUpdate(ctx).catch(() => undefined);
  return {
    async finish() {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), UPDATE_TIMEOUT_MS)));
      const line = await Promise.race([pending, timeout]);
      clearTimeout(timer);
      if (line) ctx.stderr.write(line + "\n");
    },
  };
}
