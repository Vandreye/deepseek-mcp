# Improvement notes (from Claude, observed in use)

Suggestions gathered while Claude used this MCP on other projects. Newest at the bottom.

Each note is tagged:
- **[server]**: needs a change to this MCP's code, prompt or defaults.
- **[usage]**: Claude can do it today by calling the MCP differently. It could still be built in later.

## 2026-10-31: reviews on EVE Ledger (Windows, Git Bash + PowerShell)

### Run t1: review of one commit, flash, read-only
- **[server] Self-check before reporting.** Its top two findings were wrong: it said a column was missing from a SELECT that does include it, and that a time window never closes when it does. One grep each would have caught them. Add a final step to DeepSeek's system prompt for review and debug: re-open every cited `file:line`, confirm the claim, and drop anything that can't be confirmed.
- **[server] Commands fail on Windows.** `service/.venv/Scripts/python -m pytest ...` failed with "'service' is not recognized". The command runner uses `cmd.exe`, which doesn't handle forward-slash relative executables. Make relative executable paths absolute or convert them to Windows form, or run commands through Git Bash when it's available.
- **[server] Step limit too low.** The default of 25 steps ran out on a single-commit review. Use a higher default for review, research and audit (around 80).
- **[usage]** Until that changes, Claude passes `max_steps` on reviews.
- **[server] Report cut mid-finding.** The inline result was cut off ("…[1880 chars cut]…") in the middle of a finding, so a second `deepseek_get_report` call was needed. Cut at whole findings, keep the findings list whole, and trim the command log first.
- **[server] Noisy command log.** Failed commands repeat their full tail. Show just the error line.
- **[server] No default model per task type.** Allow setting a default model for each task type (in `/route` or the config), so "use pro" doesn't have to be repeated.

### Run t2: whole-project security review, pro, read-only, max_steps 150
It stopped at the token limit after 32 steps, with 3.36M tokens in (3.0M cached), about $0.71. It read whole large files and ran out of room before covering the scheduler, collectors and Discord code.
- **[server] Partial file reads.** Give the file-read tool offset and limit (or line ranges) if it lacks them. Have the prompt prefer grep and line ranges, and warn the model when a file is over N lines.
- **[server] Plan the budget first.** Before it starts, have it estimate coverage and budget per area, and say which areas it will skip, rather than stopping partway.
- **[usage] Split big reviews.** Claude can send one `deepseek_task` per area (auth, isolation, feeds and so on) and merge the reports. Claude can also tell it to use grep and line ranges in the task text.
- **[server] Optional built-in split.** For a whole-project task, the server could fan out the sub-tasks itself, each with its own budget, and merge the reports.
- **[server] Show which limit it hit.** Report the limit it stopped at and how much budget each area used.
- **Good:** it said clearly what it did not cover ("Not done: …"). Keep that.

### Runs t3 and t4: two area reviews sent side by side, pro, max_steps 80
- t3 (feeds) finished in 37 steps (2.78M in, about $0.43), with useful findings. t4 (Discord) stopped at the **token limit** after 39 steps (3.16M in, 2.97M of it cached, about $0.63). So the token limit, not the step limit, is now what stops runs.
- **[server] Count cached tokens separately.** 94% of input was cache hits, which cost about a tenth as much. Base the token limit on cost (cached tokens weighted lower), or have separate limits for new and cached input, so cheap cached re-reads don't end a run early.
- **[server] Compact the history.** Input grows each step because the whole history is sent again. Past a threshold, replace old tool outputs with short summaries and keep the file:line notes. That keeps late steps cheap and leaves room to finish.
- **[server] Allow a larger token budget.** Let `deepseek_task` take a `max_tokens` (or budget in $) for one call, like `max_steps`.
- **Good:** finding quality improved. All t3 and t4 findings Claude checked were real (minor ones). The self-check and the "Not covered" lines work.

## Status (2026-10-31)

