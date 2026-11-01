import type { ApprovalStore, AskUser } from "./approvals.js";
import { reasoningEffortFor, stepCapFor, stepsFor, thinkingFor, type Config, type ModelKey } from "./config.js";
import { DeepSeekError, type ChatFn, type ChatMessage } from "./deepseek.js";
import { compactHistory, restoreReasoning } from "./compact.js";
import { auditLogger, ensureWorkspaceDir } from "./log.js";
import { systemPrompt, userPrompt, VERIFY_TYPES } from "./prompts.js";
import { checkQuotes } from "./quotes.js";
import type { Effort, TaskType } from "./routing.js";
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
  /** The user's /route effort choice for a task type (undefined = built-in default). */
  effortFor?: (workspace: string, type: TaskType) => Effort | undefined;
}

export interface NewTask {
  task: string;
  type: TaskType;
  model: ModelKey;
  workspace: string;
  readOnly: boolean;
  /** Offer web_search / web_fetch (read-only tasks only). */
  web?: boolean;
  files?: string[];
  contextGlobs?: string[];
  maxSteps?: number;
  /** Input-token budget for this run (weighted; default config.maxTaskTokens). */
  maxTokens?: number;
}

export async function startTask(input: NewTask, deps: AgentDeps): Promise<TaskRecord> {
  const task = deps.tasks.create({
    type: input.type, model: input.model, workspace: input.workspace, readOnly: input.readOnly,
    web: !!input.web && input.readOnly && deps.config.webEnabled,
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
        web: task.web,
      }),
    },
    { role: "user", content: userPrompt(input.task, input.files, input.contextGlobs) },
  );
  await runLoop(task, deps, maxSteps, maxTokens);
  return task;
}

/**
 * Split one big task into parallel sub-tasks, one per area. Without max_tokens each area gets
 * the default budget; an explicit max_tokens is the total for the whole call and is shared.
 * Returns the sub-tasks in the order of `areas`.
 */
export async function startFanOut(input: NewTask, areas: string[], deps: AgentDeps): Promise<TaskRecord[]> {
  const out: TaskRecord[] = new Array(areas.length);
  const maxTokens = input.maxTokens && Math.max(1, Math.floor(input.maxTokens / areas.length));
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
      out[i] = await startTask({ ...input, task: text, maxTokens }, sub);
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
  const steps = maxSteps ?? stepsFor(deps.config, task.type);
  const tokens = maxTokens ?? deps.config.maxTaskTokens;
  // The system prompt must stay unchanged (it is the cached prefix), so a new budget goes here.
  const budget = maxSteps || maxTokens ? `\n\n[Budget for this follow-up: about ${steps} tool steps and ${(tokens / 1e6).toFixed(1)}M input tokens.]` : "";
  task.messages.push({ role: "user", content: prefix + message.trim() + budget });
  task.status = "running";
  task.error = undefined;
  task.finalText = ""; // a failed follow-up must not show the previous run's report
  await runLoop(task, deps, steps, tokens);
  return task;
}

const PARALLEL_TOOLS = new Set(["read_file", "list_dir", "glob", "grep"]);

function isJson(s: string): boolean {
  try {
    JSON.parse(s || "{}");
    return true;
  } catch {
    return false;
  }
}

/** DeepSeek's raw tool-call markup (uses fullwidth bars), up to its closing tag or the end. */
const DSML_CALLS = /<[｜|]+DSML[｜|]+tool_calls>[\s\S]*?(?:<\/[｜|]+DSML[｜|]+tool_calls>|$)/g;

/** Notes for replies that did not end normally (finish_reason values from DeepSeek's API docs). */
const FINISH_NOTES: Record<string, string> = {
  length: "[Report cut off at the output limit; raise DEEPSEEK_MAX_FINAL_TOKENS or lower the effort with /route.]",
  content_filter: "[DeepSeek's content filter stopped this reply.]",
  insufficient_system_resource: "[DeepSeek ran out of server capacity mid-reply. Follow up with task_id to retry.]",
  aborted: "[DeepSeek aborted this reply. Follow up with task_id to retry.]",
};

/** The final report: cut-off note added, and for findings types each quoted line checked against the file. */
function finalReport(task: TaskRecord, r: { message: ChatMessage; finishReason: string }): string {
  const text = withCutNote(r);
  return VERIFY_TYPES.includes(task.type) ? checkQuotes(text, task.workspace) : text;
}

/** The reply text, flagged when it did not end normally. */
function withCutNote(r: { message: ChatMessage; finishReason: string }): string {
  // With tools off, DeepSeek sometimes writes tool calls as raw markup; that is not report text.
  const text = (r.message.content ?? "").replace(DSML_CALLS, "").trim();
  if (!text && (r.message.content ?? "").includes("DSML")) {
    return "[DeepSeek stopped while still wanting to use tools and wrote no report. Follow up with task_id to get one.]";
  }
  const note = FINISH_NOTES[r.finishReason];
  return note ? `${text}\n\n${note}`.trim() : text;
}

