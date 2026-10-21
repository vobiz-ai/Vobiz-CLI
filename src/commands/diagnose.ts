/**
 * `vobiz diagnose call <uuid>` and `vobiz diagnose message <id>`: read-only explainers. They gather what the API
 * knows about one call (call record, or the live/queued call while it is up, recordings, audio streams) or one
 * message (status and history), then explain the outcome in plain language using only the tables the Vobiz docs
 * publish (src/commands/diagnose-tables.ts). Anything the docs do not explain is reported as such, with a link.
 *
 * Output: a facts table plus "What happened" and "What to check next" in table/plain mode; with --output json
 * (or yaml/jsonl) one object `{facts, explanation, next_steps, links}`.
 */
import type { Command } from "commander";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";
import { op } from "../core/ops.js";
import { extractItems, paginate } from "../core/pagination.js";
import { DOCS, HANGUP_CODES, HANGUP_SOURCES, MESSAGE_STATUSES, QUALITY, SIP_HANGUP_CAUSES, SIP_RESPONSES } from "./diagnose-tables.js";
import { intArg, isRec, type Rec } from "./voice-shared.js";

const GET_CDR = op("get-cdr");
const GET_LIVE = op("get-live-call");
const GET_QUEUED = op("get-queued-call");
const LIST_RECORDINGS = op("list-recordings");
const LIST_STREAMS = op("list-streams");
const GET_MESSAGE = op("get-message");

export interface Diagnosis {
  facts: Rec;
  explanation: string[];
  next_steps: string[];
  links: string[];
}

const isNotFound = (e: unknown) => e instanceof VobizError && e.kind === "not_found";
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Keeps the keys whose value is set, in order. */
function pick(src: Rec, keys: [from: string, to?: string][]): Rec {
  const out: Rec = {};
  for (const [from, to] of keys) if (present(src[from])) out[to ?? from] = src[from];
  return out;
}

type CallState = { state: "completed"; record: Rec } | { state: "live" | "queued"; record: Rec };

