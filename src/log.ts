import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_DIR_NAME } from "./config.js";

/** Make <workspace>/.deepseek-mcp and keep it out of git. */
export function ensureWorkspaceDir(workspace: string): string {
  const dir = path.join(workspace, WORKSPACE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
  return dir;
}

/** Audit log: one JSON line per DeepSeek action in <workspace>/.deepseek-mcp/logs/<date>.jsonl */
export function auditLogger(workspace: string, taskId: string): (entry: Record<string, unknown>) => void {
  return (entry) => {
    try {
      const dir = path.join(ensureWorkspaceDir(workspace), "logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), task: taskId, ...entry }) + "\n");
    } catch {
      /* logging must never break a task */
    }
  };
}
