/**
 * `vobiz completion bash|zsh|fish|powershell`: shell completion generated from the live command tree, so it is
 * always in step with the commands this build registers. Each script walks the words typed so far to find the
 * current command, then offers its subcommands and flags (plus the global flags).
 */
import type { Command } from "commander";
import { listCommandTree, type CommandNode } from "../cli.js";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";

export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

interface Entry {
  key: string;
  subs: { name: string; description: string }[];
  flags: { name: string; description: string; choices?: string[] }[];
}

function entries(root: CommandNode): { all: Entry[]; globals: Entry["flags"] } {
  const globals = root.options.flatMap((o) => [o.long, o.short].filter(Boolean).map((n) => ({ name: n!, description: o.description, choices: o.choices })));
  const all: Entry[] = [];
  const walk = (n: CommandNode) => {
    all.push({
      key: ["vobiz", ...n.path].join(" "),
      subs: n.subcommands.flatMap((s) => [s.name, ...s.aliases].map((name) => ({ name, description: s.description }))),
      flags: n.path.length ? n.options.flatMap((o) => [o.long, o.short].filter(Boolean).map((name) => ({ name: name!, description: o.description, choices: o.choices }))) : [],
    });
    n.subcommands.forEach(walk);
  };
  walk(root);
  return { all, globals };
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** Command keys contain only command names (letters, digits, -), never shell metacharacters. */
const commandKeys = (all: Entry[]) => all.filter((e) => e.key !== "vobiz");

export function bashScript(root: CommandNode): string {
  const { all, globals } = entries(root);
  const known = commandKeys(all).map((e) => `"${e.key}"`).join("|");
  const cases = all
    .map((e) => `    "${e.key}") words="${[...e.subs.map((s) => s.name), ...e.flags.map((f) => f.name)].join(" ")}" ;;`)
    .join("\n");
  // Value choices are scoped per command ("<key>|<flag>"): the same flag (--status, --type) takes different values on
  // different commands, so one arm per flag name would offer the first command's values everywhere.
  const choiceCases = [
    ...all.flatMap((e) => e.flags.filter((f) => f.choices?.length).map((f) => `    "${e.key}|${f.name}") COMPREPLY=( $(compgen -W "${f.choices!.join(" ")}" -- "$cur") ); return ;;`)),
    ...globals.filter((f) => f.choices?.length).map((f) => `    *"|${f.name}") COMPREPLY=( $(compgen -W "${f.choices!.join(" ")}" -- "$cur") ); return ;;`),
  ]
    .filter((v, i, a) => a.indexOf(v) === i)
    .join("\n");
  return `# bash completion for vobiz. Install: vobiz completion bash > ~/.local/share/bash-completion/completions/vobiz
_vobiz_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" key="vobiz" w i words
  for ((i=1; i<COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    [[ "$w" == -* ]] && continue
    case "$key $w" in
      ${known || '"__none__"'}) key="$key $w" ;;
    esac
  done
  case "$key|$prev" in
${choiceCases}
  esac
  case "$key" in
${cases}
  esac
  words="$words ${globals.map((g) => g.name).join(" ")}"
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -o default -F _vobiz_complete vobiz
`;
}

export function zshScript(root: CommandNode): string {
  const { all, globals } = entries(root);
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, `'\\''`);
  const known = commandKeys(all).map((e) => `"${e.key}"`).join("|");
  const cases = all
    .map((e) => {
      const items = [...e.subs.map((s) => `'${esc(s.name)}:${esc(oneLine(s.description))}'`), ...e.flags.map((f) => `'${esc(f.name)}:${esc(oneLine(f.description))}'`)];
      return `    "${e.key}") items=(${items.join(" ")}) ;;`;
    })
    .join("\n");
  const g = globals.map((f) => `'${esc(f.name)}:${esc(oneLine(f.description))}'`).join(" ");
  return `#compdef vobiz
# zsh completion for vobiz. Install: vobiz completion zsh > "\${fpath[1]}/_vobiz" (then restart the shell)
_vobiz() {
  local key="vobiz" w i
  local -a items globals
  for ((i=2; i<CURRENT; i++)); do
    w="\${words[i]}"
    [[ "$w" == -* ]] && continue
    case "$key $w" in
      ${known || '"__none__"'}) key="$key $w" ;;
    esac
  done
  case "$key" in
${cases}
  esac
  globals=(${g})
  _describe -t commands 'vobiz' items -- globals
}
if [[ "\${funcstack[1]}" == "_vobiz" ]]; then _vobiz "$@"; else compdef _vobiz vobiz; fi
`;
}

