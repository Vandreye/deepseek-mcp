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
