/**
 * `vobiz xml build|validate|serve`: compose, check and locally host VobizXML (the call-control markup Vobiz fetches
 * from your answer URL). Needs no credentials and never calls the Vobiz API.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Option, type Command } from "commander";
import { decodeBody, parsePort, readBody, startServer, tunnelHint, untilInterrupted, type LocalServer } from "../agent/http.js";
import { applyAttr, attrNamesFor, buildResponseXml, validateXml, type XmlAction, type XmlIssue } from "../agent/xml.js";
import type { Ctx } from "../core/context.js";
import { EXIT, VobizError } from "../core/errors.js";

type Draft = Record<string, unknown> & { type: XmlAction["type"] };

/** Reads a file argument, or stdin for "-". */
export async function readSource(ctx: Ctx, file: string): Promise<string> {
  if (file === "-") return ctx.stdin.read();
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new VobizError(code === "ENOENT" ? "not_found" : "invalid_input", `Cannot read ${file}: ${code === "ENOENT" ? "no such file" : (e as Error).message}`);
  }
}

/** Collects build steps in command-line order (commander calls option parsers in the order the flags appear). */
class Steps {
  readonly list: Draft[] = [];
  /** What the next --attr applies to: the last step, or the last --prompt inside a Gather. */
  private target?: Draft;

  add(d: Draft): Draft[] {
    this.list.push(d);
    this.target = d;
    return this.list;
  }

  prompt(d: Draft, flag: string): Draft[] {
    const last = this.list[this.list.length - 1];
    if (!last || last.type !== "gather") throw new VobizError("invalid_input", `${flag} adds a prompt to the --gather before it; put it right after --gather.`);
    ((last.prompt ??= []) as Draft[]).push(d);
    this.target = d;
    return this.list;
  }

  attr(pair: string): Draft[] {
    if (!this.target) throw new VobizError("invalid_input", "--attr applies to the element before it; put it after --say, --gather, --dial and so on.");
    applyAttr(this.target, pair);
    return this.list;
  }
}

const intArg = (flag: string) => (v: string) => {
  if (!/^\d+$/.test(v)) throw new VobizError("invalid_input", `${flag} must be a whole number of seconds (got "${v}").`);
  return Number(v);
};

export function issuesSummary(issues: XmlIssue[]): { errors: number; warnings: number } {
  return { errors: issues.filter((i) => i.level === "error").length, warnings: issues.filter((i) => i.level === "warning").length };
}

/** Starts the `xml serve` server. The file is re-read on every request, so edits apply without a restart. */
export async function startXmlServer(ctx: Ctx, file: string, opts: { port: number; host: string }): Promise<LocalServer> {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    const params = decodeBody(raw, req.headers["content-type"]);
    const query = Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams);
    const fields = { ...query, ...(params && typeof params === "object" ? (params as Record<string, string>) : {}) };
    const keys = ["CallUUID", "From", "To", "CallStatus", "Digits", "Speech", "Event"].filter((k) => fields[k]);
    ctx.out.status(`${req.method} ${req.url}${keys.length ? "  " + keys.map((k) => `${k}=${fields[k]}`).join(" ") : ""}`);
    let xml: string;
    try {
      xml = readFileSync(file, "utf8");
    } catch (e) {
      ctx.out.warn(`cannot read ${file}: ${(e as Error).message}`);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("cannot read the XML file\n");
      return;
    }
    const { errors } = issuesSummary(validateXml(xml));
    if (errors) ctx.out.warn(`${file} has ${errors} error(s); run \`vobiz xml validate ${file}\`.`);
    res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" });
    res.end(xml);
  };
  return startServer(handler, opts);
}

