import type { ApprovalStore, AskUser, PendingAction } from "../approvals.js";
import { describeAction, executeAction } from "../approvals.js";
import type { Config } from "../config.js";
import type { ToolDef } from "../deepseek.js";
import { classifyCommand, describeAllowlist, isDeletion, parseCommand, toCommandString } from "../safety/commands.js";
import { resolveSafe } from "../safety/paths.js";
import type { TaskRecord } from "../tasks.js";
import { truncate } from "../tasks.js";
import { runShell } from "./command.js";
import { DEFAULT_READ_LINES, editFile, listDir, readFile, recordOriginal, writeFile } from "./fs.js";
import { globFiles, grep } from "./search.js";

export interface ToolContext {
  task: TaskRecord;
  config: Config;
  approvals: ApprovalStore;
  askUser?: AskUser;
  log: (entry: Record<string, unknown>) => void;
}

const TOOL_OUTPUT_MAX = 30_000;

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });

const READ_TOOLS: ToolDef[] = [
  fn("read_file", `Read a text file, or a line range of it. Returns numbered lines. Large files: grep first, then read only the range you need.`, {
    path: str("Workspace-relative path"),
    offset: int("First line to read (1-based, default 1)"),
    limit: int(`Max lines (default ${DEFAULT_READ_LINES})`),
  }, ["path"]),
  fn("list_dir", "List a folder as a tree (skips node_modules, .git, etc.).", {
    path: str("Folder, default '.'"),
    depth: int("Levels to descend (default 2)"),
  }),
  fn("glob", "Find files by glob pattern, e.g. 'src/**/*.ts'.", { pattern: str("Glob pattern") }, ["pattern"]),
  fn("grep", "Search file contents with a JavaScript regex. Returns path:line: text.", {
    pattern: str("Regex"),
    glob: str("Limit to files matching this glob"),
    ignore_case: bool("Case-insensitive"),
    files_only: bool("Only list matching file paths"),
    max_results: int("Default 100"),
  }, ["pattern"]),
  fn("run_command", `Run an allowlisted command in the workspace: ${describeAllowlist()}. No shell operators. Anything else: use request_command.`, {
    command: str("Command line, e.g. 'npm test'"),
  }, ["command"]),
];

const WRITE_TOOLS: ToolDef[] = [
  fn("write_file", "Create a file or fully replace its content. Parent folders are created.", {
    path: str("Workspace-relative path"),
    content: str("Full file content"),
  }, ["path", "content"]),
  fn("edit_file", "Replace an exact text snippet in a file. old_string must match exactly and be unique unless replace_all.", {
    path: str("Workspace-relative path"),
    old_string: str("Exact text to replace"),
    new_string: str("Replacement text"),
    replace_all: bool("Replace every occurrence"),
  }, ["path", "old_string", "new_string"]),
  fn("request_delete", "Ask the user to delete files or folders. You cannot delete directly; this queues the request for the user's approval.", {
    paths: { type: "array", items: { type: "string" }, description: "Workspace-relative paths" },
    reason: str("Why they should be deleted"),
  }, ["paths", "reason"]),
  fn("request_command", "Ask the user to run a command that is not on the allowlist. Queued for the user's approval.", {
    command: str("Exact command line"),
    reason: str("Why it is needed"),
  }, ["command", "reason"]),
];

export function toolDefs(readOnly: boolean): ToolDef[] {
  return readOnly ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS];
}

/** Run one tool call from DeepSeek. Never throws; errors come back as text for DeepSeek to handle. */
export async function executeTool(ctx: ToolContext, name: string, rawArgs: string): Promise<string> {
  let args: Record<string, any>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `Error: arguments are not valid JSON.`;
  }
  const allowed = toolDefs(ctx.task.readOnly).some((t) => t.function.name === name);
  if (!allowed) return `Error: tool "${name}" is not available${ctx.task.readOnly ? " (this task is read-only)" : ""}.`;

  try {
    const result = await dispatch(ctx, name, args);
    ctx.log({ tool: name, args: summarizeArgs(args), ok: true });
    return truncate(result, TOOL_OUTPUT_MAX);
  } catch (e) {
    ctx.log({ tool: name, args: summarizeArgs(args), ok: false, error: (e as Error).message });
    return `Error: ${(e as Error).message}`;
  }
}

