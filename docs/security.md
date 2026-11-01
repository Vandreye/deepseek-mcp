# Security model

## What DeepSeek can do without asking
- Read, list and search files inside the workspace.
- Create and edit files inside the workspace. Before a file is first changed in a task, the original is copied to `.deepseek-mcp/backups/<task>/`.
- Run allowlisted commands:
  - tests, builds, type checks and linters: `npm test`, `npm run build|lint|typecheck|check|compile|test:*`, `npx tsc|vitest|jest|eslint`, `npx prettier --check`, `pytest`, `python -m pytest|unittest|mypy`, `ruff check`, `cargo|go|dotnet build/test`
  - read-only git: `status`, `diff`, `log`, `show`, `blame`, `ls-files`, `rev-parse`, and `branch` with listing flags only
  - anything you add with `DEEPSEEK_ALLOW_COMMANDS`

  Commands containing shell operators (`& | ; < > $ % ^ ! ( ) { }` and backticks) never run automatically. Neither does git with `--output`. The DeepSeek, Anthropic and OpenAI API keys are removed from the environment commands run in.

## Web access
- `web_search` and `web_fetch` (DeepSeek's Search & Fetch API) are offered only when Claude passes `web: true` (as `/ds research` does), and only to **read-only** tasks, so text from a web page can never steer file edits or commands.
- DeepSeek is told to treat page text as untrusted data and never to put code, paths or secrets into queries or URLs. Secret files are hidden from it anyway, so it cannot read them to leak them.
- Web access is off by default. `DEEPSEEK_WEB=on` turns it on.

## What always needs your approval
- **Deleting files.** DeepSeek has no delete tool, only `request_delete`.
- **Any other command,** through `request_command`. Commands that look like deletes are always marked and never auto-allowed, even if you allowlisted them by mistake: `rm`, `del`, `rmdir`, `Remove-Item`, `git clean`, `git rm`, `rimraf`, `find -delete`, and similar.

Approval works in two layers:
1. **Direct prompt (elicitation).** If your Claude Code client supports it (the CLI does), the server asks you itself. Claude can't answer for you.
2. **Queue.** Otherwise the request waits in a queue, and Claude shows it to you. Carrying it out takes the `approve_actions` tool. `npm run setup` puts that tool in your `permissions.ask` list, so Claude Code asks you every time, even in auto-accept modes. Don't add it to an allow list.

Approved deletes move files to `.deepseek-mcp/trash/<id>/` rather than destroying them.

## What DeepSeek can never touch
- Anything outside the workspace. Paths are resolved with symlinks and junctions followed, so `..`, absolute paths and links pointing outside are refused.
- `.git/` internals and the `.deepseek-mcp/` folder.
- Secrets files: `.env*` (except `.env.example`, `.env.sample` and `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `.npmrc`, `.netrc`, `credentials.json`. They are hidden from reads, searches and writes, so they are never sent to DeepSeek.
- A drive root or your home folder as the workspace.

## Limits
- Commands time out after 300s (`DEEPSEEK_COMMAND_TIMEOUT_SEC`), and the whole process tree is killed.
- A task may take at most `DEEPSEEK_MAX_STEPS` steps (default 25) and `DEEPSEEK_MAX_TASK_TOKENS` input tokens. After that, DeepSeek must write its report.

## Not covered
- Allowlisted commands like `npm test` or `npm run build` run your project's own scripts. If those scripts do something dangerous, it runs. That is the same trust you give those scripts yourself.
- Pending approvals are kept in memory. They disappear if the server restarts, so nothing that was queued runs.
