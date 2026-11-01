import type { ChatMessage, ToolCall } from "./deepseek.js";

const MARK = "[shortened]";

/** Original reasoning of shortened messages, so it can be put back if the API refuses the short form. */
const fullReasoning = new WeakMap<ChatMessage, string>();

/**
 * Shorten old tool outputs in place so later steps re-send less. The newest `keepRecent`
 * tool outputs and all of DeepSeek's own message text (where it keeps its file:line notes)
 * stay whole. With `reasoning`, the thinking of assistant messages older than those tool
 * outputs is shortened too. DeepSeek's docs say all reasoning must be sent back when tools
 * are used, but the API accepts a shortened one (live check, 2026-11-01), and old thinking
 * is most of a long high-effort history. restoreReasoning() undoes it if the API refuses.
 * Returns how many characters were removed.
 */
export function compactHistory(messages: ChatMessage[], keepRecent = 8, minChars = 400, reasoning = false): number {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) for (const c of m.tool_calls ?? []) calls.set(c.id, c);

  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  let removed = 0;
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent))) {
    const m = messages[i];
    const text = m.content ?? "";
    if (text.length < minChars || text.startsWith(MARK)) continue;
    const call = m.tool_call_id ? calls.get(m.tool_call_id) : undefined;
    const what = call ? `${call.function.name} ${call.function.arguments.slice(0, 160)}` : "tool output";
    const head = text.split(/\r?\n/).slice(0, 3).join("\n").slice(0, 300);
    m.content = `${MARK} ${what} → ${text.length} chars. First lines:\n${head}\n(Old output removed to save tokens. Run the tool again if you need it.)`;
    removed += text.length - m.content.length;
  }
  if (reasoning) {
    // Keep the thinking behind the kept tool outputs: stop before the call that asked for the first of them.
    let keepFrom = toolIdx.length > keepRecent ? toolIdx[toolIdx.length - keepRecent] : 0;
    while (keepFrom > 0 && messages[keepFrom].role !== "assistant") keepFrom--;
    for (const m of messages.slice(0, keepFrom)) {
      const r = m.reasoning_content;
      if (m.role !== "assistant" || !r || r.length < minChars || r.startsWith(MARK)) continue;
      fullReasoning.set(m, r);
      m.reasoning_content = `${MARK} ${r.slice(0, 200)}…`;
      removed += r.length - m.reasoning_content.length;
    }
  }
  return removed;
}

/** Put back every shortened reasoning. Returns how many were restored. */
export function restoreReasoning(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const full = fullReasoning.get(m);
    if (full !== undefined) {
      m.reasoning_content = full;
      fullReasoning.delete(m);
      n++;
    }
  }
  return n;
}
