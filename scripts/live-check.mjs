#!/usr/bin/env node
// Live checks against DeepSeek's API (costs a fraction of a cent). Run after `npm run build`:
//   node scripts/live-check.mjs [strict] [web]
// strict: strict tool schemas on the /beta API, with and without thinking.
// web:    one web_search and one web_fetch.
import { loadConfig } from "../dist/config.js";
import { createDeepSeekChat } from "../dist/deepseek.js";
import { toolDefs } from "../dist/tools/registry.js";
import { webFetch, webSearch } from "../dist/tools/web.js";

const which = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["strict", "web"]);
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("No DeepSeek API key (DEEPSEEK_API_KEY or ~/.deepseek-mcp/api-key).");
  process.exit(1);
}
let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed++;
};

if (which.has("strict")) {
  const chat = createDeepSeekChat({ ...cfg, strictTools: true });
  const messages = [
    { role: "system", content: "You are a coding agent. Use the tools." },
    { role: "user", content: "Read lines 1-5 of package.json, then search for 'zod' in src. Call the tools now." },
  ];
  for (const [model, thinking] of [["flash", "disabled"], ["flash", "enabled"], ["pro", "enabled"]]) {
    const label = `strict tools, ${model}, thinking ${thinking}`;
    try {
      const r = await chat({ model: cfg.models[model].id, messages, tools: toolDefs(true), thinking, reasoning_effort: "low", max_tokens: 2000 });
      const calls = r.message.tool_calls ?? [];
      const parsed = calls.map((c) => { try { return JSON.parse(c.function.arguments); } catch { return null; } });
      check(calls.length > 0 && parsed.every(Boolean), label,
        calls.map((c, i) => `${c.function.name}(${JSON.stringify(parsed[i])})`).join(", ") || `no tool call (${r.finishReason})`);
    } catch (e) {
      check(false, label, e.message.slice(0, 300));
    }
  }
}

if (which.has("web")) {
  try {
    const s = await webSearch(cfg, "DeepSeek API reasoning_effort site:api-docs.deepseek.com", 3);
    check(s.billed && /https?:\/\//.test(s.text), "web_search", s.text.split("\n").slice(0, 3).join(" | ").slice(0, 200));
  } catch (e) {
    check(false, "web_search", e.message);
  }
  try {
    const f = await webFetch(cfg, "https://api-docs.deepseek.com/quick_start/pricing");
    check(f.billed && f.text.length > 200, "web_fetch", `${f.text.length} chars: ${f.text.slice(0, 80).replace(/\n/g, " ")}`);
  } catch (e) {
    check(false, "web_fetch", e.message);
  }
}

process.exit(failed ? 1 : 0);
