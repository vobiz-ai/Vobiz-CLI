/**
 * login, logout, whoami and profiles. Credentials are an Auth ID + Auth Token pair from the Vobiz console;
 * `login` verifies them with GET /api/v1/auth/me before saving them (mode 0600) so a typo never becomes a profile.
 */
import type { Command } from "commander";
import { CONSOLE_URL, SMS_BASE_URL, VOICE_BASE_URL } from "../core/config.js";
import { requireConfirmation } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { describeAuthId, profileName, resolveBaseUrls, type ResolvedCredentials } from "../core/credentials.js";
import { VobizError } from "../core/errors.js";
import { op } from "../core/ops.js";

const RETRIEVE_ACCOUNT = op("retrieve-account");

interface AccountMe {
  name?: string;
  auth_id?: string;
  [k: string]: unknown;
}

/** Parses `AUTH_ID:AUTH_TOKEN` or `{"authId": "...", "authToken": "..."}` (snake_case accepted too). */
export function parseTokenInput(text: string): { authId: string; authToken: string } {
  const t = text.trim();
  let authId: unknown;
  let authToken: unknown;
  if (t.startsWith("{")) {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(t) as Record<string, unknown>;
    } catch {
      throw new VobizError("invalid_input", "stdin is not valid JSON. Pass AUTH_ID:AUTH_TOKEN or {\"authId\":\"…\",\"authToken\":\"…\"}.");
    }
    authId = j.authId ?? j.auth_id;
    authToken = j.authToken ?? j.auth_token;
  } else {
    const i = t.indexOf(":");
    if (i > 0) {
      authId = t.slice(0, i);
      authToken = t.slice(i + 1);
    }
  }
  if (typeof authId !== "string" || typeof authToken !== "string" || !authId.trim() || !authToken.trim())
    throw new VobizError("invalid_input", "Could not read credentials from stdin. Pass AUTH_ID:AUTH_TOKEN or {\"authId\":\"…\",\"authToken\":\"…\"}.");
  return validatePair(authId, authToken);
}

function validatePair(authId: string, authToken: string): { authId: string; authToken: string } {
  const id = authId.trim();
  const token = authToken.trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) throw new VobizError("invalid_input", "That does not look like a Vobiz Auth ID (for example MA_XXXXXXXX).");
  if (token.length < 8 || /\s/.test(token)) throw new VobizError("invalid_input", "That does not look like a Vobiz Auth Token.");
  return { authId: id, authToken: token };
}

async function collectCredentials(ctx: Ctx, opts: { withToken?: boolean; browser?: boolean }): Promise<{ authId: string; authToken: string }> {
  if (opts.withToken) return parseTokenInput(await ctx.stdin.read());
  if (ctx.flags.authId || ctx.flags.authToken) {
    if (!ctx.flags.authId || !ctx.flags.authToken) throw new VobizError("invalid_input", "Pass both --auth-id and --auth-token, or neither.");
    return validatePair(ctx.flags.authId, ctx.flags.authToken);
  }
  if (!ctx.isTTY.stdin)
    throw new VobizError("invalid_input", "stdin is not a terminal. Use `vobiz login --with-token` (reads AUTH_ID:AUTH_TOKEN from stdin) or set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN.");
  if (opts.browser) {
    ctx.stderr.write(`Opening ${CONSOLE_URL} . Copy your Auth ID and Auth Token from the dashboard.\n`);
    await ctx.openUrl(CONSOLE_URL);
  } else {
    ctx.stderr.write(`Find your Auth ID and Auth Token in the Vobiz console: ${CONSOLE_URL}\n`);
  }
  const authId = await ctx.prompts.input("Auth ID:");
  const authToken = await ctx.prompts.password("Auth Token:");
  return validatePair(authId, authToken);
}

