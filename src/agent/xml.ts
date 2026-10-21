/**
 * VobizXML for `vobiz xml build|validate|serve`.
 *
 * The builder is a port of `buildResponseXml` from the Vobiz MCP server (src/xml.ts): the same element model,
 * attribute names, ranges and output, so a document built here is byte-for-byte what the MCP `generate_answer_xml`
 * tool produces for the same actions. Live-core quirks it respects: Record always carries an explicit `redirect`
 * (the core defaults it to true), Gather defaults to `inputType="dtmf"` and `method="POST"`.
 *
 * The validator parses any XML document (a small dependency-free parser) and checks it against the documented
 * VobizXML elements (Response, Speak, Play, Wait, Gather, Record, Dial/Number/User, Redirect, Hangup, Conference,
 * DTMF, PreAnswer, Stream). Values that would make the call fail are errors; undocumented attributes and risky
 * choices are warnings.
 */
import { z } from "zod";
import { VobizError } from "../core/errors.js";

// ───────────────────────────── builder (port of the MCP server's model) ─────────────────────────────

export const SPEAK_LANGS = [
  "da-DK", "nl-NL", "en-AU", "en-GB", "en-US", "en-IN", "fr-FR", "fr-CA", "de-DE", "it-IT",
  "pl-PL", "pt-PT", "pt-BR", "ru-RU", "es-ES", "es-US", "sv-SE", "hi-IN",
] as const;

const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), "must use https");
const audio = httpsUrl.refine((u) => {
  try {
    return /\.(mp3|wav)$/i.test(new URL(u).pathname);
  } catch {
    return false;
  }
}, "must point to an .mp3 or .wav file");
const method = z.enum(["GET", "POST"]).optional();
const finishKey = z.enum(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "none"]);