async function sequential<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  for (const job of jobs) out.push(await job());
  return out;
}

async function runLoop(task: TaskRecord, deps: AgentDeps, maxSteps: number, maxTokens: number): Promise<void> {
  const { chat, config } = deps;
  const model = config.models[task.model];
  const tools = toolDefs(task.readOnly, task.web);
  const log = auditLogger(task.workspace, task.id);
  const ctx = { task, config, approvals: deps.approvals, askUser: deps.askUser, log, signal: deps.signal };
  const hitAtStart = task.usage.cacheHit;
  const missAtStart = task.usage.cacheMiss;
  const stepsAtStart = task.steps;
  // Cheap types run without thinking; planning/review/debug/research think at low effort.
  // The user's /route effort choice wins over the defaults.
  const userEffort = deps.effortFor?.(task.workspace, task.type);
  const thinking = userEffort ? (userEffort === "off" ? "disabled" : "enabled") : thinkingFor(config, task.type);
  const reasoningEffort = userEffort && userEffort !== "off" ? userEffort : reasoningEffortFor(config, task.type);
  const stepCap = stepCapFor(config, thinking, reasoningEffort);
  // The redo and the final report must get more room than the step that was cut off.
  const reportCap = Math.max(config.maxFinalTokens, stepCap * 2);
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
  let shortenReasoning = config.compactReasoning;
  let compactedAt = 0; // estimated prompt tokens right after the last shortening

  log({ event: "start", type: task.type, model: model.id, readOnly: task.readOnly });
  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (run.inputTokens > maxTokens) {
        task.status = "token_limit";
        break;
      }
      const send = (cap: number) => chat(
        {
          model: model.id, messages: task.messages, tools,
          max_tokens: cap, thinking, reasoning_effort: reasoningEffort,
        },
        deps.signal,
      );
      // Shortened reasoning is accepted today but not documented. If the API refuses it,
      // put the full reasoning back, stop shortening it for this run, and send again.
      const callModel = async (cap: number) => {
        try {
          return await send(cap);
        } catch (e) {
          if (!(e instanceof DeepSeekError && e.status === 400 && /reasoning/i.test(e.message))) throw e;
          if (restoreReasoning(task.messages) === 0) throw e;
          shortenReasoning = false;
          log({ event: "reasoning_restored", error: e.message.slice(0, 200) });
          return send(cap);
        }
      };
      let r = await callModel(stepCap);
      task.usage.add(r.usage, model);
      task.steps++;
      used();
      // Cut off by the small step cap (thinking eats into it), either mid-report or mid-tool-call:
      // drop the reply and redo the step with the report cap. Tools stay on, so a step that wanted
      // more tools still gets them instead of writing the calls out as text. Same prefix, mostly cached.
      // DeepSeek can also stop a reply when it runs short of server capacity; that is worth one redo too.
      const unfinished = !r.message.tool_calls?.length || r.message.tool_calls.some((c) => !isJson(c.function.arguments));
      if (unfinished && (r.finishReason === "length" || r.finishReason === "insufficient_system_resource")) {
        log({ event: "step_redo", reason: r.finishReason, maxTokens: stepCap });
        r = await callModel(reportCap);
        task.usage.add(r.usage, model);
        used();
      }

      const calls = r.message.tool_calls ?? [];
      if (calls.length === 0) {
        task.messages.push(r.message);
        task.finalText = finalReport(task, r);
        task.status = "done";
        log({ event: "done", steps: task.steps, cost: task.usage.cost });
        return;
      }
      task.messages.push(r.message);
      // Reads have no side effects, so a step made only of reads runs them at the same time.
      const run1 = (c: (typeof calls)[number]) => executeTool(ctx, c.function.name, c.function.arguments);
      const results = calls.every((c) => PARALLEL_TOOLS.has(c.function.name))
        ? await Promise.all(calls.map(run1))
        : await sequential(calls.map((c) => () => run1(c)));
      calls.forEach((call, i) => task.messages.push({ role: "tool", tool_call_id: call.id, content: results[i] }));
      // The prompt is re-sent every step; once it is big, shorten old tool outputs.
      // Each shortening breaks the cache from that point, so wait until the prompt has grown again.
      if (r.usage.prompt_tokens > Math.max(config.compactTokens, compactedAt + config.compactTokens / 2)) {
        const removed = compactHistory(task.messages, 8, 400, shortenReasoning);
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
        max_tokens: reportCap, thinking, reasoning_effort: reasoningEffort,
      },
      deps.signal,
    );
    task.usage.add(r.usage, model);
    task.messages.push(r.message);
    used();
    task.finalText = finalReport(task, r);
    log({ event: task.status, steps: task.steps, cost: task.usage.cost });
  } catch (e) {
    task.status = "error";
    task.error = (e as Error).message;
    log({ event: "error", error: task.error });
  }
}
