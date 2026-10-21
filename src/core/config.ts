/**
 * Profiles and settings on disk: $VOBIZ_CONFIG_DIR or $XDG_CONFIG_HOME/vobiz or ~/.config/vobiz.
 * credentials.json holds one entry per profile and is written with mode 0600; config.json holds non-secret settings.
 * Nothing here is ever logged.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const VOICE_BASE_URL = "https://api.vobiz.ai";
export const SMS_BASE_URL = "https://api.vobiz.ai/api/v1/sms";
export const CONSOLE_URL = "https://console.vobiz.ai";
export const DOCS_URL = "https://www.vobiz.ai/docs";

export const profileSchema = z.object({
  authId: z.string().min(3),
  authToken: z.string().min(8),
  /** Overrides for staging or self-hosted gateways. */
  voiceBaseUrl: z.string().url().optional(),
  smsBaseUrl: z.string().url().optional(),
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
  /** Anonymous usage telemetry is OFF by default and only ever switched on with `vobiz config set telemetry true`. */
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

function writeJsonAtomic(file: string, data: unknown, mode: number): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    /* Windows */
  }
  renameSync(tmp, file);
}

export class ConfigStore {
  constructor(readonly dir: string = configDir()) {}
  get credentialsPath() {
    return join(this.dir, "credentials.json");
  }
  get settingsPath() {
    return join(this.dir, "config.json");
  }

  profiles(): Record<string, Profile> {
    return readJson(this.credentialsPath, credentialsFile, { version: 1 as const, profiles: {} }).profiles;
  }
  getProfile(name: string): Profile | undefined {
    return this.profiles()[name];
  }
  setProfile(name: string, p: Profile): void {
    const all = this.profiles();
    all[name] = { ...p, createdAt: p.createdAt ?? new Date().toISOString() };
    writeJsonAtomic(this.credentialsPath, { version: 1, profiles: all }, 0o600);
  }
  removeProfile(name: string): boolean {
    const all = this.profiles();
    if (!(name in all)) return false;
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
