#!/usr/bin/env node
// Turns benchmark results into a comparison table.
//   node bench/compare.mjs results/a.jsonl [results/b.jsonl ...]
// Versions are compared in the order they first appear. With two versions, each change is marked
// better / worse, or "~" when the ranges of the repeats overlap (the difference may be noise).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const total = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const range = (xs) => [Math.min(...xs), Math.max(...xs)];

function load(files) {
  const lines = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  return { meta: lines.filter((l) => l.kind === "version"), runs: lines.filter((l) => !l.kind) };
}

/** Per-metric direction: -1 = lower is better, +1 = higher is better. */
const METRICS = [
  ["pass rate", (rs) => mean(rs.map((r) => Number(r.pass))), +1, (v) => `${Math.round(v * 100)}%`, null],
  ["score", (rs) => mean(rs.map((r) => r.score)), +1, (v) => v.toFixed(2), (r) => r.score],
  ["Claude reads (tokens)", (rs) => median(rs.map((r) => r.reportTokens)), -1, (v) => Math.round(v), (r) => r.reportTokens],
  ["DeepSeek cost $", (rs) => median(rs.map((r) => r.costUsd)), -1, (v) => v.toFixed(4), (r) => r.costUsd],
  ["time (s)", (rs) => median(rs.map((r) => r.wallMs / 1000)), -1, (v) => v.toFixed(0), (r) => r.wallMs / 1000],
  ["API calls", (rs) => median(rs.map((r) => r.apiCalls)), -1, (v) => v.toFixed(0), (r) => r.apiCalls],
  ["input tokens", (rs) => median(rs.map((r) => r.cacheHit + r.cacheMiss)), -1, (v) => `${(v / 1000).toFixed(0)}k`, (r) => r.cacheHit + r.cacheMiss],
  ["cache hit", (rs) => median(rs.map((r) => r.cacheRatio)), +1, (v) => `${Math.round(v * 100)}%`, (r) => r.cacheRatio],
  ["output tokens", (rs) => median(rs.map((r) => r.outTokens)), -1, (v) => `${(v / 1000).toFixed(1)}k`, (r) => r.outTokens],
  ["thinking tokens", (rs) => median(rs.map((r) => r.thinkingTokens)), -1, (v) => `${(v / 1000).toFixed(1)}k`, (r) => r.thinkingTokens],
  ["tool errors", (rs) => total(rs.map((r) => r.toolErrors)), -1, (v) => String(v), null],
  ["redone steps", (rs) => total(rs.map((r) => r.redoneSteps)), -1, (v) => String(v), null],
  ["cut-off/empty reports", (rs) => total(rs.map((r) => Number(!!(r.cutOff || r.finalCut)) + Number(!!r.noReport) + Number(!!r.markupLeak))), -1, (v) => String(v), null],
  ["API retries", (rs) => total(rs.map((r) => r.apiRetries)), -1, (v) => String(v), null],
  ["repeat file reads", (rs) => total(rs.map((r) => r.repeatReads)), -1, (v) => String(v), null],
  ["harness errors", (rs) => rs.filter((r) => r.harnessError || r.isError).length, -1, (v) => String(v), null],
];

function mark(a, b, dir, rawA, rawB) {
  if (a === null || b === null) return "";
  if (a === b) return "=";
  // Overlapping ranges across repeats: can't tell it apart from noise.
  if (rawA && rawB && rawA.length > 1 && rawB.length > 1) {
    const [a0, a1] = range(rawA);
    const [b0, b1] = range(rawB);
    if (a0 <= b1 && b0 <= a1) return "~";
  }
  return (b - a) * dir > 0 ? "better" : "worse";
}

const pct = (a, b) => (a ? ` (${b > a ? "+" : ""}${Math.round(((b - a) / Math.abs(a)) * 100)}%)` : "");