export function fishScript(root: CommandNode): string {
  const { all, globals } = entries(root);
  const lines = [
    "# fish completion for vobiz. Install: vobiz completion fish > ~/.config/fish/completions/vobiz.fish",
    `set -g __vobiz_cmds ${commandKeys(all).map((e) => sq(e.key)).join(" ")}`,
    "function __vobiz_path",
    "  set -l key vobiz",
    "  for t in (commandline -opc)[2..-1]",
    "    string match -q -- '-*' $t; and continue",
    '    if contains -- "$key $t" $__vobiz_cmds',
    '      set key "$key $t"',
    "    end",
    "  end",
    "  echo $key",
    "end",
    "complete -c vobiz -f",
  ];
  const flag = (name: string) => (name.startsWith("--") ? `-l ${name.slice(2)}` : `-s ${name.slice(1)}`);
  for (const f of globals) lines.push(`complete -c vobiz ${flag(f.name)} -d ${sq(oneLine(f.description))}${f.choices ? ` -xa ${sq(f.choices.join(" "))}` : ""}`);
  for (const e of all) {
    const cond = `-n ${sq(`test (__vobiz_path) = '${e.key}'`.replace(/'/g, '"'))}`;
    for (const s of e.subs) lines.push(`complete -c vobiz ${cond} -a ${sq(s.name)} -d ${sq(oneLine(s.description))}`);
    for (const f of e.flags) lines.push(`complete -c vobiz ${cond} ${flag(f.name)} -d ${sq(oneLine(f.description))}${f.choices ? ` -xa ${sq(f.choices.join(" "))}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

export function powershellScript(root: CommandNode): string {
  const { all, globals } = entries(root);
  const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const table = all
    .map((e) => `  ${psq(e.key)} = @(${[...e.subs.map((s) => s.name), ...e.flags.map((f) => f.name)].map(psq).join(", ")})`)
    .join("\n");
  return `# PowerShell completion for vobiz. Load it: vobiz completion powershell | Out-String | Invoke-Expression (add that line to $PROFILE to keep it)
$__vobizTree = @{
${table}
}
$__vobizGlobals = @(${globals.map((g) => psq(g.name)).join(", ")})
Register-ArgumentCompleter -Native -CommandName vobiz -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $key = 'vobiz'
  $elements = $commandAst.CommandElements | Select-Object -Skip 1
  foreach ($el in $elements) {
    $t = $el.ToString()
    if ($t -eq $wordToComplete -and $el.Extent.EndOffset -ge $cursorPosition) { break }
    if ($t.StartsWith('-')) { continue }
    if ($__vobizTree.ContainsKey("$key $t")) { $key = "$key $t" }
  }
  @($__vobizTree[$key]) + $__vobizGlobals | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function completionScript(shell: Shell, program: Command): string {
  const root = listCommandTree(program);
  switch (shell) {
    case "bash":
      return bashScript(root);
    case "zsh":
      return zshScript(root);
    case "fish":
      return fishScript(root);
    case "powershell":
      return powershellScript(root);
  }
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("completion")
    .description("Print a shell completion script (bash, zsh, fish or powershell)")
    .argument("<shell>", SHELLS.join(" | "))
    .addHelpText(
      "after",
      "\nInstall:\n  bash        vobiz completion bash > ~/.local/share/bash-completion/completions/vobiz\n  zsh         vobiz completion zsh > \"${fpath[1]}/_vobiz\"\n  fish        vobiz completion fish > ~/.config/fish/completions/vobiz.fish\n  powershell  vobiz completion powershell | Out-String | Invoke-Expression   (add this line to $PROFILE)",
    )
    .action((shell: string) => {
      if (!(SHELLS as readonly string[]).includes(shell)) throw new VobizError("invalid_input", `Unsupported shell "${shell}". Use ${SHELLS.join(", ")}.`);
      ctx.stdout.write(completionScript(shell as Shell, program));
    });
}
