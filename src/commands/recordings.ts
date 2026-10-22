/**
 * `vobiz recordings`: list, inspect, delete and download call and conference recordings, and queue a bulk export
 * that Vobiz emails as a download link.
 */
import { Option, type Command } from "commander";
import { requireConfirmation } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { VobizError, usage } from "../core/errors.js";
import { assertWritableTarget } from "../core/fsafe.js";
import { op } from "../core/ops.js";
import { paginate } from "../core/pagination.js";
import { toE164 } from "../core/phone.js";
import { parseRange } from "../core/time.js";
import { USER_AGENT } from "../core/version.js";
import { addListFlags, collect, hostOf, intArg, isInternalHost, isRec, printPage, streamUrl, toYmdHms, type ListFlags, type Rec } from "./voice-shared.js";

const LIST = op("list-recordings");
const GET = op("get-recording");
const DELETE = op("delete-recording");
const EXPORT = op("bulk-export-recordings");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Hosts that receive the account credentials on a recording download: the API host itself and,
 * for the production API, Vobiz's media host, which answers 401 without them (live-verified 2026-10-22).
 * Any other storage host (and any redirect target) gets no credentials.
 */
export function credentialHosts(apiHost: string): Set<string> {
  const hosts = new Set([apiHost]);
  if (apiHost === "api.vobiz.ai") hosts.add("media.vobiz.ai");
  return hosts;
}

/** Default file name: `<id>.<format>` from the record, else the URL's extension, else mp3. */
export function defaultFileName(id: string, rec: Rec, url: URL): string {
  const fmt = typeof rec.recording_format === "string" && /^[a-z0-9]{2,5}$/i.test(rec.recording_format) ? rec.recording_format.toLowerCase() : undefined;
  const ext = fmt ?? /\.([a-z0-9]{2,5})$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? "mp3";
  return `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.${ext}`;
}

interface ExportOpts {
  email: string[];
  from?: string;
  to?: string;
  ageDays?: number;
  minAgeDays?: number;
  maxAgeDays?: number;
  fromNumber?: string;
  toNumber?: string;
  callUuid?: string;
  conference?: string;
  format?: string;
  recordingId?: string;
}

