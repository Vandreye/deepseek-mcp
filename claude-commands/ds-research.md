---
description: Have DeepSeek research a question in the codebase and on the web (read-only)
argument-hint: <question>
---
The user explicitly chose DeepSeek for this. Call the `deepseek_task` MCP tool now with type "research", web: true and user_override: true. Rewrite the request below as one short, self-contained question for DeepSeek: name files by path and never paste their contents or any secrets (DeepSeek may search the web with it). Then give the user the answer in a few lines with the source URLs DeepSeek cited (if the report says web access is off, say it researched the workspace only). Show any items waiting for approval.

Request: $ARGUMENTS
