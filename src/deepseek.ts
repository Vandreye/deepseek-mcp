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
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
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
    if (thinking === "enabled") body.reasoning_effort = req.reasoning_effort ?? "low";
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = req.tool_choice ?? "auto";
    }
    if (req.max_tokens) body.max_tokens = req.max_tokens;

    let lastErr: unknown;
    let retryAfterMs = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        // Jitter spreads out parallel areas that hit a rate limit at the same moment.
        const backoff = Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
        await sleep(Math.min(60_000, Math.max(backoff, retryAfterMs)), signal);
        retryAfterMs = 0;
      }
      try {
        const timeout = AbortSignal.timeout(15 * 60_000);
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
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

export class UsageTotals {
  cacheHit = 0;
  cacheMiss = 0;
  output = 0;
  calls = 0;
  cost = 0;

  add(u: Usage, model: ModelInfo): void {
    const hit = u.prompt_cache_hit_tokens ?? 0;
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, u.prompt_tokens - hit);
    this.cacheHit += hit;
    this.cacheMiss += miss;
    this.output += u.completion_tokens;
    this.calls++;
    this.cost += (hit * model.price.cacheHit + miss * model.price.cacheMiss + u.completion_tokens * model.price.output) / 1e6;
  }

  /** Add another task's totals (for merged reports). */
  merge(o: UsageTotals): void {
    this.cacheHit += o.cacheHit;
    this.cacheMiss += o.cacheMiss;
    this.output += o.output;
    this.calls += o.calls;
    this.cost += o.cost;
  }

  get input(): number {
    return this.cacheHit + this.cacheMiss;
  }

  summary(): string {
    return `${k(this.input)} in (${k(this.cacheHit)} cached) / ${k(this.output)} out, ${this.calls} calls, ≤$${this.cost.toFixed(4)}`;
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