export function register(program: Command, ctx: Ctx): void {
  const rec = program.command("recordings").description("List, download, delete and bulk-export call recordings");

  addListFlags(rec.command("list").alias("ls").description("List recordings, newest first"), 20)
    .addHelpText("after", "\nExamples:\n  vobiz recordings list --limit 50\n  vobiz recordings list --all --output tsv > recordings.tsv")
    .action(async (o: ListFlags) => {
      const page = await paginate(ctx.client, LIST, {}, { limit: o.limit ?? 20, all: o.all, itemsKey: "objects" });
      printPage(ctx, page, {
        itemsKey: "objects",
        columns: ["recording_id", "add_time", "call_uuid", "from_number", "to_number", "recording_duration_ms", "recording_format"],
        idKey: "recording_id",
        empty: "No recordings.",
      });
    });

  rec
    .command("get")
    .argument("<id>", "recording id")
    .description("Show a recording, including its download URL")
    .action(async (id: string) => {
      ctx.out.print(await ctx.client.call(GET, { path: { recording_id: id } }), { idKey: "recording_id" });
    });

  rec
    .command("delete")
    .alias("rm")
    .argument("<id>", "recording id")
    .description("Permanently delete a recording")
    .action(async (id: string) => {
      await requireConfirmation(ctx, { action: `Permanently delete recording ${id}` });
      await ctx.client.call(DELETE, { path: { recording_id: id }, sideEffect: true });
      ctx.out.success(`Deleted recording ${id}.`, { recording_id: id, deleted: true });
    });

  rec
    .command("download")
    .argument("<id>", "recording id")
    .description("Download a recording's audio file")
    .option("--out <file>", "where to write it (default: <id>.<format> in the current directory; - for stdout)")
    .option("--force", "overwrite an existing file")
    .option("--allow-insecure-url", "allow a recording_url on a loopback, private or link-local host (local testing only)")
    .addHelpText("after", "\nExamples:\n  vobiz recordings download 55667788-1234-5678-90ab-cdef12345678\n  vobiz recordings download <id> --out call.wav --force")
    .action(async (id: string, o: { out?: string; force?: boolean; allowInsecureUrl?: boolean }) => {
      const body = await ctx.client.call<Rec>(GET, { path: { recording_id: id } });
      const raw = isRec(body) && typeof body.recording_url === "string" ? body.recording_url : "";
      if (!raw) throw new VobizError("unexpected_response", `Recording ${id} has no recording_url yet. Try again once processing finishes.`);
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new VobizError("unexpected_response", `Recording ${id} has an invalid recording_url.`);
      }
      if (url.protocol !== "https:") throw new VobizError("unexpected_response", `Refusing to download over ${url.protocol} (expected https).`);
      // Only send credentials to the API host and Vobiz's own media host, never to a third-party storage host.
      const apiHost = new URL(ctx.client.baseUrl("voice")).host;
      // The URL comes from the API answer: never let it point the CLI at this machine or an internal network.
      if (url.host !== apiHost && isInternalHost(url.hostname) && !o.allowInsecureUrl)
        throw new VobizError("unexpected_response", `Refusing to download a recording from the internal host ${url.hostname}. Pass --allow-insecure-url for local testing.`);
      const toStdout = o.out === "-";
      const out = toStdout ? undefined : (o.out ?? defaultFileName(id, body, url));
      if (out) assertWritableTarget(out, !!o.force, "Pass --force to overwrite it or --out to pick another name.");
      const headers: Record<string, string> = { "User-Agent": USER_AGENT };
      if (credentialHosts(apiHost).has(url.host)) Object.assign(headers, { "X-Auth-ID": ctx.creds.authId, "X-Auth-Token": ctx.creds.authToken });
      const bytes = await streamUrl(ctx, url, headers, `GET recording from ${url.host}`, { out, force: o.force });
      if (out) ctx.out.success(`Saved ${out} (${bytes} bytes from ${hostOf(raw)}).`, { recording_id: id, file: out, bytes });
    });

  rec
    .command("export")
    .description("Queue a bulk export; Vobiz emails a download link (one export at a time per account)")
    .requiredOption("--email <address>", "recipient of the download link (repeat for several)", collect)
    .option("--from <when>", "start of the window (today, 7d, 2026-10-01 or ISO; default: 7 days ago)")
    .option("--to <when>", "end of the window (default: now)")
    .option("--age-days <n>", "instead of --from/--to: recordings exactly N days old", intArg(0, 3660))
    .option("--min-age-days <n>", "instead of --from/--to: recordings at least N days old", intArg(0, 3660))
    .option("--max-age-days <n>", "instead of --from/--to: recordings at most N days old", intArg(0, 3660))
    .option("--from-number <e164>", "only calls from this number (ranges of 30 days or less)")
    .option("--to-number <e164>", "only calls to this number (ranges of 30 days or less)")
    .option("--call-uuid <uuid>", "only this call, conference or multi-party call UUID")
    .option("--conference <name>", "only this conference name")
    .addOption(new Option("--format <format>", "only this recording format").choices(["mp3", "wav"]))
    .option("--recording-id <id>", "only this recording")
    .addHelpText(
      "after",
      "\nExamples:\n  vobiz recordings export --email ops@example.com --from 2026-09-01 --to 2026-09-30\n  vobiz recordings export --email ops@example.com --min-age-days 7 --max-age-days 30 --format wav --yes",
    )
    .action(async (o: ExportOpts) => {
      for (const e of o.email) if (!EMAIL.test(e)) throw usage(`"${e}" is not an email address.`);
      const byAge = o.ageDays !== undefined || o.minAgeDays !== undefined || o.maxAgeDays !== undefined;
      if (byAge && (o.from || o.to)) throw usage("Use either --from/--to or the --*-age-days filters, not both.");
      if (o.ageDays !== undefined && (o.minAgeDays !== undefined || o.maxAgeDays !== undefined)) throw usage("--age-days cannot be combined with --min-age-days/--max-age-days.");
      if ((o.minAgeDays === undefined) !== (o.maxAgeDays === undefined)) throw usage("Pass both --min-age-days and --max-age-days.");
      if (o.minAgeDays !== undefined && o.maxAgeDays !== undefined) {
        if (o.minAgeDays > o.maxAgeDays) throw usage("--min-age-days is larger than --max-age-days.");
        if (o.maxAgeDays - o.minAgeDays > 30) throw usage("The age range can span at most 30 days.");
      }
      const body: Rec = { recipient: { customer_account: o.email } };
      let window = "";
      if (o.ageDays !== undefined) {
        body.recording_storage_duration = String(o.ageDays);
        window = `recordings exactly ${o.ageDays} days old`;
      } else if (o.minAgeDays !== undefined) {
        body.recording_storage_duration__gte = String(o.minAgeDays);
        body.recording_storage_duration__lte = String(o.maxAgeDays);
        window = `recordings ${o.minAgeDays}-${o.maxAgeDays} days old`;
      } else if (o.from || o.to) {
        const now = ctx.now();
        const r = parseRange(o.from, o.to, now);
        const to = r.to && o.to && /^\d{4}-\d{2}-\d{2}$/.test(o.to.trim()) ? new Date(r.to.getFullYear(), r.to.getMonth(), r.to.getDate(), 23, 59, 59) : r.to;
        if (r.from) body.from = toYmdHms(r.from);
        if (to) body.to = toYmdHms(to);
        const start = r.from ?? new Date(now.getTime() - 7 * 86_400_000);
        if (((to ?? now).getTime() - start.getTime()) / 86_400_000 > 366) throw usage("The export window can span at most 366 days.");
        window = `${body.from ?? "7 days ago"} to ${body.to ?? "now"}`;
      } else {
        window = "the last 7 days (API default)";
      }
      if (o.fromNumber) body.from_number = toE164(o.fromNumber);
      if (o.toNumber) body.to_number = toE164(o.toNumber);
      if (o.callUuid) body.call_uuid = o.callUuid;
      if (o.conference) body.conference_name = o.conference;
      if (o.format) body.recording_format = o.format;
      if (o.recordingId) body.recording_id = o.recordingId;
      await requireConfirmation(ctx, {
        action: "Queue a bulk recording export (emailed as a download link)",
        details: { window, recipients: o.email.join(", ") },
      });
      const res = await ctx.client.call<Rec>(EXPORT, { body, sideEffect: true });
      ctx.out.success(`Export queued. ${o.email.join(", ")} will get a download link, usually within 15-60 minutes.`, res);
    });
}