/** The finished call record, else the live call, else the queued call. Throws not_found when none exists. */
async function findCall(ctx: Ctx, uuid: string): Promise<CallState> {
  try {
    const body = await ctx.client.call<Rec>(GET_CDR, { path: { call_id: uuid } });
    return { state: "completed", record: isRec(body?.data) ? (body.data as Rec) : body };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  try {
    return { state: "live", record: await ctx.client.call<Rec>(GET_LIVE, { path: { call_uuid: uuid }, query: { status: "live" } }) };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  try {
    return { state: "queued", record: await ctx.client.call<Rec>(GET_QUEUED, { path: { call_uuid: uuid }, query: { status: "queued" } }) };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  throw new VobizError(
    "not_found",
    `No call record, live call or queued call has UUID ${uuid}. A call record can take a few seconds to appear after hangup; check \`vobiz cdr recent\`.`,
  );
}

/** Recordings of the call among the newest `scan` recordings (the list endpoint has no call filter). */
async function findRecordings(ctx: Ctx, uuid: string, scan: number): Promise<{ items: Rec[]; scanned: number; error?: string }> {
  try {
    const page = await paginate<Rec>(ctx.client, LIST_RECORDINGS, {}, { limit: scan, itemsKey: "objects" });
    return { items: page.items.filter((r) => isRec(r) && r.call_uuid === uuid), scanned: page.items.length };
  } catch (e) {
    return { items: [], scanned: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function findStreams(ctx: Ctx, uuid: string): Promise<{ items: Rec[]; error?: string }> {
  try {
    const body = await ctx.client.call(LIST_STREAMS, { path: { call_uuid: uuid } });
    return { items: (extractItems(body) ?? []).filter(isRec) };
  } catch (e) {
    if (isNotFound(e)) return { items: [] };
    return { items: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Plain-language explanation of a finished call record. Exported for tests. */
export function explainCdr(cdr: Rec): Pick<Diagnosis, "explanation" | "next_steps" | "links"> {
  const explanation: string[] = [];
  const next: string[] = [];
  const links = new Set<string>([DOCS.hangupCauses]);
  const uuid = String(cdr.uuid ?? cdr.call_uuid ?? "");

  const billsec = num(cdr.billsec);
  if (present(cdr.answer_time) || (billsec ?? 0) > 0) explanation.push(`The call was answered${billsec !== undefined ? ` and billed for ${billsec}s` : ""}.`);
  else if (present(cdr.answer_time) === false && billsec !== undefined) explanation.push("The call was not answered (no answer time, 0 billable seconds).");

  const code = num(cdr.hangup_cause_code);
  const info = code !== undefined ? HANGUP_CODES[code] : undefined;
  let documented = false;
  if (code !== undefined && info) {
    documented = true;
    explanation.push(`Hangup code ${code}, "${info.cause}" (${info.group.toLowerCase()}): ${info.description}.`);
    if (!/^None\b/.test(info.nextSteps)) next.push(`${info.nextSteps}.`);
    if (code >= 8011 && code <= 8014) next.push("Fetch your XML URL yourself and check it with `vobiz xml validate <file>`.");
    if (code >= 7011 && code <= 7014) next.push("Fetch the URL yourself (for example with curl) and confirm it answers 2xx over the public internet.");
  } else if (code !== undefined) {
    explanation.push(`Hangup code ${code}${present(cdr.hangup_cause_name) ? ` ("${String(cdr.hangup_cause_name)}")` : ""} is not in the documented code table; see ${DOCS.hangupCauses}.`);
  }

  const cause = typeof cdr.hangup_cause === "string" ? cdr.hangup_cause : undefined;
  if (cause) {
    const meaning = SIP_HANGUP_CAUSES[cause.toUpperCase()];
    if (meaning) {
      documented = true;
      explanation.push(`hangup_cause ${cause}: ${meaning}.`);
    } else explanation.push(`hangup_cause ${cause} is not in the documented SIP cause table; see ${DOCS.hangupCauses}.`);
  }

  const source = typeof cdr.hangup_source === "string" ? cdr.hangup_source : undefined;
  if (source) {
    const meaning = HANGUP_SOURCES[source.toLowerCase()];
    explanation.push(`Ended by: ${source}.${meaning ? ` ${meaning}.` : ""}`);
  }

  for (const key of ["failure_code", "sip_code", "sip_response_code"]) {
    if (!present(cdr[key])) continue;
    const sip = SIP_RESPONSES[String(cdr[key]).trim()];
    if (sip) {
      documented = true;
      explanation.push(`SIP ${String(cdr[key])} ${sip.name}: ${sip.meaning}.`);
      next.push(`${sip.next}.`);
      links.add(DOCS.sip480486);
    } else {
      explanation.push(`${key} ${String(cdr[key])}${present(cdr.failure_reason) ? ` (${String(cdr.failure_reason)})` : ""}: not explained in the docs; see ${DOCS.hangupCauses}.`);
    }
    break;
  }
  if (!present(cdr.failure_code) && present(cdr.failure_reason)) explanation.push(`failure_reason: ${String(cdr.failure_reason)}.`);

  const mos = num(cdr.mos);
  const jitter = num(cdr.jitter);
  const loss = num(cdr.packet_loss);
  const poor: string[] = [];
  if (mos !== undefined && mos > 0 && mos < QUALITY.minMos) poor.push(`MOS ${mos} (below ${QUALITY.minMos})`);
  if (jitter !== undefined && jitter > QUALITY.maxJitterMs) poor.push(`jitter ${jitter} ms (above ${QUALITY.maxJitterMs} ms)`);
  if (loss !== undefined && loss > QUALITY.maxPacketLossPct) poor.push(`packet loss ${loss}% (above ${QUALITY.maxPacketLossPct}%)`);
  if (poor.length) {
    explanation.push(`Audio quality issue, separate from the hangup cause: ${poor.join(", ")}.`);
    next.push("Check the network path between your SIP endpoint or carrier and Vobiz for jitter and packet loss.");
  }

  const streaming = num(cdr.streaming_cost);
  if (streaming !== undefined && streaming > 0) explanation.push(`Audio streaming was used on this call (streaming_cost ${streaming}${present(cdr.currency) ? ` ${String(cdr.currency)}` : ""}).`);

  if (!documented && code === undefined && !cause) explanation.push(`The record has no hangup cause yet; see ${DOCS.cdr}.`);
  if (info && (info.group === "System error" || /contact support/i.test(info.nextSteps)) && uuid) {
    if (!next.some((n) => /support/i.test(n))) next.push(`Contact support@vobiz.ai with the call UUID ${uuid}.`);
  }
  if (!documented && uuid) next.push(`Open the call's debug logs in the Console (Voice → Logs → Calls) and contact support@vobiz.ai with the call UUID ${uuid} and the hangup code.`);
  links.add(DOCS.cdr);
  return { explanation, next_steps: next, links: [...links] };
}

export async function diagnoseCall(ctx: Ctx, uuid: string, o: { scan: number }): Promise<Diagnosis> {
  const found = await findCall(ctx, uuid);
  const r = found.record;
  // Streams can be listed only while the call is up; a finished call's record carries streaming_cost instead.
  const [recordings, streams] = await Promise.all([
    findRecordings(ctx, uuid, o.scan),
    found.state === "completed" ? Promise.resolve(undefined) : findStreams(ctx, uuid),
  ]);

  let facts: Rec;
  let explanation: string[];
  let next_steps: string[];
  let links: string[];
  if (found.state === "completed") {
    facts = {
      call_uuid: r.uuid ?? uuid,
      state: "completed",
      ...pick(r, [
        ["call_direction", "direction"], ["caller_id_number", "from"], ["destination_number", "to"], ["start_time"], ["answer_time"], ["end_time"],
        ["duration", "duration_s"], ["billsec"], ["ring_time", "ring_time_s"], ["hangup_cause"], ["hangup_cause_code"], ["hangup_cause_name"],
        ["hangup_source"], ["hangup_disposition"], ["failure_code"], ["failure_reason"], ["codec"], ["mos"], ["jitter"], ["packet_loss"],
        ["total_cost"], ["streaming_cost"], ["currency"], ["context"], ["trunk_id"], ["sip_call_id"],
      ]),
    };
    ({ explanation, next_steps, links } = explainCdr(r));
  } else {
    const status = String(r.call_status ?? found.state);
    facts = {
      call_uuid: r.call_uuid ?? uuid,
      state: found.state,
      ...pick(r, [["call_status", "status"], ["direction"], ["call_direction", "direction"], ["from"], ["to"], ["caller_name"]]),
    };
    explanation = [
      found.state === "live"
        ? `The call is still up (status ${status}); there is no call record until it ends.`
        : `The call is queued (status ${status}) and has not connected yet.`,
    ];
    next_steps = [`Follow it with \`vobiz calls watch ${uuid}\`, then run \`vobiz diagnose call ${uuid}\` again after it ends.`];
    links = [DOCS.cdr, DOCS.hangupCauses];
  }

  facts.recordings = recordings.error ? `not checked (${recordings.error})` : recordings.items.length;
  if (streams) facts.streams = streams.error ? `not checked (${streams.error})` : streams.items.length;
  if (recordings.items.length) {
    const ids = recordings.items.map((x) => String(x.recording_id ?? x.id ?? "")).filter(Boolean);
    explanation.push(`${ids.length} recording${ids.length === 1 ? "" : "s"} for this call: ${ids.join(", ")}.`);
    if (ids[0]) next_steps.push(`Listen to it: \`vobiz recordings download ${ids[0]}\`.`);
  } else if (!recordings.error && recordings.scanned >= o.scan) {
    explanation.push(`No recording among the newest ${recordings.scanned} recordings (raise --scan to look further back).`);
  }
  if (streams?.items.length) {
    const s = streams.items.map((x) => [x.stream_id ?? x.id, x.status ?? x.state].filter(present).join(" ")).filter(Boolean);
    explanation.push(`${streams.items.length} audio stream${streams.items.length === 1 ? "" : "s"}${s.length ? `: ${s.join(", ")}` : ""}.`);
    next_steps.push(`Test your WebSocket server offline with \`vobiz streams test <wss-url>\`.`);
    links.push(DOCS.streamEvents);
  }
  return { facts, explanation, next_steps, links };
}

/** Explanation of one message (MessageWithHistory). Exported for tests. */
export function explainMessage(m: Rec): Diagnosis {
  const status = typeof m.status === "string" ? m.status : "";
  const history = Array.isArray(m.statusHistory) ? (m.statusHistory as unknown[]).filter(isRec) : [];
  const facts: Rec = {
    ...pick(m, [["id"], ["direction"], ["channel"], ["from"], ["to"], ["status"], ["errorCode"], ["errorMessage"], ["tag"], ["scheduledAt"], ["createdAt"], ["updatedAt"]]),
  };
  if (history.length) facts.history = history.map((h) => [h.status, h.createdAt].filter(present).join(" @ ")).join(" → ");

  const explanation: string[] = [];
  const next: string[] = [];
  const meaning = MESSAGE_STATUSES[status];
  explanation.push(meaning ? `Status ${status}: ${meaning}.` : `Status ${status || "(none)"} is not one of the documented message statuses; see ${DOCS.smsMessages}.`);
  const id = String(m.id ?? "<id>");
  const to = typeof m.to === "string" ? m.to : "";
  const failure = history.find((h) => h.status === "failed" && (present(h.errorCode) || present(h.errorMessage)));
  const errorCode = m.errorCode ?? failure?.errorCode;
  const errorMessage = m.errorMessage ?? failure?.errorMessage;

  switch (status) {
    case "sent":
      next.push(`Check again later with \`vobiz diagnose message ${id}\`, or subscribe to message.delivered and message.failed with \`vobiz sms webhooks create\`.`);
      break;
    case "scheduled":
      if (present(m.scheduledAt)) explanation.push(`It is scheduled for ${String(m.scheduledAt)}.`);
      break;
    case "failed":
      if (present(errorCode) || present(errorMessage)) explanation.push(`Reason reported: ${[errorCode, errorMessage].filter(present).join(": ")}.`);
      if (to) next.push(`Check the recipient has not opted out: \`vobiz sms opt-outs check ${to}\`.`);
      if (to.startsWith("+91")) next.push("India traffic needs TRAI DLT IDs (dltEntityId, dltHeaderId, dltTemplateId) and text that matches the registered template.");
      if (to.startsWith("+1")) next.push("US long codes need a registered 10DLC brand and campaign with the number attached; US toll-free numbers need a toll-free campaign.");
      next.push("Quote the errorMessage and the message ID to support@vobiz.ai if the reason is unclear.");
      break;
    case "unknown":
      next.push(`Read the status history (\`vobiz sms messages get ${id} --json\`) for the last state the network reported.`);
      break;
    case "received":
      if (present(m.conversationId)) next.push(`Read the thread: \`vobiz sms conversations messages ${String(m.conversationId)}\`.`);
      break;
  }
  return { facts, explanation, next_steps: next, links: [DOCS.smsMessages, DOCS.smsErrors, DOCS.smsWebhooks] };
}

/** Prints a diagnosis: structured in machine modes (or with --fields/--query), a readable report otherwise. */
export function printDiagnosis(ctx: Ctx, d: Diagnosis): void {
  const mode = ctx.out.mode;
  if (mode === "json" || mode === "jsonl" || mode === "yaml" || mode === "tsv" || ctx.flags.fields?.length || ctx.flags.query || ctx.flags.quiet) {
    ctx.out.print(d);
    return;
  }
  ctx.out.print(d.facts);
  const lines = ["", "What happened:", ...d.explanation.map((l) => `  - ${l}`)];
  if (d.next_steps.length) lines.push("", "What to check next:", ...d.next_steps.map((l, i) => `  ${i + 1}. ${l}`));
  lines.push("", "Docs:", ...d.links.map((l) => `  ${l}`));
  ctx.stdout.write(lines.join("\n") + "\n");
}

export function register(program: Command, ctx: Ctx): void {
  const diagnose = program.command("diagnose").description("Explain why a call or message ended the way it did (read-only)");

  diagnose
    .command("call")
    .argument("<call-uuid>", "call UUID (from `vobiz cdr recent`, `calls list` or a webhook)")
    .description("Explain a call: hangup cause, who hung up, quality, recordings and streams, and what to check next")
    .option("--scan <n>", "how many of the newest recordings to search for this call (default: 200)", intArg(1, 10_000))
    .addHelpText(
      "after",
      `
Examples:
  vobiz diagnose call 6d8f9a2e-1b3c-4d5e-8f70-123456789abc
  vobiz diagnose call "$(vobiz cdr recent --limit 1 --query '[0].uuid' --output plain)"
  vobiz diagnose call <uuid> --json | jq .next_steps

Explanations come from the hangup-cause tables in the Vobiz docs (${DOCS.hangupCauses}).`,
    )
    .action(async (uuid: string, o: { scan?: number }) => {
      printDiagnosis(ctx, await diagnoseCall(ctx, uuid.trim(), { scan: o.scan ?? 200 }));
    });

  diagnose
    .command("message")
    .argument("<message-id>", "message ID (UUID) from `vobiz sms send` or `sms messages list`")
    .description("Explain a message's delivery status and history, and what to check next")
    .addHelpText("after", "\nExamples:\n  vobiz diagnose message 9b2e1c40-8a3d-4f5e-9c1a-7d6b2e8f4a01\n  vobiz diagnose message <id> --json")
    .action(async (id: string) => {
      const body = await ctx.client.call<Rec>(GET_MESSAGE, { path: { id: id.trim() } });
      printDiagnosis(ctx, explainMessage(isRec(body) ? body : {}));
    });
}
