#!/usr/bin/env node
// Benchmark runner: runs the same tasks against one or more versions of the connector,
// talking to each version's MCP server exactly as Claude Code does.
//
//   node bench/run.mjs --versions new=.,old=13c8626 [--tasks all|id,id] [--reps 3]
//                      [--parallel 2] [--budget 3] [--model flash] [--out file.jsonl]
//
// A version is "." (this working tree, rebuilt) or any git ref (checked out into
// bench/.versions/<sha> and built there once).
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFixture } from "./fixture.mjs";
import { TASKS } from "./tasks.mjs";
import { printComparison } from "./compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const PROBE = pathToFileURL(path.join(here, "probe.mjs")).href;

// Peak prices (USD per 1M tokens). Always peak, so runs at different times compare fairly.
const PRICES = {
  flash: { hit: 0.006, miss: 0.3, out: 1.2 },
  pro: { hit: 0.044, miss: 1.32, out: 3.96 },
};
const WEB_PRICE = 0.00075;

// ---------- arguments ----------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
// label=ref, optionally with settings: label=ref?DEEPSEEK_STRICT_TOOLS=off&DEEPSEEK_WEB=off
const versionSpecs = opt("versions", "current=.").split(",").map((spec) => {
  const [main, query = ""] = spec.split("?");
  const eq = main.indexOf("=");
  const [label, ref] = eq >= 0 ? [main.slice(0, eq), main.slice(eq + 1)] : [main, main];
  const env = Object.fromEntries(query.split("&").filter(Boolean).map((kv) => {
    const i = kv.indexOf("=");
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
  return { label, ref, env };
});
const taskIds = opt("tasks", "all");
const tasks = taskIds === "all" ? TASKS : taskIds.split(",").map((id) => {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown task ${id}. Known: ${TASKS.map((x) => x.id).join(", ")}`);
  return t;
});
const reps = Number(opt("reps", "3"));
const parallel = Number(opt("parallel", "2"));
const budget = Number(opt("budget", "3"));
const model = opt("model", "flash");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = path.resolve(opt("out", path.join(here, "results", `${stamp}.jsonl`)));

// ---------- API key ----------
function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const home = process.env.DEEPSEEK_MCP_HOME || path.join(os.homedir(), ".deepseek-mcp");
  try {
    return fs.readFileSync(path.join(home, "api-key"), "utf8").trim();
  } catch {
    return "";
  }
}
const KEY = apiKey();
if (!KEY) {
  console.error("No DeepSeek API key (DEEPSEEK_API_KEY or ~/.deepseek-mcp/api-key).");
  process.exit(1);
}

// ---------- versions ----------
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

let builtWorkingTree = false;
function prepareVersion({ label, ref, env }) {
  if (ref === "." || ref === "current") {
    if (!builtWorkingTree) {
      console.log(`[${label}] building this working tree`);
      sh(`${npm} run build`, repo);
      builtWorkingTree = true;
    }
    return { label, ref: "working tree", env, sha: sh("git rev-parse --short HEAD", repo) + (sh("git status --porcelain", repo) ? "+dirty" : ""), dir: repo };
  }
  const sha = sh(`git rev-parse --short ${ref}`, repo);
  const dir = path.join(here, ".versions", sha);
  if (!fs.existsSync(path.join(dir, "dist", "index.js"))) {
    console.log(`[${label}] preparing ${ref} (${sha}) in ${dir}`);
    if (!fs.existsSync(dir)) sh(`git worktree add --detach "${dir}" ${sha}`, repo);
    sh(`${npm} ci --no-audit --no-fund`, dir);
    sh(`${npm} run build`, dir);
  }
  return { label, ref, env, sha, dir };
}

// ---------- one run ----------
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DEEPSEEK_") && !k.startsWith("BENCH_")));

function connect(version, workspace, home, probeFile, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", PROBE, path.join(version.dir, "dist", "index.js")],
    cwd: workspace,
    env: {
      ...cleanEnv, DEEPSEEK_API_KEY: KEY, DEEPSEEK_MCP_HOME: home, DEEPSEEK_WORKSPACE: workspace,
      // A version's settings win over a task's, so "all off" really means off for every task.
      BENCH_PROBE_FILE: probeFile, ...extraEnv, ...version.env,
    },
    stderr: "pipe",
  });
  // No elicitation capability: approvals go to the queue, as when nobody answers a prompt.
  const client = new Client({ name: "deepseek-bench", version: "1.0.0" }, { capabilities: {} });
  return { client, transport };
}

/** Fixed per-session overhead a version adds to Claude's context: tool schemas + server instructions. */
async function measureOverhead(version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsbench-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsbench-ws-"));
  writeFixture(ws);
  const { client, transport } = connect(version, ws, home, path.join(home, "probe.jsonl"));
  await client.connect(transport);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions?.() ?? "";
  await client.close();
  const chars = JSON.stringify(tools).length + instructions.length;
  return { tools: tools.length, chars, tokens: Math.round(chars / 4) };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function auditEntries(workspace) {
  const dir = path.join(workspace, ".deepseek-mcp", "logs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readJsonl(path.join(dir, f)));
}

function priceFor(modelId) {
  return /pro/i.test(modelId ?? "") ? PRICES.pro : PRICES.flash;
}

async function runOne(version, task, rep) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dsbench-ws-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsbench-home-"));
  const probeFile = path.join(home, "probe.jsonl");
  writeFixture(ws);
  const rec = { version: version.label, sha: version.sha, task: task.id, rep, model, startedAt: new Date().toISOString() };
  const { client, transport } = connect(version, ws, home, probeFile, task.env);
  let report = "";
  const start = Date.now();
  try {
    await client.connect(transport);
    const args = { ...task.args, model, workspace: ws, user_override: true };
    const res = await client.callTool({ name: task.tool, arguments: args }, undefined, { timeout: 40 * 60_000, resetTimeoutOnProgress: true });
    report = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    rec.isError = !!res.isError;
  } catch (e) {
    rec.harnessError = String(e?.message ?? e).slice(0, 300);
  } finally {
    rec.wallMs = Date.now() - start;
    await client.close().catch(() => {});
  }

  // What Claude reads.
  rec.reportChars = report.length;
  rec.reportTokens = Math.round(report.length / 4);
  const header = /DeepSeek task t\d+ \[[^\]]*\] (.+?) after (\d+) steps/.exec(report);
  rec.status = header ? header[1].replace(/\s*\(.*$/, "") : /DeepSeek split task/.test(report) ? "split" : task.tool === "deepseek_ask" ? (report ? "answered" : "empty") : "unknown";
  // Split tasks report one header per area; add their steps up.
  const headers = [...report.matchAll(/DeepSeek task t\d+ \[[^\]]*\] .+? after (\d+) steps/g)];
  rec.steps = headers.length ? headers.reduce((n, h) => n + Number(h[1]), 0) : null;
  rec.cutOff = /\[Report cut off|\[Answer cut off/.test(report);
  rec.markupLeak = /DSML/.test(report);
  rec.noReport = /\(no summary\)|wrote no report/.test(report) || (!report && !rec.harnessError);
  rec.pendingApprovals = (report.match(/^\s+p\d+/gm) ?? []).length || (/NEEDS USER APPROVAL/.test(report) ? 1 : 0);

  // What DeepSeek did and cost (from the probe).
  const calls = readJsonl(probeFile);
  const chat = calls.filter((c) => c.path.endsWith("/chat/completions"));
  const okChat = chat.filter((c) => c.status === 200);
  const web = calls.filter((c) => c.path.includes("/v1/tools/"));
  const sum = (f) => okChat.reduce((s, c) => s + (f(c) ?? 0), 0);
  rec.apiCalls = okChat.length;
  rec.apiRetries = chat.length - okChat.length;
  rec.http429 = chat.filter((c) => c.status === 429).length;
  rec.apiMs = chat.reduce((s, c) => s + (c.ms ?? 0), 0);
  rec.slowestCallMs = Math.max(0, ...chat.map((c) => c.ms ?? 0));
  rec.cacheHit = sum((c) => c.usage?.prompt_cache_hit_tokens);
  rec.cacheMiss = sum((c) => c.usage?.prompt_cache_miss_tokens ?? (c.usage ? c.usage.prompt_tokens - (c.usage.prompt_cache_hit_tokens ?? 0) : 0));
  rec.outTokens = sum((c) => c.usage?.completion_tokens);
  rec.thinkingTokens = sum((c) => c.usage?.completion_tokens_details?.reasoning_tokens);
  rec.cacheRatio = rec.cacheHit + rec.cacheMiss ? +(rec.cacheHit / (rec.cacheHit + rec.cacheMiss)).toFixed(3) : 0;
  rec.capHits = okChat.filter((c) => c.finish === "length").length;
  // The last reply of the run was cut off by the output cap, whether or not the version noticed.
  // (Split tasks: any area's last reply; we only see the last call overall, so this is a lower bound.)
  rec.finalCut = okChat.length > 0 && okChat[okChat.length - 1].finish === "length";
  rec.finishReasons = Object.fromEntries([...new Set(okChat.map((c) => c.finish))].map((f) => [f, okChat.filter((c) => c.finish === f).length]));
  rec.webCalls = web.filter((c) => c.status === 200).length;
  const p = priceFor(okChat[0]?.model);
  rec.costUsd = +((rec.cacheHit * p.hit + rec.cacheMiss * p.miss + rec.outTokens * p.out) / 1e6 + rec.webCalls * WEB_PRICE).toFixed(5);
  // Extra model calls beyond one per step (+1 final report when a limit was hit) = redone steps.
  if (rec.steps !== null) {
    const limit = (report.match(/stopped at (step|token) limit/g) ?? []).length;
    rec.redoneSteps = Math.max(0, rec.apiCalls - rec.steps - limit);
  }

  // Behaviour (from the server's own audit log).
  const audit = auditEntries(ws);
  const tools = audit.filter((e) => e.tool);
  rec.toolCalls = tools.length;
  rec.toolErrors = tools.filter((e) => e.ok === false).length;
  rec.toolErrorSamples = tools.filter((e) => e.ok === false).slice(0, 3).map((e) => `${e.tool}: ${String(e.error).slice(0, 100)}`);
  const reads = tools.filter((e) => e.tool === "read_file").map((e) => `${e.args?.path}|${e.args?.offset ?? 1}|${e.args?.limit ?? ""}`);
  rec.fileReads = reads.length;
  rec.repeatReads = reads.length - new Set(reads).size;
  rec.compactions = audit.filter((e) => e.event === "compact").length;

  // Quality.
  try {
    const c = task.check({ report, dir: ws });
    Object.assign(rec, { pass: c.pass, score: +c.score.toFixed(2), checkDetail: c.detail });
  } catch (e) {
    Object.assign(rec, { pass: false, score: 0, checkDetail: `check failed: ${e.message}` });
  }
  rec.reportExcerpt = report.slice(0, 600);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  return rec;
}

// ---------- main ----------
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const versions = versionSpecs.map(prepareVersion);
for (const v of versions) {
  v.overhead = await measureOverhead(v);
  const meta = { kind: "version", version: v.label, ref: v.ref, settings: v.env, sha: v.sha, overhead: v.overhead, model, at: new Date().toISOString() };
  fs.appendFileSync(outFile, JSON.stringify(meta) + "\n");
  console.log(`[${v.label}] ${v.sha}: ${v.overhead.tools} tools, ~${v.overhead.tokens} tokens of fixed overhead per Claude session`);
}

// Interleave versions (A,B / B,A ...) so changes in API load hit all of them alike.
const queue = [];
for (let r = 1; r <= reps; r++) {
  for (const t of tasks) {
    const order = r % 2 ? versions : [...versions].reverse();
    for (const v of order) queue.push({ v, t, r });
  }
}
console.log(`${queue.length} runs (${tasks.length} tasks x ${reps} reps x ${versions.length} versions), ${parallel} at a time, budget $${budget}. Results: ${outFile}`);

let spent = 0;
let done = 0;
let skipped = 0;
const worker = async () => {
  while (queue.length) {
    if (spent >= budget) {
      skipped += queue.length;
      queue.length = 0;
      break;
    }
    const { v, t, r } = queue.shift();
    const rec = await runOne(v, t, r);
    spent += rec.costUsd ?? 0;
    fs.appendFileSync(outFile, JSON.stringify(rec) + "\n");
    done++;
    console.log(`${String(done).padStart(3)} ${rec.pass ? "PASS" : "FAIL"} ${v.label.padEnd(8)} ${t.id.padEnd(20)} r${r} ${(rec.wallMs / 1000).toFixed(0)}s $${(rec.costUsd ?? 0).toFixed(4)} report ${rec.reportTokens}t ${rec.checkDetail}${rec.harnessError ? ` ERROR ${rec.harnessError}` : ""}`);
  }
};
await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
if (skipped) console.log(`Budget of $${budget} reached: skipped ${skipped} runs.`);
console.log(`Spent about $${spent.toFixed(3)} (peak prices).\n`);
printComparison([outFile]);
