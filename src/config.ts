import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskType } from "./routing.js";

/** User-wide settings folder: ~/.deepseek-mcp */
export const HOME_DIR = process.env.DEEPSEEK_MCP_HOME || path.join(os.homedir(), ".deepseek-mcp");

/** Folder created inside each workspace for logs, backups and trash. */
export const WORKSPACE_DIR_NAME = ".deepseek-mcp";

export type ModelKey = "flash" | "pro";

export interface ModelInfo {
  id: string;
  /** USD per 1M tokens, at peak rates (an upper bound; off-peak is half). */
  price: { cacheHit: number; cacheMiss: number; output: number };
}

export type Thinking = "enabled" | "disabled";
export const THINKING_MODES: readonly Thinking[] = ["enabled", "disabled"];

/**
 * Thinking costs output tokens, so only the task types that need it get it:
 * off for code, tests, docs, question, general; on (at "low" effort) for the rest.
 */
const DEFAULT_THINKING: Record<TaskType, Thinking> = {
  plan: "enabled",
  code: "disabled",
  review: "enabled",
  bugfix: "enabled",
  debug: "enabled",
  research: "enabled",
  tests: "disabled",
  docs: "disabled",
  question: "disabled",
  general: "disabled",
};

const DEFAULT_REASONING_EFFORT = "low";
/** reasoning_effort values the API takes; other env values are ignored. */
const API_EFFORTS = ["low", "medium", "high", "max"];

export interface Config {
  apiKey: string;
  baseUrl: string;
  /** Strict tool schemas (beta, uses the /beta base URL): DEEPSEEK_STRICT_TOOLS=on. */
  strictTools: boolean;
  /** web_search / web_fetch may be offered to research tasks (DEEPSEEK_WEB=off disables). */
  webEnabled: boolean;
  models: Record<ModelKey, ModelInfo>;
  /** Thinking mode per task type (DEEPSEEK_THINKING and DEEPSEEK_THINKING_<TYPE> override). */
  thinkingByType: Record<TaskType, Thinking>;
  /** Reasoning effort per task type, only sent when thinking is on. */
  reasoningEffortByType: Record<TaskType, string>;
  /** max_tokens for each tool-loop step and for the final report. */
  maxToolStepTokens: number;
  maxFinalTokens: number;
  /** Step limit for task types without their own entry in maxStepsByType. */
  maxSteps: number;
  /** Bigger limits for exploring task types (reviews and research read a lot). */
  maxStepsByType: Partial<Record<TaskType, number>>;
  /** Input-token budget per run. Cached tokens count at cacheWeight (they cost about a tenth). */
  maxTaskTokens: number;
  cacheWeight: number;
  /**
   * When a prompt passes this many tokens, old tool outputs are shortened. Kept high on purpose:
   * cached input costs 1/50 of uncached, and each shortening makes the rest of the history
   * uncached again, so it only pays off for very long prompts. Both models have a 1M window.
   */
  compactTokens: number;
  /** Sub-tasks run at the same time when a task is split into areas. */
  fanoutConcurrency: number;
  maxReplyChars: number;
  commandTimeoutMs: number;
  extraAllowCommands: string[][];
  elicitation: "auto" | "off";
  defaultWorkspace: string;
}

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function envChoice(name: string, allowed: readonly string[]): string | undefined {
  const v = process.env[name];
  return v && allowed.includes(v) ? v : undefined;
}

/** Per-type thinking: env DEEPSEEK_THINKING_<TYPE> wins, then DEEPSEEK_THINKING, then the defaults. */
function thinkingDefaults(): Record<TaskType, Thinking> {
  const out = { ...DEFAULT_THINKING };
  const global = envChoice("DEEPSEEK_THINKING", THINKING_MODES) as Thinking | undefined;
  for (const t of Object.keys(out) as TaskType[]) {
    out[t] = (envChoice(`DEEPSEEK_THINKING_${t.toUpperCase()}`, THINKING_MODES) as Thinking | undefined) ?? global ?? out[t];
  }
  return out;
}