function registerLogin(program: Command, ctx: Ctx) {
  program
    .command("login")
    .description("Save and verify a Vobiz Auth ID and Auth Token as a profile")
    .option("--with-token", "read AUTH_ID:AUTH_TOKEN or JSON {authId, authToken} from stdin (CI)")
    .option("--browser", "open the Vobiz console to copy your credentials, then prompt")
    .option("--default", "make this profile the default")
    .addHelpText(
      "after",
      "\nExamples:\n  vobiz login\n  vobiz login --profile staging\n  printf '%s:%s' \"$VOBIZ_AUTH_ID\" \"$VOBIZ_AUTH_TOKEN\" | vobiz login --with-token",
    )
    .action(async (opts: { withToken?: boolean; browser?: boolean; default?: boolean }) => {
      const name = profileName(ctx.flags, ctx.store, ctx.env);
      const pair = await collectCredentials(ctx, opts);
      const existing = ctx.store.getProfile(name);
      const creds: ResolvedCredentials = {
        ...pair,
        ...resolveBaseUrls(ctx.flags, ctx.env, existing, (m) => ctx.log("warn", m)),
        source: "flags",
        profile: name,
      };
      let me: AccountMe | undefined;
      try {
        me = await ctx.makeClient(creds).call<AccountMe>(RETRIEVE_ACCOUNT);
      } catch (err) {
        if (err instanceof VobizError && (err.kind === "auth_failed" || err.kind === "forbidden"))
          throw new VobizError("auth_failed", "Vobiz rejected these credentials. Check the Auth ID and Auth Token in the console and try again.", err.status);
        throw err;
      }
      const accountName = typeof me?.name === "string" && me.name ? me.name : undefined;
      ctx.store.setProfile(name, {
        authId: pair.authId,
        authToken: pair.authToken,
        accountName,
        ...(creds.voiceBaseUrl !== VOICE_BASE_URL ? { voiceBaseUrl: creds.voiceBaseUrl } : {}),
        ...(creds.smsBaseUrl !== SMS_BASE_URL ? { smsBaseUrl: creds.smsBaseUrl } : {}),
        createdAt: existing?.createdAt,
      });
      const settings = ctx.store.settings();
      const makeDefault = !!opts.default || !settings.defaultProfile || !ctx.store.getProfile(settings.defaultProfile);
      if (makeDefault) ctx.store.patchSettings({ defaultProfile: name });
      ctx.resetAuth();
      const who = `${accountName ?? pair.authId} (${pair.authId}, ${describeAuthId(pair.authId)})`;
      ctx.out.success(`Logged in to ${who}. Saved profile "${name}"${makeDefault ? " (default)" : ""} to ${ctx.store.credentialsPath}.`, {
        profile: name,
        auth_id: pair.authId,
        account_name: accountName ?? null,
        account_type: describeAuthId(pair.authId),
        default: makeDefault || ctx.store.settings().defaultProfile === name,
        credentials_file: ctx.store.credentialsPath,
      });
    });
}

function registerLogout(program: Command, ctx: Ctx) {
  program
    .command("logout")
    .description("Remove saved credentials (the selected profile, or --all)")
    .option("--all", "remove every saved profile")
    .action(async (opts: { all?: boolean }) => {
      const names = opts.all ? Object.keys(ctx.store.profiles()) : [profileName(ctx.flags, ctx.store, ctx.env)];
      if (!opts.all && !ctx.store.getProfile(names[0])) throw new VobizError("not_found", `No saved profile named "${names[0]}".`);
      if (ctx.flags.dryRun) {
        ctx.stderr.write(`[dry-run] would remove ${names.length ? names.map((n) => `"${n}"`).join(", ") : "no profiles"}\n`);
        return;
      }
      for (const n of names) ctx.store.removeProfile(n);
      if (opts.all) ctx.store.patchSettings({ defaultProfile: undefined });
      ctx.resetAuth();
      ctx.out.success(names.length ? `Removed ${names.map((n) => `"${n}"`).join(", ")} from ${ctx.store.credentialsPath}.` : "No saved profiles.", {
        removed: names,
      });
    });
}

