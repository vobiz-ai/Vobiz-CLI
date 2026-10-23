/**
 * `vobiz conferences`: list and inspect conference rooms, end them, moderate members (mute, deaf, kick, hang up,
 * play audio) and record a room. Room names are case-sensitive and sent URL-encoded; member ids come from the
 * `<Conference callbackUrl>` enter callback and may be a single id, a comma-separated list, or `all`.
 */
import { Option, type Command } from "commander";
import { requireConfirmation, type ConfirmDetail } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { op, type Operation } from "../core/ops.js";
import { checkUrl, hostOf, isRec, type Rec } from "./voice-shared.js";

const LIST = op("list-conferences");
const GET = op("get-conference");
const END = op("delete-conference");
const END_ALL = op("delete-all-conferences");
const START_RECORDING = op("start-conference-recording");
const STOP_RECORDING = op("stop-conference-recording");
const PLAY = op("play-audio-member");
const STOP_PLAY = op("stop-audio-member");

/** Simple member actions: verb → operation, confirmation wording, past tense. */
const MEMBER_ACTIONS: { verb: string; op: Operation; desc: string; action: string; done: string }[] = [
  { verb: "mute", op: op("mute-member"), desc: "Mute a member so the room cannot hear them", action: "Mute", done: "Muted" },
  { verb: "unmute", op: op("unmute-member"), desc: "Let a muted member speak again", action: "Unmute", done: "Unmuted" },
  { verb: "deaf", op: op("deaf-member"), desc: "Stop a member hearing the room", action: "Deafen", done: "Deafened" },
  { verb: "undeaf", op: op("undeaf-member"), desc: "Let a deafened member hear the room again", action: "Undeafen", done: "Undeafened" },
  { verb: "kick", op: op("kick-member"), desc: "Remove a member from the room; their call continues with the next XML", action: "Kick", done: "Kicked" },
  { verb: "hangup", op: op("hangup-member"), desc: "Hang up a member's call", action: "Hang up", done: "Hung up" },
];

