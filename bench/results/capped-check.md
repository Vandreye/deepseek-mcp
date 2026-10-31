# DeepSeek MCP benchmark

From: capped-check.jsonl

## Versions

| version | commit | runs | fixed overhead per Claude session |
|---|---|---|---|
| before | 13c8626 | 4 | ~1558 tokens (7 tools) |
| now | c5a6739+dirty | 4 | ~1583 tokens (7 tools) |

## Overall (all tasks; change from before to now)

| metric | before | now | change |
|---|---|---|---|
| pass rate | 100% | 100% | = |
| score | 1.00 | 1.00 | = |
| Claude reads (tokens) | 742 | 846 | ~ (+14%) |
| DeepSeek cost $ | 0.0068 | 0.0082 | worse (+20%) |
| time (s) | 29 | 32 | ~ (+11%) |
| API calls | 15 | 13 | ~ (-13%) |
| input tokens | 50k | 45k | ~ (-11%) |
| cache hit | 81% | 82% | ~ |
| output tokens | 3.5k | 4.8k | worse (+36%) |
| thinking tokens | 1.0k | 1.0k | ~ (+4%) |
| tool errors | 0 | 0 | = |
| redone steps | 0 | 1 | ~ |
| cut-off/empty reports | 2 | 0 | better (-100%) |
| API retries | 0 | 0 | = |
| repeat file reads | 0 | 0 | = |
| harness errors | 0 | 0 | = |

## Per task

Cells: before → now; marks: better / worse / ~ (within noise) / =

| task | pass rate | score | Claude reads (tokens) | DeepSeek cost $ | time (s) | tool errors | redone steps | cut-off/empty reports |
|---|---|---|---|---|---|---|---|---|
| code-chunk | 100% → 100% | 1.00 → 1.00 | 240 → 265 worse | 0.0021 → 0.0021 ~ | 9 → 8 ~ | 0 → 0 | 0 → 0 | 0 → 0 |
| review-legacy-capped | 100% → 100% | 1.00 → 1.00 | 502 → 582 ~ | 0.0048 → 0.0061 worse | 20 → 23 ~ | 0 → 0 | 0 → 1 worse | 2 → 0 better |