function registerWhoami(program: Command, ctx: Ctx) {
  program
    .command("whoami")
    .description("Show the account, Auth ID and credential source in use (offline; --check verifies with the API)")
    .option("--check", "verify the credentials with GET /api/v1/auth/me")
    .action(async (opts: { check?: boolean }) => {
      const c = ctx.creds;
      const saved = c.profile ? ctx.store.getProfile(c.profile) : undefined;
      const data: Record<string, unknown> = {
        auth_id: c.authId,
        account_type: describeAuthId(c.authId),
        account_name: saved?.accountName ?? null,
        source: c.source,
        profile: c.profile ?? null,
        voice_base_url: c.voiceBaseUrl,
        sms_base_url: c.smsBaseUrl,
      };
      if (opts.check) {
        const me = await ctx.client.call<AccountMe>(RETRIEVE_ACCOUNT);
        data.verified = true;
        if (typeof me?.name === "string") data.account_name = me.name;
        data.account = me;
      }
      ctx.out.print(data);
    });
}

function registerProfiles(program: Command, ctx: Ctx) {
  const profiles = program.command("profiles").description("List, switch, rename and remove saved logins");

  profiles
    .command("list")
    .alias("ls")
    .description("List saved profiles (tokens are never shown)")
    .action(() => {
      const def = ctx.store.settings().defaultProfile;
      const rows = Object.entries(ctx.store.profiles()).map(([name, p]) => ({
        name,
        default: name === def,
        auth_id: p.authId,
        account_name: p.accountName ?? null,
        voice_base_url: p.voiceBaseUrl ?? null,
        created_at: p.createdAt ?? null,
      }));
      ctx.out.print(rows, { columns: ["name", "default", "auth_id", "account_name", "created_at"], idKey: "name", empty: "No saved profiles. Run `vobiz login`." });
    });

  profiles
    .command("use")
    .argument("<name>", "profile to make the default")
    .description("Make a profile the default")
    .action((name: string) => {
      if (!ctx.store.getProfile(name)) throw new VobizError("not_found", `No saved profile named "${name}". Run \`vobiz profiles list\`.`);
      ctx.store.patchSettings({ defaultProfile: name });
      ctx.out.success(`"${name}" is now the default profile.`, { default_profile: name });
    });

  profiles
    .command("remove")
    .alias("rm")
    .argument("<name>", "profile to remove")
    .description("Delete a saved profile and its credentials")
    .action(async (name: string) => {
      if (!ctx.store.getProfile(name)) throw new VobizError("not_found", `No saved profile named "${name}".`);
      await requireConfirmation(ctx, { action: `Remove the saved profile "${name}"`, details: { file: ctx.store.credentialsPath } });
      if (ctx.flags.dryRun) return;
      ctx.store.removeProfile(name);
      ctx.out.success(`Removed profile "${name}".`, { removed: [name] });
    });

  profiles
    .command("rename")
    .argument("<from>", "current name")
    .argument("<to>", "new name")
    .description("Rename a saved profile")
    .action((from: string, to: string) => {
      const p = ctx.store.getProfile(from);
      if (!p) throw new VobizError("not_found", `No saved profile named "${from}".`);
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(to)) throw new VobizError("invalid_input", "Profile names may use letters, digits, _ . and - (1-64 characters).");
      if (ctx.store.getProfile(to)) throw new VobizError("invalid_input", `A profile named "${to}" already exists.`);
      const wasDefault = ctx.store.settings().defaultProfile === from;
      ctx.store.setProfile(to, p);
      ctx.store.removeProfile(from);
      if (wasDefault) ctx.store.patchSettings({ defaultProfile: to });
      ctx.out.success(`Renamed "${from}" to "${to}".`, { from, to, default: wasDefault });
    });
}

export function register(program: Command, ctx: Ctx): void {
  registerLogin(program, ctx);
  registerLogout(program, ctx);
  registerWhoami(program, ctx);
  registerProfiles(program, ctx);
}
