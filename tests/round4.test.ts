import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTask } from "../src/agent.js";
import { ApprovalStore } from "../src/approvals.js";
import { createDeepSeekChat, isPeak, strictTool, UsageTotals, type ChatFn, type ChatMessage, type ChatRequest } from "../src/deepseek.js";
import { classifyCommand, parseCommand } from "../src/safety/commands.js";
import { TaskStore } from "../src/tasks.js";
import { listDir } from "../src/tools/fs.js";
import { executeTool, toolDefs } from "../src/tools/registry.js";
import { webSearch } from "../src/tools/web.js";
import { makeCtx, tempWorkspace, testConfig } from "./helpers.js";

const deps = (chat: ChatFn) => ({ chat, config: { ...testConfig(), compactTokens: 1e9 }, approvals: new ApprovalStore(), tasks: new TaskStore() });
const input = (over: object = {}) => ({ task: "t", type: "research" as const, model: "flash" as const, workspace: tempWorkspace(), readOnly: true, ...over });
const usage = { prompt_tokens: 1000, completion_tokens: 10 };

function scripted(steps: [ChatMessage, string][]): { chat: ChatFn; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatFn = async (req) => {
    requests.push(structuredClone(req));
    const [message, finishReason] = steps.shift()!;
    return { message, usage, finishReason };
  };
  return { chat, requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("finish reasons", () => {
  it("redoes a step DeepSeek stopped for lack of server capacity", async () => {
    const { chat, requests } = scripted([[{ role: "assistant", content: "" }, "insufficient_system_resource"], [{ role: "assistant", content: "report" }, "stop"]]);
    const task = await startTask(input(), deps(chat));
    expect(requests).toHaveLength(2);
    expect(task.finalText).toBe("report");
  });

  it("says when the content filter stopped the reply", async () => {
    const { chat } = scripted([[{ role: "assistant", content: "partial" }, "content_filter"]]);
    const task = await startTask(input(), deps(chat));
    expect(task.finalText).toMatch(/^partial\n\n\[DeepSeek's content filter/);
  });
});

describe("cost and usage", () => {
  it("knows DeepSeek's peak hours", () => {
    expect(isPeak(new Date("2026-11-02T02:30:00Z"))).toBe(true); // Monday 02:30 UTC
    expect(isPeak(new Date("2026-11-02T05:00:00Z"))).toBe(false); // gap between the peak windows
    expect(isPeak(new Date("2026-11-02T09:59:00Z"))).toBe(true);
    expect(isPeak(new Date("2026-11-01T02:30:00Z"))).toBe(false); // Sunday
  });

  it("charges half off-peak, counts thinking tokens and web calls", () => {
    const model = { id: "m", price: { cacheHit: 0, cacheMiss: 1, output: 0 } } as any;
    const u = new UsageTotals();
    u.add({ prompt_tokens: 1e6, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1500 } }, model, new Date("2026-11-02T02:00:00Z"));
    u.add({ prompt_tokens: 1e6, completion_tokens: 0 }, model, new Date("2026-11-01T02:00:00Z"));
    u.addWeb();
    expect(u.cost).toBeCloseTo(1 + 0.5 + 0.00075, 6);
    expect(u.summary()).toMatch(/2\.0k out \(1\.5k thinking\), 2 calls, 1 web,/);
  });
});

describe("strict tool schemas", () => {
  it("lists every property as required, makes optional ones nullable, and forbids extras", () => {
    const read = toolDefs(true).find((t) => t.function.name === "read_file")!;
    const s = strictTool(read);
    expect(s.function.strict).toBe(true);
    const p = s.function.parameters as any;
    expect(p.required).toEqual(["path", "offset", "limit"]);
    expect(p.additionalProperties).toBe(false);
    expect(p.properties.path).toEqual({ type: "string", description: "Workspace-relative path" });
    expect(p.properties.offset.anyOf).toEqual([{ type: "integer" }, { type: "null" }]);
    expect(read.function.parameters).not.toHaveProperty("additionalProperties"); // original untouched
  });

  it("treats null arguments from strict mode as not given", async () => {
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
    const out = await executeTool(makeCtx(ws, true), "read_file", JSON.stringify({ path: "a.txt", offset: null, limit: null }));
    expect(out).toMatch(/1\tone/);
  });

  it("sends strict tools to the /beta base URL only when turned on", async () => {
    const urls: string[] = [];
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      urls.push(url);
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage }));
    });
    const tools = toolDefs(true);
    await createDeepSeekChat({ ...testConfig(), strictTools: true })({ model: "m", messages: [], tools });
    await createDeepSeekChat({ ...testConfig(), strictTools: false })({ model: "m", messages: [], tools });
    expect(urls[0]).toMatch(/\/beta\/chat\/completions$/);
    expect(bodies[0].tools[0].function.strict).toBe(true);
    expect(urls[1]).not.toMatch(/beta/);
    expect(bodies[1].tools[0].function.strict).toBeUndefined();
  });
});

