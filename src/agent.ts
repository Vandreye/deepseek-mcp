import type { ApprovalStore, AskUser } from "./approvals.js";
import { reasoningEffortFor, stepsFor, thinkingFor, type Config, type ModelKey } from "./config.js";
import type { ChatFn } from "./deepseek.js";
import { compactHistory } from "./compact.js";
import { auditLogger, ensureWorkspaceDir } from "./log.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import type { TaskType } from "./routing.js";
import type { TaskRecord, TaskStore } from "./tasks.js";
import { executeTool, toolDefs } from "./tools/registry.js";

export interface AgentDeps {
  chat: ChatFn;
  config: Config;
  approvals: ApprovalStore;
  tasks: TaskStore;
  askUser?: AskUser;
  onProgress?: (step: number, maxSteps: number, message: string) => void;
  signal?: AbortSignal;
}

export interface NewTask {
  task: string;
  type: TaskType;
  model: ModelKey;
  workspace: string;
  readOnly: boolean;
  files?: string[];
  contextGlobs?: string[];
  maxSteps?: number;
  /** Input-token budget for this run (weighted; default config.maxTaskTokens). */
  maxTokens?: number;
}

export async function startTask(input: NewTask, deps: AgentDeps): Promise<TaskRecord> {
  const task = deps.tasks.create({
    type: input.type, model: input.model, workspace: input.workspace, readOnly: input.readOnly,
  });
  ensureWorkspaceDir(input.workspace);
  const maxSteps = input.maxSteps ?? stepsFor(deps.config, input.type);
  const maxTokens = input.maxTokens ?? deps.config.maxTaskTokens;
  task.messages.push(
    {
      role: "system",
      content: systemPrompt(input.type, input.workspace, input.readOnly, {
        maxSteps,
        maxTokens,
        cacheWeight: deps.config.cacheWeight,
      }),
    },
    { role: "user", content: userPrompt(input.task, input.files, input.contextGlobs) },
  );
  await runLoop(task, deps, maxSteps, maxTokens);
  return task;
}

/**
 * Split one big task into parallel sub-tasks, one per area, each with its own budget.
 * Returns the sub-tasks in the order of `areas`.
 */
