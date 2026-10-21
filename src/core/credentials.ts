/**
 * Resolution order for the account the command acts on:
 *   1. --auth-id / --auth-token flags (discouraged: they land in shell history)
 *   2. VOBIZ_AUTH_ID + VOBIZ_AUTH_TOKEN environment variables (CI)
 *   3. the profile named by --profile / VOBIZ_PROFILE / the configured default / "default"
 */
import { ConfigStore, type Profile, SMS_BASE_URL, VOICE_BASE_URL } from "./config.js";
import { VobizError } from "./errors.js";

export interface ResolvedCredentials {
  authId: string;
  authToken: string;
  voiceBaseUrl: string;
  smsBaseUrl: string;
  source: "flags" | "env" | "profile";
  profile?: string;
}

export interface CredentialFlags {
  profile?: string;
  authId?: string;
  authToken?: string;
  baseUrl?: string;
  smsBaseUrl?: string;
}

export function profileName(flags: CredentialFlags, store: ConfigStore, env = process.env): string {
  return flags.profile ?? env.VOBIZ_PROFILE ?? store.settings().defaultProfile ?? "default";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why `url` may not be used as an API base URL, or undefined when it may. Credentials go to this host, so it must be
 * https; plain http is accepted only for localhost/127.0.0.1/[::1], and only when `allowLocalHttp` is true.
 */
export function baseUrlProblem(url: string, allowLocalHttp: boolean): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "is not a valid URL";
  }
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) {
    return allowLocalHttp ? undefined : "uses http; set VOBIZ_ALLOW_INSECURE_BASE_URL=1 to allow http for localhost";
  }
  return "must use https (http is allowed only for localhost with VOBIZ_ALLOW_INSECURE_BASE_URL=1)";
}

/** True for vobiz.ai and its subdomains (api.vobiz.ai, staging.vobiz.ai…). `vobiz.ai.example.com` is not. */
export function isVobizHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "vobiz.ai" || h.endsWith(".vobiz.ai");
}

/** True when a base URL may receive the token without VOBIZ_ALLOW_ANY_BASE_URL: a Vobiz host or loopback. */
export function isTrustedBaseHost(url: string): boolean {
  try {
    const u = new URL(url);
    return isVobizHost(u.hostname) || LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Throws invalid_input unless `url` is an https base URL (or http on localhost with VOBIZ_ALLOW_INSECURE_BASE_URL=1). */
export function assertSecureBaseUrl(url: string, label: string, env: NodeJS.ProcessEnv = process.env): string {
  const problem = baseUrlProblem(url, env.VOBIZ_ALLOW_INSECURE_BASE_URL === "1");
  if (problem) throw new VobizError("invalid_input", `${label} ${problem} (got "${url}").`);
  // The Auth Token goes to this host on every request, so only Vobiz (and loopback, for local testing) by default.
  if (!isTrustedBaseHost(url) && env.VOBIZ_ALLOW_ANY_BASE_URL !== "1")
    throw new VobizError(
      "invalid_input",
      `${label} points at ${new URL(url).host}, which is not a Vobiz host (*.vobiz.ai). Your Auth Token would be sent there. Set VOBIZ_ALLOW_ANY_BASE_URL=1 only if you trust that host.`,
    );
  return url;
}

/** One stderr line per run for every base URL outside *.vobiz.ai / loopback (only reachable with VOBIZ_ALLOW_ANY_BASE_URL=1). */
export function customBaseUrlWarnings(urls: { voiceBaseUrl: string; smsBaseUrl: string }): string[] {
  const hosts = new Set<string>();
  for (const u of [urls.voiceBaseUrl, urls.smsBaseUrl]) if (!isTrustedBaseHost(u)) hosts.add(new URL(u).host);
  return [...hosts].map((h) => `sending your Vobiz credentials to ${h}, which is not a Vobiz host (VOBIZ_ALLOW_ANY_BASE_URL=1).`);
}

/** Picks the voice and Messaging base URLs (flag, env, profile, default) and checks both. */
export function resolveBaseUrls(
  flags: CredentialFlags,
  env: NodeJS.ProcessEnv,
  p?: Pick<Profile, "voiceBaseUrl" | "smsBaseUrl">,
  warn?: (message: string) => void,
): { voiceBaseUrl: string; smsBaseUrl: string } {
  const pick = (flag: string | undefined, flagName: string, envName: string, saved: string | undefined, savedName: string, dflt: string) => {
    if (flag !== undefined) return assertSecureBaseUrl(flag, flagName, env);
    if (env[envName] !== undefined) return assertSecureBaseUrl(env[envName]!, envName, env);
    if (saved !== undefined) return assertSecureBaseUrl(saved, savedName, env);
    return dflt;
  };
  const urls = {
    voiceBaseUrl: pick(flags.baseUrl, "--base-url", "VOBIZ_BASE_URL", p?.voiceBaseUrl, "The profile's voiceBaseUrl", VOICE_BASE_URL),
    smsBaseUrl: pick(flags.smsBaseUrl, "--sms-base-url", "VOBIZ_SMS_BASE_URL", p?.smsBaseUrl, "The profile's smsBaseUrl", SMS_BASE_URL),
  };
  if (warn) for (const w of customBaseUrlWarnings(urls)) warn(w);
  return urls;
}

/** `warn` receives one line per non-Vobiz base host (see customBaseUrlWarnings). */
export function resolveCredentials(flags: CredentialFlags, store: ConfigStore, env = process.env, warn?: (message: string) => void): ResolvedCredentials {
  const usesProfile = !(flags.authId || flags.authToken || env.VOBIZ_AUTH_ID || env.VOBIZ_AUTH_TOKEN);
  // Flag and env base URLs are checked up front; the profile path re-resolves with the saved URLs (and warns once there).
  const { voiceBaseUrl, smsBaseUrl } = resolveBaseUrls(flags, env, undefined, usesProfile ? undefined : warn);
  if (flags.authId || flags.authToken) {
    if (!flags.authId || !flags.authToken) throw new VobizError("missing_credentials", "Pass both --auth-id and --auth-token, or neither.");
    return { authId: flags.authId, authToken: flags.authToken, voiceBaseUrl, smsBaseUrl, source: "flags" };
  }
  if (env.VOBIZ_AUTH_ID || env.VOBIZ_AUTH_TOKEN) {
    if (!env.VOBIZ_AUTH_ID || !env.VOBIZ_AUTH_TOKEN)
      throw new VobizError("missing_credentials", "Set both VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN, or neither.");
    return { authId: env.VOBIZ_AUTH_ID, authToken: env.VOBIZ_AUTH_TOKEN, voiceBaseUrl, smsBaseUrl, source: "env" };
  }
  const name = profileName(flags, store, env);
  const p: Profile | undefined = store.getProfile(name);
  if (!p) {
    const hint = name === "default" ? "Run `vobiz login` first." : `Run \`vobiz login --profile ${name}\` first.`;
    throw new VobizError("missing_credentials", `No credentials for profile "${name}". ${hint} In CI, set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN.`);
  }
  return {
    authId: p.authId,
    authToken: p.authToken,
    ...resolveBaseUrls(flags, env, p, warn),
    source: "profile",
    profile: name,
  };
}

/** `MA_…` main account, `SA_…` sub-account. Anything else is still sent; the gateway decides. */
export function describeAuthId(authId: string): string {
  if (authId.startsWith("MA_")) return "main account";
  if (authId.startsWith("SA_")) return "sub-account";
  return "account";
}

export function maskToken(token: string): string {
  if (token.length <= 8) return "••••";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
