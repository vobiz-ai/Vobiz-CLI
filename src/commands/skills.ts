/**
 * `vobiz skills list|install|update`: copy the Vobiz Agent Skills bundled in this package (skills/, refreshed from
 * the Vobiz MCP server repository by scripts/sync-skills.mjs) into a project, so Claude Code, Codex and other
 * agents load them. Needs no credentials.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { requireConfirmation } from "../core/confirm.js";
import type { Ctx } from "../core/context.js";
import { VobizError } from "../core/errors.js";

/** The skills/ folder shipped with the package (two levels up from dist/commands or src/commands). */
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));
export const DEFAULT_SKILLS_DIR = ".claude/skills";

export interface SkillInfo {
  name: string;
  version: string;
  description: string;
  path: string;
}

function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ? `metadata.${kv[2]}` : kv[2];
    out[key] = kv[3].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function bundledSkills(dir = BUNDLED_SKILLS_DIR): SkillInfo[] {
  if (!existsSync(dir)) throw new VobizError("internal_error", `The bundled skills folder is missing (${dir}). Reinstall the Vobiz CLI.`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => {
      const fm = frontMatter(readFileSync(join(dir, d.name, "SKILL.md"), "utf8"));
      return { name: fm.name || d.name, version: fm["metadata.version"] ?? "", description: fm.description ?? "", path: join(dir, d.name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Hash of every file under a folder (relative path + content), to tell an up-to-date copy from a changed one. */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) h.update(relative(dir, p).replace(/\\/g, "/")).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

function selected(all: SkillInfo[], only: string[] | undefined): SkillInfo[] {
  if (!only?.length) return all;
  const names = only.flatMap((o) => o.split(",")).map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !all.some((s) => s.name === n));
  if (unknown.length) throw new VobizError("invalid_input", `Unknown skill(s): ${unknown.join(", ")}. Run \`vobiz skills list\`.`);
  return all.filter((s) => names.includes(s.name));
}

type PlanStatus = "install" | "update" | "up to date" | "exists (run skills update)" | "not installed";
interface PlanRow {
  skill: string;
  status: PlanStatus;
  path: string;
}

export function plan(skills: SkillInfo[], dir: string, verb: "install" | "update"): PlanRow[] {
  return skills.map((s) => {
    const target = join(dir, s.name);
    if (!existsSync(target)) return { skill: s.name, status: verb === "install" ? "install" : "not installed", path: target };
    if (!statSync(target).isDirectory()) throw new VobizError("invalid_input", `${target} exists and is not a folder.`);
    if (treeHash(target) === treeHash(s.path)) return { skill: s.name, status: "up to date", path: target };
    return { skill: s.name, status: verb === "install" ? "exists (run skills update)" : "update", path: target };
  });
}

async function apply(ctx: Ctx, verb: "install" | "update", opts: { dir?: string; only?: string[] }): Promise<void> {
  const dir = resolve(opts.dir ?? DEFAULT_SKILLS_DIR);
  const all = bundledSkills();
  const rows = plan(selected(all, opts.only), dir, verb);
  const todo = rows.filter((r) => r.status === "install" || r.status === "update");
  if (verb === "update" && rows.every((r) => r.status === "not installed")) {
    throw new VobizError("not_found", `No Vobiz skills are installed in ${dir}. Run \`vobiz skills install --dir ${opts.dir ?? DEFAULT_SKILLS_DIR}\` first.`);
  }
  if (todo.length) {
    await requireConfirmation(ctx, {
      action: `${verb === "install" ? "Install" : "Update"} ${todo.length} Vobiz skill${todo.length === 1 ? "" : "s"} in ${dir}`,
      details: { skills: todo.map((r) => r.skill).join(", "), ...(verb === "update" ? { note: "replaces those folders, including any local edits" } : {}) },
    });
    if (!ctx.flags.dryRun) {
      for (const r of todo) {
        const src = all.find((s) => s.name === r.skill)!.path;
        rmSync(r.path, { recursive: true, force: true });
        cpSync(src, r.path, { recursive: true });
      }
    }
  }
  const done = rows.map((r) => ({
    ...r,
    status: ctx.flags.dryRun ? r.status : r.status === "install" ? "installed" : r.status === "update" ? "updated" : r.status,
  }));
  ctx.out.print(done, { columns: ["skill", "status", "path"], idKey: "skill" });
  if (!ctx.flags.dryRun && todo.length) ctx.out.status(`${verb === "install" ? "Installed" : "Updated"} ${todo.length} skill(s) in ${dir}. Agents load them the next time they start.`);
  else if (!todo.length) ctx.out.status("Nothing to do.");
}

export function register(program: Command, ctx: Ctx): void {
  const skills = program.command("skills").description("Install the Vobiz Agent Skills into a project for Claude Code, Codex and other agents");

  skills
    .command("list")
    .description("List the Vobiz Agent Skills bundled with this CLI")
    .option("--dir <path>", "also show whether each skill is installed in this folder")
    .action((opts: { dir?: string }) => {
      const all = bundledSkills();
      const rows = all.map((s) => {
        const row: Record<string, string> = { name: s.name, version: s.version, description: s.description };
        if (opts.dir) {
          const st = plan([s], resolve(opts.dir), "update")[0].status;
          row.installed = st === "not installed" ? "no" : st === "up to date" ? "yes" : "outdated";
        }
        return row;
      });
      ctx.out.print(rows, { columns: opts.dir ? ["name", "version", "installed", "description"] : ["name", "version", "description"], idKey: "name" });
    });

  const addOptions = (cmd: Command) =>
    cmd
      .option("--dir <path>", `skills folder in your project: ${DEFAULT_SKILLS_DIR} (Claude Code) or .agents/skills (Codex and others)`, DEFAULT_SKILLS_DIR)
      .option("--only <names...>", "only these skills (space- or comma-separated; see `vobiz skills list`)");

  addOptions(skills.command("install").description("Copy the bundled Vobiz skills into a project's skills folder (existing ones are left alone)"))
    .addHelpText(
      "after",
      `
Examples:
  vobiz skills install                                   # into ./.claude/skills
  vobiz skills install --dir .agents/skills --only vobiz-voice-xml vobiz-voice-calls
  vobiz skills install --dir ~/.claude/skills            # every project for this user`,
    )
    .action((opts: { dir?: string; only?: string[] }) => apply(ctx, "install", opts));

  addOptions(skills.command("update").description("Re-copy installed Vobiz skills from this CLI version (replaces local edits)"))
    .addHelpText("after", "\nExample:\n  npm i -g @vobiz/cli@latest && vobiz skills update")
    .action((opts: { dir?: string; only?: string[] }) => apply(ctx, "update", opts));
}
