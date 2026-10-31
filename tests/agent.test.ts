import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { continueTask, startTask } from "../src/agent.js";
import { ApprovalStore } from "../src/approvals.js";
import type { ChatFn, ChatMessage, ChatRequest } from "../src/deepseek.js";
import { compactReport, reportSection } from "../src/report.js";
import { TaskStore } from "../src/tasks.js";
import { tempWorkspace, testConfig } from "./helpers.js";

/** Fake DeepSeek that plays back a script of assistant messages. */
function scripted(replies: ChatMessage[]): { chat: ChatFn; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatFn = async (req) => {
    requests.push(structuredClone(req));
    const message = replies.shift();
    if (!message) throw new Error("script exhausted");
    return { message, usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }, finishReason: "stop" };
  };
  return { chat, requests };
}

const tool = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

describe("agent loop", () => {
  it("runs tools, keeps reasoning_content, queues deletes and returns a compact report", async () => {
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "old.js"), "legacy\n");
    const { chat, requests } = scripted([
      { role: "assistant", content: "", reasoning_content: "think-1", tool_calls: [tool("c1", "write_file", { path: "src/sum.js", content: "export const sum=(a,b)=>a+b;\n" })] },
      { role: "assistant", content: "", reasoning_content: "think-2", tool_calls: [tool("c2", "run_command", { command: "node --version" }), tool("c3", "request_delete", { paths: ["old.js"], reason: "replaced" })] },
      { role: "assistant", content: "- Added src/sum.js\n- Asked to delete old.js", reasoning_content: "think-3" },
    ]);
    const approvals = new ApprovalStore();
    const deps = { chat, config: testConfig(), approvals, tasks: new TaskStore() };
    const task = await startTask({ task: "Add a sum helper", type: "code", model: "flash", workspace: ws, readOnly: false, files: ["old.js"] }, deps);

    expect(task.status).toBe("done");
    expect(task.steps).toBe(3);
    expect(fs.readFileSync(path.join(ws, "src", "sum.js"), "utf8")).toContain("sum");
    expect(fs.existsSync(path.join(ws, "old.js"))).toBe(true); // not deleted without approval

    // DeepSeek requires reasoning_content to be sent back in tool loops.
    expect(requests[2].messages.filter((m) => m.reasoning_content).map((m) => m.reasoning_content)).toEqual(["think-1", "think-2"]);
    expect(requests[0].messages[1].content).toContain("old.js");

    const report = compactReport(task, approvals, 3200, "brief");
    expect(report).toContain("A src/sum.js +1/-0");
    expect(report).toContain("OK node --version");
    expect(report).toContain("NEEDS USER APPROVAL");
    expect(report).toContain("p1: DELETE old.js");
    expect(report.length).toBeLessThan(1500);
    expect(reportSection(task, "diff", "src/sum.js")).toContain("+export const sum");

    // Follow-up reuses history and passes on approval results.
    task.notes.push("User rejected p1");
    const second = scripted([{ role: "assistant", content: "ok" }]);
    await continueTask(task, "Also export it as default", { ...deps, chat: second.chat });
    const last = second.requests[0].messages.at(-1)!;
    expect(last.content).toContain("User rejected p1");
    expect(second.requests[0].messages.length).toBeGreaterThan(6);
  });

  it("stops at the step limit and asks for a final report", async () => {
    const ws = tempWorkspace();
    const loopCall = { role: "assistant" as const, content: "", tool_calls: [tool("x", "list_dir", {})] };
    const { chat, requests } = scripted([loopCall, loopCall, { role: "assistant", content: "partial" }]);
    const task = await startTask(
      { task: "t", type: "research", model: "flash", workspace: ws, readOnly: true, maxSteps: 2 },
      { chat, config: testConfig(), approvals: new ApprovalStore(), tasks: new TaskStore() },
    );
    expect(task.status).toBe("step_limit");
    expect(task.finalText).toBe("partial");
    expect(requests[2].tool_choice).toBe("none");
    expect(requests[0].tools!.some((t) => t.function.name === "write_file")).toBe(false);
  });

  it("reports API errors instead of throwing", async () => {
    const chat: ChatFn = async () => {
      throw new Error("DeepSeek API 401: bad key");
    };
    const task = await startTask(
      { task: "t", type: "code", model: "flash", workspace: tempWorkspace(), readOnly: false },
      { chat, config: testConfig(), approvals: new ApprovalStore(), tasks: new TaskStore() },
    );
    expect(task.status).toBe("error");
    expect(compactReport(task, new ApprovalStore(), 3200, "brief")).toContain("401");
  });
});
