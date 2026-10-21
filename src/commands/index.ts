/**
 * Every command group, in help order. A group module exports `register(program: Command, ctx: Ctx): void`.
 * To add a group: one import line and one array entry in YOUR slot below (the slots are separated so parallel
 * branches merge without conflicts).
 */
import type { RegisterFn } from "../cli.js";
import { INTERNAL_BUILD } from "../generated/build-flags.js";

// ── W1 core: auth, config, doctor, api, completion, help topics, update ──
import { register as auth } from "./auth.js";
import { register as config } from "./config.js";
import { register as doctor } from "./doctor.js";
import { register as update } from "./update.js";

// ── W2 voice: account, calls, conferences, recordings, cdr ──
import { register as account } from "./account.js";
import { register as calls } from "./calls.js";
import { register as conferences } from "./conferences.js";
import { register as recordings } from "./recordings.js";
import { register as cdr } from "./cdr.js";

// ── W3 provisioning: numbers, trunks, apps, endpoints, sub-accounts, partner ──
import { register as numbers } from "./numbers.js";
import { register as trunks } from "./trunks.js";
import { register as apps } from "./apps.js";
import { register as endpoints } from "./endpoints.js";
import { register as subAccounts } from "./sub-accounts.js";
import { register as partner } from "./partner.js";

// ── W4 messaging: sms ──
import { register as sms } from "./sms/index.js";

// ── W5 agent surface: xml, webhooks, mcp, skills, docs ──
import { register as xml } from "./xml.js";
import { register as webhooks } from "./webhooks.js";
import { register as mcp } from "./mcp.js";
import { register as skills } from "./skills.js";
import { register as docs } from "./docs.js";

// ── W9 agent ops: diagnose, streams, setup, feedback ──
import { register as diagnose } from "./diagnose.js";
import { register as feedback } from "./feedback.js";
import { register as streams } from "./streams.js";
import { register as setup } from "./setup.js";

// ── W1 core (kept last in help): api, completion, help topics ──
import { register as api } from "./api.js";
import { register as completion } from "./completion.js";
import { register as helpTopics } from "./help-topics.js";

// ── W7 internal: `vobiz internal …` lives in src/internal/ (private repo only; never synced to the public repo) ──
// The module is optional: when it is absent (the public tree) nothing is loaded. When it is present, the group is
// registered only if `internalEnabled(env)`: VOBIZ_INTERNAL=1 at run time, or a `npm run build:internal` build
// (unless VOBIZ_INTERNAL=0, which the docs/completions/man generators set so they always describe the public CLI).
const INTERNAL_MODULE = "../internal/commands/index.js"; // a variable, so tsc does not require the file to exist
const internalGroups: RegisterFn[] = await import(INTERNAL_MODULE).then(
  (m: { INTERNAL_GROUPS?: RegisterFn[] }) => m.INTERNAL_GROUPS ?? [],
  (err: NodeJS.ErrnoException) => {
    // Only "the internal module itself is missing" means "public tree"; anything else is a real bug.
    const missing = /'([^']+)'/.exec(String(err?.message))?.[1] ?? "";
    if (err?.code === "ERR_MODULE_NOT_FOUND" && /internal[\\/]commands[\\/]index(\.[jt]s)?$/.test(missing)) return [];
    throw err;
  },
);

export function internalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VOBIZ_INTERNAL === "1") return true;
  return INTERNAL_BUILD && env.VOBIZ_INTERNAL !== "0";
}

const internal: RegisterFn = (program, ctx) => {
  if (!internalGroups.length || !internalEnabled(ctx?.env ?? process.env)) return;
  for (const register of internalGroups) register(program, ctx);
};

export const COMMAND_GROUPS: RegisterFn[] = [
  auth,
  config,
  doctor,
  update,

  // W2 voice
  account,
  calls,
  conferences,
  recordings,
  cdr,

  // W3 provisioning
  numbers,
  trunks,
  apps,
  endpoints,
  subAccounts,
  partner,

  // W4 messaging
  sms,

  // W5 agent surface
  xml,
  webhooks,
  mcp,
  skills,
  docs,

  // W9 agent ops
  setup,
  diagnose,
  streams,
  feedback,

  api,
  completion,
  helpTopics,

  // W7 internal (absent unless enabled)
  internal,
];
