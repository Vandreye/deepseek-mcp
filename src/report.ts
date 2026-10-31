import type { ApprovalStore } from "./approvals.js";
import { describeAction } from "./approvals.js";
import type { CommandRecord, TaskRecord } from "./tasks.js";
import { fileChanges, fileDiff, truncate } from "./tasks.js";

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

function lastLines(text: string, n: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-n).map((l) => `    ${l.slice(0, 200)}`).join("\n");
}

/** The short report Claude sees after each task. Kept small on purpose. */
export function compactReport(task: TaskRecord, approvals: ApprovalStore, maxChars: number, detail: "brief" | "full"): string {
  const parts: string[] = [];
  const changes = fileChanges(task);
  if (changes.length) {
    parts.push("Files: " + changes.map((c) => `${c.kind} ${c.rel} +${c.added}/-${c.removed}`).join(" | "));
  }

  const cmds = latestCommands(task).filter((c) => c.status !== "denied");
  if (cmds.length) {
    const line = cmds.slice(-8).map((c) => {
      if (c.status === "timeout") return `TIMEOUT ${c.command}`;
      return `${c.exitCode === 0 ? "OK" : `FAIL(${c.exitCode})`} ${c.command}`;
    });
    parts.push("Commands (last run): " + line.join(" | "));
    for (const c of cmds) {
      if (c.status === "ran" && c.exitCode !== 0 && c.exitCode !== null) parts.push(`  ${c.command} tail:\n${lastLines(c.output, 8)}`);
    }
  }

  const pending = task.pendingIds.map((id) => approvals.get(id)).filter((a) => a !== undefined);
  if (pending.length) {
    parts.push("NEEDS USER APPROVAL (not done yet):\n" + pending.map((a) => `  ${describeAction(a)}`).join("\n") +
      "\n  → Show these to the user. approve_actions / reject_actions with the ids.");
  }

  parts.push(`DeepSeek usage: ${task.usage.summary()}`);
  if (detail === "brief") parts.push(`More: deepseek_get_report task_id=${task.id} section=summary|files|diff|commands|trace`);

  const header = `DeepSeek task ${task.id} [${task.type}, ${task.model}${task.readOnly ? ", read-only" : ""}] ${STATUS[task.status]} after ${task.steps} steps`;
  const errorLine = task.error ? `Error: ${task.error}` : "";
  const tail = parts.join("\n");

  if (detail === "full") {
    const diffs = changes.map((c) => fileDiff(task, c.rel)).join("\n");
    return [header, errorLine, task.finalText, tail, diffs ? truncate(diffs, 40_000) : ""].filter(Boolean).join("\n\n");
  }
  const budget = Math.max(400, maxChars - header.length - errorLine.length - tail.length);
  const summary = task.finalText ? truncate(task.finalText, budget) : task.error ? "" : "(no summary)";
  return [header, errorLine, summary, tail].filter(Boolean).join("\n\n");
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
        ? truncate(task.commands.map((c) => `$ ${c.command}  [${c.status}${c.exitCode !== null ? `, exit ${c.exitCode}` : ""}]\n${truncate(c.output, 6000)}`).join("\n\n"), 60_000)
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
