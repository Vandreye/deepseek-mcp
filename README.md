# DeepSeek MCP Connector

Use **DeepSeek as a cheap subagent for Claude Code**, in the terminal or in VS Code. Claude stays the orchestrator. It hands tasks such as planning, coding, reviews, bug fixes, debugging, tests and docs to DeepSeek, and gets back a short report. That saves Claude tokens.

- **You choose who does what.** A routing table you control says which task types go to DeepSeek, which stay with Claude, and which ask you first. Slash commands override it for a single task.
- **DeepSeek works on its own.** It reads, searches, creates and edits files and runs your tests in a loop until the job is done. Claude only sees a compact report of roughly 800 tokens or less.
- **Deletes need your permission.** DeepSeek has no delete tool. It can only *request* a delete, and nothing happens until you approve. Deleted files are moved to a trash folder, not destroyed.
- **Sandboxed to the project.** DeepSeek can't reach files outside the workspace, `.git` internals, or secrets like `.env` and keys. Commands are limited to an allowlist.

## How it works

```
You ─▶ Claude Code (orchestrator) ──MCP──▶ deepseek-mcp (local) ──▶ DeepSeek API
                    ▲                             │  agent loop with file/search/test tools,
                    └──── compact report ◀────────┘  jailed to the project folder
```

## Setup

1. **Get an API key** at [platform.deepseek.com](https://platform.deepseek.com). Then do one of these:
   - Set it as a user environment variable, for example in PowerShell: `setx DEEPSEEK_API_KEY "sk-..."`. Restart VS Code afterwards.
   - Or save it in the file `%USERPROFILE%\.deepseek-mcp\api-key`.
2. **Build and install:**
   ```
   npm install
   npm run build
   npm run setup
   ```
   `npm run setup` does four things:
   - registers the MCP server user-wide (`claude mcp add deepseek --scope user ...`)
   - installs the slash commands into `~/.claude/commands`
   - creates your routing table
   - adds a permission rule so that `approve_actions` **always** asks you

   Add `-- --allow-tools` if Claude shouldn't ask you before every DeepSeek call. Approving deletes still asks either way.
3. Restart Claude Code or VS Code and run `/mcp`. `deepseek` should show as connected.

## Choosing who does what

Routing lives in `~/.deepseek-mcp/routing.json`. You can override it per project in `<project>/.deepseek-mcp/routing.json`.

```json
{ "plan": "claude", "code": "deepseek", "review": "claude", "bugfix": "deepseek",
  "debug": "deepseek", "research": "deepseek", "tests": "deepseek", "docs": "deepseek",
  "question": "deepseek", "default": "claude" }
```

Each value is `deepseek`, `claude` or `ask`. With `ask`, Claude asks you each time. The server enforces the table too: if Claude tries to send DeepSeek a task type you routed to Claude, the server refuses unless you explicitly asked for DeepSeek.

| Command | What it does |
|---|---|
| `/route` | Open a menu to pick who handles each task type |
| `/route show` | Show the routing |
| `/route code deepseek review claude` | Change it (add `--project` to change only this project) |
| `/route review pro debug pro` | Set DeepSeek's default model per task type |
| `/ds <task>` | Send this task to DeepSeek, whatever the routing says |
| `/ds-plan`, `/ds-code`, `/ds-review`, `/ds-fix`, `/ds-debug`, `/ds-tests` | Same, with a specific role |
| `/ds-approve [ids\|all\|reject ids]` | See or answer DeepSeek's pending deletes and commands |

You can also just say it: "have DeepSeek review this" or "do this one yourself".

## Tools Claude gets

| Tool | Purpose |
|---|---|
| `deepseek_task` | Delegate a task. DeepSeek works until done and returns a compact report. `task_id` continues an earlier task cheaply, because DeepSeek's prompt cache is reused. `areas: ["auth", "feeds"]` splits a big job into parallel sub-tasks with one merged report. `max_steps` / `max_tokens` raise the budget for one call. |
| `deepseek_ask` | One-shot question with optional files, no tools. A cheap second opinion. |
| `deepseek_get_report` | Fetch details only when needed: summary, files, a diff, command output, or the tool-call trace. |
| `deepseek_routing` | Show or change the routing and the default model per task type. |
| `list_pending_approvals` / `approve_actions` / `reject_actions` | Handle the delete and command queue. |

## Models and cost

The default is `deepseek-flash`. Claude can pick `pro` (`deepseek-v4-pro`) for hard tasks. To always use `pro` for a task type, set it once with `/route review pro`; it is stored in `~/.deepseek-mcp/models.json` (or `<project>/.deepseek-mcp/models.json`), for example `{ "review": "pro", "default": "flash" }`. Every report ends with DeepSeek's token use and a cost estimate at peak prices; off-peak is half.

Long runs stay cheap: cached input (the re-sent history) counts at 10% toward the token budget, and once a prompt passes about 60k tokens, old tool outputs are shortened to one-line summaries.

## Safety

See [docs/security.md](docs/security.md). In short:
- DeepSeek has no delete tool.
- Commands outside the allowlist wait for you.
- Edited files are backed up to `.deepseek-mcp/backups/` and deleted files go to `.deepseek-mcp/trash/`.
- Every action is logged to `.deepseek-mcp/logs/`.

The `.deepseek-mcp/` folder ignores itself in git.

> Code you delegate is sent to DeepSeek's API, which is hosted in China. Secret files are never sent, but don't delegate code you can't share.

## Configuration

All settings are optional environment variables; see [.env.example](.env.example). Useful ones:
- `DEEPSEEK_ALLOW_COMMANDS`: extra auto-allowed commands, for example `make test;cargo fmt --check`
- `DEEPSEEK_MAX_STEPS`: how many tool-loop steps a task may take (default 25)
- `DEEPSEEK_MAX_STEPS_REVIEW` / `_RESEARCH` / `_DEBUG` / `_PLAN`: higher limits for those types (defaults 80 / 80 / 50 / 40)
- `DEEPSEEK_THINKING=enabled`: turn thinking on for every type; it is off for code/tests/docs/question/general and on at `low` effort for plan/review/debug/bugfix/research. Per type: `DEEPSEEK_THINKING_<TYPE>`, `DEEPSEEK_REASONING_EFFORT[_<TYPE>]`
- `DEEPSEEK_ELICITATION=off`: stop the server prompting you directly

## Development

```
npm test            # unit tests (no API key needed)
npm run build
npm run inspect     # MCP Inspector, to call the tools by hand
```
