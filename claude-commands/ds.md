---
description: Hand a task to DeepSeek
argument-hint: "[plan|code|review|bugfix|debug|research|tests|docs] <task>"
---
The user explicitly chose DeepSeek for this. Call the `deepseek_task` MCP tool now with user_override: true. If the request starts with one of the types in the hint, use it as `type` and drop it from the text; otherwise use "general". For "research" also pass web: true.

Rewrite the request as one short, self-contained instruction: name files by path, never paste their contents or secrets. Then tell the user the outcome in 2–4 lines (for research: the answer plus any cited URLs, or say it used the workspace only if web access is off). Show any items waiting for approval. Don't re-read changed files unless the report shows failures.

Request: $ARGUMENTS
