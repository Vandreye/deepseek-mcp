---
description: Show or change who handles each task type, DeepSeek's model and thinking effort
argument-hint: "[show | <type> deepseek|claude|ask|flash|pro|off|low|high|max|auto ...] [--project]"
---
Use the `deepseek_routing` MCP tool. Scope is "project" if "--project" is present, else "user".

**With "<type> <value>" pairs** (e.g. "code deepseek review pro review high"): set them all in one call.
- deepseek / claude / ask → `set` (who handles the type).
- flash / pro → `models` (DeepSeek's default model for the type).
- off / low / medium / high / max / auto → `effort` (thinking; auto = off for code/tests/docs/question/general, low for the rest; medium is treated as high).
- Type "all" means `default` plus every type.
Valid types: plan, code, review, bugfix, debug, research, tests, docs, question, general, default.

**With "show"**: call it with no changes and show the result.

**With no arguments: open a menu.**
1. Call `deepseek_routing` with no changes to read the current settings.
2. AskUserQuestion, one question (header "Routing"): "How should tasks be split between Claude and DeepSeek?" Options: "Customize" (pick per task type), "All Claude", "All DeepSeek", "Keep current".
3. If "Customize": ask in three AskUserQuestion calls (max 4 questions each): plan, code, review, bugfix / debug, research, tests, docs / question, general. Each: "Who should handle <type> tasks?", header = the type, options "Claude", "DeepSeek", "Ask me each time". Put the current choice first with " (current)".
4. Call `deepseek_routing` once with all choices in `set` (skip if nothing changed).

Reply with the resulting settings in one or two lines.

Arguments: $ARGUMENTS
