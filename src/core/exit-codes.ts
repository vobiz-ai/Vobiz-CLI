/**
 * The documented exit codes: the single source for `vobiz help exit-codes`, docs/COMMANDS.md, the man page and the
 * generated tables in README.md, docs/AGENTS.md and docs/ARCHITECTURE.md (`npm run docs:commands` rewrites the
 * blocks between `<!-- BEGIN GENERATED exit-codes… -->` markers). Edit the text here, then regenerate.
 */
export interface ExitCodeDoc {
  code: number;
  /** One line, plain text (no Markdown), shown identically everywhere. */
  meaning: string;
  /** What an agent should do next (docs/AGENTS.md only). */
  agent: string;
}

export const EXIT_CODE_DOCS: readonly ExitCodeDoc[] = [
  { code: 0, meaning: "Success.", agent: "Continue." },
  {
    code: 1,
    meaning: "Server error or unknown failure. A 5xx on a read is retryable; a 5xx on a write is exit 7.",
    agent: "Report it; retry once, and only a read.",
  },
  { code: 2, meaning: "Usage error or invalid input.", agent: "Fix the command; check its --help." },
  {
    code: 3,
    meaning: "Authentication failed, credentials missing, access forbidden or account suspended.",
    agent: "Ask the user to run vobiz login or check the credentials.",
  },
  { code: 4, meaning: "Not found.", agent: "List again to find the right ID." },
  { code: 5, meaning: "Rate limited or insufficient balance.", agent: "Wait (rate limit) or tell the user (balance)." },
  {
    code: 6,
    meaning: "Confirmation required (pass --yes) or the action is not allowed.",
    agent: "Ask the user, then run it again with --yes.",
  },
  {
    code: 7,
    meaning:
      "Outcome unknown: a side-effecting request (call, message, purchase, transfer) timed out, lost its connection, or got a 5xx or 408 answer on a write. It may have taken effect, so it is not retryable; check the state first. The CLI never retries on its own.",
    agent: "Do not retry. Check vobiz calls list, vobiz cdr recent, vobiz sms messages list or vobiz account transactions list first.",
  },
  { code: 8, meaning: "Timeout or network error on a read (nothing was changed; safe to retry).", agent: "Retry the read." },
  { code: 130, meaning: "Interrupted (Ctrl-C).", agent: "Ask the user before running it again." },
];

const cell = (s: string): string => s.replace(/[\\|]/g, (c) => `\\${c}`);

/** The Markdown table used in README.md, docs/ARCHITECTURE.md and docs/COMMANDS.md. */
export function exitCodesMarkdown(): string {
  return ["| Code | Meaning |", "|---|---|", ...EXIT_CODE_DOCS.map((e) => `| ${e.code} | ${cell(e.meaning)} |`)].join("\n");
}

/** The Markdown table used in docs/AGENTS.md: the same meanings plus what an agent should do. */
export function exitCodesAgentsMarkdown(): string {
  return [
    "| Code | Meaning | What the agent should do |",
    "|---|---|---|",
    ...EXIT_CODE_DOCS.map((e) => `| ${e.code} | ${cell(e.meaning)} | ${cell(e.agent)} |`),
  ].join("\n");
}

/** Generated blocks in the hand-written docs: marker name → renderer. */
export const GENERATED_DOC_BLOCKS: Record<string, () => string> = {
  "exit-codes": exitCodesMarkdown,
  "exit-codes-agents": exitCodesAgentsMarkdown,
};

/**
 * Replaces every `<!-- BEGIN GENERATED <name> -->` … `<!-- END GENERATED <name> -->` block in `text` with the
 * current rendering. Unknown names are left alone.
 */
export function fillGeneratedBlocks(text: string, blocks: Record<string, () => string> = GENERATED_DOC_BLOCKS): string {
  return text.replace(
    /<!-- BEGIN GENERATED ([\w-]+) -->\n[\s\S]*?<!-- END GENERATED \1 -->/g,
    (whole, name: string) => (Object.hasOwn(blocks, name) ? `<!-- BEGIN GENERATED ${name} -->\n${blocks[name]()}\n<!-- END GENERATED ${name} -->` : whole),
  );
}
