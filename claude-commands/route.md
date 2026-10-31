---
description: Show or change which agent (DeepSeek or Claude) handles each task type
argument-hint: "[show | type deepseek|claude|ask ...] [--project]"
---
Use the `deepseek_routing` MCP tool. Scope is "project" if "--project" is present, else "user".

**With "<type> <deepseek|claude|ask>" pairs** (e.g. "code deepseek review claude"): set those directly.
Valid types: plan, code, review, bugfix, debug, research, tests, docs, question, general, default.

**With "show"**: show the current routing only.

**With no arguments: open a menu.**
1. Call `deepseek_routing` with no `set` to read the current routing.
2. AskUserQuestion, one question (header "Routing"): "How should tasks be split between Claude and DeepSeek?" Options:
   - "Customize" — pick an agent per task type
   - "All Claude" — every type → claude
   - "All DeepSeek" — every type → deepseek
   - "Keep current" — change nothing
3. If "Customize": ask in three AskUserQuestion calls (single-select each, max 4 questions per call):
   - plan, code, review, bugfix
   - debug, research, tests, docs
   - question, general ("other")
   Each question: "Who should handle <type> tasks?", header = the type, options "Claude", "DeepSeek", "Ask me each time". Put the current choice first and add " (current)" to its label.
4. Call `deepseek_routing` once with all choices in `set` (skip if nothing changed).

Reply with the resulting routing in one line.

Arguments: $ARGUMENTS
