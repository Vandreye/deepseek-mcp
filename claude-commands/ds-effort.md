---
description: Show or set DeepSeek's thinking effort per task type (off, low, medium, high, max, auto)
argument-hint: "[show | <level> | <type> <level> ...] [--project]"
---
Use the `deepseek_routing` MCP tool with its `effort` field. Scope is "project" if "--project" is present, else "user".

Levels: off (no thinking, cheapest), low, medium (DeepSeek treats it as high), high, max (most tokens), auto (built-in default: off for code/tests/docs/question/general, low for the rest).
Valid types: plan, code, review, bugfix, debug, research, tests, docs, question, general, default.

**With "<type> <level>" pairs** (e.g. "review high plan medium"): set those in one call.

**With a single level** (e.g. "high"): set it for every type: `{"default": <level>}` plus each type listed above, in one call.

**With "show"**: call `deepseek_routing` with no changes and show only the effort line.

**With no arguments: open a menu.**
1. Call `deepseek_routing` with no changes to read the current efforts.
2. AskUserQuestion, one question (header "Effort"): "How hard should DeepSeek think?" Options:
   - "Auto (Recommended)": off for simple work, low for plan/review/debug/research
   - "Low everywhere": thinking on at low effort for every type
   - "High everywhere": deepest thinking; costs the most output tokens
   - "Customize": pick a level per task type
3. If "Customize": ask in three AskUserQuestion calls (max 4 questions each):
   - plan, code, review, bugfix
   - debug, research, tests, docs
   - question, general
   Each question: "Thinking effort for <type> tasks?", header = the type, options "Auto", "Off", "Low", "High" (medium or max can be typed via Other). Put the current choice first and add " (current)" to its label.
4. Call `deepseek_routing` once with all choices in `effort` (skip if nothing changed). For "Auto", "Low everywhere" or "High everywhere", set `default` and every type to that level (auto/low/high).

Reply with the resulting effort line only.

Arguments: $ARGUMENTS
