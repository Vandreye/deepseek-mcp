import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export interface Config {
  apiKey: string;
  baseUrl: string;
  models: Record<ModelKey, ModelInfo>;
  thinking: "enabled" | "disabled";
  reasoningEffort: string;
  maxSteps: number;
  maxTaskTokens: number;
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
    thinking: process.env.DEEPSEEK_THINKING === "disabled" ? "disabled" : "enabled",
    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || "high",
    maxSteps: num("DEEPSEEK_MAX_STEPS", 25),
    maxTaskTokens: num("DEEPSEEK_MAX_TASK_TOKENS", 3_000_000),
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