/** Per-type reasoning effort: env DEEPSEEK_REASONING_EFFORT_<TYPE> wins, then DEEPSEEK_REASONING_EFFORT. */
function effortDefaults(): Record<TaskType, string> {
  const out = {} as Record<TaskType, string>;
  const global = envChoice("DEEPSEEK_REASONING_EFFORT", API_EFFORTS);
  for (const t of Object.keys(DEFAULT_THINKING) as TaskType[]) {
    out[t] = envChoice(`DEEPSEEK_REASONING_EFFORT_${t.toUpperCase()}`, API_EFFORTS) || global || DEFAULT_REASONING_EFFORT;
  }
  return out;
}

function readApiKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(HOME_DIR, "api-key"), "utf8").trim();
  } catch {
    return "";
  }
}

export function loadConfig(): Config {
  return {
    apiKey: readApiKey(),
    baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
    strictTools: process.env.DEEPSEEK_STRICT_TOOLS === "on",
    webEnabled: process.env.DEEPSEEK_WEB !== "off",
    models: {
      flash: {
        id: process.env.DEEPSEEK_MODEL_FLASH || "deepseek-flash",
        price: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      },
      pro: {
        id: process.env.DEEPSEEK_MODEL_PRO || "deepseek-v4-pro",
        price: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      },
    },
    thinkingByType: thinkingDefaults(),
    reasoningEffortByType: effortDefaults(),
    maxToolStepTokens: num("DEEPSEEK_MAX_TOOL_STEP_TOKENS", 8_000),
    maxFinalTokens: num("DEEPSEEK_MAX_FINAL_TOKENS", 16_000),
    maxSteps: num("DEEPSEEK_MAX_STEPS", 25),
    maxStepsByType: {
      review: num("DEEPSEEK_MAX_STEPS_REVIEW", 80),
      research: num("DEEPSEEK_MAX_STEPS_RESEARCH", 80),
      debug: num("DEEPSEEK_MAX_STEPS_DEBUG", 50),
      plan: num("DEEPSEEK_MAX_STEPS_PLAN", 40),
    },
    maxTaskTokens: num("DEEPSEEK_MAX_TASK_TOKENS", 3_000_000),
    cacheWeight: Math.min(1, num("DEEPSEEK_CACHE_WEIGHT", 0.1)),
    compactTokens: Math.min(800_000, num("DEEPSEEK_COMPACT_TOKENS", 200_000)),
    fanoutConcurrency: num("DEEPSEEK_FANOUT_CONCURRENCY", 3),
    maxReplyChars: num("DEEPSEEK_MAX_REPLY_CHARS", 3200),
    commandTimeoutMs: num("DEEPSEEK_COMMAND_TIMEOUT_SEC", 300) * 1000,
    extraAllowCommands: (process.env.DEEPSEEK_ALLOW_COMMANDS || "")
      .split(";")
      .map((s) => s.trim().split(/\s+/).filter(Boolean))
      .filter((a) => a.length > 0),
    elicitation: process.env.DEEPSEEK_ELICITATION === "off" ? "off" : "auto",
    defaultWorkspace: process.env.DEEPSEEK_WORKSPACE || process.cwd(),
  };
}

/** Default step limit for a task type. */
export function stepsFor(cfg: Config, type: TaskType): number {
  return cfg.maxStepsByType[type] ?? cfg.maxSteps;
}

/** Thinking mode for a task type. With thinking off, no reasoning tokens are generated. */
export function thinkingFor(cfg: Config, type?: TaskType): Thinking {
  return (type && cfg.thinkingByType[type]) || "disabled";
}

/** Reasoning effort for a task type; the API only gets it when thinking is on. */
export function reasoningEffortFor(cfg: Config, type?: TaskType): string {
  return (type && cfg.reasoningEffortByType[type]) || DEFAULT_REASONING_EFFORT;
}
