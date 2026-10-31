import type { Config } from "../config.js";

/**
 * DeepSeek's Search & Fetch API (https://api-docs.deepseek.com/guides/search).
 * $0.75 per 1,000 successful calls each; only 200s with results are billed.
 */

const RESULT_CHARS = 400;
const FETCH_CHARS = 7_000;

async function post(cfg: Config, path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  if (!cfg.apiKey) throw new Error("DEEPSEEK_API_KEY is not set.");
  const timeout = AbortSignal.timeout(60_000);
  const res = await fetch(`${cfg.baseUrl}/v1/tools/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`web ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`web ${path}: unreadable response`);
  }
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

export interface WebResult {
  text: string;
  /** The call was billed (it returned results). */
  billed: boolean;
}

export async function webSearch(cfg: Config, query: string, count = 5, signal?: AbortSignal): Promise<WebResult> {
  const q = query.trim().slice(0, 128); // the API takes 1-128 characters
  if (!q) throw new Error("query is empty.");
  const n = Math.min(Math.max(1, Math.floor(count) || 5), 10);
  const json = await post(cfg, "search", { query: q, count: n, need_content: false }, signal);
  const results: any[] = Array.isArray(json?.results) ? json.results : [];
  if (!results.length) return { text: "No results.", billed: false };
  const lines = results.map((r, i) => {
    const date = r.date ? ` (${String(r.date).slice(0, 10)})` : "";
    return `${i + 1}. ${clip(r.title, 120)}${date}\n   ${r.url}\n   ${clip(r.summary || r.snippet, RESULT_CHARS)}`;
  });
  return { text: lines.join("\n"), billed: true };
}

export async function webFetch(cfg: Config, url: string, signal?: AbortSignal): Promise<WebResult> {
  if (!/^https?:\/\//i.test(url.trim())) throw new Error("url must start with http:// or https://");
  const json = await post(cfg, "fetch", { url: url.trim() }, signal);
  const content = String(json?.content ?? "");
  if (!content) return { text: "The page had no readable content.", billed: false };
  const body = content.length > FETCH_CHARS
    ? `${content.slice(0, FETCH_CHARS)}\n…[page cut at ${FETCH_CHARS} of ${content.length} chars]`
    : content;
  return { text: `# ${clip(json.title, 200)}\n${body}`, billed: true };
}
