import { defineConfig } from "vitest/config";

// Backups and task artifacts live in .deepseek-mcp; never run those copies as tests.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/dist/**", "**/.deepseek-mcp/**"] },
});
