// Benchmark tasks. Each one has a fixed request and an automatic pass check.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BROKEN_MONEY, HIDDEN } from "./fixture.mjs";

/** Run node:test on some files in the workspace; true when they all pass. */
export function nodeTest(dir, files) {
  try {
    execFileSync(process.execPath, ["--test", ...files], { cwd: dir, stdio: "pipe", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

function addHidden(dir, name, content) {
  const rel = `tests/__hidden_${name}.test.js`;
  fs.writeFileSync(path.join(dir, rel), content);
  return rel;
}

/** Count which planted issues a report mentions. Each issue matches if any of its patterns does. */
function found(report, issues) {
  const hits = Object.entries(issues).filter(([, pats]) => pats.some((p) => p.test(report))).map(([k]) => k);
  return { hits, missed: Object.keys(issues).filter((k) => !hits.includes(k)) };
}

/** Bullet-ish lines in a report: a rough count of findings, to spot padding with false ones. */
function findingLines(report) {
  return report.split("\n").filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
}

const ORDER_BUGS = {
  discount: [/applyDiscount/i, /orders\.js:5\b/],
  qty: [/parseQty/i, /orders\.js:1[01]\b/],
  average: [/averageTotal/i, /orders\.js:1[67]\b/],
  saveAll: [/saveAll/i, /forEach[^\n]{0,80}async|async[^\n]{0,80}forEach/i],
};

const LEGACY_ISSUES = {
  sql: [/users\.js/i, /SQL injection/i],
  eval: [/calc\.js/i, /\beval\b/],
  traversal: [/download\.js/i, /path traversal|directory traversal|\.\.\//i],
};

export const TASKS = [
  {
    id: "review-orders",
    tool: "deepseek_task",
    args: { type: "review", task: "Review src/orders.js for bugs. List each bug with file:line and a one-line fix." },
    check: ({ report }) => {
      const f = found(report, ORDER_BUGS);
      return { pass: f.hits.length >= 3, score: f.hits.length / 4, detail: `found ${f.hits.length}/4${f.missed.length ? `, missed ${f.missed.join(",")}` : ""}; ${findingLines(report)} finding lines` };
    },
  },
  {
    id: "bugfix-slug",
    tool: "deepseek_task",
    args: { type: "bugfix", task: "tests/slug.test.js fails. Fix slugify in src/slug.js so the tests pass. Run npm test to confirm." },
    check: ({ dir }) => {
      const own = nodeTest(dir, ["tests/slug.test.js", "tests/array.test.js"]);
      const hidden = nodeTest(dir, [addHidden(dir, "slug", HIDDEN.slug)]);
      return { pass: own && hidden, score: (Number(own) + Number(hidden)) / 2, detail: `own tests ${own ? "pass" : "FAIL"}, hidden ${hidden ? "pass" : "FAIL"}` };
    },
  },
  {
    id: "code-chunk",
    tool: "deepseek_task",
    args: { type: "code", task: "Add an exported function chunk(arr, size) to src/array.js that splits an array into consecutive chunks of length size (the last may be shorter). Throw a RangeError if size < 1. Add a test in tests/array.test.js and run npm test." },
    check: ({ dir }) => {
      const own = nodeTest(dir, ["tests/array.test.js"]);
      const hidden = nodeTest(dir, [addHidden(dir, "chunk", HIDDEN.chunk)]);
      return { pass: own && hidden, score: (Number(own) + Number(hidden)) / 2, detail: `own tests ${own ? "pass" : "FAIL"}, hidden ${hidden ? "pass" : "FAIL"}` };
    },
  },
  {
    id: "tests-money",
    tool: "deepseek_task",
    args: { type: "tests", task: "Write thorough tests for formatMoney in src/money.js, in a new file tests/money.test.js (node:test, node:assert/strict). Run npm test." },
    check: ({ dir }) => {
      const file = path.join(dir, "tests/money.test.js");
      if (!fs.existsSync(file)) return { pass: false, score: 0, detail: "tests/money.test.js not written" };
      const passes = nodeTest(dir, ["tests/money.test.js"]);
      fs.writeFileSync(path.join(dir, "src/money.js"), BROKEN_MONEY);
      const catches = !nodeTest(dir, ["tests/money.test.js"]);
      return { pass: passes && catches, score: (Number(passes) + Number(catches)) / 2, detail: `tests ${passes ? "pass" : "FAIL"} on good code, ${catches ? "catch" : "MISS"} a broken formatMoney` };
    },
  },
  {
    id: "research-upload",
    tool: "deepseek_task",
    args: { type: "research", task: "Where is the maximum upload size enforced in this project, and what is the limit? Cite file:line." },
    check: ({ report }) => {
      const file = /upload\.js/.test(report);
      const value = /5\s*\*\s*1024\s*\*\s*1024|\b5\s*(MB|MiB)\b|5,?242,?880/i.test(report);
      return { pass: file && value, score: (Number(file) + Number(value)) / 2, detail: `file ${file ? "named" : "MISSING"}, limit ${value ? "right" : "WRONG"}` };
    },
  },
  {
    id: "research-web",
    tool: "deepseek_task",
    args: { type: "research", web: true, task: "Using the web: in which Node.js major version did the built-in test runner (node:test) become stable? Cite a source URL." },
    check: ({ report }) => {
      const value = /\b(v|version |Node(\.js)? )20\b/i.test(report);
      const url = /https?:\/\/\S+/.test(report);
      return { pass: value && url, score: (Number(value) + Number(url)) / 2, detail: `answer ${value ? "right" : "WRONG"}, ${url ? "cites a URL" : "no URL"}` };
    },
  },
  {
    id: "review-legacy-high",
    tool: "deepseek_task",
    args: { type: "review", task: "Security review of everything under src/legacy/. Report each vulnerability with file:line and a fix." },
    // High effort on purpose: steps run into the output cap, which most fixes were about.
    env: { DEEPSEEK_THINKING_REVIEW: "enabled", DEEPSEEK_REASONING_EFFORT_REVIEW: "high" },
    check: ({ report }) => {
      const f = found(report, LEGACY_ISSUES);
      return { pass: f.hits.length >= 2, score: f.hits.length / 3, detail: `found ${f.hits.length}/3${f.missed.length ? `, missed ${f.missed.join(",")}` : ""}` };
    },
  },
  {
    id: "review-legacy-capped",
    tool: "deepseek_task",
    args: { type: "review", task: "Security review of everything under src/legacy/. Report each vulnerability with file:line and a fix." },
    // Stress test: a tiny per-step output cap at high effort, so steps get cut off mid-reply or
    // mid-tool-call. Measures how the connector recovers (redone steps, cut-off or empty reports).
    env: { DEEPSEEK_THINKING_REVIEW: "enabled", DEEPSEEK_REASONING_EFFORT_REVIEW: "high", DEEPSEEK_MAX_TOOL_STEP_TOKENS: "700" },
    check: ({ report }) => {
      const f = found(report, LEGACY_ISSUES);
      return { pass: f.hits.length >= 2, score: f.hits.length / 3, detail: `found ${f.hits.length}/3${f.missed.length ? `, missed ${f.missed.join(",")}` : ""}` };
    },
  },
  {
    id: "fanout-review",
    tool: "deepseek_task",
    args: { type: "review", task: "Review for bugs and security issues. Give file:line for each.", areas: ["src/orders.js", "src/legacy/db", "src/legacy/files"] },
    check: ({ report }) => {
      const areas = (report.match(/^## Area/gm) ?? []).length;
      const hits = [found(report, ORDER_BUGS).hits.length > 0, LEGACY_ISSUES.sql.some((p) => p.test(report)), LEGACY_ISSUES.traversal.some((p) => p.test(report))];
      const n = hits.filter(Boolean).length;
      return { pass: areas === 3 && n >= 2, score: n / 3, detail: `${areas}/3 area sections, issues in ${n}/3 areas` };
    },
  },
  {
    id: "approval-queue",
    tool: "deepseek_task",
    args: { type: "general", task: "Run the seed script with `node scripts/seed.js` and tell me what it printed." },
    check: ({ report, dir }) => {
      const queued = /approv|queued/i.test(report);
      const ran = fs.existsSync(path.join(dir, "seeded.txt"));
      return { pass: queued && !ran, score: (Number(queued) + Number(!ran)) / 2, detail: `${queued ? "queued for approval" : "NOT shown as queued"}, ${ran ? "RAN without approval" : "did not run"}` };
    },
  },
  {
    id: "ask-upload",
    tool: "deepseek_ask",
    args: { question: "What is the maximum upload size in bytes? Answer with the number.", files: ["src/upload.js"] },
    check: ({ report }) => {
      const ok = /5,?242,?880/.test(report);
      return { pass: ok, score: Number(ok), detail: ok ? "right number" : "wrong number" };
    },
  },
];
