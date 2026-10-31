import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { isSecretFile } from "../safety/paths.js";
import type { TaskRecord } from "../tasks.js";
import { IGNORED_DIRS } from "./fs.js";

const IGNORE = [...IGNORED_DIRS].map((d) => `**/${d}/**`);

function cleanPattern(pattern: string): string {
  const p = (pattern || "**/*").replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.split("/").includes("..")) {
    throw new Error("Glob patterns must be relative to the workspace (no '..' or absolute paths).");
  }
  return p;
}

export async function globFiles(task: TaskRecord, pattern: string, max = 500): Promise<string> {
  const files = await fg(cleanPattern(pattern), {
    cwd: task.workspace, ignore: IGNORE, dot: true, onlyFiles: true, followSymbolicLinks: false,
  });
  const visible = files.filter((f) => !isSecretFile(f)).sort();
  if (visible.length === 0) return "No files match.";
  const shown = visible.slice(0, max);
  return shown.join("\n") + (visible.length > max ? `\n…[${visible.length - max} more]` : "");
}

const MAX_TEST_CHARS = 10_000;

/**
 * DeepSeek often writes PCRE/Python-style leading flags like "(?i)foo", which JavaScript rejects.
 * Turn leading i/s/m flag groups into RegExp flags (other flags would change nothing per line).
 */
export function jsRegex(pattern: string, ignoreCase?: boolean): { source: string; flags: string } {
  let source = pattern;
  const flags = new Set(ignoreCase ? ["i"] : []);
  let m: RegExpExecArray | null;
  while ((m = /^\(\?([imsx]+)\)/.exec(source))) {
    for (const f of m[1]) if (f === "i" || f === "s" || f === "m") flags.add(f);
    source = source.slice(m[0].length);
  }
  return { source, flags: [...flags].join("") };
}

export interface GrepArgs {
  pattern: string;
  glob?: string;
  ignore_case?: boolean;
  files_only?: boolean;
  max_results?: number;
}

export async function grep(task: TaskRecord, a: GrepArgs): Promise<string> {
  let re: RegExp;
  try {
    const { source, flags } = jsRegex(a.pattern, a.ignore_case);
    re = new RegExp(source, flags);
  } catch (e) {
    throw new Error(`Invalid regex: ${(e as Error).message}`);
  }
  const max = Math.min(Math.max(1, a.max_results ?? 100), 500);
  const files = await fg(cleanPattern(a.glob || "**/*"), {
    cwd: task.workspace, ignore: IGNORE, dot: true, onlyFiles: true, followSymbolicLinks: false,
  });
  const out: string[] = [];
  for (const rel of files.sort()) {
    if (isSecretFile(rel)) continue;
    const abs = path.join(task.workspace, rel);
    let buf: Buffer;
    try {
      if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // A bad pattern on a huge line (minified files) can run for minutes; test only its start.
      if (!re.test(lines[i].length > MAX_TEST_CHARS ? lines[i].slice(0, MAX_TEST_CHARS) : lines[i])) continue;
      if (a.files_only) {
        out.push(rel);
        break;
      }
      const text = lines[i].length > 300 ? lines[i].slice(0, 300) + "…" : lines[i];
      out.push(`${rel}:${i + 1}: ${text}`);
      if (out.length >= max) break;
    }
    if (out.length >= max) {
      out.push(`…[stopped at ${max} results]`);
      break;
    }
  }
  return out.length ? out.join("\n") : "No matches.";
}