const speak = z.object({
  type: z.literal("speak"),
  text: z.string().trim().min(1).max(3000),
  voice: z.enum(["WOMAN", "MAN"]).optional(),
  language: z.enum(SPEAK_LANGS).optional(),
  loop: z.number().int().min(0).max(100).optional(),
});
const play = z.object({ type: z.literal("play"), url: audio, loop: z.number().int().min(0).max(100).optional() });
const wait = z.object({
  type: z.literal("wait"),
  length: z.number().int().min(1).max(3600),
  silence: z.boolean().optional(),
  min_silence_ms: z.number().int().min(100).max(60000).optional(),
  beep: z.boolean().optional(),
});
const gather = z.object({
  type: z.literal("gather"),
  action_url: httpsUrl.optional(),
  method,
  input_type: z.enum(["dtmf", "speech", "dtmf speech"]).optional(),
  num_digits: z.number().int().min(1).max(32).optional(),
  execution_timeout: z.number().int().min(5).max(60).optional(),
  digit_end_timeout: z.union([z.number().int().min(2).max(10), z.literal("auto")]).optional(),
  finish_on_key: finishKey.optional(),
  language: z.enum(SPEAK_LANGS).optional(),
  redirect: z.boolean().optional(),
  prompt: z.array(z.union([speak, play])).max(5).optional(),
});
const record = z.object({
  type: z.literal("record"),
  action_url: httpsUrl,
  method,
  file_format: z.enum(["mp3", "wav"]).optional(),
  max_length: z.number().int().min(1).max(14400).optional(),
  timeout: z.number().int().min(1).max(3600).optional(),
  play_beep: z.boolean().optional(),
  finish_on_key: z.string().regex(/^[0-9*#]{1,12}$/).optional(),
  redirect: z.boolean().optional(),
  callback_url: httpsUrl.optional(),
});
const dial = z.object({
  type: z.literal("dial"),
  number: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional(),
  sip_uri: z.string().regex(/^sip:[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9.-]{1,253}$/).optional(),
  caller_id: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional(),
  timeout: z.number().int().min(5).max(120).optional(),
  time_limit: z.number().int().min(10).max(14400).optional(),
  action_url: httpsUrl.optional(),
  method,
});
const redirect = z.object({ type: z.literal("redirect"), url: httpsUrl, method });
const hangup = z.object({
  type: z.literal("hangup"),
  reason: z.enum(["rejected", "busy"]).optional(),
  schedule: z.number().int().min(1).max(86400).optional(),
});

export const xmlAction = z.discriminatedUnion("type", [speak, play, wait, gather, record, dial, redirect, hangup]);
export type XmlAction = z.infer<typeof xmlAction>;
export const xmlActions = z.array(xmlAction).min(1).max(20);

export const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string);

function attrs(pairs: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
}

export interface BuildOptions {
  /** Extra check for call-control URLs (action/redirect/callback); throw to reject. */
  checkUrl?: (url: string, field: string) => void;
  /** Extra check for every dialled number; throw to reject. */
  checkDestination?: (number: string, field: string) => void;
  /** Default Gather action URL when the action has none. */
  defaultGatherAction?: string;
}

function el(a: XmlAction, o: BuildOptions, indent: string): string {
  const checkUrl = o.checkUrl ?? (() => {});
  switch (a.type) {
    case "speak":
      return `${indent}<Speak${attrs({ voice: a.voice, language: a.language, loop: a.loop })}>${escapeXml(a.text)}</Speak>`;
    case "play":
      return `${indent}<Play${attrs({ loop: a.loop })}>${escapeXml(a.url)}</Play>`;
    case "wait":
      if (a.min_silence_ms !== undefined && !a.silence) throw new VobizError("invalid_input", "wait.min_silence_ms needs silence: true.");
      if (a.silence && a.min_silence_ms !== undefined && a.length * 1000 <= a.min_silence_ms) {
        throw new VobizError("invalid_input", "wait.length (seconds) must be longer than min_silence_ms.");
      }
      return `${indent}<Wait${attrs({ length: a.length, silence: a.silence, minSilence: a.min_silence_ms, beep: a.beep })}/>`;
    case "gather": {
      const action = a.action_url ?? o.defaultGatherAction;
      if (!action) throw new VobizError("invalid_input", "gather.action_url is required.");
      if (a.action_url) checkUrl(a.action_url, "gather.action_url");
      const inner = (a.prompt ?? []).map((p) => el(p, o, indent + "    ")).join("\n");
      const open = `${indent}<Gather${attrs({
        action,
        method: a.method ?? "POST",
        inputType: a.input_type ?? "dtmf",
        numDigits: a.num_digits,
        executionTimeout: a.execution_timeout,
        digitEndTimeout: a.digit_end_timeout,
        finishOnKey: a.finish_on_key,
        language: a.language,
        redirect: a.redirect,
      })}`;
      return inner ? `${open}>\n${inner}\n${indent}</Gather>` : `${open}/>`;
    }
    case "record":
      checkUrl(a.action_url, "record.action_url");
      if (a.callback_url) checkUrl(a.callback_url, "record.callback_url");
      return `${indent}<Record${attrs({
        action: a.action_url,
        method: a.method ?? "POST",
        fileFormat: a.file_format,
        maxLength: a.max_length,
        timeout: a.timeout,
        playBeep: a.play_beep,
        finishOnKey: a.finish_on_key,
        redirect: a.redirect ?? false,
        callbackUrl: a.callback_url,
      })}/>`;
    case "dial": {
      if (!!a.number === !!a.sip_uri) throw new VobizError("invalid_input", "dial needs exactly one of number or sip_uri.");
      if (a.action_url) checkUrl(a.action_url, "dial.action_url");
      if (a.number) o.checkDestination?.(a.number, "dial.number");
      const target = a.number
        ? `${indent}    <Number>${escapeXml(a.number.startsWith("+") ? a.number : "+" + a.number)}</Number>`
        : `${indent}    <User>${escapeXml(a.sip_uri as string)}</User>`;
      return `${indent}<Dial${attrs({
        callerId: a.caller_id,
        timeout: a.timeout,
        timeLimit: a.time_limit,
        action: a.action_url,
        method: a.action_url ? (a.method ?? "POST") : undefined,
      })}>\n${target}\n${indent}</Dial>`;
    }
    case "redirect":
      checkUrl(a.url, "redirect.url");
      return `${indent}<Redirect${attrs({ method: a.method ?? "POST" })}>${escapeXml(a.url)}</Redirect>`;
    case "hangup":
      return `${indent}<Hangup${attrs({ reason: a.reason, schedule: a.schedule })}/>`;
  }
}

/** Builds a complete <Response> document. Throws invalid_input for unreachable or invalid sequences. */
export function buildResponseXml(actions: XmlAction[], o: BuildOptions = {}): string {
  const parsed = xmlActions.safeParse(actions);
  if (!parsed.success) {
    throw new VobizError("invalid_input", `Invalid XML actions: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const list = parsed.data;
  list.forEach((a, i) => {
    const terminal = a.type === "redirect" || (a.type === "hangup" && a.schedule === undefined);
    if (terminal && i < list.length - 1) {
      throw new VobizError("invalid_input", `Action ${i + 1} (${a.type}) ends the flow, so the actions after it would never run.`);
    }
  });
  const body = list.map((a) => el(a, o, "    ")).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>\n`;
  if (Buffer.byteLength(xml) > 100_000) throw new VobizError("invalid_input", "The XML document exceeds Vobiz's 100 KB limit.");
  return xml;
}

// ─────────────────────── `--attr key=value` → builder fields (XML or model names) ───────────────────────

type FieldType = "string" | "int" | "bool" | "int|auto";
/** Per action type: accepted attribute name → [model field, value type]. XML (camelCase) and model names both work. */
const ATTR_FIELDS: Record<XmlAction["type"], Record<string, [string, FieldType]>> = {
  speak: { voice: ["voice", "string"], language: ["language", "string"], loop: ["loop", "int"] },
  play: { loop: ["loop", "int"] },
  wait: { length: ["length", "int"], silence: ["silence", "bool"], minSilence: ["min_silence_ms", "int"], beep: ["beep", "bool"] },
  gather: {
    action: ["action_url", "string"],
    method: ["method", "string"],
    inputType: ["input_type", "string"],
    numDigits: ["num_digits", "int"],
    executionTimeout: ["execution_timeout", "int"],
    digitEndTimeout: ["digit_end_timeout", "int|auto"],
    finishOnKey: ["finish_on_key", "string"],
    language: ["language", "string"],
    redirect: ["redirect", "bool"],
  },
  record: {
    action: ["action_url", "string"],
    method: ["method", "string"],
    fileFormat: ["file_format", "string"],
    maxLength: ["max_length", "int"],
    timeout: ["timeout", "int"],
    playBeep: ["play_beep", "bool"],
    finishOnKey: ["finish_on_key", "string"],
    redirect: ["redirect", "bool"],
    callbackUrl: ["callback_url", "string"],
  },
  dial: {
    callerId: ["caller_id", "string"],
    timeout: ["timeout", "int"],
    timeLimit: ["time_limit", "int"],
    action: ["action_url", "string"],
    method: ["method", "string"],
  },
  redirect: { method: ["method", "string"] },
  hangup: { reason: ["reason", "string"], schedule: ["schedule", "int"] },
};

/** Attribute names `--attr` accepts for an action type (XML names), for help and error messages. */
export const attrNamesFor = (type: XmlAction["type"]): string[] => Object.keys(ATTR_FIELDS[type]);

function coerce(raw: string, t: FieldType, key: string): unknown {
  if (t === "string") return raw;
  if (t === "bool") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new VobizError("invalid_input", `--attr ${key} must be true or false.`);
  }
  if (t === "int|auto" && raw === "auto") return "auto";
  if (!/^-?\d+$/.test(raw)) throw new VobizError("invalid_input", `--attr ${key} must be a whole number${t === "int|auto" ? " or auto" : ""}.`);
  return Number(raw);
}

/** Applies one `key=value` to a draft action, using XML attribute names (numDigits) or model names (num_digits). */
export function applyAttr(action: Record<string, unknown> & { type: XmlAction["type"] }, pair: string): void {
  const eq = pair.indexOf("=");
  if (eq <= 0) throw new VobizError("invalid_input", `--attr expects key=value (got "${pair}").`);
  const key = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1);
  const table = ATTR_FIELDS[action.type];
  const entry = table[key] ?? Object.values(table).find(([field]) => field === key);
  if (!entry) {
    throw new VobizError("invalid_input", `<${tagFor(action.type)}> has no attribute "${key}" here. Use one of: ${Object.keys(table).join(", ")}.`);
  }
  action[entry[0]] = coerce(value, entry[1], key);
}

const tagFor = (t: XmlAction["type"]) => t.charAt(0).toUpperCase() + t.slice(1);

// ───────────────────────────────────────── parser ─────────────────────────────────────────

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated text and CDATA directly inside this element, trimmed. */
  text: string;
  line: number;
}