export async function startFanOut(input: NewTask, areas: string[], deps: AgentDeps): Promise<TaskRecord[]> {
  const out: TaskRecord[] = new Array(areas.length);
  let next = 0;
  const worker = async () => {
    while (next < areas.length) {
      const i = next++;
      const area = areas[i];
      const sub: AgentDeps = {
        ...deps,
        onProgress: deps.onProgress && ((step, max, msg) => deps.onProgress!(step, max, `[${area}] ${msg}`)),
      };
      const text = `${input.task.trim()}

Your area for this run: ${area}
Other areas are covered by separate runs at the same time. Stay within your area.`;
      out[i] = await startTask({ ...input, task: text }, sub);
    }
  };
  const n = Math.max(1, Math.min(deps.config.fanoutConcurrency, areas.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/** Send a follow-up to an earlier task. Its history (and DeepSeek's cache) is reused. */
export async function continueTask(task: TaskRecord, message: string, deps: AgentDeps, maxSteps?: number, maxTokens?: number): Promise<TaskRecord> {
  const notes = task.notes.splice(0);
  const prefix = notes.length ? `Updates since your last report:\n- ${notes.join("\n- ")}\n\n` : "";
  task.messages.push({ role: "user", content: prefix + message.trim() });
  task.status = "running";
  task.error = undefined;
  await runLoop(task, deps, maxSteps ?? stepsFor(deps.config, task.type), maxTokens ?? deps.config.maxTaskTokens);
  return task;
}

async function runLoop(task: TaskRecord, deps: AgentDeps, maxSteps: number, maxTokens: number): Promise<void> {
  const { chat, config } = deps;
  const model = config.models[task.model];
  const tools = toolDefs(task.readOnly);
  const log = auditLogger(task.workspace, task.id);
  const ctx = { task, config, approvals: deps.approvals, askUser: deps.askUser, log };
  const hitAtStart = task.usage.cacheHit;
  const missAtStart = task.usage.cacheMiss;
  const stepsAtStart = task.steps;
  // Cheap types run without thinking; planning/review/debug/research think at low effort.
  const thinking = thinkingFor(config, task.type);
  const reasoningEffort = reasoningEffortFor(config, task.type);
  const run = { maxSteps, steps: 0, maxTokens, inputTokens: 0, rawInputTokens: 0, compactions: 0 };
  task.run = run;
  // Cached input costs about a tenth, so it counts for less against the budget.
  const used = () => {
    const hit = task.usage.cacheHit - hitAtStart;
    const miss = task.usage.cacheMiss - missAtStart;
    run.steps = task.steps - stepsAtStart;
    run.rawInputTokens = hit + miss;
    run.inputTokens = Math.round(miss + hit * config.cacheWeight);
  };
  let warned = false;
  let compactedAt = 0; // estimated prompt tokens right after the last shortening

  log({ event: "start", type: task.type, model: model.id, readOnly: task.readOnly });
  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (run.inputTokens > maxTokens) {
        task.status = "token_limit";
        break;
      }
      const r = await chat(
        {
          model: model.id, messages: task.messages, tools,
          max_tokens: config.maxToolStepTokens, thinking, reasoning_effort: reasoningEffort,
        },
        deps.signal,
      );
      task.usage.add(r.usage, model);
      task.steps++;
      task.messages.push(r.message);
      used();

      const calls = r.message.tool_calls ?? [];
      if (calls.length === 0) {
        task.finalText = (r.message.content ?? "").trim();
        task.status = "done";
        log({ event: "done", steps: task.steps, cost: task.usage.cost });
        return;
      }
      for (const call of calls) {
        const result = await executeTool(ctx, call.function.name, call.function.arguments);
        task.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      // The prompt is re-sent every step; once it is big, shorten old tool outputs.
      // Each shortening breaks the cache from that point, so wait until the prompt has grown again.
      if (r.usage.prompt_tokens > Math.max(config.compactTokens, compactedAt + config.compactTokens / 2)) {
        const removed = compactHistory(task.messages);
        if (removed > 0) {
          compactedAt = r.usage.prompt_tokens - Math.round(removed / 4);
          run.compactions++;
          log({ event: "compact", promptTokens: r.usage.prompt_tokens, removedChars: removed });
        }
      }
      // Warn once when the budget runs low, so it wraps up instead of stopping mid-area.
      const stepsLeft = maxSteps - step;
      const tokenShare = run.inputTokens / maxTokens;
      if (!warned && stepsLeft > 0 && (stepsLeft <= Math.max(2, Math.ceil(maxSteps * 0.2)) || tokenShare >= 0.8)) {
        warned = true;
        const last = task.messages[task.messages.length - 1];
        last.content += `

[Budget: ${stepsLeft} of ${maxSteps} steps left, ${Math.round(tokenShare * 100)}% of the token budget used. Finish the current area, then write your report with "Not done: …".]`;
      }
      deps.onProgress?.(step, maxSteps, calls.map((c) => c.function.name).join(", "));
    }

    // Out of steps or tokens: ask for a final report without more tool use.
    if (task.status === "running") task.status = "step_limit";
    task.messages.push({
      role: "user",
      content: "Limit reached. Stop using tools and write your final report now: what is done, what is left.",
    });
    const r = await chat(
      {
        model: model.id, messages: task.messages, tools, tool_choice: "none",
        max_tokens: config.maxFinalTokens, thinking, reasoning_effort: reasoningEffort,
      },
      deps.signal,
    );
    task.usage.add(r.usage, model);
    task.messages.push(r.message);
    used();
    task.finalText = (r.message.content ?? "").trim();
    log({ event: task.status, steps: task.steps, cost: task.usage.cost });
  } catch (e) {
    task.status = "error";
    task.error = (e as Error).message;
    log({ event: "error", error: task.error });
  }
}
