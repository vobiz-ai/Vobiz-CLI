/**
 * `vobiz doctor`: everything that commonly breaks a CLI install, checked in one go. Each check is
 * ok | warn | fail | skip; any fail sets exit code 1. `--offline` skips the network checks (CI smoke tests).
 * Proxy variables are reported by name only: their values often embed credentials.
 */
import { existsSync, statSync } from "node:fs";
import type { Command } from "commander";
import { SMS_BASE_URL, VOICE_BASE_URL } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { resolveCredentials } from "../core/credentials.js";
import { VobizError } from "../core/errors.js";
import { op } from "../core/ops.js";
import { CLI_VERSION } from "../core/version.js";

type Status = "ok" | "warn" | "fail" | "skip";
export interface Check {
  check: string;
  status: Status;
  detail: string;
}

const MIN_NODE = [22, 9];
const SKEW_WARN_MS = 60_000;
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS"];

export function nodeCheck(version = process.versions.node): Check {
  const [maj, min] = version.split(".").map(Number);
  const ok = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  return { check: "node", status: ok ? "ok" : "fail", detail: ok ? `Node.js ${version}` : `Node.js ${version}; the Vobiz CLI needs ${MIN_NODE.join(".")} or newer` };
}

export function permissionChecks(ctx: Ctx, platform = process.platform): Check[] {
  const dir = ctx.store.dir;
  if (!existsSync(dir)) return [{ check: "config dir", status: "ok", detail: `${dir} (not created yet; \`vobiz login\` creates it)` }];
  if (platform === "win32") return [{ check: "config dir", status: "skip", detail: `${dir} (permissions are not checked on Windows)` }];
  const out: Check[] = [];
  const dirMode = statSync(dir).mode & 0o777;
  out.push(
    dirMode & 0o077
      ? { check: "config dir", status: "warn", detail: `${dir} is mode ${dirMode.toString(8)}; run: chmod 700 "${dir}"` }
      : { check: "config dir", status: "ok", detail: `${dir} (mode ${dirMode.toString(8)})` },
  );
  const file = ctx.store.credentialsPath;
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    out.push(
      mode & 0o077
        ? { check: "credentials file", status: "fail", detail: `${file} is mode ${mode.toString(8)} (readable by others); run: chmod 600 "${file}"` }
        : { check: "credentials file", status: "ok", detail: `${file} (mode ${mode.toString(8)})` },
    );
  } else out.push({ check: "credentials file", status: "skip", detail: "no saved profiles" });
  try {
    ctx.store.settings();
  } catch (e) {
    out.push({ check: "settings file", status: "fail", detail: (e as Error).message });
  }
  return out;
}

async function reach(ctx: Ctx, name: string, base: string): Promise<{ check: Check; date?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(ctx.flags.timeout * 1000, 10_000));
  const started = Date.now();
  try {
    const res = await ctx.fetch(base, { method: "GET", signal: controller.signal, redirect: "manual", headers: { Accept: "application/json" } });
    await res.arrayBuffer().catch(() => undefined);
    const date = res.headers.get("date");
    return {
      check: { check: name, status: "ok", detail: `${new URL(base).host} answered HTTP ${res.status} in ${Date.now() - started}ms` },
      date: date ? Date.parse(date) : undefined,
    };
  } catch {
    return { check: { check: name, status: "fail", detail: `cannot reach ${base}${controller.signal.aborted ? " (timed out)" : ""}` } };
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor(ctx: Ctx, opts: { offline?: boolean }): Promise<Check[]> {
  const checks: Check[] = [{ check: "cli", status: "ok", detail: `vobiz ${CLI_VERSION}` }, nodeCheck(), ...permissionChecks(ctx)];

  let creds: ReturnType<typeof resolveCredentials> | undefined;
  try {
    creds = resolveCredentials(ctx.flags, ctx.store, ctx.env);
    checks.push({ check: "credentials", status: "ok", detail: `${creds.authId} from ${creds.source}${creds.profile ? ` (profile "${creds.profile}")` : ""}` });
  } catch (e) {
    checks.push({ check: "credentials", status: "warn", detail: e instanceof VobizError ? e.message : String(e) });
  }

  const proxies = PROXY_VARS.filter((v) => ctx.env[v]);
  checks.push(
    proxies.length
      ? {
          check: "proxy env",
          status: "ok",
          detail: `set: ${proxies.join(", ")}${ctx.env.NODE_USE_ENV_PROXY ? "" : " (Node's fetch uses them only with NODE_USE_ENV_PROXY=1)"}`,
        }
      : { check: "proxy env", status: "ok", detail: "none set" },
  );

  if (opts.offline) {
    checks.push({ check: "network", status: "skip", detail: "--offline" });
    return checks;
  }
  const voiceBase = creds?.voiceBaseUrl ?? ctx.flags.baseUrl ?? ctx.env.VOBIZ_BASE_URL ?? VOICE_BASE_URL;
  const smsBase = creds?.smsBaseUrl ?? ctx.flags.smsBaseUrl ?? ctx.env.VOBIZ_SMS_BASE_URL ?? SMS_BASE_URL;
  const [voice, sms] = await Promise.all([reach(ctx, "voice API", voiceBase), reach(ctx, "messaging API", smsBase)]);
  checks.push(voice.check, sms.check);

  const serverDate = voice.date ?? sms.date;
  if (serverDate && Number.isFinite(serverDate)) {
    const skew = ctx.now().getTime() - serverDate;
    checks.push(
      Math.abs(skew) > SKEW_WARN_MS
        ? { check: "clock", status: "warn", detail: `local clock is ${Math.round(skew / 1000)}s off the server; webhook signature checks may fail` }
        : { check: "clock", status: "ok", detail: `within ${Math.max(1, Math.round(Math.abs(skew) / 1000))}s of the server` },
    );
  } else checks.push({ check: "clock", status: "skip", detail: "server sent no Date header" });

  if (creds) {
    try {
      const me = await ctx.makeClient(creds).call<{ name?: string }>(op("retrieve-account"), { dryRun: false });
      checks.push({ check: "auth", status: "ok", detail: `verified${me?.name ? ` as ${me.name}` : ""}` });
    } catch (e) {
      const err = e instanceof VobizError ? e : new VobizError("internal_error", String(e));
      checks.push({ check: "auth", status: "fail", detail: `${err.kind}: ${err.message}` });
    }
  } else checks.push({ check: "auth", status: "skip", detail: "no credentials" });
  return checks;
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("doctor")
    .description("Check Node.js, config permissions, connectivity, credentials, clock skew and proxy settings")
    .option("--offline", "skip network checks")
    .action(async (opts: { offline?: boolean }) => {
      const checks = await runDoctor(ctx, opts);
      ctx.out.print(checks, { columns: ["check", "status", "detail"], idKey: "check" });
      if (checks.some((c) => c.status === "fail")) ctx.exitCode = 1;
    });
}