/** Parses an XML document into elements. Throws invalid_input with a line number for malformed XML. */
export function parseXml(src: string): XmlNode {
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lineAt = (pos: number) => src.slice(0, pos).split("\n").length;
  const fail = (msg: string, pos = i): never => {
    throw new VobizError("invalid_input", `line ${lineAt(pos)}: ${msg}`);
  };
  const decode = (s: string, pos: number) =>
    s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+)?(;?)/g, (_m, ent: string | undefined, semi: string) => {
      if (!ent || !semi) fail(`"&" must be escaped as &amp;`, pos);
      ent = ent as string;
      if (ent[0] === "#") {
        const code = ent[1] === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return String.fromCodePoint(code);
      }
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (!(ent in named)) fail(`unknown entity &${ent};`, pos);
      return named[ent];
    });
  const skipMisc = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("<?", i)) {
        const end = src.indexOf("?>", i);
        if (end < 0) fail("unterminated processing instruction");
        i = end + 2;
      } else if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i);
        if (end < 0) fail("unterminated comment");
        i = end + 3;
      } else if (src.startsWith("<!DOCTYPE", i) || src.startsWith("<!doctype", i)) {
        fail("DOCTYPE declarations are not allowed in VobizXML");
      } else return;
    }
  };
  const nameRe = /[A-Za-z_][\w.-]*/y;
  const readName = () => {
    nameRe.lastIndex = i;
    const m = nameRe.exec(src);
    if (!m) fail("expected a name");
    i += m![0].length;
    return m![0];
  };

  const parseElement = (): XmlNode => {
    const start = i;
    if (src[i] !== "<") fail("expected an element");
    i++;
    const name = readName();
    const node: XmlNode = { name, attrs: {}, children: [], text: "", line: lineAt(start) };
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (i >= src.length) fail(`unterminated <${name}>`, start);
      if (src.startsWith("/>", i)) {
        i += 2;
        return node;
      }
      if (src[i] === ">") {
        i++;
        break;
      }
      const attrPos = i;
      const an = readName();
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== "=") fail(`attribute ${an} on <${name}> needs a value`);
      i++;
      while (/\s/.test(src[i] ?? "")) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`attribute ${an} on <${name}> must be quoted`);
      const end = src.indexOf(q, i + 1);
      if (end < 0) fail(`unterminated value for ${an}`);
      const raw = src.slice(i + 1, end);
      if (raw.includes("<")) fail(`"<" is not allowed in attribute ${an}`);
      if (an in node.attrs) fail(`duplicate attribute ${an} on <${name}>`, attrPos);
      node.attrs[an] = decode(raw, attrPos);
      i = end + 1;
    }
    let text = "";
    for (;;) {
      if (i >= src.length) fail(`<${name}> is never closed`, start);
      if (src.startsWith("</", i)) {
        i += 2;
        const close = readName();
        if (close !== name) fail(`</${close}> does not match <${name}> (line ${node.line})`);
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] !== ">") fail(`expected ">" after </${close}`);
        i++;
        node.text = text.trim();
        return node;
      }
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i);
        if (end < 0) fail("unterminated comment");
        i = end + 3;
      } else if (src.startsWith("<![CDATA[", i)) {
        const end = src.indexOf("]]>", i);
        if (end < 0) fail("unterminated CDATA section");
        text += src.slice(i + 9, end);
        i = end + 3;
      } else if (src[i] === "<") {
        node.children.push(parseElement());
      } else {
        const next = src.indexOf("<", i);
        const end = next < 0 ? src.length : next;
        text += decode(src.slice(i, end), i);
        i = end;
      }
    }
  };

  skipMisc();
  if (i >= src.length) fail("the document is empty");
  const root = parseElement();
  skipMisc();
  if (i < src.length) fail("content after the root element");
  return root;
}

