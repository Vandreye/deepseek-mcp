import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkQuotes } from "../src/quotes.js";
import { tempWorkspace } from "./helpers.js";

describe("seen-quote check", () => {
  const ws = tempWorkspace();
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "a.js"), ["const a = 1;", "", "function f(x) {", "  return  eval(x);", "}"].join("\n"));

  it("leaves a quote that is at (or near) the cited line", () => {
    const line = "- `src/a.js:4` — eval on input — use JSON.parse — seen: `return eval(x);`";
    expect(checkQuotes(line, ws)).toBe(line);
    expect(checkQuotes("- src/a.js:2 — x — seen: `return eval(x)…`", ws)).not.toMatch(/NOT found/);
  });

  it("flags a quote that is not in the file there, or a missing file", () => {
    expect(checkQuotes("- src/a.js:4 — x — seen: `exec(x)`", ws)).toMatch(/NOT found/);
    expect(checkQuotes("- src/b.js:4 — x — seen: `eval(x)`", ws)).toMatch(/NOT found/);
  });

  it("uses the location on an earlier line of the same finding, and skips lines without a quote", () => {
    expect(checkQuotes("1. src/a.js:4 — eval\n   seen: `nope`", ws)).toMatch(/NOT found/);
    expect(checkQuotes("1. src/a.js:4 — eval\n\nseen: `nope`", ws)).not.toMatch(/NOT found/);
    expect(checkQuotes("- src/a.js:4 — problem, no quote", ws)).toBe("- src/a.js:4 — problem, no quote");
  });
});
