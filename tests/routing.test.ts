import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkRoute, DEFAULT_ROUTING, describeRouting, loadRouting, routeFor, saveRouting } from "../src/routing.js";
import { tempWorkspace } from "./helpers.js";

describe("routing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsmcp-home-"));
  const ws = tempWorkspace();

  it("starts from defaults", () => {
    const t = loadRouting(ws, home);
    expect(t).toEqual(DEFAULT_ROUTING);
    expect(routeFor(t, "general")).toBe("claude"); // falls back to default
  });

  it("user file overrides defaults, project file overrides user", () => {
    saveRouting("user", { review: "deepseek", code: "ask" }, ws, home);
    saveRouting("project", { review: "claude" }, ws, home);
    const t = loadRouting(ws, home);
    expect(t.code).toBe("ask");
    expect(t.review).toBe("claude");
    expect(loadRouting(tempWorkspace(), home).review).toBe("deepseek");
  });

  it("ignores invalid entries in the file", () => {
    fs.writeFileSync(path.join(home, "routing.json"), JSON.stringify({ code: "gpt", bogus: "deepseek", docs: "claude" }));
    const t = loadRouting(tempWorkspace(), home);
    expect(t.code).toBe(DEFAULT_ROUTING.code);
    expect(t.docs).toBe("claude");
  });

  it("enforces routing unless the user overrides", () => {
    const t = { code: "deepseek", review: "claude", plan: "ask", default: "claude" } as const;
    expect(checkRoute(t, "code", false)).toBeNull();
    expect(checkRoute(t, "review", false)).toMatch(/Claude/);
    expect(checkRoute(t, "plan", false)).toMatch(/ask the user/);
    expect(checkRoute(t, "review", true)).toBeNull();
    expect(describeRouting(t)).toContain("code→deepseek");
  });
});
