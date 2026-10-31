import { describe, expect, it } from "vitest";
import { startFanOut } from "../src/agent.js";
import { ApprovalStore } from "../src/approvals.js";
import { retryAfter, type ChatFn } from "../src/deepseek.js";
import { classifyCommand, parseCommand, toCommandString } from "../src/safety/commands.js";
import { TaskStore } from "../src/tasks.js";
import { tempWorkspace, testConfig } from "./helpers.js";

describe("review fixes", () => {
  it("splits a small explicit budget across areas without a per-area floor", async () => {
    const chat: ChatFn = async () => ({ message: { role: "assistant", content: "ok" }, usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: "stop" });
    const deps = { chat, config: testConfig(), approvals: new ApprovalStore(), tasks: new TaskStore() };
    const input = { task: "t", type: "review" as const, model: "flash" as const, workspace: tempWorkspace(), readOnly: true, maxTokens: 50_000 };
    const list = await startFanOut(input, ["a", "b", "c", "d", "e", "f", "g", "h"], deps);
    expect(list.reduce((s, t) => s + t.run!.maxTokens, 0)).toBeLessThanOrEqual(50_000);
  });

  it("keeps quotes and backslashes in rebuilt commands", () => {
    expect(toCommandString(["git", "log", 'say "hi"'])).toBe('git log "say \\"hi\\""');
    expect(toCommandString(["x", "a b\\"])).toBe('x "a b\\\\"');
    const parsed = parseCommand(`git log --grep 'a"b'`);
    expect(parsed.ok && toCommandString(parsed.argv)).toBe('git log --grep "a\\"b"');
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    expect(retryAfter("3")).toBe(3000);
    expect(retryAfter(null)).toBe(0);
    const now = Date.parse("Sun, 01 Nov 2026 00:00:00 GMT");
    expect(retryAfter("Sun, 01 Nov 2026 00:00:05 GMT", now)).toBe(5000);
    expect(retryAfter("nonsense")).toBe(0);
  });

  it("sends allowed tools with file-writing flags for approval", () => {
    const cls = (c: string) => { const p = parseCommand(c); return p.ok ? classifyCommand(p.argv) : "bad"; };
    for (const c of ["npx eslint --fix .", "npx prettier --check --write .", "ruff check --fix .", "npx tsc --build --clean",
      "npx vitest -u", "npx jest --updateSnapshot", "cargo clippy --fix", "npx eslint . -o out.txt", "npx eslint . --output-file=o"]) {
      expect(cls(c), c).toBe("approve");
    }
    for (const c of ["npx eslint .", "npx eslint --fix-dry-run .", "npx tsc --noEmit", "npm test", "ruff check ."]) {
      expect(cls(c), c).toBe("allow");
    }
  });
});
