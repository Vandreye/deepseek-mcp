#!/usr/bin/env node
// Does delegating save Claude tokens? Runs each benchmark task through real Claude Code
// (`claude -p`) twice: once with Claude doing it alone, once with the DeepSeek MCP and
// routing set to DeepSeek. Compares Claude's tokens and cost, DeepSeek's cost and pass rate.
//   node bench/claude-vs-ds.mjs [--tasks a,b] [--reps 2] [--model sonnet]
// Uses your Claude plan/API key and your DeepSeek key. Build first (npm run build).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixture } from "./fixture.mjs";
import { TASKS } from "./tasks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const DEFAULT_TASKS = "review-orders,bugfix-slug,code-chunk,tests-money,research-upload,review-legacy-high";
const taskIds = opt("tasks", DEFAULT_TASKS).split(",");
const reps = Number(opt("reps", "2"));
const model = opt("model", "");
const modes = ["claude", "delegate"];
const entry = path.join(root, "dist", "index.js");
if (!fs.existsSync(entry)) throw new Error("Run npm run build first.");
const tasks = taskIds.map((id) => TASKS.find((t) => t.id === id) ?? (() => { throw new Error(`unknown task ${id}`); })());

const ALLOWED_TOOLS = [
  "Read", "Grep", "Glob", "Edit", "Write", "Bash(npm test)", "Bash(npm test:*)", "Bash(node --test:*)",
  "mcp__deepseek__deepseek_task", "mcp__deepseek__deepseek_ask", "mcp__deepseek__deepseek_get_report",
];

const TYPES = ["plan", "code", "review", "bugfix", "debug", "research", "tests", "docs", "question", "general", "default"];

function claude(args, cwd, env) {
  return new Promise((resolve) => {
    const child = execFile("claude", args, { cwd, env, maxBuffer: 50e6, timeout: 15 * 60_000 }, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ is_error: true, result: `harness: ${(stderr || stdout || err?.message || "").slice(0, 400)}` });
      }
    });
    child.stdin?.end(); // no stdin: claude -p would otherwise wait 3s for it
  });
}

/** DeepSeek's cost for a run, from the server's audit log (the last "done"-type event per task). */
function deepseekCost(ws) {
  const dir = path.join(ws, ".deepseek-mcp", "logs");
  if (!fs.existsSync(dir)) return { cost: 0, tasks: 0 };
  const last = new Map();
  for (const f of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line);
      if (typeof e.cost === "number") last.set(e.task ?? e.taskId ?? f, e.cost);
    }
  }
  return { cost: [...last.values()].reduce((a, b) => a + b, 0), tasks: last.size };
}

async function runOne(task, mode, rep) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cvd-home-"));
  writeFixture(ws);
  const mcp = { mcpServers: {} };
  if (mode === "delegate") {
    fs.writeFileSync(path.join(home, "routing.json"), JSON.stringify(Object.fromEntries(TYPES.map((t) => [t, "deepseek"]))));
    mcp.mcpServers.deepseek = {
      command: process.execPath, args: [entry],
      env: { DEEPSEEK_MCP_HOME: home, DEEPSEEK_WORKSPACE: ws, ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}) },
    };
    const key = path.join(os.homedir(), ".deepseek-mcp", "api-key");
    if (!process.env.DEEPSEEK_API_KEY && fs.existsSync(key)) fs.copyFileSync(key, path.join(home, "api-key"));
  }
  const mcpFile = path.join(home, "mcp.json");
  fs.writeFileSync(mcpFile, JSON.stringify(mcp));
  const args = [
    "-p", task.args.task, "--output-format", "json",
    // Only what the tasks need, inside a throwaway copy of the test project. Anything else is refused.
    "--permission-mode", "dontAsk", "--allowedTools", ...ALLOWED_TOOLS,
    "--mcp-config", mcpFile, "--strict-mcp-config", "--no-session-persistence",
    ...(model ? ["--model", model] : []),
  ];
  const started = Date.now();
  const out = await claude(args, ws, { ...process.env });
  const report = out.result ?? "";
  let check;
  try {
    check = task.check({ report, dir: ws });
  } catch (e) {
    check = { pass: false, score: 0, detail: `check error: ${e.message}` };
  }
  const u = out.usage ?? {};
  const ds = deepseekCost(ws);
  return {
    task: task.id, mode, rep, pass: !!check.pass, score: check.score ?? 0, detail: check.detail,
    claudeCost: out.total_cost_usd ?? 0, turns: out.num_turns ?? 0, wallMs: Date.now() - started,
    input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0,
    models: Object.keys(out.modelUsage ?? {}), dsCost: ds.cost, dsTasks: ds.tasks, isError: !!out.is_error,
    resultExcerpt: report.slice(0, 400),
  };
}

const results = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(root, "bench", "results");
fs.mkdirSync(outDir, { recursive: true });
const jsonl = path.join(outDir, `claude-vs-ds-${stamp}.jsonl`);
for (let rep = 1; rep <= reps; rep++) {
  for (const task of tasks) {
    // Both modes of a task run side by side, so API load hits them alike.
    const pair = await Promise.all(modes.map((m) => runOne(task, m, rep)));
    for (const r of pair) {
      results.push(r);
      fs.appendFileSync(jsonl, JSON.stringify(r) + "\n");
      console.log(`${r.pass ? "PASS" : "FAIL"} ${r.mode.padEnd(8)} ${r.task.padEnd(20)} r${rep} claude $${r.claudeCost.toFixed(3)} ` +
        `(in ${r.input} + cache w ${r.cacheWrite} / r ${r.cacheRead}, out ${r.output}, ${r.turns} turns) deepseek $${r.dsCost.toFixed(4)} ${(r.wallMs / 1000).toFixed(0)}s ${r.detail ?? ""}${r.isError ? " ERROR " + r.resultExcerpt.slice(0, 120) : ""}`);
    }
  }
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const lines = [
  `# Claude alone vs delegated to DeepSeek`, ``, `From: ${path.basename(jsonl)}. Models: ${[...new Set(results.flatMap((r) => r.models))].join(", ")}. ${reps} repeats.`, ``,
  `| task | mode | pass | Claude $ | Claude output tok | Claude input tok (new + cache write + cache read) | turns | DeepSeek $ | total $ | time (s) |`,
  `|---|---|---|---|---|---|---|---|---|---|`,
];
for (const t of [...tasks.map((t) => t.id), "ALL"]) {
  for (const m of modes) {
    const rs = results.filter((r) => r.mode === m && (t === "ALL" || r.task === t));
    if (!rs.length) continue;
    const c = avg(rs.map((r) => r.claudeCost));
    const d = avg(rs.map((r) => r.dsCost));
    lines.push(`| ${t} | ${m} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${c.toFixed(3)} | ${Math.round(avg(rs.map((r) => r.output)))} | ` +
      `${Math.round(avg(rs.map((r) => r.input)))} + ${Math.round(avg(rs.map((r) => r.cacheWrite)))} + ${Math.round(avg(rs.map((r) => r.cacheRead)))} | ` +
      `${avg(rs.map((r) => r.turns)).toFixed(1)} | ${d.toFixed(4)} | ${(c + d).toFixed(3)} | ${(avg(rs.map((r) => r.wallMs)) / 1000).toFixed(0)} |`);
  }
}
const md = jsonl.replace(/\.jsonl$/, ".md");
fs.writeFileSync(md, lines.join("\n") + "\n");
console.log("\n" + lines.join("\n") + `\n\nSaved ${md}`);
