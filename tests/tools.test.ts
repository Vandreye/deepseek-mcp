import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeAction } from "../src/approvals.js";
import { fileChanges } from "../src/tasks.js";
import { executeTool, trackDeletes } from "../src/tools/registry.js";
import { makeCtx, tempWorkspace } from "./helpers.js";

const call = (ctx: ReturnType<typeof makeCtx>, name: string, args: unknown) => executeTool(ctx, name, JSON.stringify(args));

describe("DeepSeek file tools", () => {
  it("writes, edits (CRLF too), reads and records changes with backups", async () => {
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "one\r\ntwo\r\nthree\r\n");
    const ctx = makeCtx(ws);
    expect(await call(ctx, "write_file", { path: "src/new.ts", content: "export const x = 1;\n" })).toMatch(/Wrote src\/new.ts/);
    expect(await call(ctx, "edit_file", { path: "a.txt", old_string: "one\ntwo", new_string: "ONE\nTWO" })).toMatch(/Edited/);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("ONE\r\nTWO\r\nthree\r\n");
    expect(await call(ctx, "read_file", { path: "a.txt" })).toContain("1\tONE");
    expect(await call(ctx, "edit_file", { path: "a.txt", old_string: "nope", new_string: "x" })).toMatch(/not found/);

    const changes = fileChanges(ctx.task);
    expect(changes.map((c) => `${c.kind} ${c.rel}`)).toEqual(["M a.txt", "A src/new.ts"]);
    expect(fs.existsSync(path.join(ws, ".deepseek-mcp", "backups", ctx.task.id, "a.txt"))).toBe(true);
  });

  it("blocks writes in read-only tasks and outside the workspace", async () => {
    const ws = tempWorkspace();
    expect(await call(makeCtx(ws, true), "write_file", { path: "x.txt", content: "x" })).toMatch(/not available/);
    expect(await call(makeCtx(ws), "write_file", { path: "../x.txt", content: "x" })).toMatch(/outside/);
    expect(await call(makeCtx(ws), "read_file", { path: ".env" })).toMatch(/secrets/);
  });

  it("searches with glob and grep", async () => {
    const ws = tempWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.mkdirSync(path.join(ws, "node_modules"));
    fs.writeFileSync(path.join(ws, "src", "a.ts"), "const needle = 1;\n");
    fs.writeFileSync(path.join(ws, "node_modules", "b.ts"), "needle\n");
    const ctx = makeCtx(ws);
    expect(await call(ctx, "glob", { pattern: "**/*.ts" })).toBe("src/a.ts");
    expect(await call(ctx, "grep", { pattern: "needle" })).toBe("src/a.ts:1: const needle = 1;");
    expect(await call(ctx, "glob", { pattern: "../*" })).toMatch(/relative/);
  });
});

describe("deletes and risky commands need approval", () => {
  it("request_delete only queues; the file stays until approved, then goes to trash", async () => {
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "old.ts"), "old\n");
    const ctx = makeCtx(ws);
    const msg = await call(ctx, "request_delete", { paths: ["old.ts"], reason: "unused" });
    expect(msg).toMatch(/Queued as p1/);
    expect(fs.existsSync(path.join(ws, "old.ts"))).toBe(true);

    const item = ctx.approvals.get("p1")!;
    trackDeletes(ctx.task, item);
    expect(await executeAction(item, 10_000)).toMatch(/deleted/);
    expect(fs.existsSync(path.join(ws, "old.ts"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".deepseek-mcp", "trash", "p1", "old.ts"))).toBe(true);
    expect(fileChanges(ctx.task)[0]).toMatchObject({ rel: "old.ts", kind: "D" });
  });

  it("run_command refuses deletes and non-allowlisted commands", async () => {
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "keep.txt"), "k");
    const ctx = makeCtx(ws);
    expect(await call(ctx, "run_command", { command: "del keep.txt" })).toMatch(/Not run/);
    expect(await call(ctx, "run_command", { command: "git status && del keep.txt" })).toMatch(/Not run/);
    expect(fs.existsSync(path.join(ws, "keep.txt"))).toBe(true);
    expect(await call(ctx, "request_command", { command: "del keep.txt", reason: "x" })).toMatch(/Queued/);
    expect(ctx.approvals.list()[0]).toMatchObject({ kind: "command", deletes: true });
  });

  it("with a direct prompt (elicitation) a declined request does nothing", async () => {
    const ws = tempWorkspace();
    fs.writeFileSync(path.join(ws, "x.ts"), "x");
    const ctx = { ...makeCtx(ws), askUser: async () => false };
    expect(await call(ctx, "request_delete", { paths: ["x.ts"], reason: "r" })).toMatch(/Queued/);
    expect(fs.existsSync(path.join(ws, "x.ts"))).toBe(true);

    const yes = { ...makeCtx(ws), askUser: async () => true };
    expect(await call(yes, "request_delete", { paths: ["x.ts"], reason: "r" })).toMatch(/approved/);
    expect(fs.existsSync(path.join(ws, "x.ts"))).toBe(false);
  });

  it("runs allowlisted commands", async () => {
    const ctx = makeCtx(tempWorkspace());
    const out = await call(ctx, "run_command", { command: "node --version" });
    expect(out).toMatch(/Exit code 0[\s\S]*v\d+/);
  });
});
