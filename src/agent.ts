import type { ApprovalStore, AskUser } from "./approvals.js";
import { stepsFor, type Config, type ModelKey } from "./config.js";
import type { ChatFn } from "./deepseek.js";
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
}

export async function startTask(input: NewTask, deps: AgentDeps): Promise<TaskRecord> {
  const task = deps.tasks.create({
    type: input.type, model: input.model, workspace: input.workspace, readOnly: input.readOnly,
  });
  ensureWorkspaceDir(input.workspace);
  task.messages.push(
    {
      role: "system",
      content: systemPrompt(input.type, input.workspace, input.readOnly, {
        maxSteps: input.maxSteps ?? stepsFor(deps.config, input.type),
        maxTokens: deps.config.maxTaskTokens,
      }),
    },
    { role: "user", content: userPrompt(input.task, input.files, input.contextGlobs) },
  );
  await runLoop(task, deps, input.maxSteps ?? stepsFor(deps.config, input.type));
  return task;
}

/** Send a follow-up to an earlier task. Its history (and DeepSeek's cache) is reused. */
export async function continueTask(task: TaskRecord, message: string, deps: AgentDeps, maxSteps?: number): Promise<TaskRecord> {
  const notes = task.notes.splice(0);
  const prefix = notes.length ? `Updates since your last report:\n- ${notes.join("\n- ")}\n\n` : "";
  task.messages.push({ role: "user", content: prefix + message.trim() });
  task.status = "running";
  task.error = undefined;
  await runLoop(task, deps, maxSteps ?? stepsFor(deps.config, task.type));
  return task;
}

async function runLoop(task: TaskRecord, deps: AgentDeps, maxSteps: number): Promise<void> {
  const { chat, config } = deps;
  const model = config.models[task.model];
  const tools = toolDefs(task.readOnly);
  const log = auditLogger(task.workspace, task.id);
  const ctx = { task, config, approvals: deps.approvals, askUser: deps.askUser, log };
  const inputAtStart = task.usage.input;
  const stepsAtStart = task.steps;
  const run = { maxSteps, steps: 0, maxTokens: config.maxTaskTokens, inputTokens: 0 };
  task.run = run;
  const used = () => {
    run.steps = task.steps - stepsAtStart;
    run.inputTokens = task.usage.input - inputAtStart;
  };
  let warned = false;

  log({ event: "start", type: task.type, model: model.id, readOnly: task.readOnly });
  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (task.usage.input - inputAtStart > config.maxTaskTokens) {
        task.status = "token_limit";
        break;
      }
      const r = await chat({ model: model.id, messages: task.messages, tools }, deps.signal);
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
      // Warn once when the budget runs low, so it wraps up instead of stopping mid-area.
      const stepsLeft = maxSteps - step;
      const tokenShare = run.inputTokens / config.maxTaskTokens;
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
    const r = await chat({ model: model.id, messages: task.messages, tools, tool_choice: "none" }, deps.signal);
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