// ──────────────────────────────────────── validator ────────────────────────────────────────

export interface XmlIssue {
  level: "error" | "warning";
  line: number;
  element: string;
  message: string;
}

type Check = (v: string) => string | undefined;
const int =
  (min: number, max = Number.MAX_SAFE_INTEGER): Check =>
  (v) =>
    /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? undefined : max === Number.MAX_SAFE_INTEGER ? `must be a whole number >= ${min}` : `must be a whole number from ${min} to ${max}`;
const bool: Check = (v) => (v === "true" || v === "false" ? undefined : "must be true or false");
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    values.includes(v) ? undefined : `must be one of ${values.join(", ")}`;
const httpMethod = oneOf("GET", "POST");
const url: Check = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? undefined : "must be an http(s) URL";
  } catch {
    return "must be an absolute URL";
  }
};
const str: Check = () => undefined;
const intOrAuto = (min: number, max: number): Check => (v) => (v === "auto" ? undefined : int(min, max)(v) && `must be ${min}–${max} or auto`);
const digitKey = oneOf("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#");

interface ElementSpec {
  attrs: Record<string, Check>;
  children?: string[];
  /** "required" | "forbidden" | "optional" text content. */
  text: "required" | "forbidden" | "optional";
  textCheck?: (text: string) => string | undefined;
}

