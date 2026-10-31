import type { ApprovalStore } from "./approvals.js";
import { describeAction } from "./approvals.js";
import type { CommandRecord, TaskRecord } from "./tasks.js";
import { fileChanges, fileDiff, truncate } from "./tasks.js";
import { UsageTotals } from "./deepseek.js";

const STATUS: Record<TaskRecord["status"], string> = {
  running: "running",
  done: "done",
  step_limit: "stopped at step limit",
  token_limit: "stopped at token limit",
  error: "FAILED",
};

/** Last run of each distinct command. */
function latestCommands(task: TaskRecord): CommandRecord[] {
  const byCmd = new Map<string, CommandRecord>();
  for (const c of task.commands) byCmd.set(c.command, c);
  return [...byCmd.values()];
}

const ERROR_LINE = /error|fail|not recognized|not found|cannot|exception|assert|traceback|denied|✗|×/i;

/** The single most useful line of a failed command's output. */
export function errorLine(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = [...lines].reverse().find((l) => ERROR_LINE.test(l)) ?? lines.at(-1) ?? "";
  return hit.length > 160 ? hit.slice(0, 160) + "…" : hit;
}

function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`;
}

function statusText(task: TaskRecord): string {
  const r = task.run;
  if (task.status === "step_limit" && r) return `stopped at step limit (${r.steps}/${r.maxSteps} steps)`;
  if (task.status === "token_limit" && r) {
    const raw = r.rawInputTokens > r.inputTokens ? `, cached counted lower; ${fmtTokens(r.rawInputTokens)} sent` : "";
    return `stopped at token limit (${fmtTokens(r.inputTokens)}/${fmtTokens(r.maxTokens)} input tokens${raw}, step ${r.steps}/${r.maxSteps})`;
  }
  return STATUS[task.status];
}

/** Task types whose reply is a list of findings; they get more room so the list stays whole. */
const FINDINGS_TYPES = new Set(["review", "research", "debug", "plan"]);

const NOT_DONE = /^\W*(not done|not covered|left|remaining|skipped)\b/i;
const ITEM_START = /^\s{0,3}([-*•]|\d+[.)]|#{1,6}\s|\*\*)/;

/** Split text into items: a bullet, numbered or heading line plus its continuation lines. */
function items(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const prev = out[out.length - 1];
    if (prev === undefined || ITEM_START.test(line) || NOT_DONE.test(line) || line.trim() === "" || prev.trim() === "") out.push(line);
    else out[out.length - 1] = prev + "\n" + line;
  }
  return out;
}

/**
 * Shorten a summary without cutting an item in half. Keeps the first items (findings are
 * ranked by severity) and the trailing "Not done" part, which tells Claude what is missing.
 */
export function cutSummary(text: string, budget: number, more: string): string {
  if (text.length <= budget) return text;
  const parts = items(text);
  let tailStart = parts.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (NOT_DONE.test(parts[i])) {
      tailStart = i;
      break;
    }
  }
  const tail = parts.slice(tailStart).join("\n").trim();
  const keepTail = tail.length > 0 && tail.length < budget / 3;
  const end = keepTail ? tailStart : parts.length;
  const room = budget - (keepTail ? tail.length : 0) - 100;
  const head: string[] = [];
  let len = 0;
  for (let i = 0; i < end; i++) {
    if (len + parts[i].length + 1 > room) break;
    head.push(parts[i]);
    len += parts[i].length + 1;
  }
  if (head.length === 0) head.push(parts[0].slice(0, Math.max(200, room)) + "…");
  const cut = parts.slice(head.length, end).filter((p) => p.trim()).length;
  const note = `…[${cut} more item${cut === 1 ? "" : "s"} cut; ${more}]`;
  return [head.join("\n").trimEnd(), note, keepTail ? tail : ""].filter(Boolean).join("\n");
}

/** The short report Claude sees after each task. Kept small on purpose. */
export function compactReport(task: TaskRecord, approvals: ApprovalStore, maxChars: number, detail: "brief" | "full"): string {
  const parts: string[] = [];
  const changes = fileChanges(task);
  if (changes.length) {
    parts.push("Files: " + changes.map((c) => `${c.kind} ${c.rel} +${c.added}/-${c.removed}`).join(" | "));
  }

  const cmds = latestCommands(task).filter((c) => c.status !== "denied").slice(-8);
  const cmdLine = (withErrors: boolean) => "Commands (last run): " + cmds.map((c) => {
    if (c.status === "timeout") return `TIMEOUT ${c.command}`;
    if (c.exitCode === 0 || c.exitCode === null) return `OK ${c.command}`;
    const err = withErrors ? errorLine(c.output) : "";
    return `FAIL(${c.exitCode}) ${c.command}${err ? ` → ${err}` : ""}`;
  }).join(" | ");
  const cmdIndex = cmds.length ? parts.push(cmdLine(true)) - 1 : -1;

  const pending = task.pendingIds.map((id) => approvals.get(id)).filter((a) => a !== undefined);
  if (pending.length) {
    parts.push("NEEDS USER APPROVAL (not done yet):\n" + pending.map((a) => `  ${describeAction(a)}`).join("\n") +
      "\n  → Show these to the user. approve_actions / reject_actions with the ids.");
  }

  parts.push(`DeepSeek usage: ${task.usage.summary()}`);
  if (detail === "brief") parts.push(`More: deepseek_get_report task_id=${task.id} section=summary|files|diff|commands|trace`);

  const shortened = task.run?.compactions ? `, history shortened ${task.run.compactions}×` : "";
  const header = `DeepSeek task ${task.id} [${task.type}, ${task.model}${task.readOnly ? ", read-only" : ""}] ${statusText(task)} after ${task.steps} steps${shortened}`;
  const errorText = task.error ? `Error: ${task.error}` : "";

  if (detail === "full") {
    const diffs = changes.map((c) => fileDiff(task, c.rel)).join("\n");
    return [header, errorText, task.finalText, parts.join("\n"), diffs ? truncate(diffs, 40_000) : ""].filter(Boolean).join("\n\n");
  }

  const total = FINDINGS_TYPES.has(task.type) ? maxChars * 2 : maxChars;
  const summary = task.finalText || (task.error ? "" : "(no summary)");
  // Trim the command log before touching the summary.
  if (cmdIndex >= 0 && header.length + errorText.length + summary.length + parts.join("\n").length > total) {
    parts[cmdIndex] = cmdLine(false);
  }
  const tail = parts.join("\n");
  const budget = Math.max(600, total - header.length - errorText.length - tail.length);
  const more = `full text: deepseek_get_report task_id=${task.id} section=summary`;
  return [header, errorText, cutSummary(summary, budget, more), tail].filter(Boolean).join("\n\n");
}

/** One report for a task split into areas: each area's short report, then the combined cost. */
export function mergedReport(areas: string[], list: TaskRecord[], approvals: ApprovalStore, maxChars: number): string {
  const perArea = Math.max(700, Math.round((maxChars * 2) / list.length));
  const total = new UsageTotals();
  const parts = list.map((t, i) => {
    total.merge(t.usage);
    return `## Area: ${areas[i]}
