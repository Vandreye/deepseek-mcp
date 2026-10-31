import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startTask } from "../src/agent.js";
import { ApprovalStore } from "../src/approvals.js";
import { stepsFor } from "../src/config.js";
import type { ChatFn, ChatMessage, ChatRequest } from "../src/deepseek.js";
import { systemPrompt } from "../src/prompts.js";
import { compactReport, cutSummary, errorLine } from "../src/report.js";
import { loadModels, modelFor, saveModels } from "../src/routing.js";
import { TaskStore } from "../src/tasks.js";
import { fixWindowsProgram } from "../src/tools/command.js";
import { executeTool } from "../src/tools/registry.js";
import { makeCtx, tempWorkspace, testConfig } from "./helpers.js";

function scripted(replies: ChatMessage[], promptTokens = 1000): { chat: ChatFn; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatFn = async (req) => {
    requests.push(structuredClone(req));
    const message = replies.shift();
    if (!message) throw new Error("script exhausted");
    return { message, usage: { prompt_tokens: promptTokens, completion_tokens: 10 }, finishReason: "stop" };
  };
  return { chat, requests };
}
const listCall = { role: "assistant" as const, content: "", tool_calls: [{ id: "x", type: "function" as const, function: { name: "list_dir", arguments: "{}" } }] };

describe("windows command paths", () => {
  it("turns slashes in the program into backslashes on Windows only", () => {
    expect(fixWindowsProgram("service/.venv/Scripts/python -m pytest a/b.py", "win32")).toBe("service\\.venv\\Scripts\\python -m pytest a/b.py");
    expect(fixWindowsProgram('"my dir/bin/tool" x', "win32")).toBe('"my dir\\bin\\tool" x');
    expect(fixWindowsProgram("npm test", "win32")).toBe("npm test");
    expect(fixWindowsProgram("service/.venv/bin/python -m pytest", "linux")).toBe("service/.venv/bin/python -m pytest");
  });
});

describe("prompts and limits", () => {
  it("adds a self-check and budget plan for reviews, not for code", () => {
    const review = systemPrompt("review", "/w", true, { maxSteps: 80, maxTokens: 3e6 });
    expect(review).toMatch(/re-open every file:line/);
    expect(review).toMatch(/about 80 tool steps/);
    expect(systemPrompt("code", "/w", false, { maxSteps: 25, maxTokens: 3e6 })).not.toMatch(/re-open|Budget:/);
  });

  it("gives reviews a higher step limit", () => {
    const cfg = testConfig();
    expect(stepsFor(cfg, "review")).toBeGreaterThanOrEqual(80);
    expect(stepsFor(cfg, "code")).toBe(cfg.maxSteps);
  });

  it("warns DeepSeek when steps run low and names the limit in the report", async () => {
    const { chat, requests } = scripted([listCall, listCall, listCall, listCall, listCall, { role: "assistant", content: "partial" }]);
    const task = await startTask(
      { task: "t", type: "research", model: "flash", workspace: tempWorkspace(), readOnly: true, maxSteps: 5 },
      { chat, config: testConfig(), approvals: new ApprovalStore(), tasks: new TaskStore() },
    );
    const warnings = requests.at(-1)!.messages.filter((m) => m.role === "tool" && m.content?.includes("[Budget:"));
    expect(warnings).toHaveLength(1);
    expect(compactReport(task, new ApprovalStore(), 3200, "brief")).toContain("stopped at step limit (5/5 steps)");
  });

  it("reports the token limit with numbers", async () => {
    const { chat } = scripted([listCall, listCall, { role: "assistant", content: "partial" }], 2_000_000);
    const task = await startTask(
      { task: "t", type: "review", model: "flash", workspace: tempWorkspace(), readOnly: true },
      { chat, config: { ...testConfig(), maxTaskTokens: 3_000_000 }, approvals: new ApprovalStore(), tasks: new TaskStore() },
    );
    expect(task.status).toBe("token_limit");
    expect(compactReport(task, new ApprovalStore(), 3200, "brief")).toMatch(/token limit \(6\.00M\/3\.00M input tokens, step 2\/80\)/);
  });
});

describe("compact report", () => {
  it("cuts at whole items and keeps the Not done part", () => {
    const findings = Array.from({ length: 30 }, (_, i) => `- src/f${i}.ts:${i} — problem number ${i} — fix it like this\n  more detail for ${i}`).join("\n");
    const text = `${findings}\nNot done: scheduler, collectors`;
    const out = cutSummary(text, 800, "more");
    expect(out.length).toBeLessThanOrEqual(800);
    expect(out).toContain("Not done: scheduler, collectors");
    expect(out).toMatch(/more items cut/);
    // no half items: every kept bullet has its detail line
    const kept = out.split("\n").filter((l) => l.startsWith("- src/")).length;
    expect(out.split("\n").filter((l) => l.startsWith("  more detail")).length).toBe(kept);
  });

  it("shows one error line per failed command", () => {
    expect(errorLine("collecting...\n'service' is not recognized as an internal or external command,\noperable program or batch file.\n")).toMatch(/not recognized/);
    const ctx = makeCtx(tempWorkspace());
    ctx.task.commands.push({ command: "npm test", exitCode: 1, output: "line\n".repeat(50) + "Error: boom\n", status: "ran" });
    const report = compactReport(ctx.task, ctx.approvals, 3200, "brief");
    expect(report).toContain("FAIL(1) npm test → Error: boom");
    expect(report).not.toContain("    line");
  });
});

describe("partial reads", () => {
  it("reads 400 lines by default and points to grep and offset", async () => {
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "big.txt"), Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join("\n"));
    const out = await executeTool(makeCtx(ws), "read_file", JSON.stringify({ path: "big.txt", limit: null }));
    expect(out).toContain("l400");
    expect(out).not.toContain("l401\n");
    expect(out).toMatch(/file has 1000 lines; showed 1-400.*offset=401/);
  });
});

describe("default model per type", () => {
  it("layers user and project files and falls back to flash", () => {
    const home = tempWorkspace();
    const ws = tempWorkspace();
    saveModels("user", { review: "pro" }, ws, home);
    saveModels("project", { debug: "pro", review: "flash" }, ws, home);
    const t = loadModels(ws, home);
    expect(modelFor(t, "review")).toBe("flash");
    expect(modelFor(t, "debug")).toBe("pro");
    expect(modelFor(t, "code")).toBe("flash");
  });
});
