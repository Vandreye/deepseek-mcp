import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_DIR_NAME } from "./config.js";
import { resolveSafe } from "./safety/paths.js";
import { runShell } from "./tools/command.js";

export interface PendingAction {
  id: string;
  kind: "delete" | "command";
  workspace: string;
  taskId: string;
  reason: string;
  /** Workspace-relative paths (delete). */
  paths?: string[];
  /** Exact command string (command). */
  command?: string;
  /** Command looks like it deletes files. */
  deletes?: boolean;
  created: Date;
}

/**
 * Asks the user directly (MCP elicitation). Returns true only on explicit approval.
 * Undefined when the client cannot show such prompts.
 */
export type AskUser = (message: string, signal?: AbortSignal) => Promise<boolean>;

export class ApprovalStore {
  private items = new Map<string, PendingAction>();
  private counter = 0;

  add(a: Omit<PendingAction, "id" | "created">): PendingAction {
    const item: PendingAction = { ...a, id: `p${++this.counter}`, created: new Date() };
    this.items.set(item.id, item);
    return item;
  }

  list(): PendingAction[] {
    return [...this.items.values()];
  }

  get(id: string): PendingAction | undefined {
    return this.items.get(id);
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }
}

export function describeAction(a: PendingAction): string {
  const what =
    a.kind === "delete"
      ? `DELETE ${a.paths!.join(", ")}`
      : `${a.deletes ? "RUN (deletes files!) " : "RUN "}\`${a.command}\``;
  return `${a.id}: ${what}  (task ${a.taskId}; reason: ${a.reason || "none given"})`;
}

/**
 * Carry out an approved action. Deleted files are moved to
 * <workspace>/.deepseek-mcp/trash/<id>/ rather than destroyed, so they can be restored.
 */
export async function executeAction(a: PendingAction, commandTimeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (a.kind === "delete") {
    const trash = path.join(a.workspace, WORKSPACE_DIR_NAME, "trash", a.id);
    const done: string[] = [];
    for (const p of a.paths ?? []) {
      const safe = resolveSafe(a.workspace, p, "write");
      if (!fs.existsSync(safe.abs)) {
        done.push(`${safe.rel}: already gone`);
        continue;
      }
      const dest = path.join(trash, safe.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(safe.abs, dest, { recursive: true });
      fs.rmSync(safe.abs, { recursive: true });
      done.push(`${safe.rel}: deleted`);
    }
    return `${done.join("; ")} (copies kept in ${WORKSPACE_DIR_NAME}/trash/${a.id})`;
  }
  const r = await runShell(a.command!, a.workspace, commandTimeoutMs, signal);
  const status = r.timedOut ? "timed out" : `exit ${r.exitCode}`;
  return `\`${a.command}\` → ${status}\n${r.output.slice(-2000)}`;
}