Done in the server:
- Self-check: review, debug, research and bugfix prompts must re-open each cited `file:line` and drop what they can't confirm.
- Windows: slashes in the program path are turned into backslashes before `cmd.exe` runs it (also for approved commands).
- Step limits per type: review 80, research 80, debug 50, plan 40, others 25 (env `DEEPSEEK_MAX_STEPS_<TYPE>`).
- Report: the summary is cut at whole items, keeps the trailing "Not done" part, and findings types get twice the room. The command log is trimmed first.
- Command log: each failed command shows one error line instead of an 8-line tail.
- Default model per type: `/route review pro`, stored in `models.json` (user, or per project).
- Partial reads: `read_file` returns 200 lines by default and says how long the file is; the prompt says grep first, then read ranges.
- Budget planning: review/research/debug/plan prompts state the step and token budget and ask for a plan per area up front. DeepSeek gets one warning when 20% of steps or 80% of tokens are left.
- Limit shown: the report header says which limit stopped it, with numbers (for example `stopped at token limit (3.10M/3.00M input tokens, step 32/150)`).

- Cached tokens: the token budget counts cached input at 10% (`DEEPSEEK_CACHE_WEIGHT`). The token-limit header also shows the raw tokens sent.
- History compaction: once a prompt passes 200k tokens (`DEEPSEEK_COMPACT_TOKENS`), tool outputs older than the newest 8 are shortened to one line. The prompt tells DeepSeek to note file:line facts in its own messages. The report header shows "history shortened N×".
- Per-call budget: `deepseek_task` takes `max_tokens`.
- Built-in fan-out: `deepseek_task` takes `areas: [...]`. It runs one sub-task per area (3 at a time, `DEEPSEEK_FANOUT_CONCURRENCY`), each with its own budget, and returns one merged report with each area's task_id.

Not done:
- Nothing open.

## 2026-11-01: four review rounds, new features and a benchmark

DeepSeek (pro) reviewed this repo four times. Claude checked each finding before fixing it, and a few were false: grep `g` flags, split-task cache misses, and Windows `\"` quoting. Commits `bd86bd5` through `35e219f`.

### Fixed
- **Cut-off reports (the biggest one).** DeepSeek writes its final report in a normal tool step, which was capped at 8k tokens, and thinking used most of that. Now a step that hits the cap with no tool calls, or with half-written tool-call arguments, is redone with the report cap (16k) and tools still on. Tool-call markup (`DSML`) that leaks into a reply is stripped. A reply still cut off gets a note.
  - An earlier version of this fix turned tools off for the redo. DeepSeek then wrote its tool calls out as text. Don't use `tool_choice: "none"` for the redo.
- **Other finish reasons.** `insufficient_system_resource` gets one redo. `content_filter` and `aborted` get a note.
- **Safety.**
  - `approve_actions` refuses to run without a confirmation prompt, unless `DEEPSEEK_ELICITATION=off`.
  - It skips repeated ids, and re-checks that each item is still in the queue right before running it.
  - Allowlisted tools with file-writing flags need approval: `--fix`, `--write`/`-w`, `--clean`, `-u`/`--update`, and eslint `-o`/`--output-file`.
  - `list_dir` hides secret files.
- **Robustness.**
  - Unix timeouts kill the whole process group.
  - Cancelling a task stops its running commands and approval prompts.
  - A call that hits the 15-minute API timeout isn't retried.
  - `Retry-After` given as a date is read correctly, and server-requested waits of up to 5 minutes are honoured.
  - grep tests only the first 10k characters of each line, and accepts `(?i)`-style leading flags.
  - Effort values from environment variables are validated, and `medium` is sent as `high`.
- **Claude-side tokens.**
  - Single-file diff, trace and summary sections are capped.
  - Split-task reports show the usage line once.
  - `deepseek_ask` reads only the start of each file, and notes a cut-off answer.
