import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_DIR_NAME } from "./config.js";

/** Task types you can route. `general` and anything unlisted fall back to `default`. */
export const TASK_TYPES = [
  "plan", "code", "review", "bugfix", "debug", "research", "tests", "docs", "question", "general",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const ROUTES = ["deepseek", "claude", "ask"] as const;
export type Route = (typeof ROUTES)[number];

export type RoutingTable = Partial<Record<TaskType | "default", Route>>;

/** Starting suggestion only; the user edits it with /route or the JSON file. */
export const DEFAULT_ROUTING: RoutingTable = {
  plan: "claude",
  code: "deepseek",
  review: "claude",
  bugfix: "deepseek",
  debug: "deepseek",
  research: "deepseek",
  tests: "deepseek",
  docs: "deepseek",
  question: "deepseek",
  default: "claude",
};

export const ROUTING_FILE = "routing.json";

export function userRoutingPath(homeDir: string): string {
  return path.join(homeDir, ROUTING_FILE);
}

export function projectRoutingPath(workspace: string): string {
  return path.join(workspace, WORKSPACE_DIR_NAME, ROUTING_FILE);
}

function readTable(file: string): RoutingTable | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out: RoutingTable = {};
    for (const [key, val] of Object.entries(raw ?? {})) {
      if ((key === "default" || (TASK_TYPES as readonly string[]).includes(key)) && (ROUTES as readonly string[]).includes(val as string)) {
        out[key as TaskType] = val as Route;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Built-in defaults, then the user file, then the project file (most specific wins). */
export function loadRouting(workspace: string, homeDir: string): RoutingTable {
  return {
    ...DEFAULT_ROUTING,
    ...(readTable(userRoutingPath(homeDir)) ?? {}),
    ...(readTable(projectRoutingPath(workspace)) ?? {}),
  };
}

export function routeFor(table: RoutingTable, type: TaskType): Route {
  return table[type] ?? table.default ?? "claude";
}

export function saveRouting(
  scope: "user" | "project",
  changes: RoutingTable,
  workspace: string,
  homeDir: string,
): string {
  const file = scope === "user" ? userRoutingPath(homeDir) : projectRoutingPath(workspace);
  const current = readTable(file) ?? (scope === "user" ? { ...DEFAULT_ROUTING } : {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, ...changes }, null, 2) + "\n");
  return file;
}

/** One compact line, e.g. "code→deepseek, review→claude, …, other→claude". */
export function describeRouting(table: RoutingTable): string {
  const parts = TASK_TYPES.filter((t) => table[t]).map((t) => `${t}→${table[t]}`);
  return `${parts.join(", ")}, other→${table.default ?? "claude"}`;
}

/** Returns an error message if the routing does not allow DeepSeek for this call, else null. */
export function checkRoute(table: RoutingTable, type: TaskType, userOverride: boolean): string | null {
  if (userOverride) return null;
  const route = routeFor(table, type);
  if (route === "deepseek") return null;
  if (route === "ask") {
    return `Routing for "${type}" is "ask": ask the user whether DeepSeek should do this. If they say yes, call again with user_override: true.`;
  }
  return `Routing sends "${type}" tasks to Claude, not DeepSeek. Do it yourself, unless the user explicitly asked for DeepSeek (then set user_override: true).`;
}

// ---- Default DeepSeek model per task type ----

export const MODEL_KEYS = ["flash", "pro"] as const;
export type ModelChoice = (typeof MODEL_KEYS)[number];
export type ModelTable = Partial<Record<TaskType | "default", ModelChoice>>;

export const MODELS_FILE = "models.json";

export function userModelsPath(homeDir: string): string {
  return path.join(homeDir, MODELS_FILE);
}

export function projectModelsPath(workspace: string): string {
  return path.join(workspace, WORKSPACE_DIR_NAME, MODELS_FILE);
}

function readModels(file: string): ModelTable {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out: ModelTable = {};
    for (const [key, val] of Object.entries(raw ?? {})) {
      if ((key === "default" || (TASK_TYPES as readonly string[]).includes(key)) && (MODEL_KEYS as readonly string[]).includes(val as string)) {
        out[key as TaskType] = val as ModelChoice;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** User file, then project file (most specific wins). Nothing set means flash. */
export function loadModels(workspace: string, homeDir: string): ModelTable {
  return { ...readModels(userModelsPath(homeDir)), ...readModels(projectModelsPath(workspace)) };
}

export function modelFor(table: ModelTable, type: TaskType): ModelChoice {
  return table[type] ?? table.default ?? "flash";
}

export function saveModels(scope: "user" | "project", changes: ModelTable, workspace: string, homeDir: string): string {
  const file = scope === "user" ? userModelsPath(homeDir) : projectModelsPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...readModels(file), ...changes }, null, 2) + "\n");
  return file;
}

/** e.g. "review→pro, other→flash". */
export function describeModels(table: ModelTable): string {
  const parts = TASK_TYPES.filter((t) => table[t]).map((t) => `${t}→${table[t]}`);
  return [...parts, `other→${table.default ?? "flash"}`].join(", ");
}

// ---- Thinking effort per task type (/ds-effort) ----

/** off = no thinking; low/medium/high = thinking at that reasoning_effort; auto = built-in default. */
export const EFFORTS = ["off", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export type EffortTable = Partial<Record<TaskType | "default", Effort>>;

export const EFFORTS_FILE = "efforts.json";

export function userEffortsPath(homeDir: string): string {
  return path.join(homeDir, EFFORTS_FILE);
}

export function projectEffortsPath(workspace: string): string {
  return path.join(workspace, WORKSPACE_DIR_NAME, EFFORTS_FILE);
}

function readEfforts(file: string): EffortTable {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out: EffortTable = {};
    for (const [key, val] of Object.entries(raw ?? {})) {
      if ((key === "default" || (TASK_TYPES as readonly string[]).includes(key)) && (EFFORTS as readonly string[]).includes(val as string)) {
        out[key as TaskType] = val as Effort;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** User file, then project file (most specific wins). Empty means built-in defaults. */
export function loadEfforts(workspace: string, homeDir: string): EffortTable {
  return { ...readEfforts(userEffortsPath(homeDir)), ...readEfforts(projectEffortsPath(workspace)) };
}

/** The user's effort for a type, or undefined to keep the built-in default. */
export function effortFor(table: EffortTable, type: TaskType): Effort | undefined {
  return table[type] ?? table.default;
}

/** Saves changes; "auto" removes the entry so the built-in default applies again. */
export function saveEfforts(
  scope: "user" | "project",
  changes: Partial<Record<TaskType | "default", Effort | "auto">>,
  workspace: string,
  homeDir: string,
): string {
  const file = scope === "user" ? userEffortsPath(homeDir) : projectEffortsPath(workspace);
  const next: Record<string, string> = { ...readEfforts(file) };
  for (const [k, v] of Object.entries(changes)) {
    if (v === "auto") delete next[k];
    else if (v) next[k] = v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return file;
}

/** e.g. "review→high, other→auto". */
export function describeEfforts(table: EffortTable): string {
  const parts = TASK_TYPES.filter((t) => table[t]).map((t) => `${t}→${table[t]}`);
  return [...parts, `other→${table.default ?? "auto"}`].join(", ");
}
