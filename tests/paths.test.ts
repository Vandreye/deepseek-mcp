import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PathError, isSecretFile, realWorkspace, resolveSafe } from "../src/safety/paths.js";
import { tempWorkspace } from "./helpers.js";

describe("workspace jail", () => {
  const ws = tempWorkspace();
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "a.ts"), "x");

  it("allows normal paths, including new files in new folders", () => {
    expect(resolveSafe(ws, "src/a.ts", "read").rel).toBe("src/a.ts");
    expect(resolveSafe(ws, "./new/deep/file.ts", "write").rel).toBe("new/deep/file.ts");
    expect(resolveSafe(ws, path.join(ws, "src", "a.ts"), "read").rel).toBe("src/a.ts");
  });

  it("rejects escapes with .. and absolute paths", () => {
    expect(() => resolveSafe(ws, "../outside.txt", "read")).toThrow(PathError);
    expect(() => resolveSafe(ws, "src/../../x", "write")).toThrow(/outside/);
    expect(() => resolveSafe(ws, os.tmpdir(), "read")).toThrow(/outside/);
  });

  it("rejects links that point outside", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsmcp-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.symlinkSync(outside, path.join(ws, "link"), "junction");
    expect(() => resolveSafe(ws, "link/secret.txt", "read")).toThrow(/outside/);
    expect(() => resolveSafe(ws, "link/new.txt", "write")).toThrow(/outside/);
  });

  it("protects .git, .deepseek-mcp and secrets", () => {
    expect(() => resolveSafe(ws, ".git/config", "read")).toThrow(/\.git/);
    expect(() => resolveSafe(ws, ".deepseek-mcp/routing.json", "write")).toThrow();
    expect(() => resolveSafe(ws, ".env", "read")).toThrow(/secrets/);
    expect(() => resolveSafe(ws, "config/server.pem", "write")).toThrow(/secrets/);
    expect(resolveSafe(ws, ".env.example", "read").rel).toBe(".env.example");
    expect(isSecretFile("a/.env.production")).toBe(true);
    expect(isSecretFile("a/env.ts")).toBe(false);
  });

  it("refuses the workspace root for writes and bad workspaces", () => {
    expect(() => resolveSafe(ws, ".", "write")).toThrow();
    expect(resolveSafe(ws, ".", "read").rel).toBe("");
    expect(() => realWorkspace(path.parse(ws).root)).toThrow(/root/);
    expect(() => realWorkspace(os.homedir())).toThrow(/home/);
  });
});