async function dispatch(ctx: ToolContext, name: string, a: Record<string, any>): Promise<string> {
  const t = ctx.task;
  switch (name) {
    case "read_file":
      return readFile(t, a.path, a.offset ?? undefined, a.limit ?? undefined);
    case "list_dir":
      return listDir(t, a.path ?? ".", a.depth ?? 2);
    case "glob":
      return globFiles(t, a.pattern);
    case "grep":
      return grep(t, a as any);
    case "write_file":
      return writeFile(t, a.path, String(a.content ?? ""));
    case "edit_file":
      return editFile(t, a.path, String(a.old_string ?? ""), String(a.new_string ?? ""), !!a.replace_all);
    case "run_command":
      return runCommand(ctx, String(a.command ?? ""));
    case "request_delete":
      return requestDelete(ctx, a.paths, String(a.reason ?? ""));
    case "request_command":
      return requestCommand(ctx, String(a.command ?? ""), String(a.reason ?? ""));
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

async function runCommand(ctx: ToolContext, command: string): Promise<string> {
  const parsed = parseCommand(command);
  if (!parsed.ok) {
    ctx.task.commands.push({ command, exitCode: null, output: parsed.reason, status: "denied" });
    return `Not run: ${parsed.reason} Use request_command if it is really needed.`;
  }
  if (classifyCommand(parsed.argv, ctx.config.extraAllowCommands) !== "allow") {
    ctx.task.commands.push({ command, exitCode: null, output: "not on allowlist", status: "denied" });
    return `Not run: "${command}" is not on the allowlist. Use request_command with a reason if it is needed.`;
  }
  const line = toCommandString(parsed.argv);
  const r = await runShell(line, ctx.task.workspace, ctx.config.commandTimeoutMs);
  ctx.task.commands.push({ command: line, exitCode: r.exitCode, output: r.output, status: r.timedOut ? "timeout" : "ran" });
  const head = r.timedOut ? `Timed out after ${ctx.config.commandTimeoutMs / 1000}s.` : `Exit code ${r.exitCode}.`;
  return `${head}\n${truncate(r.output, 15_000)}`;
}

async function requestDelete(ctx: ToolContext, paths: unknown, reason: string): Promise<string> {
  const list = Array.isArray(paths) ? paths.map(String) : typeof paths === "string" ? [paths] : [];
  if (list.length === 0) throw new Error("paths is empty.");
  const rels = list.map((p) => {
    const s = resolveSafe(ctx.task.workspace, p, "write");
    return s.rel;
  });
  return queueOrAsk(ctx, { kind: "delete", paths: rels, reason });
}

async function requestCommand(ctx: ToolContext, command: string, reason: string): Promise<string> {
  if (!command.trim()) throw new Error("command is empty.");
  const parsed = parseCommand(command);
  const deletes = parsed.ok ? isDeletion(parsed.argv) : /\b(rm|del|rmdir|rd|erase|remove-item)\b/i.test(command);
  return queueOrAsk(ctx, { kind: "command", command: command.trim(), reason, deletes });
}

async function queueOrAsk(
  ctx: ToolContext,
  req: Pick<PendingAction, "kind" | "paths" | "command" | "reason" | "deletes">,
): Promise<string> {
  const item = ctx.approvals.add({ ...req, workspace: ctx.task.workspace, taskId: ctx.task.id });
  if (ctx.askUser) {
    let approved = false;
    try {
      approved = await ctx.askUser(`DeepSeek asks for approval:\n${describeAction(item)}`);
    } catch {
      approved = false; // fall back to the queue
    }
    if (approved) {
      ctx.approvals.remove(item.id);
      trackDeletes(ctx.task, item);
      const result = await executeAction(item, ctx.config.commandTimeoutMs);
      if (item.kind === "command") {
        ctx.task.commands.push({ command: item.command!, exitCode: null, output: result, status: "ran" });
      }
      ctx.log({ approval: item.id, approved: true, via: "elicitation" });
      return `The user approved it. Result: ${result}`;
    }
  }
  ctx.task.pendingIds.push(item.id);
  ctx.log({ approval: item.id, queued: true });
  return `Queued as ${item.id} for the user's approval; it has NOT happened yet. Continue without it and mention it in your final report.`;
}

/** Before an approved delete, remember file contents so the report can show them as deleted. */
export function trackDeletes(task: TaskRecord, item: PendingAction): void {
  if (item.kind !== "delete") return;
  for (const p of item.paths ?? []) {
    try {
      const s = resolveSafe(task.workspace, p, "write");
      recordOriginal(task, s.abs, s.rel);
    } catch {
      /* executeAction reports the problem */
    }
  }
}

function summarizeArgs(a: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  return out;
}
