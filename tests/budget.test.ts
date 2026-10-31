import { describe, expect, it } from "vitest";
import { startFanOut, startTask } from "../src/agent.js";
import { ApprovalStore } from "../src/approvals.js";
import { compactHistory } from "../src/compact.js";
import type { ChatFn, ChatMessage, ChatRequest, Usage } from "../src/deepseek.js";
import { compactReport, mergedReport } from "../src/report.js";
import { TaskStore } from "../src/tasks.js";
import { tempWorkspace, testConfig } from "./helpers.js";

const listCall = (id = "x"): ChatMessage => ({
  role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "list_dir", arguments: "{}" } }],
});

function scripted(replies: ChatMessage[], usage: Usage): { chat: ChatFn; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatFn = async (req) => {
    requests.push(structuredClone(req));
    const message = replies.shift();
    if (!message) throw new Error("script exhausted");
    return { message, usage, finishReason: "stop" };
  };
  return { chat, requests };
}

const deps = (chat: ChatFn, cfg = testConfig()) => ({ chat, config: cfg, approvals: new ApprovalStore(), tasks: new TaskStore() });
const input = (over: object = {}) => ({ task: "t", type: "review" as const, model: "flash" as const, workspace: tempWorkspace(), readOnly: true, ...over });

describe("token budget", () => {
  it("counts cached input at the cache weight, so cheap re-reads don't stop the run", async () => {
    // 1M per step, 95% cached → about 0.145M weighted per step.
    const { chat } = scripted([listCall(), listCall(), listCall(), listCall(), { role: "assistant", content: "done" }],
      { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 950_000, prompt_cache_miss_tokens: 50_000, completion_tokens: 10 });
    const task = await startTask(input(), deps(chat, { ...testConfig(), maxTaskTokens: 1_000_000, compactTokens: 1e9 }));
    expect(task.status).toBe("done");
    expect(task.run!.rawInputTokens).toBe(5_000_000);
    expect(task.run!.inputTokens).toBe(725_000);
  });

  it("takes a per-call token budget and names it in the report", async () => {
    const { chat } = scripted([listCall(), listCall(), { role: "assistant", content: "partial" }],
      { prompt_tokens: 400_000, prompt_cache_hit_tokens: 200_000, completion_tokens: 10 });
    // 220k weighted per call (200k new + 200k cached at 10%); two steps pass 300k, then the final report call.
    const task = await startTask(input({ maxTokens: 300_000 }), deps(chat, { ...testConfig(), compactTokens: 1e9 }));
    expect(task.status).toBe("token_limit");
    expect(compactReport(task, new ApprovalStore(), 3200, "brief")).toMatch(/token limit \(660k\/300k input tokens, cached counted lower; 1\.20M sent, step 2\//);
  });
});

describe("thinking and output caps per task type", () => {
  it("thinks only for the hard types, and caps tool steps and the final report", async () => {
    const { chat, requests } = scripted([listCall(), { role: "assistant", content: "partial" }],
      { prompt_tokens: 1000, completion_tokens: 10 });
    const cfg = { ...testConfig(), compactTokens: 1e9 };
    await startTask(input({ maxSteps: 1 }), deps(chat, cfg)); // type "review"
    expect(requests[0]).toMatchObject({ thinking: "enabled", reasoning_effort: "low", max_tokens: 8000 });
    expect(requests[1]).toMatchObject({ thinking: "enabled", max_tokens: 16000 }); // final report

    const code = scripted([{ role: "assistant", content: "done" }], { prompt_tokens: 1000, completion_tokens: 10 });
    await startTask(input({ type: "code" }), deps(code.chat, cfg));
    expect(code.requests[0].thinking).toBe("disabled");
  });

  it("uses the user's /ds-effort choice over the defaults", async () => {
    const reply = () => scripted([{ role: "assistant", content: "done" }], { prompt_tokens: 1000, completion_tokens: 10 });
    const high = reply();
    await startTask(input({ type: "code" }), { ...deps(high.chat), effortFor: () => "high" as const });
    expect(high.requests[0]).toMatchObject({ thinking: "enabled", reasoning_effort: "high" });
    const off = reply();
    await startTask(input(), { ...deps(off.chat), effortFor: () => "off" as const }); // review
    expect(off.requests[0].thinking).toBe("disabled");
  });
});

describe("history compaction", () => {
  it("shortens old tool outputs and keeps recent ones and DeepSeek's notes", () => {
    const big = "line\n".repeat(500);
    const messages: ChatMessage[] = [{ role: "system", content: "s" }];
    for (let i = 0; i < 10; i++) {
      messages.push({ ...listCall(`c${i}`), content: `note src/a.ts:${i}` });
      messages.push({ role: "tool", tool_call_id: `c${i}`, content: big });
    }
    const removed = compactHistory(messages, 3);
    const tools = messages.filter((m) => m.role === "tool");
    expect(removed).toBeGreaterThan(0);
    expect(tools.slice(0, 7).every((m) => m.content!.startsWith("[shortened] list_dir"))).toBe(true);
    expect(tools.slice(7).every((m) => m.content === big)).toBe(true);
    expect(messages.filter((m) => m.content?.startsWith("note src/a.ts:")).length).toBe(10);
    expect(compactHistory(messages, 3)).toBe(0); // already shortened
  });

  it("drops reasoning_content from all but the latest assistant message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "assistant", content: "a1", reasoning_content: "think-1", tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "small output" },
      { role: "assistant", content: "a2", reasoning_content: "think-22" },
    ];
    expect(compactHistory(messages, 8)).toBe("think-1".length); // only the old reasoning goes
    expect(messages[1].reasoning_content).toBeUndefined();
    expect(messages[1].content).toBe("a1"); // only the reasoning goes
    expect(messages[3].reasoning_content).toBe("think-22"); // the latest one stays
    expect(compactHistory(messages, 8)).toBe(0); // nothing left to strip
  });

  it("runs during a task once the prompt is big", async () => {
    const { chat, requests } = scripted([...Array.from({ length: 12 }, (_, i) => listCall(`c${i}`)), { role: "assistant", content: "done" }],
      { prompt_tokens: 100_000, completion_tokens: 10 });
    const cfg = { ...testConfig(), compactTokens: 50_000, maxTaskTokens: 1e9 };
    const ws = tempWorkspace();
    // make list_dir output long enough to be worth shortening
    for (let i = 0; i < 40; i++) (await import("node:fs")).writeFileSync(`${ws}/file-with-a-long-name-${i}.txt`, "x");
    const task = await startTask(input({ workspace: ws, maxSteps: 20 }), deps(chat, cfg));
    expect(task.run!.compactions).toBeGreaterThan(0);
    expect(requests.at(-1)!.messages.some((m) => m.content?.startsWith("[shortened]"))).toBe(true);
    expect(compactReport(task, new ApprovalStore(), 3200, "brief")).toMatch(/history shortened \d+×/);
  });
});

describe("fan-out", () => {
  it("runs one sub-task per area and merges the reports", async () => {
    const seen: string[] = [];
    const chat: ChatFn = async (req) => {
      const user = req.messages.find((m) => m.role === "user")!.content!;
      const area = /Your area for this run: (\w+)/.exec(user)![1];
      seen.push(area);
      return { message: { role: "assistant", content: `- finding in ${area}` }, usage: { prompt_tokens: 1000, completion_tokens: 10 }, finishReason: "stop" };
    };
    const areas = ["auth", "feeds", "discord"];
    const list = await startFanOut(input(), areas, deps(chat, { ...testConfig(), fanoutConcurrency: 2 }));
    expect(seen.sort()).toEqual([...areas].sort());
    expect(list.map((t) => t.status)).toEqual(["done", "done", "done"]);
    const report = mergedReport(areas, list, new ApprovalStore(), 3200);
    for (const a of areas) expect(report).toContain(`## Area: ${a}`);
    expect(report).toContain("finding in feeds");
    expect(report).toMatch(/Total DeepSeek usage: 3\.0k in/);
  });
});