const VERBS = ["Speak", "Play", "Wait", "Gather", "Record", "Dial", "Redirect", "Hangup", "Conference", "DTMF", "PreAnswer", "Stream"];

export const ELEMENTS: Record<string, ElementSpec> = {
  Response: { attrs: {}, children: VERBS, text: "forbidden" },
  Speak: {
    attrs: { voice: oneOf("WOMAN", "MAN"), language: str, loop: int(0) },
    text: "required",
    textCheck: (t) => (t.length > 3000 ? "is longer than 3000 characters" : undefined),
  },
  Play: { attrs: { loop: int(0) }, text: "required", textCheck: url },
  Wait: { attrs: { length: int(1), silence: bool, minSilence: int(1), beep: bool }, text: "forbidden" },
  Gather: {
    attrs: {
      action: url,
      method: httpMethod,
      inputType: oneOf("dtmf", "speech", "dtmf speech"),
      executionTimeout: int(5, 60),
      digitEndTimeout: intOrAuto(2, 10),
      speechEndTimeout: intOrAuto(2, 10),
      finishOnKey: (v) => (v === "" || v === "none" || !digitKey(v) ? undefined : 'must be one digit, *, # or "none" (an empty value ends the call with hangup cause 8011)'),
      numDigits: int(1, 32),
      speechModel: oneOf("default", "command_and_search", "phone_call"),
      hints: str,
      language: str,
      interimSpeechResultsCallback: url,
      interimSpeechResultsCallbackMethod: httpMethod,
      log: bool,
      redirect: bool,
      profanityFilter: bool,
    },
    children: ["Speak", "Play"],
    text: "forbidden",
  },
  Record: {
    attrs: {
      action: url,
      method: httpMethod,
      fileFormat: oneOf("mp3", "wav"),
      redirect: bool,
      timeout: int(1),
      maxLength: int(1),
      playBeep: bool,
      finishOnKey: (v) => (/^[0-9*#]{1,12}$/.test(v) || v === "none" ? undefined : "must be digits, * or #"),
      recordSession: bool,
      startOnDialAnswer: bool,
      transcriptionType: str,
      transcriptionUrl: url,
      transcriptionMethod: httpMethod,
      callbackUrl: url,
      callbackMethod: httpMethod,
    },
    text: "forbidden",
  },
  Dial: {
    attrs: {
      action: url,
      method: httpMethod,
      callbackUrl: url,
      callbackMethod: httpMethod,
      redirect: bool,
      callerId: str,
      callerName: str,
      timeout: int(1),
      timeLimit: int(1),
      hangupOnStar: bool,
      dialMusic: (v) => (v === "real" ? undefined : url(v)),
      confirmSound: url,
      confirmKey: digitKey,
      confirmTimeout: int(1),
      digitsMatch: str,
      digitsMatchBLeg: str,
      sipHeaders: str,
    },
    children: ["Number", "User"],
    text: "forbidden",
  },
  Number: {
    attrs: { sendDigits: (v) => (/^[0-9*#wW]+$/.test(v) ? undefined : "must contain only digits, *, #, w and W"), sendOnPreanswer: bool },
    text: "required",
    textCheck: (t) => (/^\+?[1-9]\d{6,14}$/.test(t) ? undefined : "must be a phone number in E.164 format, e.g. +919876543210"),
  },
  User: {
    attrs: { sendDigits: (v) => (/^[0-9*#wW]+$/.test(v) ? undefined : "must contain only digits, *, #, w and W"), sendOnPreanswer: bool, sipHeaders: str },
    text: "required",
    textCheck: (t) => (/^sips?:[^@\s]+@[^\s]+$/.test(t) ? undefined : "must be a SIP URI, e.g. sip:alice@example.com"),
  },
  Redirect: { attrs: { method: httpMethod }, text: "required", textCheck: url },
  Hangup: { attrs: { reason: oneOf("rejected", "busy"), schedule: int(1) }, text: "forbidden" },
  Conference: {
    attrs: {
      muted: bool,
      beep: str,
      startConferenceOnEnter: bool,
      endConferenceOnExit: bool,
      maxParticipants: int(2),
      stayAlone: bool,
      enterSound: str,
      exitSound: str,
      relayDTMF: bool,
      digitsMatch: str,
      hangupOnStar: bool,
      waitSound: url,
      callbackUrl: url,
      callbackMethod: httpMethod,
      record: bool,
      recordFileFormat: oneOf("mp3", "wav"),
      timeLimit: int(1),
      action: url,
      method: httpMethod,
    },
    text: "required",
  },
  DTMF: { attrs: { async: bool }, text: "required", textCheck: (t) => (/^[0-9*#wW]+$/.test(t) ? undefined : "must contain only digits, *, #, w and W") },
  PreAnswer: { attrs: {}, children: ["Speak", "Play", "Wait"], text: "forbidden" },
  Stream: {
    attrs: {
      bidirectional: bool,
      audioTrack: oneOf("inbound", "outbound", "both"),
      streamTimeout: int(1),
      statusCallbackUrl: url,
      statusCallbackMethod: httpMethod,
      contentType: str,
      extraHeaders: str,
      maxRetries: int(0),
      keepCallAlive: bool,
    },
    text: "required",
    textCheck: (t) => (/^wss?:\/\/\S+$/.test(t) ? undefined : "must be a WebSocket URL (wss://…)"),
  },
};

/** Validates a VobizXML document. Never throws for content problems: malformed XML becomes one error issue. */
export function validateXml(src: string): XmlIssue[] {
  const issues: XmlIssue[] = [];
  if (Buffer.byteLength(src) > 100_000) issues.push({ level: "error", line: 1, element: "Response", message: "the document exceeds Vobiz's 100 KB limit" });
  let root: XmlNode;
  try {
    root = parseXml(src);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /^line (\d+): (.*)$/s.exec(msg);
    issues.push({ level: "error", line: m ? Number(m[1]) : 1, element: "", message: `not well-formed XML: ${m ? m[2] : msg}` });
    return issues;
  }
  const add = (level: XmlIssue["level"], n: XmlNode, message: string) => issues.push({ level, line: n.line, element: n.name, message });
  if (root.name !== "Response") {
    add("error", root, `the root element must be <Response>, not <${root.name}>`);
    return issues;
  }
  if (!root.children.length) add("warning", root, "<Response> is empty: Vobiz hangs up immediately");

  const visit = (n: XmlNode, parent?: XmlNode) => {
    const spec = ELEMENTS[n.name];
    if (!spec) {
      const close = Object.keys(ELEMENTS).find((k) => k.toLowerCase() === n.name.toLowerCase());
      add("error", n, `<${n.name}> is not a VobizXML element${close ? ` (element names are case-sensitive: use <${close}>)` : ""}`);
      return;
    }
    if (parent) {
      const allowed = ELEMENTS[parent.name]?.children ?? [];
      if (!allowed.includes(n.name)) add("error", n, `<${n.name}> is not allowed inside <${parent.name}>${allowed.length ? ` (allowed: ${allowed.join(", ")})` : ""}`);
    }
    for (const [k, v] of Object.entries(n.attrs)) {
      const check = spec.attrs[k];
      if (!check) {
        if (n.name === "Gather" && k === "timeout") add("error", n, 'Gather has no "timeout" attribute; use executionTimeout (5–60 seconds)');
        else {
          const close = Object.keys(spec.attrs).find((a) => a.toLowerCase() === k.toLowerCase());
          add("warning", n, `"${k}" is not a documented <${n.name}> attribute${close ? ` (did you mean ${close}?)` : ""}`);
        }
        continue;
      }
      const problem = check(v);
      if (problem) add("error", n, `${k}="${v}" ${problem}`);
    }
    if (spec.text === "required" && !n.text) add("error", n, `<${n.name}> needs text content`);
    if (spec.text === "forbidden" && n.text) add("error", n, `<${n.name}> must not contain text`);
    if (spec.textCheck && n.text) {
      const problem = spec.textCheck(n.text);
      if (problem) add("error", n, `content "${n.text.length > 60 ? n.text.slice(0, 57) + "…" : n.text}" ${problem}`);
    }
    if (!spec.children && n.children.length) add("error", n, `<${n.name}> cannot contain other elements`);
    semantic(n, add);
    n.children.forEach((c) => visit(c, n));
  };
  visit(root);

  root.children.forEach((c, idx) => {
    const terminal = c.name === "Redirect" || (c.name === "Hangup" && c.attrs.schedule === undefined);
    if (terminal && idx < root.children.length - 1) add("warning", root.children[idx + 1], `<${c.name}> on line ${c.line} ends the flow, so this element never runs`);
  });
  return issues.sort((a, b) => a.line - b.line);
}

function semantic(n: XmlNode, add: (level: XmlIssue["level"], n: XmlNode, m: string) => void): void {
  const a = n.attrs;
  switch (n.name) {
    case "Speak":
      if (a.language && !(SPEAK_LANGS as readonly string[]).includes(a.language)) add("warning", n, `language "${a.language}" is not in the documented Speak languages`);
      break;
    case "Play":
      if (n.text.startsWith("http://")) add("warning", n, "use an https URL for audio");
      else if (!/\.(mp3|wav)(\?|$)/i.test(n.text)) add("warning", n, "Play supports .mp3 and .wav files");
      break;
    case "Wait":
      if (a.minSilence !== undefined && a.silence !== "true") add("warning", n, 'minSilence only applies with silence="true"');
      if (a.silence === "true" && a.minSilence && a.length && Number(a.length) * 1000 <= Number(a.minSilence)) add("error", n, "length (seconds) must be longer than minSilence (milliseconds)");
      break;
    case "Gather":
      if (!a.action) add("error", n, "Gather needs an action URL to receive Digits/Speech");
      if (a.finishOnKey === "") add("error", n, 'finishOnKey="" ends the call (hangup cause 8011); use finishOnKey="none"');
      if (a.speechModel || a.hints || a.speechEndTimeout) {
        if (!a.inputType || a.inputType === "dtmf") add("warning", n, 'speech attributes are ignored unless inputType is "speech" or "dtmf speech"');
      }
      break;
    case "Record":
      if (!a.action) add("warning", n, "set action: the Vobiz core posts the RecordingID there when recording starts");
      if (a.redirect === undefined) add("warning", n, 'set redirect explicitly: the Vobiz core treats a missing redirect as true and fetches XML from action');
      break;
    case "Dial":
      if (!n.children.length) add("error", n, "Dial needs at least one <Number> or <User>");
      if (a.callerId && !/^\+?[1-9]\d{6,14}$/.test(a.callerId) && !a.callerId.startsWith("sip:")) add("warning", n, "callerId should be a Vobiz number in E.164 format");
      if (a.confirmKey && !a.confirmSound) add("warning", n, "confirmKey has no effect without confirmSound");
      break;
    case "Stream":
      if (n.text.startsWith("ws://")) add("warning", n, "use wss:// so audio is encrypted in transit");
      break;
  }
}
