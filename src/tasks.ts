import fs from "node:fs";
import path from "node:path";
import { diffLines, createTwoFilesPatch } from "diff";
import type { ChatMessage } from "./deepseek.js";
import { UsageTotals } from "./deepseek.js";
import type { ModelKey } from "./config.js";
import type { TaskType } from "./routing.js";

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  output: string;
  status: "ran" | "queued" | "denied" | "timeout";
}

export interface TaskRecord {
  id: string;
  type: TaskType;
  model: ModelKey;
  workspace: string;
  readOnly: boolean;
  messages: ChatMessage[];
  /** Content of each file before this task first changed it (null = file was new). */
  originals: Map<string, string | null>;
  commands: CommandRecord[];
  pendingIds: string[];
  /** Notes to pass to DeepSeek on the next follow-up (e.g. approval results). */
  notes: string[];
  finalText: string;
  status: "running" | "done" | "step_limit" | "token_limit" | "error";
  error?: string;
  steps: number;
  /** Limits of the latest run, and how far it got (for the report). */
  run?: { maxSteps: number; steps: number; maxTokens: number; inputTokens: number };
  usage: UsageTotals;
  created: Date;
}

export class TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private counter = 0;

  constructor(private readonly keep = 50) {}

  create(init: Pick<TaskRecord, "type" | "model" | "workspace" | "readOnly">): TaskRecord {
    const id = `t${++this.counter}`;
    const task: TaskRecord = {
      ...init,
      id,
      messages: [],
      originals: new Map(),
      commands: [],
      pendingIds: [],
      notes: [],
      finalText: "",
      status: "running",
      steps: 0,
      usage: new UsageTotals(),
      created: new Date(),
    };
    this.tasks.set(id, task);
    while (this.tasks.size > this.keep) this.tasks.delete(this.tasks.keys().next().value!);
    return task;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }
}

export interface FileChange {
  rel: string;
  kind: "A" | "M" | "D";
  added: number;
  removed: number;
}

function readOrNull(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

/** Compare each touched file's original content with what is on disk now. */
export function fileChanges(task: TaskRecord): FileChange[] {
  const out: FileChange[] = [];
  for (const [rel, before] of task.originals) {
    const after = readOrNull(path.join(task.workspace, rel));
    if (before === after) continue;
    if (after === null) {
      out.push({ rel, kind: "D", added: 0, removed: countLines(before ?? "") });
      continue;
    }
    let added = 0;
    let removed = 0;
    for (const part of diffLines(before ?? "", after)) {
      if (part.added) added += part.count ?? 0;
      else if (part.removed) removed += part.count ?? 0;
    }
    out.push({ rel, kind: before === null ? "A" : "M", added, removed });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function fileDiff(task: TaskRecord, rel: string): string {
  if (!task.originals.has(rel)) return `No changes recorded for ${rel} in task ${task.id}.`;
  const before = task.originals.get(rel) ?? "";
  const after = readOrNull(path.join(task.workspace, rel)) ?? "";
  return createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, "", "", { context: 3 });
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 40;
  return `${text.slice(0, head)}\n…[${text.length - head - tail} chars cut]…\n${text.slice(-tail)}`;
}
