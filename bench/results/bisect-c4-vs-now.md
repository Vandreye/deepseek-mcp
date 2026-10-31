# DeepSeek MCP benchmark

From: bisect-c4-vs-now.jsonl

## Versions

| version | commit | runs | fixed overhead per Claude session |
|---|---|---|---|
| c4 | 7eb8db2 | 24 | ~1558 tokens (7 tools) |
| plain | b2968f2+dirty (DEEPSEEK_STRICT_TOOLS=off) | 24 | ~1583 tokens (7 tools) |
| now | b2968f2+dirty | 24 | ~1583 tokens (7 tools) |

## Overall (all tasks)

| metric | c4 | plain | now |
|---|---|---|---|
| pass rate | 96% | 100% | 96% |
| score | 0.98 | 0.97 | 0.95 |
| Claude reads (tokens) | 1073 | 1056 | 1009 |
| DeepSeek cost $ | 0.0087 | 0.0075 | 0.0092 |
| time (s) | 37 | 31 | 39 |
| API calls | 21 | 17 | 22 |
| input tokens | 66k | 44k | 69k |
| cache hit | 78% | 77% | 82% |
| output tokens | 4.1k | 3.7k | 4.7k |
| thinking tokens | 0.4k | 0.4k | 0.5k |
| tool errors | 6 | 0 | 0 |
| redone steps | 0 | 0 | 0 |
| cut-off/empty reports | 0 | 0 | 0 |
| API retries | 0 | 0 | 0 |
| repeat file reads | 2 | 0 | 0 |
| harness errors | 0 | 0 | 0 |

## Per task

Cells: c4 → plain → now

| task | pass rate | score | Claude reads (tokens) | DeepSeek cost $ | time (s) | tool errors | redone steps | cut-off/empty reports |
|---|---|---|---|---|---|---|---|---|
| review-orders | 100% → 100% → 100% | 1.00 → 0.91 → 0.91 | 405 → 401 → 352 | 0.0018 → 0.0020 → 0.0022 | 9 → 9 → 9 | 0 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 |
| tests-money | 88% → 100% → 88% | 0.94 → 1.00 → 0.94 | 339 → 341 → 319 | 0.0050 → 0.0037 → 0.0046 | 19 → 15 → 19 | 0 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 |
| research-upload | 100% → 100% → 100% | 1.00 → 1.00 → 1.00 | 329 → 314 → 338 | 0.0019 → 0.0018 → 0.0024 | 8 → 8 → 11 | 6 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 |

## Failed runs

- now tests-money r4: tests FAIL on good code, catch a broken formatMoney
- c4 tests-money r4: tests FAIL on good code, catch a broken formatMoney
