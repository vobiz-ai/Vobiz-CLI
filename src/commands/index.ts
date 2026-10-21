/**
 * Every command group, in help order. A group module exports `register(program: Command, ctx: Ctx): void`.
 * To add a group: one import line and one array entry in YOUR slot below (the slots are separated so parallel
 * branches merge without conflicts).
 */
import type { RegisterFn } from "../cli.js";

// ── W1 core: auth, config, doctor, api, completion, help topics, update ──
import { register as auth } from "./auth.js";
import { register as config } from "./config.js";
import { register as doctor } from "./doctor.js";
import { register as update } from "./update.js";

// ── W2 voice: account, calls, conferences, recordings, cdr ──

// ── W3 provisioning: numbers, trunks, apps, endpoints, sub-accounts, partner ──

// ── W4 messaging: sms ──

// ── W5 agent surface: xml, webhooks, mcp, skills, docs ──
import { register as xml } from "./xml.js";
import { register as webhooks } from "./webhooks.js";
import { register as mcp } from "./mcp.js";
import { register as skills } from "./skills.js";
import { register as docs } from "./docs.js";

// ── W1 core (kept last in help): api, completion, help topics ──
import { register as api } from "./api.js";
import { register as completion } from "./completion.js";
import { register as helpTopics } from "./help-topics.js";

export const COMMAND_GROUPS: RegisterFn[] = [
  auth,
  config,
  doctor,
  update,

  // W2 voice

  // W3 provisioning

  // W4 messaging

  // W5 agent surface
  xml,
  webhooks,
  mcp,
  skills,
  docs,

  api,
  completion,
  helpTopics,
];