- **Cost display.** Off-peak half price is applied (Chinese holidays aren't tracked, so it stays an upper bound). Thinking tokens and web calls are counted.

### New
- **Web access, off by default.**
  - `web_search` / `web_fetch` use DeepSeek's Search & Fetch API, at $0.75 per 1,000 calls.
  - They're offered only to read-only tasks with `web: true`, and only when `DEEPSEEK_WEB=on`.
  - `/ds-research` asks for web access. When it's off, the report says DeepSeek used the workspace only.
- **Strict tool schemas, off by default** (`DEEPSEEK_STRICT_TOOLS=on`, beta `/beta` API).
  - They work on flash and pro, with and without thinking (`npm run check:live`).
  - The benchmark showed about 20% more DeepSeek cost (more steps, longer tool calls) and no quality gain. Keep them off.
- **Benchmark (`bench/`, see `bench/README.md`).**
  - 11 tasks with automatic pass checks, run through the real MCP interface against any git refs or settings.
  - A fetch probe records every DeepSeek request, so old commits can be measured too.
  - Example: `npm run bench -- --versions "before=13c8626,now=.?DEEPSEEK_STRICT_TOOLS=off" --reps 3`.

### Benchmark findings (flash, 3 repeats; results in `bench/results/`)
- **Current defaults vs `13c8626`, on ordinary tasks:** same DeepSeek cost (+2%), same speed, Claude reads about 7% less. All of that is within run-to-run noise.
- **Stress test, steps cut off at the cap:** pass rate 1/3 → 3/3, and cut-off reports reaching Claude 4 → 0. Recovery costs more DeepSeek spend and time.
- **The commit-by-commit run** found nothing that raised cost except strict tool schemas.
- **Noise is large.** One task's cost varies about 2× between runs. Use at least 3 repeats, or 8 for close calls.
- The 11 tasks are mostly too easy to tell versions apart on quality. Only the stress task separates them.

### Open
- **Does delegating save money?** Not measured yet. The benchmark covers DeepSeek's cost and report size, not Claude's total tokens with and without delegating.
  - Likely yes for read-heavy tasks (big reviews, debugging, test loops). Likely not for small ones, because Claude reading a small file costs about the same as reading the report.
  - Next step: run each task two ways through `claude -p --output-format json`, once with Claude doing it and once delegated.
- **Harder benchmark tasks**, so quality differences show up.
- **One tool error** in a tests-money run (2026-11-01 results) hasn't been looked at.
- **Fixed overhead** is about 1,590 tokens per Claude session (7 tools plus instructions). It could be trimmed.
- **Benchmark coverage:** pro and higher effort levels haven't been benchmarked; everything so far ran on flash.

## 2026-11-01 (later): token review against DeepSeek's docs

Checked the code against DeepSeek's current docs (pricing, context caching, thinking mode, change log). Model ids, prices, off-peak hours, cache-friendly ordering and the `medium` → `high` mapping all match. Web search billing starts 2026-11-01; it was already counted at $0.75 per 1,000.

### Done
- **Quoted findings (Claude side).** Review, debug, research and bugfix reports end each finding with `seen: \`code\``. The server checks each quote against the cited line (±3 lines) and adds `[quote NOT found at that line]` when it isn't there (`src/quotes.ts`). The server instructions tell Claude it can trust confirmed quotes without re-opening the file. Before, Claude re-checked every finding by reading the file.
- **Fewer slash commands (Claude side).** 11 → 3: `/ds [type] <task>`, `/route` (now also sets thinking effort) and `/ds-approve`. Each command's description is in every Claude session. `npm run setup` removes the old ones it installed.
- **Step cap follows thinking effort (DeepSeek side).** 8k at off/low, 16k at high, 32k at max; the redo and final report get twice that. A step cut off at the cap is thrown away and paid again, and a higher cap costs nothing unless used. `DEEPSEEK_MAX_TOOL_STEP_TOKENS` still sets a fixed cap.

### Benchmark (flash, 3 repeats, `bench/results/2026-11-01T03-25-41.md` and `…03-29-28.md`)
- First try: same pass rate, but reviews grew from ~500 to ~850 tokens. DeepSeek wrote more around each finding, not just the quote.
- After adding "keep each finding to 1-2 lines; the quote is the evidence": report size −1%, DeepSeek cost −1%, all runs pass. One review-orders run found 3 of 4 planted bugs instead of 4 (within noise; watch it).
- The step-cap change didn't show up: these tasks never reached 8k in one step. It matters on long runs at high effort.
- The saving (Claude not re-reading files to check findings) isn't something the benchmark can measure.

### Learned from the docs
- With tools on, every earlier `reasoning_content` must be sent back and is put into the context again (400 error otherwise). So high effort makes every later step bigger too. History shortening keeps it whole.
- The docs give no minimum size for cache hits. A shared prefix is only cached once it has been seen in at least two requests.

### Shortened old reasoning (done)
- **Live check:** with tools on, the API accepts a shortened or empty `reasoning_content` on old messages (no 400), and the prompt shrinks by that much (1,259 → 492 tokens in the test). The docs say to send it back in full.
- **Built:** history shortening now also cuts the thinking of assistant messages older than the newest 8 tool outputs to 200 chars. If the API ever answers 400 about reasoning, the full text is put back, shortening of reasoning stops for that run, and the call is sent again. `DEEPSEEK_COMPACT_REASONING=off` turns it off.
- **Benchmark** (`bench/results/2026-11-01T03-39-00.md`; shortening forced at 10k tokens in both versions so it triggers on small tasks): same pass rate, DeepSeek cost −14%, input tokens −27%, time −20%. At the normal 200k threshold only long runs see this.

### Open
- **Routing is all-Claude** in the user's `routing.json`, and effort is `high` for every type in `efforts.json`. Both are the user's choice.

### Does delegating save Claude tokens? (measured)
`bench/claude-vs-ds.mjs` runs each task through real Claude Code (`claude -p`, Opus 5.5) twice: Claude alone, and with this MCP and every type routed to DeepSeek. It uses a narrow tool allowlist (file tools, `npm test`, `node --test`, the DeepSeek tools). About $0.12-0.25 of Claude per run.
- **First run** (`claude-vs-ds-2026-11-01T03-41-47.md`): delegating cost about 6% less overall. Small tasks cost 3-31% *more*. Every delegation took at least 3 Claude turns, because Claude Code hides MCP tools behind a search step, and loading `deepseek_task` was a turn of its own.
- **Fix:** `deepseek_task` now sets `_meta["anthropic/alwaysLoad"]` when any type is routed to DeepSeek or "ask" (`DEEPSEEK_ALWAYS_LOAD=on|off` overrides). With all-Claude routing it stays deferred, so it costs nothing.
- **After the fix** (`claude-vs-ds-…03-49-30.md` and `…03-51-47.md`), 2 repeats, Claude $ per task, alone → delegated:

| task | alone | delegated | change |
|---|---|---|---|
| review-orders (small) | 0.102 | 0.112* | +10% |
| research-upload | 0.121 | 0.110 | −9% |
| bugfix-slug | 0.121 | 0.107 | −12% |
| code-chunk | 0.157 | 0.112 | −29% |
| review-legacy-high (18 files) | 0.197 | 0.135 | −31% |
| tests-money | 0.234 | 0.129 | −45% |

  *Without the first run, which paid a one-off cache write for the new tool list ($0.246).
  - DeepSeek's cost is under $0.01 per task. Delegated runs take 2 Claude turns; alone it's 2-20.
  - Pass rates: alone 10/12, delegated 11/12. tests-money fails often either way (alone 0/4, delegated 2/4). The check wants tests that pass on the good code; worth a look.
- **Takeaway:** delegating pays off from small tasks upward once the tool is loaded upfront. Only a tiny review of one small file is cheaper for Claude to do itself. Most of Claude's cost per task is fixed (~10k-token system prompt, cache write), so the saving comes from fewer turns.
