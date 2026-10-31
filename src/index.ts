#!/usr/bin/env node
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { continueTask, startTask, type AgentDeps } from "./agent.js";
import { ApprovalStore, describeAction, executeAction, type AskUser } from "./approvals.js";
import { HOME_DIR, loadConfig, type ModelKey } from "./config.js";
import { createDeepSeekChat, UsageTotals, type ChatFn } from "./deepseek.js";
import { compactReport, REPORT_SECTIONS, reportSection } from "./report.js";
import {
  checkRoute, describeRouting, loadRouting, projectRoutingPath, ROUTES, saveRouting, TASK_TYPES,
  userRoutingPath, type RoutingTable, type TaskType,
} from "./routing.js";
import { resolveSafe, realWorkspace } from "./safety/paths.js";
import { TaskStore, truncate } from "./tasks.js";
import { trackDeletes } from "./tools/registry.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `DeepSeek subagent: a much cheaper model with file, search and test tools in the workspace.
- The USER decides which agent does which task type. Follow the routing shown in deepseek_task's description, and explicit requests ("use DeepSeek for this" / "do it yourself"). Never route on your own judgment.
- When delegating, save Claude tokens: write one short self-contained instruction, point to files by path (never paste contents), give the whole job in one call, and don't re-read changed files unless the report shows failures or the user asks. Use deepseek_get_report for details, task_id for follow-ups.
- DeepSeek cannot delete files or run unlisted commands; those wait for approval. Show pending items to the user; call approve_actions only when the user asks you to.`;

const config = loadConfig();
const chat: ChatFn = createDeepSeekChat(config);
const tasks = new TaskStore();
const approvals = new ApprovalStore();

const server = new McpServer({ name: "deepseek", version: VERSION }, { instructions: INSTRUCTIONS });

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function workspaceOf(ws?: string): string {
  return realWorkspace(ws || config.defaultWorkspace);
}

/** Ask the user directly through the MCP client, when it supports that. */
function askUser(): AskUser | undefined {
  if (config.elicitation === "off") return undefined;
  if (!server.server.getClientCapabilities()?.elicitation) return undefined;
  return async (message) => {
    const r = await server.server.elicitInput(
      {
        message,
        requestedSchema: {
          type: "object",
          properties: { approve: { type: "boolean", title: "Approve", description: "Allow this action" } },
          required: ["approve"],
        },
      },
      { timeout: 10 * 60_000 },
    );
    return r.action === "accept" && r.content?.approve === true;
  };
}

function taskDescription(): string {
  let routing = "unavailable";
  try {
    routing = describeRouting(loadRouting(workspaceOf(), HOME_DIR));
  } catch {
    /* default workspace may be invalid; routing is checked on each call anyway */
  }
  return `Hand a task to DeepSeek (cheap subagent; reads/writes files, runs tests, works until done). USER ROUTING: ${routing}. Only use for types routed to deepseek, or when the user explicitly asked for DeepSeek (set user_override). "ask" = ask the user first. Give file paths, not contents. Returns a compact report.`;
}

const taskTool = server.registerTool(
  "deepseek_task",
  {
    description: taskDescription(),
    inputSchema: {
      task: z.string().describe("Self-contained instruction (or the follow-up message when task_id is set)"),
      type: z.enum(TASK_TYPES).default("general").describe("Task type, used for routing and DeepSeek's role"),
      task_id: z.string().optional().describe("Continue an earlier task"),
      files: z.array(z.string()).optional().describe("Relevant file paths"),
      context_globs: z.array(z.string()).optional(),
      model: z.enum(["flash", "pro"]).optional().describe("Default flash; pro for hard tasks"),
      workspace: z.string().optional().describe("Absolute project folder (default: current)"),
      read_only: z.boolean().optional().describe("Default true for plan/review/research"),
      detail: z.enum(["brief", "full"]).default("brief"),
      max_steps: z.number().int().min(1).max(200).optional(),
      user_override: z.boolean().default(false).describe("User explicitly asked for DeepSeek"),
    },
  },
  async (a, extra) => {
    try {
      const deps = agentDeps(extra);
      if (a.task_id) {
        const prev = tasks.get(a.task_id);
        if (!prev) return text(`Unknown task_id ${a.task_id} (the server may have restarted). Start a new task.`, true);
        const block = checkRoute(loadRouting(prev.workspace, HOME_DIR), prev.type, a.user_override);
        if (block) return text(block, true);
        await continueTask(prev, a.task, deps, a.max_steps);
        return text(compactReport(prev, approvals, config.maxReplyChars, a.detail), prev.status === "error");
      }
      const workspace = workspaceOf(a.workspace);
      const block = checkRoute(loadRouting(workspace, HOME_DIR), a.type, a.user_override);
      if (block) return text(block, true);
      const readOnly = a.read_only ?? ["plan", "review", "research", "question"].includes(a.type);
      const task = await startTask(
        {
          task: a.task, type: a.type, model: (a.model ?? "flash") as ModelKey, workspace, readOnly,
          files: a.files, contextGlobs: a.context_globs, maxSteps: a.max_steps,
        },
        deps,
      );
      return text(compactReport(task, approvals, config.maxReplyChars, a.detail), task.status === "error");
    } catch (e) {
      return text(`deepseek_task failed: ${(e as Error).message}`, true);
    }
  },
);

function agentDeps(extra: { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> }): AgentDeps {
  const token = extra._meta?.progressToken;
  return {
    chat, config, approvals, tasks, askUser: askUser(), signal: extra.signal,
    onProgress: token === undefined ? undefined : (step, total, message) => {
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, total, message } }).catch(() => {});
    },
  };
}

server.registerTool(
  "deepseek_ask",
  {
    description: "One-shot question to DeepSeek, no tools (cheap second opinion). Routed as type 'question'. Pass file paths to include them.",
    inputSchema: {
      question: z.string(),
      files: z.array(z.string()).optional().describe("Files whose contents DeepSeek should see"),
      model: z.enum(["flash", "pro"]).optional(),
      workspace: z.string().optional(),
      user_override: z.boolean().default(false),
    },
  },
  async (a, extra) => {
    try {
      const workspace = workspaceOf(a.workspace);
      const block = checkRoute(loadRouting(workspace, HOME_DIR), "question", a.user_override);
      if (block) return text(block, true);
      let context = "";
      for (const f of a.files ?? []) {
        const s = resolveSafe(workspace, f, "read");
        context += `\n\n--- ${s.rel} ---\n${fs.readFileSync(s.abs, "utf8")}`;
        if (context.length > 400_000) throw new Error("Files are too large for deepseek_ask; use deepseek_task.");
      }
      const key = (a.model ?? "flash") as ModelKey;
      const r = await chat(
        {
          model: config.models[key].id,
          messages: [
            { role: "system", content: "Answer for Claude, which orchestrates the work. Be concise (under ~200 words unless more is truly needed), concrete, no preamble." },
            { role: "user", content: a.question + context },
          ],
        },
        extra.signal,
      );
      const usage = new UsageTotals();
      usage.add(r.usage, config.models[key]);
      return text(`${truncate(r.message.content ?? "", config.maxReplyChars * 2)}\n\n(DeepSeek ${key}: ${usage.summary()})`);
    } catch (e) {
      return text(`deepseek_ask failed: ${(e as Error).message}`, true);
    }
  },
);

server.registerTool(
  "deepseek_routing",
  {
    description: "Show or change which agent handles each task type (the user's choice). Only change it when the user asks.",
    inputSchema: {
      set: z.record(z.string(), z.enum(ROUTES)).optional().describe('e.g. {"code":"deepseek","review":"claude"}'),
      scope: z.enum(["user", "project"]).default("user").describe("user = all projects; project = this workspace only"),
      workspace: z.string().optional(),
    },
  },
  async (a) => {
    try {
      const workspace = workspaceOf(a.workspace);
      if (a.set && Object.keys(a.set).length) {
        const valid = [...TASK_TYPES, "default"] as string[];
        const bad = Object.keys(a.set).filter((k) => !valid.includes(k));
        if (bad.length) return text(`Unknown task type(s): ${bad.join(", ")}. Valid: ${valid.join(", ")}`, true);
        saveRouting(a.scope, a.set as RoutingTable, workspace, HOME_DIR);
        taskTool.update({ description: taskDescription() });
      }
      const table = loadRouting(workspace, HOME_DIR);
      return text(
        `Routing: ${describeRouting(table)}\nUser file: ${userRoutingPath(HOME_DIR)}\nProject file: ${projectRoutingPath(workspace)}` +
          `\nTypes: ${TASK_TYPES.join(", ")}, default. Values: deepseek | claude | ask.`,
      );
    } catch (e) {
      return text(`deepseek_routing failed: ${(e as Error).message}`, true);
    }
  },
);

server.registerTool(
  "deepseek_get_report",
  {
    description: "Fetch one part of a past task's full report. Only when needed: it costs Claude tokens.",
    inputSchema: {
      task_id: z.string(),
      section: z.enum(REPORT_SECTIONS),
      path: z.string().optional().describe("For section=diff: one file"),
    },
  },
  async (a) => {
    const task = tasks.get(a.task_id);
    if (!task) return text(`Unknown task_id ${a.task_id}.`, true);
    return text(reportSection(task, a.section, a.path));
  },
);

server.registerTool(
  "list_pending_approvals",
  { description: "List DeepSeek's queued delete/command requests waiting for the user's approval.", inputSchema: {} },
  async () => {
    const items = approvals.list();
    return text(items.length ? items.map(describeAction).join("\n") : "Nothing is waiting for approval.");
  },
);

server.registerTool(
  "approve_actions",
  {
    description: "Carry out queued DeepSeek requests (deletes/commands). ONLY when the user explicitly approves these ids.",
    inputSchema: { ids: z.array(z.string()).min(1) },
  },
  async (a) => {
    const items = a.ids.map((id) => approvals.get(id));
    const missing = a.ids.filter((_, i) => !items[i]);
    if (missing.length) return text(`Unknown approval id(s): ${missing.join(", ")}. See list_pending_approvals.`, true);
    const ask = askUser();
    if (ask) {
      const ok = await ask(`Approve these DeepSeek actions?\n${items.map((i) => describeAction(i!)).join("\n")}`).catch(() => false);
      if (!ok) return text("The user did not approve. Nothing was done.");
    }
    const out: string[] = [];
    for (const item of items) {
      approvals.remove(item!.id);
      const task = tasks.get(item!.taskId);
      if (task) trackDeletes(task, item!);
      let result: string;
      try {
        result = await executeAction(item!, config.commandTimeoutMs);
      } catch (e) {
        result = `failed: ${(e as Error).message}`;
      }
      if (task) {
        task.pendingIds = task.pendingIds.filter((id) => id !== item!.id);
        task.notes.push(`User approved ${item!.id}: ${result.split("\n")[0]}`);
      }
      out.push(`${item!.id}: ${truncate(result, 2500)}`);
    }
    return text(out.join("\n"));
  },
);

server.registerTool(
  "reject_actions",
  { description: "Discard queued DeepSeek requests.", inputSchema: { ids: z.array(z.string()).min(1) } },
  async (a) => {
    const out: string[] = [];
    for (const id of a.ids) {
      const item = approvals.get(id);
      if (!item) {
        out.push(`${id}: unknown`);
        continue;
      }
      approvals.remove(id);
      const task = tasks.get(item.taskId);
      if (task) {
        task.pendingIds = task.pendingIds.filter((p) => p !== id);
        task.notes.push(`User rejected ${id} (${describeAction(item)}). Do not retry it.`);
      }
      out.push(`${id}: rejected`);
    }
    return text(out.join("\n"));
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`deepseek-mcp ${VERSION} running (workspace default: ${config.defaultWorkspace}${config.apiKey ? "" : "; WARNING: no DEEPSEEK_API_KEY"})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