function memberArg(member: string): string {
  const m = member.trim();
  if (!m || !/^(all|[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*)$/.test(m)) throw usage(`"${member}" is not a member id. Use an id, a comma-separated list (10,15) or all.`);
  return m;
}

const describeMembers = (m: string) => (m === "all" ? "every member" : m.includes(",") ? `members ${m}` : `member ${m}`);

async function write(ctx: Ctx, action: string, details: Record<string, string | ConfirmDetail> | undefined, run: () => Promise<unknown>, done: string, data: Rec) {
  await requireConfirmation(ctx, { action, details });
  const res = await run();
  ctx.out.success(done, isRec(res) ? res : { ...data, ok: true });
}

export function register(program: Command, ctx: Ctx): void {
  const conf = program.command("conferences").description("List, inspect, end, moderate and record conference rooms");

  conf
    .command("list")
    .alias("ls")
    .description("List conference rooms the API reports as active")
    .action(async () => {
      const body = await ctx.client.call<Rec>(LIST);
      const names = Array.isArray(body?.conferences) ? (body.conferences as unknown[]).map(String) : [];
      const mode = ctx.out.mode;
      if ((mode === "json" || mode === "yaml") && !ctx.flags.fields?.length && !ctx.flags.quiet) ctx.out.print(body);
      else ctx.out.print(names.map((name) => ({ name })), { columns: ["name"], empty: "No conferences reported (an empty list can occur while rooms are active)." });
    });

  conf
    .command("get")
    .argument("<name>", "conference room name (case-sensitive)")
    .description("Show a conference room and its members")
    .action(async (name: string) => {
      const body = await ctx.client.call<Rec>(GET, { path: { conference_name: name } });
      if (isRec(body) && body.error !== undefined && body.conference_name === undefined)
        throw new VobizError("backend_error", `Vobiz could not read conference "${name}" right now (${String(body.error)}). Try again shortly.`, 200);
      const mode = ctx.out.mode;
      if (mode === "json" || mode === "yaml" || ctx.flags.fields?.length || ctx.flags.quiet || !Array.isArray(body?.members)) {
        ctx.out.print(body, { idKey: "conference_name" });
        return;
      }
      ctx.out.status(`Conference "${String(body.conference_name)}": ${String(body.conference_member_count ?? body.members.length)} member(s), running ${String(body.conference_run_time ?? "?")}s`);
      ctx.out.print(body.members, { columns: ["member_id", "call_uuid", "from", "to", "direction", "muted", "deaf", "join_time"], idKey: "member_id", empty: "No members." });
    });

  conf
    .command("end")
    .argument("<name>", "conference room name")
    .description("End a conference room and disconnect every member")
    .action(async (name: string) => {
      await write(ctx, `End conference "${name}" and disconnect every member`, undefined, () => ctx.client.call(END, { path: { conference_name: name }, sideEffect: true }), `Ended "${name}".`, { conference_name: name });
    });

  conf
    .command("end-all")
    .description("End every active conference room on the account")
    .action(async () => {
      // Show the blast radius: the rooms that would end. A read, so it runs under --dry-run too; a failed list stops here.
      const body = await ctx.client.call<Rec>(LIST, { dryRun: false });
      const names = Array.isArray(body?.conferences) ? (body.conferences as unknown[]).map(String) : [];
      const shown = names.slice(0, 10).map((n) => JSON.stringify(n)).join(", ");
      await write(
        ctx,
        `End ALL ${names.length} conference room${names.length === 1 ? "" : "s"} and disconnect every member`,
        {
          rooms: String(names.length),
          ...(names.length ? { names: { value: names.length > 10 ? `${shown} and ${names.length - 10} more` : shown, fromApi: true, max: 400 } } : {}),
          ...(names.length ? {} : { note: "the API reported no active rooms; any it did not list are ended too" }),
        },
        () => ctx.client.call(END_ALL, { sideEffect: true }),
        "Ended all conferences.",
        { ended_all: true },
      );
    });

  const members = conf.command("members").description("Moderate conference members (id, comma-separated ids, or all)");
  for (const a of MEMBER_ACTIONS) {
    members
      .command(a.verb)
      .argument("<conference>", "conference room name")
      .argument("<member>", "member id, comma-separated ids, or all")
      .description(a.desc)
      .action(async (name: string, member: string) => {
        const m = memberArg(member);
        await write(
          ctx,
          `${a.action} ${describeMembers(m)} in "${name}"`,
          undefined,
          () => ctx.client.call(a.op, { path: { conference_name: name, member_id: m }, sideEffect: true }),
          `${a.done} ${describeMembers(m)} in "${name}".`,
          { conference_name: name, member_id: m },
        );
      });
  }

  const play = members
    .command("play")
    .argument("<conference>", "conference room name")
    .argument("<member>", "member id, comma-separated ids, or all")
    .description("Play an audio file to members (`members play stop <conference> <member>` stops it)")
    .option("--url <url>", "https URL of the audio file; required")
    .addOption(new Option("--allow-insecure-url", "allow http:// URLs on localhost, for local testing"))
    .addHelpText("after", "\nExamples:\n  vobiz conferences members play Standup all --url https://example.com/notice.mp3\n  vobiz conferences members play stop Standup all")
    .action(async (name: string, member: string, o: { url?: string; allowInsecureUrl?: boolean }) => {
      if (!o.url) throw usage("--url is required (or use `vobiz conferences members play stop <conference> <member>`).");
      const m = memberArg(member);
      const url = checkUrl(o.url, "--url", { allowInsecure: o.allowInsecureUrl });
      await write(
        ctx,
        `Play audio to ${describeMembers(m)} in "${name}"`,
        { "audio host": hostOf(url) },
        () => ctx.client.call(PLAY, { path: { conference_name: name, member_id: m }, body: { url }, sideEffect: true }),
        `Playing to ${describeMembers(m)} in "${name}".`,
        { conference_name: name, member_id: m },
      );
    });
  play
    .command("stop")
    .argument("<conference>", "conference room name")
    .argument("<member>", "member id, comma-separated ids, or all")
    .description("Stop audio playing to members")
    .action(async (name: string, member: string) => {
      const m = memberArg(member);
      await write(
        ctx,
        `Stop audio for ${describeMembers(m)} in "${name}"`,
        undefined,
        () => ctx.client.call(STOP_PLAY, { path: { conference_name: name, member_id: m }, sideEffect: true }),
        `Stopped audio for ${describeMembers(m)} in "${name}".`,
        { conference_name: name, member_id: m },
      );
    });

  const record = conf.command("record").description("Record a conference room");
  record
    .command("start")
    .argument("<conference>", "conference room name")
    .description("Start recording every member's audio in a room")
    .addOption(new Option("--format <format>", "file format").choices(["mp3", "wav"]))
    .option("--callback-url <url>", "https URL notified when the recording is ready")
    .addOption(new Option("--allow-insecure-url", "allow http:// URLs on localhost, for local testing"))
    .action(async (name: string, o: { format?: string; callbackUrl?: string; allowInsecureUrl?: boolean }) => {
      const body: Rec = {};
      if (o.format) body.file_format = o.format;
      if (o.callbackUrl) body.callback_url = checkUrl(o.callbackUrl, "--callback-url", { allowInsecure: o.allowInsecureUrl });
      await write(
        ctx,
        `Start recording conference "${name}" (billed)`,
        o.callbackUrl ? { "callback host": hostOf(o.callbackUrl) } : undefined,
        () => ctx.client.call(START_RECORDING, { path: { conference_name: name }, body, sideEffect: true }),
        `Recording "${name}".`,
        { conference_name: name },
      );
    });
  record
    .command("stop")
    .argument("<conference>", "conference room name")
    .description("Stop recording a room")
    .action(async (name: string) => {
      await write(
        ctx,
        `Stop recording conference "${name}"`,
        undefined,
        () => ctx.client.call(STOP_RECORDING, { path: { conference_name: name }, sideEffect: true }),
        `Stopped recording "${name}".`,
        { conference_name: name },
      );
    });
}
