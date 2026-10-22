/**
 * `vobiz xml build|validate|serve`: compose, check and locally host VobizXML (the call-control markup Vobiz fetches
 * from your answer URL). Needs no credentials and never calls the Vobiz API.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Option, type Command } from "commander";
import {
  checkBindHost,
  checkToken,
  decodeBody,
  logPath,
  maskSensitive,
  newToken,
  notFound,
  parsePort,
  pathHasToken,
  readBody,
  rejectMethod,
  requestPath,
  startServer,
  tunnelHint,
  untilInterrupted,
  type LocalServer,
} from "../agent/http.js";
import { applyAttr, attrNamesFor, buildResponseXml, validateXml, type XmlAction, type XmlIssue } from "../agent/xml.js";
import type { Ctx } from "../core/context.js";
import { cleanLogText } from "../core/sanitize.js";
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

export interface XmlServeOptions {
  port: number;
  host: string;
  /** The XML already read from stdin for `xml serve -`; served from memory instead of re-reading `file`. */
  text?: string;
  /** Answer only on `/<token>` and `/<token>/…`; other paths get 404. Without it every path is answered. */
  token?: string;
  /** Log Digits, Speech, From and To in clear instead of masked. */
  logSensitive?: boolean;
}

const LOGGED_FIELDS = ["CallUUID", "From", "To", "CallStatus", "Digits", "Speech", "Event"];
const SENSITIVE_FIELDS = new Set(["From", "To", "Digits", "Speech"]);

/**
 * Starts the `xml serve` server. The file is re-read on every request, so edits apply without a restart. With
 * `opts.text` (the XML already read from stdin for `xml serve -`) that text is served from memory instead. Only GET
 * and POST are answered, and with `opts.token` only on the token path.
 */
export async function startXmlServer(ctx: Ctx, file: string, opts: XmlServeOptions): Promise<LocalServer> {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const shown = logPath(req.url, opts.token);
    const path = requestPath(req.url);
    if (!path || (opts.token && !pathHasToken(path, opts.token))) {
      ctx.out.status(`${cleanLogText(req.method, 10)} ${shown}  → 404 (${opts.token ? "missing or wrong path token" : "not a path"})`);
      return notFound(req, res);
    }
    if (rejectMethod(req, res)) {
      ctx.out.status(`${cleanLogText(req.method, 10)} ${shown}  → 405`);
      return;
    }
    const raw = await readBody(req);
    const params = decodeBody(raw, req.headers["content-type"]);
    const query = Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams);
    const fields: Record<string, unknown> = { ...query, ...(params && typeof params === "object" ? (params as Record<string, unknown>) : {}) };
    const keys = LOGGED_FIELDS.filter((k) => fields[k]);
    const show = (k: string) => (SENSITIVE_FIELDS.has(k) && !opts.logSensitive ? maskSensitive(k, fields[k]) : cleanLogText(fields[k], 80));
    ctx.out.status(`${req.method} ${shown}${keys.length ? "  " + keys.map((k) => `${k}=${show(k)}`).join(" ") : ""}`);
    let xml: string;
    try {
      xml = opts.text ?? readFileSync(file, "utf8");
    } catch (e) {
      ctx.out.warn(`cannot read ${file}: ${(e as Error).message}`);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error\n");
      return;
    }
    const { errors } = issuesSummary(validateXml(xml));
    if (errors) ctx.out.warn(`${file} has ${errors} error(s); run \`vobiz xml validate ${file}\`.`);
    res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(xml);
  };
  const server = await startServer(handler, { port: opts.port, host: opts.host, onError: (e) => ctx.out.warn(`xml serve: ${cleanLogText((e as Error)?.message ?? e)}`) });
  return opts.token ? { ...server, url: `${server.url}/${opts.token}` } : server;
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
    .argument("<file>", "XML file to serve (re-read on every request), or - to serve stdin (read once)")
    .option("--port <port>", "port to listen on (0 picks a free one)", "3000")
    .option("--host <address>", "address to bind (default 127.0.0.1); anything else also needs --allow-lan", "127.0.0.1")
    .option("--allow-lan", "allow a non-loopback --host such as 0.0.0.0 (the server is then reachable from your network)")
    .option("--token <token>", "path token to require instead of a random one (16-128 characters of A-Z a-z 0-9 - _)")
    .option("--no-token", "answer on every path instead of only /<token> (anyone who finds the URL can read the XML)")
    .option("--log-sensitive", "log Digits, Speech, From and To in clear (masked by default)")
    .addHelpText(
      "after",
      `
The file is served only on a random path, printed at start (http://127.0.0.1:3000/<token>); other paths get 404,
so only someone who knows the full URL can read your call script. GET and POST are answered; each request's
CallUUID, CallStatus and Event are logged to stderr, with From, To, Digits and Speech masked unless you pass
--log-sensitive. Stop with Ctrl-C.

Example:
  vobiz xml serve answer.xml --port 3000
  cloudflared tunnel --url http://localhost:3000     # in another terminal; answer_url = https://<tunnel>/<token>`,
    )
    .action(async (file: string, opts: { port?: string; host: string; allowLan?: boolean; token?: string | boolean; logSensitive?: boolean }) => {
      checkBindHost(ctx, opts.host, opts.allowLan);
      const token = opts.token === false ? undefined : typeof opts.token === "string" ? checkToken(opts.token) : newToken();
      const source = await readSource(ctx, file);
      const { errors } = issuesSummary(validateXml(source));
      if (errors) ctx.out.warn(`${file} has ${errors} error(s); run \`vobiz xml validate ${file}\`. Serving it anyway.`);
      const server = await startXmlServer(ctx, file, {
        port: parsePort(opts.port, 3000),
        host: opts.host,
        token,
        logSensitive: opts.logSensitive,
        ...(file === "-" ? { text: source } : {}),
      });
      if (ctx.out.explicitJson) ctx.out.print({ url: server.url, file, bind: server.bind });
      else ctx.stdout.write(server.url + "\n");
      ctx.out.status(`Serving ${file} at ${server.url} (listening on ${server.bind}; Ctrl-C to stop).`);
      if (!token) ctx.out.warn("--no-token: every path answers, so anyone who finds the URL can read this XML.");
      ctx.out.status(tunnelHint(server.port) + (token ? ` Append /${token} to it.` : ""));
      await untilInterrupted();
      await server.close();
    });
}
