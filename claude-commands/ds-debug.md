---
description: Have DeepSeek troubleshoot a problem
argument-hint: <task>
---
The user explicitly chose DeepSeek for this. Call the `deepseek_task` MCP tool now with type "debug" and user_override: true. Rewrite the request below as one short, self-contained instruction for DeepSeek: name files by path and never paste their contents. Then tell the user the outcome in 2–4 lines. Show any items waiting for approval. Don't re-read changed files unless the report shows failures.

Request: $ARGUMENTS
