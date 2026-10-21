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

export function resolveCredentials(flags: CredentialFlags, store: ConfigStore, env = process.env): ResolvedCredentials {
  const voiceBaseUrl = flags.baseUrl ?? env.VOBIZ_BASE_URL ?? VOICE_BASE_URL;
  const smsBaseUrl = flags.smsBaseUrl ?? env.VOBIZ_SMS_BASE_URL ?? SMS_BASE_URL;
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
    voiceBaseUrl: flags.baseUrl ?? env.VOBIZ_BASE_URL ?? p.voiceBaseUrl ?? VOICE_BASE_URL,
    smsBaseUrl: flags.smsBaseUrl ?? env.VOBIZ_SMS_BASE_URL ?? p.smsBaseUrl ?? SMS_BASE_URL,
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
