// Loaded into the MCP server with `node --import`. Records every request the server makes to
// DeepSeek (timing, status, token usage) without changing the server, so it works on any version.
import fs from "node:fs";

const out = process.env.BENCH_PROBE_FILE;
const realFetch = globalThis.fetch;

if (out && realFetch) {
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    let req = {};
    try {
      req = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      /* not JSON */
    }
    const start = Date.now();
    const rec = {
      t: start, path, model: req.model, tools: Array.isArray(req.tools) ? req.tools.length : 0,
      toolChoice: req.tool_choice, maxTokens: req.max_tokens, thinking: req.thinking?.type, effort: req.reasoning_effort,
      msgs: Array.isArray(req.messages) ? req.messages.length : undefined,
    };
    try {
      const res = await realFetch(input, init);
      rec.status = res.status;
      rec.ms = Date.now() - start;
      try {
        const body = JSON.parse(await res.clone().text());
        rec.usage = body.usage;
        rec.finish = body.choices?.[0]?.finish_reason;
        rec.toolCalls = body.choices?.[0]?.message?.tool_calls?.length ?? 0;
        if (Array.isArray(body.results)) rec.results = body.results.length;
        if (typeof body.content === "string") rec.contentChars = body.content.length;
      } catch {
        /* non-JSON body */
      }
      write(rec);
      return res;
    } catch (e) {
      rec.ms = Date.now() - start;
      rec.error = String(e?.name ?? e);
      write(rec);
      throw e;
    }
  };
}

function write(rec) {
  try {
    fs.appendFileSync(out, JSON.stringify(rec) + "\n");
  } catch {
    /* never break the server */
  }
}