export function register(program: Command, ctx: Ctx): void {
  const xml = program.command("xml").description("Build, validate and locally serve VobizXML call-control documents");

  const steps = new Steps();
  const build = xml.command("build");
  // Plain option descriptions: commander would print the --hangup preset as `(preset: "")`.
  build.configureHelp({ ...build.configureHelp(), optionDescription: (o) => o.description });
  build
    .description("Compose a VobizXML <Response> from flags, in the order you give them, and print it")
    .option("--say <text>", "speak text with text-to-speech (<Speak>)", (v) => steps.add({ type: "speak", text: v }))
    .option("--play <url>", "play an https .mp3 or .wav file (<Play>)", (v) => steps.add({ type: "play", url: v }))
    .option("--gather <action-url>", "collect digits or speech and post them to this https URL (<Gather>)", (v) => steps.add({ type: "gather", action_url: v }))
    .option("--prompt <text>", "speak this inside the preceding --gather (up to 5 prompts)", (v) => steps.prompt({ type: "speak", text: v }, "--prompt"))
    .option("--prompt-play <url>", "play this file inside the preceding --gather", (v) => steps.prompt({ type: "play", url: v }, "--prompt-play"))
    .option("--dial <destination>", "connect the caller to a number (+919876543210) or SIP URI (sip:alice@example.com) (<Dial>)", (v) =>
      steps.add(v.startsWith("sip:") ? { type: "dial", sip_uri: v } : { type: "dial", number: v }),
    )
    .option("--record <action-url>", "record the caller; Vobiz posts the RecordingID to this https URL (<Record>)", (v) => steps.add({ type: "record", action_url: v }))
    .option("--pause <seconds>", "wait silently for this many seconds (<Wait>)", (v) => steps.add({ type: "wait", length: intArg("--pause")(v) }))
    .option("--redirect <url>", "fetch the next VobizXML from this https URL (<Redirect>; ends this document)", (v) => steps.add({ type: "redirect", url: v }))
    .addOption(
      new Option("--hangup [reason]", "end the call, optionally with reason rejected or busy (<Hangup>)").preset("").argParser((v: string) =>
        steps.add(v ? { type: "hangup", reason: v } : { type: "hangup" }),
      ),
    )
    .option("--attr <key=value>", "set an attribute on the element before it, e.g. voice=MAN, numDigits=1, callerId=+918000000000 (repeatable)", (v) => steps.attr(v))
    .addHelpText(
      "after",
      `
Elements appear in the order of the flags. --attr applies to the element right before it; attribute names are the
VobizXML ones (camelCase):
  --say       ${attrNamesFor("speak").join(", ")}
  --play      ${attrNamesFor("play").join(", ")}
  --gather    ${attrNamesFor("gather").join(", ")}
  --dial      ${attrNamesFor("dial").join(", ")}
  --record    ${attrNamesFor("record").join(", ")}
  --pause     ${attrNamesFor("wait").join(", ")}
  --redirect  ${attrNamesFor("redirect").join(", ")}
  --hangup    ${attrNamesFor("hangup").join(", ")}

Examples:
  vobiz xml build --say "Hello from Vobiz" --hangup > answer.xml
  vobiz xml build --gather https://example.com/menu --attr numDigits=1 --prompt "Press 1 for sales" --say "No input received" --hangup
  vobiz xml build --say "Connecting you" --dial +919876543210 --attr callerId=+918000000000 --attr timeout=30
  vobiz xml build --say "Leave a message after the beep" --record https://example.com/recording --attr maxLength=120 --hangup

The XML is printed as-is (also when piped); with --json it is wrapped as {"xml": "..."}.`,
    )
    .action(() => {
      if (!steps.list.length) throw new VobizError("invalid_input", "Give at least one element, e.g. --say \"Hello\" --hangup. See `vobiz xml build --help`.");
      const doc = buildResponseXml(steps.list as XmlAction[]);
      if (ctx.out.explicitJson || ctx.out.mode === "yaml") ctx.out.print({ xml: doc });
      else ctx.stdout.write(doc);
    });

  xml
    .command("validate")
    .description("Check a VobizXML file against the documented elements and attributes")
    .argument("<file>", "XML file to check, or - for stdin")
    .option("--strict", "treat warnings as failures too")
    .addHelpText(
      "after",
      `
Errors are problems that make Vobiz reject the document or the call (exit code 2); warnings are undocumented
attributes and risky choices.

Examples:
  vobiz xml validate answer.xml
  curl -s https://example.com/answer | vobiz xml validate -`,
    )
    .action(async (file: string, opts: { strict?: boolean }) => {
      const issues = validateXml(await readSource(ctx, file));
      const { errors, warnings } = issuesSummary(issues);
      const valid = errors === 0 && !(opts.strict && warnings);
      const label = file === "-" ? "stdin" : file;
      if (ctx.out.explicitJson || ctx.out.mode === "yaml") ctx.out.print({ file: label, valid, errors, warnings, issues });
      else if (issues.length) ctx.out.print(issues, { columns: ["level", "line", "element", "message"], idKey: "message" });
      if (!(ctx.out.explicitJson || ctx.out.mode === "yaml")) {
        if (valid) ctx.out.success(`${label} is valid VobizXML${warnings ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.`);
        else ctx.out.status(`${label}: ${errors} error(s), ${warnings} warning(s).`);
      }
      if (!valid) ctx.exitCode = EXIT.invalid_input;
    });

  xml
    .command("serve")
    .description("Serve a VobizXML file over local HTTP so you can use it as an answer URL while developing")
    .argument("<file>", "XML file to serve (re-read on every request)")
    .option("--port <port>", "port to listen on (0 picks a free one)", "3000")
    .option("--host <address>", "address to bind; use 0.0.0.0 to accept connections from other machines", "127.0.0.1")
    .addHelpText(
      "after",
      `
Every request (any path, GET or POST) gets the file's current content; each request's CallUUID, From, To and
Digits are logged to stderr. Stop with Ctrl-C.

Example:
  vobiz xml serve answer.xml --port 3000
  cloudflared tunnel --url http://localhost:3000     # in another terminal; use the https URL as answer_url`,
    )
    .action(async (file: string, opts: { port?: string; host: string }) => {
      const issues = validateXml(await readSource(ctx, file));
      const { errors } = issuesSummary(issues);
      if (errors) ctx.out.warn(`${file} has ${errors} error(s); run \`vobiz xml validate ${file}\`. Serving it anyway.`);
      const server = await startXmlServer(ctx, file, { port: parsePort(opts.port, 3000), host: opts.host });
      if (ctx.out.explicitJson) ctx.out.print({ url: server.url, file });
      else ctx.stdout.write(server.url + "\n");
      ctx.out.status(`Serving ${file} at ${server.url} (Ctrl-C to stop).`);
      ctx.out.status(tunnelHint(server.port));
      await untilInterrupted();
      await server.close();
    });
}
