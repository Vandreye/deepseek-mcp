import { defineConfig } from "vitest/config";

// Backups and task artifacts live in .deepseek-mcp, and bench/ holds old versions and the
// benchmark project; never run those copies as tests.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/dist/**", "**/.deepseek-mcp/**", "bench/**"] },
});
