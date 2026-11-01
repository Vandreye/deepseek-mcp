import fs from "node:fs";
import { resolveSafe } from "./safety/paths.js";

/** A finding's location (`src/a.ts:42` or `src/a.ts:42-48`) and its `seen: \`code\`` quote. */
const LOCATION = /([\w.\-/\\]+\.[\w]+):(\d+)(?:-(\d+))?/;
const SEEN = /seen:\s*`([^`]+)`/i;

/** Lines either side of the cited line where the quote may be, since models are often off by a few. */
const SLACK = 3;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Check each finding's quote against the file. Claude is told it can trust quoted findings
 * without opening the file, so a quote that isn't there gets flagged. Lines without a location
 * and a quote are left unchanged. Returns the text with "[quote NOT found at that line]" added
 * where the check failed.
 */
export function checkQuotes(text: string, workspace: string): string {
  const cache = new Map<string, string[] | null>();
  const linesOf = (rel: string): string[] | null => {
    if (!cache.has(rel)) {
      try {
        cache.set(rel, fs.readFileSync(resolveSafe(workspace, rel, "read").abs, "utf8").split(/\r?\n/));
      } catch {
        cache.set(rel, null);
      }
    }
    return cache.get(rel)!;
  };
  let lastLoc: RegExpExecArray | null = null; // a finding may put its quote on the next line
  return text.split("\n").map((line) => {
    if (!line.trim()) lastLoc = null;
    const seen = SEEN.exec(line);
    const loc = LOCATION.exec(line) ?? lastLoc;
    lastLoc = loc;
    if (!seen || !loc) return line;
    const lines = linesOf(loc[1].replace(/\\/g, "/").replace(/^\.\//, ""));
    const quote = squash(seen[1]).replace(/…$|\.\.\.$/, "").trim();
    if (!quote) return line;
    if (lines) {
      const from = Math.max(0, Number(loc[2]) - 1 - SLACK);
      const to = Math.min(lines.length, Number(loc[3] ?? loc[2]) + SLACK);
      if (squash(lines.slice(from, to).join(" ")).includes(quote)) return line;
    }
    return `${line} [quote NOT found at that line]`;
  }).join("\n");
}
