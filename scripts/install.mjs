#!/usr/bin/env node
// Sets up deepseek-mcp for Claude Code (CLI and VS Code extension), user-wide.
//   node scripts/install.mjs [--force] [--allow-tools] [--no-mcp]
//   --force        overwrite slash commands that differ from yours
//   --allow-tools  stop Claude Code asking before each DeepSeek tool call
//                  (approve_actions always keeps asking)
//   --no-mcp       don't register the MCP server
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "index.js");
const claudeDir = path.join(os.homedir(), ".claude");
const dsHome = process.env.DEEPSEEK_MCP_HOME || path.join(os.homedir(), ".deepseek-mcp");
const log = (s) => console.log(s);

if (!fs.existsSync(entry)) {
  console.error("dist/index.js not found. Run `npm run build` first.");
  process.exit(1);
}

// 1. Routing table (who does what). Never overwrite the user's choices.
fs.mkdirSync(dsHome, { recursive: true });
const routing = path.join(dsHome, "routing.json");
if (!fs.existsSync(routing)) {
  const { DEFAULT_ROUTING } = await import(new URL(`file:///${path.join(root, "dist", "routing.js").replace(/\\/g, "/")}`));
  fs.writeFileSync(routing, JSON.stringify(DEFAULT_ROUTING, null, 2) + "\n");
  log(`✓ Created routing table ${routing}`);
} else {
  log(`✓ Kept existing routing table ${routing}`);
}

// 2. Slash commands (/ds, /route, /ds-approve) for every project.
const cmdSrc = path.join(root, "claude-commands");
const cmdDst = path.join(claudeDir, "commands");
fs.mkdirSync(cmdDst, { recursive: true });
for (const f of fs.readdirSync(cmdSrc).filter((f) => f.endsWith(".md"))) {
  const src = fs.readFileSync(path.join(cmdSrc, f), "utf8");
  const dst = path.join(cmdDst, f);
  if (fs.existsSync(dst) && fs.readFileSync(dst, "utf8") !== src && !args.has("--force")) {
    log(`! Skipped ${dst} (you have a different file; use --force to overwrite)`);
    continue;
  }
  fs.writeFileSync(dst, src);
}
log(`✓ Installed slash commands into ${cmdDst}`);
// Older versions installed one command per task type. Each one sits in every Claude session's
// context, so remove ours (they call the deepseek MCP tools); leave files that aren't ours.
const RETIRED = ["ds-code", "ds-debug", "ds-effort", "ds-fix", "ds-plan", "ds-research", "ds-review", "ds-tests"];
const removed = [];
for (const name of RETIRED) {
  const f = path.join(cmdDst, `${name}.md`);
  if (fs.existsSync(f) && /deepseek_(task|routing)/.test(fs.readFileSync(f, "utf8"))) {
    fs.rmSync(f);
    removed.push(`/${name}`);
  }
}
if (removed.length) log(`✓ Removed old commands now covered by /ds and /route: ${removed.join(", ")}`);

// 3. Permission rules: approve_actions must always ask you, even in auto-accept modes.
const settingsFile = path.join(claudeDir, "settings.json");
try {
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
  settings.permissions ??= {};
  const add = (list, rule) => {
    settings.permissions[list] ??= [];
    if (!settings.permissions[list].includes(rule)) settings.permissions[list].push(rule);
  };
  add("ask", "mcp__deepseek__approve_actions");
  if (args.has("--allow-tools")) {
    for (const t of ["deepseek_task", "deepseek_ask", "deepseek_routing", "deepseek_get_report", "list_pending_approvals", "reject_actions"]) {
      add("allow", `mcp__deepseek__${t}`);
    }
  }
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  log(`✓ Updated ${settingsFile} (approve_actions always asks you${args.has("--allow-tools") ? "; other DeepSeek tools allowed" : ""})`);
} catch (e) {
  log(`! Could not update ${settingsFile}: ${e.message}`);
  log(`  Add "mcp__deepseek__approve_actions" to permissions.ask yourself.`);
}

// 4. Register the MCP server for all projects.
if (!args.has("--no-mcp")) {
  const run = (cmd) => execSync(cmd, { stdio: "pipe", encoding: "utf8" });
  try {
    try {
      run("claude mcp remove deepseek --scope user");
    } catch {
      /* not registered yet */
    }
    run(`claude mcp add deepseek --scope user -- node "${entry}"`);
    log(`✓ Registered MCP server "deepseek" (user scope) → ${entry}`);
  } catch (e) {
    log(`! Could not run the claude CLI: ${(e.stderr || e.message || "").toString().trim()}`);
    log(`  Run it yourself: claude mcp add deepseek --scope user -- node "${entry}"`);
  }
}

// 5. API key.
const hasKey = !!process.env.DEEPSEEK_API_KEY || fs.existsSync(path.join(dsHome, "api-key"));
log(hasKey
  ? "✓ DeepSeek API key found"
  : `! No DeepSeek API key yet. Either set the DEEPSEEK_API_KEY environment variable, or save the key in ${path.join(dsHome, "api-key")}`);
log("\nRestart Claude Code / VS Code, then run /mcp to check that \"deepseek\" is connected.");
