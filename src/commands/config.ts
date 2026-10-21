/**
 * `vobiz config get|set|unset|list|path` for the non-secret settings in config.json. Credentials are managed by
 * login/logout/profiles, never here.
 */
import type { Command } from "commander";
import type { Settings } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";

type Key = "output" | "color" | "updateCheck" | "telemetry" | "defaultProfile";

interface KeySpec {
  description: string;
  parse(value: string, ctx: Ctx): Settings[Key];
}

const bool = (key: string) => (v: string) => {
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  throw new VobizError("invalid_input", `${key} must be true or false.`);
};

export const CONFIG_KEYS: Record<Key, KeySpec> = {
  output: {
    description: "default output on a terminal: table, json or yaml",
    parse: (v) => {
      if (v === "table" || v === "json" || v === "yaml") return v;
      throw new VobizError("invalid_input", "output must be table, json or yaml.");
    },
  },
  color: { description: "colored output (true/false)", parse: bool("color") },
  updateCheck: { description: "daily check for a newer CLI version (true/false)", parse: bool("updateCheck") },
  telemetry: { description: "anonymous usage telemetry, off unless set to true", parse: bool("telemetry") },
  defaultProfile: {
    description: "profile used when --profile is not given",
    parse: (v, ctx) => {
      if (!ctx.store.getProfile(v)) throw new VobizError("not_found", `No saved profile named "${v}".`);
      return v;
    },
  },
};

/** Names reserved by the plan for later releases. */
const RESERVED: Record<string, string> = {
  credentialStore: "The keychain credential store is not available yet; credentials are kept in a 0600 file.",
};

function keyOf(name: string): Key {
  if (name in RESERVED) throw new VobizError("unsupported", RESERVED[name]);
  if (!(name in CONFIG_KEYS)) throw new VobizError("invalid_input", `Unknown setting "${name}". Known settings: ${Object.keys(CONFIG_KEYS).join(", ")}.`);
  return name as Key;
}

export function register(program: Command, ctx: Ctx): void {
  const config = program.command("config").description("Read and change CLI settings (output, color, updateCheck, telemetry, defaultProfile)");

  config
    .command("list")
    .alias("ls")
    .description("Show every setting and its value")
    .action(() => {
      const s = ctx.store.settings();
      ctx.out.print(
        (Object.keys(CONFIG_KEYS) as Key[]).map((k) => ({ key: k, value: s[k] ?? null, description: CONFIG_KEYS[k].description })),
        { columns: ["key", "value", "description"], idKey: "key" },
      );
    });

  config
    .command("get")
    .argument("<key>", "setting name")
    .description("Print one setting")
    .action((name: string) => {
      const k = keyOf(name);
      ctx.out.print(ctx.store.settings()[k] ?? null);
    });

  config
    .command("set")
    .argument("<key>", "setting name")
    .argument("<value>", "new value")
    .description("Change a setting")
    .action((name: string, value: string) => {
      const k = keyOf(name);
      const parsed = CONFIG_KEYS[k].parse(value, ctx);
      ctx.store.patchSettings({ [k]: parsed } as Partial<Settings>);
      ctx.out.success(`${k} = ${String(parsed)}`, { key: k, value: parsed });
    });

  config
    .command("unset")
    .argument("<key>", "setting name")
    .description("Reset a setting to its default")
    .action((name: string) => {
      const k = keyOf(name);
      ctx.store.patchSettings({ [k]: undefined } as Partial<Settings>);
      ctx.out.success(`${k} reset to its default.`, { key: k, value: null });
    });

  config
    .command("path")
    .description("Print the configuration directory")
    .option("--credentials", "print the credentials file instead")
    .option("--settings", "print the settings file instead")
    .action((opts: { credentials?: boolean; settings?: boolean }) => {
      ctx.out.print(opts.credentials ? ctx.store.credentialsPath : opts.settings ? ctx.store.settingsPath : ctx.store.dir);
    });
}
