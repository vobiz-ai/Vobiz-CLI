/**
 * Terminal-safe text. API data (SMS bodies, caller names, SIP headers, resource names, backend error text) can
 * hold escape sequences that clear the screen, rewrite the clipboard (OSC 52), disguise links (OSC 8) or leave the
 * terminal in string mode. Everything the CLI prints for people (table, plain, tsv, --quiet, status lines,
 * warnings and errors) passes through `stripTerminalControls`; json and yaml stay verbatim because their encoders
 * already escape control characters.
 */

// 7-bit and 8-bit forms of the escape sequences terminals act on. String-type sequences (OSC, DCS, SOS, PM, APC)
// run to their terminator, or to the end of the text when it is missing, so a cut sequence cannot swallow output.
const SEQUENCES = new RegExp(
  [
    "\\x1b\\[[0-?]*[ -/]*[@-~]?", // CSI
    "\\x9b[0-?]*[ -/]*[@-~]?", // 8-bit CSI
    "\\x1b[\\]PX^_][\\s\\S]*?(?:\\x07|\\x1b\\\\|\\x9c|$)", // OSC, DCS, SOS, PM, APC
    "[\\x90\\x98\\x9d\\x9e\\x9f][\\s\\S]*?(?:\\x07|\\x1b\\\\|\\x9c|$)", // 8-bit string introducers
    "\\x1b[ -/]*[0-~]?", // any other ESC sequence (nF, Fp, Fe, Fs)
  ].join("|"),
  "g",
);

const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g;
const CONTROLS_AND_NEWLINES = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/g;

export interface StripOptions {
  /** Keep "\n" (multi-line messages); "\r" is always removed. */
  keepNewlines?: boolean;
}

/** Removes every escape sequence and every C0/C1 control character except "\t" (and "\n" with keepNewlines). */
export function stripTerminalControls(s: string, o: StripOptions = {}): string {
  return s.replace(SEQUENCES, "").replace(o.keepNewlines ? CONTROLS : CONTROLS_AND_NEWLINES, "");
}

/** One table or plain-mode cell: line breaks become spaces, then controls are stripped. */
export const cleanCell = (s: string): string => stripTerminalControls(s.replace(/\r\n|[\r\n\u2028\u2029]/g, " "));

/**
 * Remote-originated text (request paths, form fields, event names, close reasons, peer error text) for one log
 * line: line breaks become spaces, escape sequences and controls are removed, and the result is capped at `max`
 * characters with "…". Used by the local servers (`xml serve`, `webhooks listen`, `streams`, `calls --serve`).
 */
export function cleanLogText(value: unknown, max = 200): string {
  const s = [...cleanCell(String(value ?? ""))];
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).join("")}…` : s.join("");
}

/** A message line for stderr: newlines kept, everything else stripped. */
export const cleanMessage = (s: string): string => stripTerminalControls(s.replace(/\r\n/g, "\n"), { keepNewlines: true });

/**
 * A spreadsheet-safe TSV cell: escapes backslash, tab, CR and LF, strips controls, and prefixes a cell that a
 * spreadsheet would read as a formula (`=`, `+`, `-`, `@`) with `'`. Plain signed numbers (`-1.5`, E.164
 * `+919876543210`) are left alone: they are not formulas, and scripts cut them out of tsv output.
 */
export function tsvCell(s: string): string {
  const escaped = stripTerminalControls(s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r\n|\n/g, "\\n").replace(/\r/g, "\\r"));
  if (/^[=+\-@]/.test(escaped) && !/^[+-]?\d+(\.\d+)?$/.test(escaped)) return `'${escaped}`;
  return escaped;
}
