import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../src/approvals.js";
import { loadConfig, type Config } from "../src/config.js";
import { realWorkspace } from "../src/safety/paths.js";
import { TaskStore, type TaskRecord } from "../src/tasks.js";
import type { ToolContext } from "../src/tools/registry.js";

export function tempWorkspace(): string {
  return realWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), "dsmcp-")));
}

export function testConfig(): Config {
  return { ...loadConfig(), apiKey: "test", commandTimeoutMs: 60_000 };
}

export function makeCtx(workspace: string, readOnly = false): ToolContext & { task: TaskRecord } {
  const tasks = new TaskStore();
  const task = tasks.create({ type: "code", model: "flash", workspace, readOnly });
  return { task, config: testConfig(), approvals: new ApprovalStore(), log: () => {} };
}
