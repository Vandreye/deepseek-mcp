---
description: Show or change which agent (DeepSeek or Claude) handles each task type
argument-hint: "[type deepseek|claude|ask] [--project]"
---
Call the `deepseek_routing` MCP tool.
- No arguments: show the current routing.
- "<type> <deepseek|claude|ask>" (several pairs allowed, e.g. "code deepseek review claude"): set those. Use scope "project" if "--project" is present, else "user".
Valid types: plan, code, review, bugfix, debug, research, tests, docs, question, general, default.
Reply with the resulting routing in one line.

Arguments: $ARGUMENTS
