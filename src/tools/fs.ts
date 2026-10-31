import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_DIR_NAME } from "../config.js";
import { isSecretFile, resolveSafe } from "../safety/paths.js";
import type { TaskRecord } from "../tasks.js";

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", WORKSPACE_DIR_NAME, ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache",
]);

// Stay under TOOL_OUTPUT_MAX (8k) so reads stop with a clean "continue at offset" note.
const MAX_READ_CHARS = 7_800;
/** Lines returned when no limit is given. Big files should be read in ranges. */
export const DEFAULT_READ_LINES = 200;

export function readFile(task: TaskRecord, p: string, offset = 1, limit = DEFAULT_READ_LINES): string {
  const { abs, rel } = resolveSafe(task.workspace, p, "read");
  const st = statOrThrow(abs, rel);
  if (st.isDirectory()) throw new Error(`${rel} is a folder; use list_dir.`);
  if (st.size > 20 * 1024 * 1024) throw new Error(`${rel} is too large (${st.size} bytes).`);
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${rel} looks like a binary file.`);
  const lines = buf.toString("utf8").split(/\r?\n/);
  const start = Math.max(1, Math.floor(offset));
  const end = Math.min(lines.length, start + Math.max(1, Math.floor(limit)) - 1);
  let out = "";
  for (let i = start; i <= end; i++) {
    const line = lines[i - 1].length > 2000 ? lines[i - 1].slice(0, 2000) + "…" : lines[i - 1];
    out += `${String(i).padStart(5)}\t${line}\n`;
    if (out.length > MAX_READ_CHARS) {
      out += `…[stopped at line ${i}; use offset=${i + 1} to continue]\n`;
      return out;
    }
  }
  if (end < lines.length) {
    out += `…[file has ${lines.length} lines; showed ${start}-${end}. Prefer grep to find what you need, then read_file with offset/limit. Next: offset=${end + 1}]\n`;
  }
  return out || "(empty file)";
}

export function listDir(task: TaskRecord, p = ".", depth = 2): string {
  const { abs, rel } = resolveSafe(task.workspace, p, "read");
  if (!statOrThrow(abs, rel).isDirectory()) throw new Error(`${rel} is not a folder.`);
  const lines: string[] = [];
  const walk = (dir: string, prefix: string, level: number) => {
    let entries = fs.readdirSync(dir, { withFileTypes: true });
    entries = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= 500) return;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        lines.push(`${prefix}${e.name}/`);
        if (level < depth) walk(path.join(dir, e.name), prefix + "  ", level + 1);
      } else if (!isSecretFile(path.relative(task.workspace, path.join(dir, e.name)).replace(/\\/g, "/"))) {
        // Secret files (.env, keys) are hidden here too, as in read_file, grep and glob.
        lines.push(`${prefix}${e.name}`);
      }
    }
  };
  walk(abs, "", 1);
  if (lines.length >= 500) lines.push("…[truncated at 500 entries]");
  return lines.join("\n") || "(empty folder)";
}

/** Remember the original content (and back it up) the first time a task touches a file. */
export function recordOriginal(task: TaskRecord, abs: string, rel: string): void {
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return;
  if (task.originals.has(rel)) return;
  if (fs.existsSync(abs)) {
    const content = fs.readFileSync(abs, "utf8");
    task.originals.set(rel, content);
    const backup = path.join(task.workspace, WORKSPACE_DIR_NAME, "backups", task.id, rel);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, content);
  } else {
    task.originals.set(rel, null);
  }
}

export function writeFile(task: TaskRecord, p: string, content: string): string {
  const { abs, rel } = resolveSafe(task.workspace, p, "write");
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error(`${rel} is a folder.`);
  recordOriginal(task, abs, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? "");
  return `Wrote ${rel} (${countLines(content ?? "")} lines).`;
}

export function editFile(task: TaskRecord, p: string, oldStr: string, newStr: string, replaceAll = false): string {
  const { abs, rel } = resolveSafe(task.workspace, p, "write");
  statOrThrow(abs, rel);
  const text = fs.readFileSync(abs, "utf8");
  if (!oldStr) throw new Error("old_string is empty. Use write_file to create or fully rewrite a file.");
  let from = oldStr;
  let to = newStr ?? "";
  // Files with Windows line endings: match edits written with \n.
  if (text.includes("\r\n") && !from.includes("\r\n") && from.includes("\n")) {
    from = from.replace(/\n/g, "\r\n");
    to = to.replace(/\r?\n/g, "\r\n");
  }
  const count = text.split(from).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${rel}. Re-read the file and copy the text exactly.`);
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string occurs ${count} times in ${rel}. Add surrounding lines to make it unique, or set replace_all.`);
  }
  recordOriginal(task, abs, rel);
  const updated = replaceAll ? text.split(from).join(to) : text.replace(from, () => to);
  fs.writeFileSync(abs, updated);
  return `Edited ${rel} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? "s" : ""}).`;
}

function statOrThrow(abs: string, rel: string): fs.Stats {
  try {
    return fs.statSync(abs);
  } catch {
    throw new Error(`${rel || "."} does not exist.`);
  }
}

function countLines(s: string): number {
  return s ? s.split(/\r?\n/).length : 0;
}
