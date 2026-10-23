/**
 * Minimal table renderer (no dependency). Columns shrink, widest first, until the table fits the terminal;
 * cut cells end in "…". Widths count code points, which is right for the ASCII data the API returns.
 */
export interface TableOptions {
  /** Terminal width; undefined means do not truncate (not a TTY). */
  width?: number;
  /** Styles the header row after widths are computed, so ANSI codes never affect layout. */
  header?: (s: string) => string;
  /** Upper bound for any one column before terminal fitting. */
  maxColumn?: number;
}

import { cleanCell } from "./sanitize.js";

const GAP = 2;
const MIN_COL = 6;
const len = (s: string) => [...s].length;

export function truncate(s: string, width: number): string {
  if (len(s) <= width) return s;
  if (width <= 1) return [...s].slice(0, width).join("");
  return [...s].slice(0, width - 1).join("") + "…";
}

/** Renders `rows` (already stringified cells) under `headers`; returns the text with a trailing newline. */
export function renderTable(headers: string[], rows: string[][], opts: TableOptions = {}): string {
  // Sanitise first (escape sequences, controls, line breaks), so widths and truncation see only printable text.
  const clean = (s: string) => cleanCell(s).replace(/\t+/g, " ");
  headers = headers.map(clean);
  const body = rows.map((r) => headers.map((_, i) => clean(r[i] ?? "")));
  const maxColumn = opts.maxColumn ?? 60;
  const widths = headers.map((h, i) => Math.min(maxColumn, Math.max(len(h), ...body.map((r) => len(r[i])))));
  if (opts.width) {
    const total = () => widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
    while (total() > opts.width) {
      let widest = 0;
      for (let i = 1; i < widths.length; i++) if (widths[i] > widths[widest]) widest = i;
      if (widths[widest] <= MIN_COL) break;
      widths[widest]--;
    }
  }
  const line = (cells: string[], style?: (s: string) => string) =>
    cells
      .map((c, i) => {
        const cell = truncate(c, widths[i]);
        const padded = i === cells.length - 1 ? cell : cell + " ".repeat(widths[i] - len(cell));
        return style ? style(padded) : padded;
      })
      .join(" ".repeat(GAP))
      .trimEnd();
  return [line(headers, opts.header), ...body.map((r) => line(r))].join("\n") + "\n";
}