export function comparisonText(files) {
  const { meta, runs } = load(files);
  const versions = [...new Set([...meta.map((m) => m.version), ...runs.map((r) => r.version)])];
  const tasks = [...new Set(runs.map((r) => r.task))];
  const out = [];
  const head = (cols) => `| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|`;

  out.push("## Versions\n");
  out.push(head(["version", "commit", "runs", "fixed overhead per Claude session"]));
  for (const v of versions) {
    const m = meta.find((x) => x.version === v);
    out.push(`| ${v} | ${m?.sha ?? "?"} | ${runs.filter((r) => r.version === v).length} | ~${m?.overhead?.tokens ?? "?"} tokens (${m?.overhead?.tools ?? "?"} tools) |`);
  }

  const two = versions.length === 2;
  out.push(`\n## Overall (all tasks${two ? `; change from ${versions[0]} to ${versions[1]}` : ""})\n`);
  out.push(head(["metric", ...versions, ...(two ? ["change"] : [])]));
  for (const [name, fn, dir, fmt, raw] of METRICS) {
    // Overall: medians/totals across tasks are sums of per-task values, so tasks weigh equally.
    const per = versions.map((v) => {
      const vals = tasks.map((t) => fn(runs.filter((r) => r.version === v && r.task === t))).filter((x) => x !== null);
      if (!vals.length) return null;
      return ["pass rate", "score", "cache hit"].includes(name) ? mean(vals) : total(vals);
    });
    const cells = per.map((v) => (v === null ? "-" : fmt(v)));
    // Noise check: the same total, computed separately for each repeat.
    const avg = ["pass rate", "score", "cache hit"].includes(name);
    const perRep = (v) => [...new Set(runs.filter((r) => r.version === v).map((r) => r.rep))].map((rep) => {
      const vals = tasks.map((t) => fn(runs.filter((r) => r.version === v && r.task === t && r.rep === rep))).filter((x) => x !== null);
      return avg ? mean(vals) : total(vals);
    });
    const change = two && per[0] !== null && per[1] !== null
      ? `${mark(per[0], per[1], dir, perRep(versions[0]), perRep(versions[1]))}${avg ? "" : pct(per[0], per[1])}`
      : "";
    out.push(`| ${name} | ${cells.join(" | ")}${two ? ` | ${change}` : ""} |`);
    void raw;
  }

  out.push(`\n## Per task\n`);
  const keyMetrics = METRICS.filter(([n]) => ["pass rate", "score", "Claude reads (tokens)", "DeepSeek cost $", "time (s)", "tool errors", "redone steps", "cut-off/empty reports"].includes(n));
  // One row per task; with several versions each cell reads "a → b" plus the change mark.
  out.push(`Cells: ${versions.join(" → ")}${two ? "; marks: better / worse / ~ (within noise) / =" : ""}\n`);
  out.push(head(["task", ...keyMetrics.map(([n]) => n)]));
  for (const t of tasks) {
    const sets = versions.map((v) => runs.filter((r) => r.version === v && r.task === t));
    const cells = keyMetrics.map(([, fn, dir, fmt, raw]) => {
      const vals = sets.map((rs) => (rs.length ? fn(rs) : null));
      const shown = vals.map((v) => (v === null ? "-" : fmt(v))).join(" → ");
      const m = two ? mark(vals[0], vals[1], dir, raw && sets[0].map(raw), raw && sets[1].map(raw)) : "";
      return m && m !== "=" ? `${shown} ${m}` : shown;
    });
    out.push(`| ${t} | ${cells.join(" | ")} |`);
  }

  const failures = runs.filter((r) => !r.pass);
  if (failures.length) {
    out.push(`\n## Failed runs\n`);
    for (const r of failures) out.push(`- ${r.version} ${r.task} r${r.rep}: ${r.checkDetail}${r.harnessError ? `; error: ${r.harnessError}` : ""}${r.toolErrorSamples?.length ? `; tool errors: ${r.toolErrorSamples.join(" / ")}` : ""}`);
  }
  return out.join("\n");
}

export function printComparison(files) {
  const text = comparisonText(files);
  console.log(text);
  const md = files[0].replace(/\.jsonl$/, ".md");
  fs.writeFileSync(md, `# DeepSeek MCP benchmark\n\nFrom: ${files.map((f) => path.basename(f)).join(", ")}\n\n${text}\n`);
  console.log(`\nSaved ${md}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("Usage: node bench/compare.mjs results/run.jsonl [more.jsonl ...]");
    process.exit(1);
  }
  printComparison(files);
}
