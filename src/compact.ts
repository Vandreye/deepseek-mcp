import type { ChatMessage, ToolCall } from "./deepseek.js";

const MARK = "[shortened]";

/**
 * Shorten old tool outputs in place so later steps re-send less. The newest `keepRecent`
 * tool outputs and all of DeepSeek's own messages (where it keeps its file:line notes) stay
 * whole, and so does reasoning_content: DeepSeek requires all of it to be sent back when
 * tools are in use (omitting it is a 400 error).
 * Returns how many characters were removed.
 */
export function compactHistory(messages: ChatMessage[], keepRecent = 8, minChars = 400): number {
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
  return removed;
}