describe("API timeouts", () => {
  it("does not retry a call that hit our own timeout", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    await expect(createDeepSeekChat(testConfig())({ model: "m", messages: [] })).rejects.toThrow(/15 minutes/);
    expect(calls).toBe(1);
  });
});

describe("web tools", () => {
  it("are offered only to read-only tasks that asked for them", async () => {
    const names = (ro: boolean, web: boolean) => toolDefs(ro, web).map((t) => t.function.name);
    expect(names(true, true)).toContain("web_search");
    expect(names(true, false)).not.toContain("web_search");
    expect(names(false, true)).not.toContain("web_search");
    const { chat, requests } = scripted([[{ role: "assistant", content: "r" }, "stop"]]);
    const task = await startTask(input({ web: true, readOnly: false, type: "code" }), deps(chat));
    expect(task.web).toBe(false);
    expect(requests[0].tools!.map((t) => t.function.name)).not.toContain("web_fetch");
  });

  it("stay off unless DEEPSEEK_WEB=on", async () => {
    const ask = () => scripted([[{ role: "assistant", content: "r" }, "stop"]]);
    expect(testConfig().webEnabled).toBe(false);
    const off = await startTask(input({ web: true }), deps(ask().chat));
    expect(off.web).toBe(false);
    const on = ask();
    const task = await startTask(input({ web: true }), { ...deps(on.chat), config: { ...testConfig(), compactTokens: 1e9, webEnabled: true } });
    expect(task.web).toBe(true);
    expect(on.requests[0].tools!.map((t) => t.function.name)).toContain("web_search");
  });

  it("are refused when the task has no web access", async () => {
    const out = await executeTool(makeCtx(tempWorkspace(), true), "web_search", JSON.stringify({ query: "x" }));
    expect(out).toMatch(/not available/);
  });

  it("formats search results and counts the call", async () => {
    let sent: any;
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ results: [{ title: "Docs", url: "https://x.dev", summary: "About   x", date: "2026-10-17T00:00:00Z" }] }));
    });
    const ctx = makeCtx(tempWorkspace(), true);
    ctx.task.web = true;
    const out = await executeTool(ctx, "web_search", JSON.stringify({ query: "q".repeat(200) }));
    expect(sent.url).toMatch(/\/v1\/tools\/search$/);
    expect(sent.body.query).toHaveLength(128);
    expect(out).toBe("1. Docs (2026-10-17)\n   https://x.dev\n   About x");
    expect(ctx.task.usage.webCalls).toBe(1);
  });

  it("does not bill an empty search", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [] })));
    expect(await webSearch(testConfig(), "q")).toEqual({ text: "No results.", billed: false });
  });
});

describe("smaller fixes", () => {
  it("catches eslint -o with the file name attached", () => {
    const p = parseCommand("npx eslint . -oout.txt");
    expect(p.ok && classifyCommand(p.argv)).toBe("approve");
  });

  it("hides secret files from list_dir", () => {
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, ".env"), "K=1");
    fs.writeFileSync(path.join(ws, ".env.example"), "K=");
    fs.writeFileSync(path.join(ws, "a.ts"), "");
    const out = listDir(makeCtx(ws).task);
    expect(out).not.toMatch(/^\.env$/m);
    expect(out).toMatch(/\.env\.example/);
    expect(out).toMatch(/a\.ts/);
  });
});

describe("grep patterns from other regex dialects", () => {
  it("turns leading (?i) style flags into JavaScript flags", async () => {
    const { jsRegex } = await import("../src/tools/search.js");
    expect(jsRegex("(?i)upload|size")).toEqual({ source: "upload|size", flags: "i" });
    expect(jsRegex("(?is)a.b", false)).toEqual({ source: "a.b", flags: "is" });
    expect(jsRegex("(?x)a", true)).toEqual({ source: "a", flags: "i" });
    expect(jsRegex("plain(?i)")).toEqual({ source: "plain(?i)", flags: "" }); // only leading groups
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "a.js"), "const MAX_UPLOAD = 5;\n");
    const out = await executeTool(makeCtx(ws, true), "grep", JSON.stringify({ pattern: "(?i)max_upload" }));
    expect(out).toMatch(/a\.js:1:/);
  });
});
