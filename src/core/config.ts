/**
 * Profiles and settings on disk: $VOBIZ_CONFIG_DIR, else $XDG_CONFIG_HOME/vobiz, else %APPDATA%\vobiz on Windows, else
 * ~/.config/vobiz.
 * credentials.json holds one entry per profile and is written with mode 0600 (on Windows the user profile ACLs protect it); config.json holds non-secret settings.
 * Nothing here is ever logged.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { permissionProblem, writeFileAtomicExclusive } from "./fsafe.js";
import { baseUrlProblem } from "./credentials.js";
import { VobizError } from "./errors.js";
import { isUnsafeKey } from "./keys.js";

/** Throws invalid_input for a profile name that would act on the object prototype instead of a saved entry. */
export function assertProfileName(name: string): string {
  if (isUnsafeKey(name)) throw new VobizError("invalid_input", `"${name}" cannot be used as a profile name.`);
  return name;
}

export const VOICE_BASE_URL = "https://api.vobiz.ai";
export const SMS_BASE_URL = "https://api.vobiz.ai/api/v1/sms";
export const CONSOLE_URL = "https://console.vobiz.ai";
export const DOCS_URL = "https://www.vobiz.ai/docs";

export const profileSchema = z.object({
  authId: z.string().min(3),
  authToken: z.string().min(8),
  /** Overrides for staging or self-hosted gateways. */
  voiceBaseUrl: z.string().url().refine((u) => !baseUrlProblem(u, true), "voiceBaseUrl must use https (http only for localhost)").optional(),
  smsBaseUrl: z.string().url().refine((u) => !baseUrlProblem(u, true), "smsBaseUrl must use https (http only for localhost)").optional(),
  /** Set on `vobiz login` from GET /auth/me so `whoami` works offline. */
  accountName: z.string().optional(),
  createdAt: z.string().optional(),
});
export type Profile = z.infer<typeof profileSchema>;

const credentialsFile = z.object({ version: z.literal(1), profiles: z.record(z.string(), profileSchema) });
const settingsFile = z.object({
  version: z.literal(1),
  defaultProfile: z.string().optional(),
  /** Default --output when stdout is a TTY. */
  output: z.enum(["table", "json", "yaml"]).optional(),
  color: z.boolean().optional(),
  /** `vobiz update` reminder; false disables the check entirely. */
  updateCheck: z.boolean().optional(),
  lastUpdateCheck: z.string().optional(),
  latestKnownVersion: z.string().optional(),
  /** Accepted in existing config files for forward compatibility; not a user-visible setting and nothing reads it. */
  telemetry: z.boolean().optional(),
});
export type Settings = z.infer<typeof settingsFile>;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VOBIZ_CONFIG_DIR) return env.VOBIZ_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "vobiz");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "vobiz");
  return join(homedir(), ".config", "vobiz");
}

function readJson<T>(file: string, schema: z.ZodType<T>, empty: T): T {
  if (!existsSync(file)) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON. Fix or delete it.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} has an unexpected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/** Exclusive random temp file + rename; the config dir is kept 0700 (see fsafe.ts). */
function writeJsonAtomic(file: string, data: unknown, mode: number): void {
  writeFileAtomicExclusive(file, JSON.stringify(data, null, 2) + "\n", { mode, overwrite: true, privateDir: true });
}

export class ConfigStore {
  constructor(readonly dir: string = configDir()) {}
  get credentialsPath() {
    return join(this.dir, "credentials.json");
  }
  get settingsPath() {
    return join(this.dir, "config.json");
  }

  /** A warning when credentials.json is readable by group or others (POSIX only), like ssh does for keys. */
  credentialsPermissionProblem(): string | undefined {
    return permissionProblem(this.credentialsPath);
  }

  profiles(): Record<string, Profile> {
    return readJson(this.credentialsPath, credentialsFile, { version: 1 as const, profiles: {} }).profiles;
  }
  getProfile(name: string): Profile | undefined {
    assertProfileName(name);
    const all = this.profiles();
    return Object.hasOwn(all, name) ? all[name] : undefined;
  }
  setProfile(name: string, p: Profile): void {
    assertProfileName(name);
    const all = this.profiles();
    all[name] = { ...p, createdAt: p.createdAt ?? new Date().toISOString() };
    writeJsonAtomic(this.credentialsPath, { version: 1, profiles: all }, 0o600);
  }
  removeProfile(name: string): boolean {
    assertProfileName(name);
    const all = this.profiles();
    if (!Object.hasOwn(all, name)) return false;
    delete all[name];
    writeJsonAtomic(this.credentialsPath, { version: 1, profiles: all }, 0o600);
    const s = this.settings();
    if (s.defaultProfile === name) this.setSettings({ ...s, defaultProfile: undefined });
    return true;
  }

  settings(): Settings {
    return readJson(this.settingsPath, settingsFile, { version: 1 as const });
  }
  setSettings(s: Settings): void {
    writeJsonAtomic(this.settingsPath, { ...s, version: 1 }, 0o644);
  }
  patchSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch, version: 1 as const };
    this.setSettings(next);
    return next;
  }
}
