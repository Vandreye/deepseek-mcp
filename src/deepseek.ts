import type { Config, ModelInfo, Thinking } from "./config.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Thinking-mode reasoning. DeepSeek requires it to be sent back in tool loops. */
  reasoning_content?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: "auto" | "none";
  max_tokens?: number;
  /** Thinking mode for this call (default: off). */
  thinking?: Thinking;
  /** Sent only when thinking is on (default: "low"). */
  reasoning_effort?: string;
}

export interface ChatResponse {
  message: ChatMessage;
  usage: Usage;
  finishReason: string;
}

export type ChatFn = (req: ChatRequest, signal?: AbortSignal) => Promise<ChatResponse>;

export class DeepSeekError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Minimal client for DeepSeek's OpenAI-compatible /chat/completions endpoint. */
export function createDeepSeekChat(cfg: Config): ChatFn {
  return async (req, signal) => {
    if (!cfg.apiKey) {
      throw new DeepSeekError(
        "DEEPSEEK_API_KEY is not set. Set it as an environment variable or put the key in ~/.deepseek-mcp/api-key, then restart Claude Code.",
      );
    }
    const thinking = req.thinking ?? "disabled";
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
      thinking: { type: thinking },
    };
    // DeepSeek has low, high and max; it treats medium as high, so send that directly.
    if (thinking === "enabled") body.reasoning_effort = req.reasoning_effort === "medium" ? "high" : (req.reasoning_effort ?? "low");
    if (req.tools?.length) {
      body.tools = cfg.strictTools ? req.tools.map(strictTool) : req.tools;
      body.tool_choice = req.tool_choice ?? "auto";
    }
    if (req.max_tokens) body.max_tokens = req.max_tokens;

    let lastErr: unknown;
    let retryAfterMs = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        // Jitter spreads out parallel areas that hit a rate limit at the same moment.
        const backoff = Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
        // Honour a server-requested wait up to 5 minutes; our own backoff stays under 30s.
        await sleep(Math.min(300_000, Math.max(backoff, retryAfterMs)), signal);
        retryAfterMs = 0;
      }
      try {
        const timeout = AbortSignal.timeout(15 * 60_000);
        // Strict tool schemas are a beta feature, served only from the /beta base URL.
        const base = cfg.strictTools && req.tools?.length ? `${cfg.baseUrl}/beta` : cfg.baseUrl;
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new DeepSeekError(`DeepSeek API ${res.status}: ${text.slice(0, 500)}`, res.status);
          if (RETRYABLE.has(res.status)) {
            lastErr = err;
            retryAfterMs = retryAfter(res.headers.get("retry-after"));
            continue;
          }
          throw err;
        }
        // A 200 is already billed; retrying a body we cannot parse would pay for it again.
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          throw new DeepSeekError(`Unreadable DeepSeek response: ${text.slice(0, 300)}`);
        }
        const choice = json.choices?.[0];
        if (!choice?.message) throw new DeepSeekError(`Unexpected DeepSeek response: ${text.slice(0, 300)}`);
        const m = choice.message;
        const message: ChatMessage = { role: "assistant", content: m.content ?? "" };
        if (m.reasoning_content) message.reasoning_content = m.reasoning_content;
        if (m.tool_calls?.length) message.tool_calls = m.tool_calls;
        return { message, usage: json.usage ?? { prompt_tokens: 0, completion_tokens: 0 }, finishReason: choice.finish_reason ?? "" };
      } catch (e) {
        if (signal?.aborted) throw e;
        if (e instanceof DeepSeekError) throw e;
        // Our own 15-minute limit: retrying a call that hung would only hang again.
        if ((e as Error)?.name === "TimeoutError") throw new DeepSeekError("DeepSeek did not answer within 15 minutes.");
        lastErr = e; // network error: retry
      }
    }
    throw lastErr instanceof Error ? lastErr : new DeepSeekError(String(lastErr));
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

/** Search & Fetch API: USD per successful call ($0.75 per 1,000). */
export const WEB_CALL_PRICE = 0.00075;

/**
 * DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. Other hours cost half.
 * Chinese public holidays are also off-peak; they are not tracked, so costs stay an upper bound.
 */
export function isPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const h = at.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

export class UsageTotals {
  cacheHit = 0;
  cacheMiss = 0;
  output = 0;
  /** Output tokens spent on thinking (part of output). */
  reasoning = 0;
  calls = 0;
  webCalls = 0;
  cost = 0;

  add(u: Usage, model: ModelInfo, at = new Date()): void {
    const hit = u.prompt_cache_hit_tokens ?? 0;
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, u.prompt_tokens - hit);
    this.cacheHit += hit;
    this.cacheMiss += miss;
    this.output += u.completion_tokens;
    this.reasoning += u.completion_tokens_details?.reasoning_tokens ?? 0;
    this.calls++;
    const rate = isPeak(at) ? 1 : 0.5;
    this.cost += (rate * (hit * model.price.cacheHit + miss * model.price.cacheMiss + u.completion_tokens * model.price.output)) / 1e6;
  }

  /** One billed web_search / web_fetch call. */
  addWeb(): void {
    this.webCalls++;
    this.cost += WEB_CALL_PRICE;
  }

  /** Add another task's totals (for merged reports). */
  merge(o: UsageTotals): void {
    this.cacheHit += o.cacheHit;
    this.cacheMiss += o.cacheMiss;
    this.output += o.output;
    this.reasoning += o.reasoning;
    this.calls += o.calls;
    this.webCalls += o.webCalls;
    this.cost += o.cost;
  }

  get input(): number {
    return this.cacheHit + this.cacheMiss;
  }

  summary(): string {
    const thinking = this.reasoning ? ` (${k(this.reasoning)} thinking)` : "";
    const web = this.webCalls ? `, ${this.webCalls} web` : "";
    return `${k(this.input)} in (${k(this.cacheHit)} cached) / ${k(this.output)} out${thinking}, ${this.calls} calls${web}, ≤$${this.cost.toFixed(4)}`;
  }
}

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Retry-After in ms: either seconds or an HTTP date. */
export function retryAfter(h: string | null, now = Date.now()): number {
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

/**
 * Strict mode (beta): DeepSeek then always returns arguments that match the schema.
 * It needs every property listed as required and additionalProperties false, so optional
 * properties become "this type or null"; the tool code already treats null as "not given".
 */
export function strictTool(t: ToolDef): ToolDef {
  return { ...t, function: { ...t.function, strict: true, parameters: strictSchema(t.function.parameters) } };
}

function strictSchema(schema: Record<string, any>): Record<string, any> {
  if (schema.type === "array" && schema.items) return { ...schema, items: strictSchema(schema.items) };
  if (schema.type !== "object") return schema;
  const props: Record<string, any> = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  const out: Record<string, any> = {};
  for (const [name, p] of Object.entries(props)) {
    const inner = strictSchema(p);
    if (required.has(name)) {
      out[name] = inner;
    } else {
      const { description, ...rest } = inner;
      out[name] = { anyOf: [rest, { type: "null" }], ...(description ? { description } : {}) };
    }
  }
  return { ...schema, properties: out, required: Object.keys(props), additionalProperties: false };
}