${compactReport(t, approvals, perArea, "brief")}`;
  });
  const ids = list.map((t) => t.id).join(", ");
  const done = list.filter((t) => t.status === "done").length;
  return [
    `DeepSeek split task: ${list.length} areas (${ids}), ${done} finished normally. Follow up per area with its task_id.`,
    ...parts,
    `Total DeepSeek usage: ${total.summary()}`,
  ].join("\n\n");
}

export const REPORT_SECTIONS = ["summary", "files", "diff", "commands", "trace"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export function reportSection(task: TaskRecord, section: ReportSection, filePath?: string): string {
  switch (section) {
    case "summary":
      return task.finalText || "(no summary)";
    case "files": {
      const ch = fileChanges(task);
      return ch.length ? ch.map((c) => `${c.kind} ${c.rel} +${c.added}/-${c.removed}`).join("\n") : "No file changes.";
    }
    case "diff": {
      if (filePath) return fileDiff(task, filePath.replace(/\\/g, "/").replace(/^\.\//, ""));
      const all = fileChanges(task).map((c) => fileDiff(task, c.rel)).join("\n");
      return truncate(all || "No file changes.", 60_000);
    }
    case "commands":
      return task.commands.length
        ? truncate(task.commands.map((c) => `$ ${c.command}  [${c.status}${c.exitCode !== null ? `, exit ${c.exitCode}` : ""}]\n${truncate(c.output, 4000)}`).join("\n\n"), 60_000)
        : "No commands were run.";
    case "trace": {
      const lines: string[] = [];
      for (const m of task.messages) {
        for (const tc of m.tool_calls ?? []) lines.push(`${tc.function.name} ${tc.function.arguments.slice(0, 160)}`);
      }
      return lines.length ? lines.join("\n") : "No tool calls.";
    }
  }
}
