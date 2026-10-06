# cachelens

Prompt-cache economics for LLM agent pipelines: cost distribution, cache
hit rate, byte-level root-cause diagnosis for cache misses, and a CI gate
that fails the build when the numbers regress. A tracing dashboard shows
the hit rate dropping; `cachelens diagnose` tells you which line of the
prompt did it, what it cost, and how to fix it.

## Quick start

```bash
npm install --save-dev cachelens
```

Capture a trace (see [Three ways to capture](#three-ways-to-capture)),
then inspect and gate it:

```bash
cachelens report trace.jsonl        # cost by step, cache hit rate
cachelens diagnose trace.jsonl      # root-cause findings per miss
cachelens check trace.jsonl --min-hit-rate 80 --max-wasted-usd 5
```

`check` exits `1` when a threshold is violated, so it drops straight into
CI. `report`, `diagnose` and `check` accept several trace files and
analyse them as one trace; a session split across files is still one
session. Those three commands take `--json` (`proxy` and `help` do not),
and every JSON output carries a `warnings` string array. `report --html
<out.html>` writes a self-contained artifact instead.

On the bundled demo traces, `report` prints a 38.9% hit rate for
`fixtures/demo-agent/naive.jsonl` and 86.0% for
`fixtures/demo-agent/fixed.jsonl`; `diagnose` finds 15
`dynamic-prefix-content` misses in the naive one and none in the fixed
one.

## Three ways to capture

Every capture path writes the same JSONL trace format, documented field
by field in [docs/OPERATIONS.md](docs/OPERATIONS.md#trace-format).
Request bodies are redacted by default (see
[Redaction](#redaction)); responses are never stored, only their `usage`
token counts.

### 1. SDK wrapper (JS/TS)

```ts
import Anthropic from "@anthropic-ai/sdk";
import { JsonlTraceStore, wrapAnthropic } from "cachelens";

const client = wrapAnthropic((fetch) => new Anthropic({ fetch }), {
  store: new JsonlTraceStore("./trace.jsonl"),
  sessionId: "session-1",
  stepName: "planner"
});
```

`wrapOpenAi` is the same shape for the OpenAI SDK. Both are thin
adapters over `createCaptureFetch(adapter, options)`: the response is
handed back as soon as the underlying `fetch` resolves, and usage is read
in the background from a tee of the body, so streaming is not delayed.
Streamed usage is parsed from Anthropic `message_start`/`message_delta`
events, the OpenAI Chat Completions usage chunk (sent when
`stream_options.include_usage` is set) and the OpenAI Responses
`response.completed` event. Recording errors go to `options.onError` and never reach your code.
Without `onError`, the first recording error in the process is printed
to stderr once, and the number of further errors is printed at exit.

**Flush before exit.** Because recording is asynchronous, a short script
that exits right after its last call can lose the pending records:
`JsonlTraceStore` holds no open file handle that would keep Node alive.
Build the capturing fetch yourself so you can await it:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicCaptureFetch, JsonlTraceStore } from "cachelens";

const fetch = createAnthropicCaptureFetch({
  store: new JsonlTraceStore("./trace.jsonl"),
  sessionId: "session-1",
  stepName: "planner"
});
const client = new Anthropic({ fetch });
// ... make calls ...
await fetch.flush(); // resolves once every in-flight record is written
```

`createOpenAiCaptureFetch` is the OpenAI equivalent. Responses with a
non-2xx status are not recorded.

**Limitation.** Only a string request body can be recorded. A body
passed as a `Uint8Array`, stream or other non-string value is stored as
`{"redacted":"unparseable-body"}` with model `unknown`. The analysis
commands then print a pricing warning for it, and its cost and request
content cannot be analysed. Serialize the body to a string before
calling `fetch`.

The wrappers are also available from the `cachelens/capture/wrap/anthropic`
and `cachelens/capture/wrap/openai` subpaths.

### 2. HTTP reverse proxy (any language)

```bash
cachelens proxy trace.jsonl --port 8787 --session nightly-eval
# point your client's base URL at http://127.0.0.1:8787
```

The proxy forwards every request to one upstream (default
`https://api.anthropic.com`, change it with `--upstream <url>`). The
upstream is an origin, `scheme://host[:port]`: any path in it is
ignored, and the client's request path is forwarded unchanged. It binds `127.0.0.1` unless you pass `--host`.
Without `--port` it picks a free port and prints it. All requests
share one session id per proxy start: the `--session` value, or a random
id. A request's `x-cachelens-session` header overrides it, and
`x-cachelens-step` sets the step name (default `proxy`). Only successful
(`2xx`) `POST` requests to the completion endpoints `/v1/messages`,
`/v1/chat/completions`, `/v1/responses` and `/v1/completions` are
recorded, the last three as OpenAI calls. Everything else, such as
`count_tokens`, embeddings, `/v1/models`, `GET` requests and `4xx`/`5xx`
responses, is proxied without being recorded. Limits, `5xx` handling and Docker usage are in
[docs/OPERATIONS.md](docs/OPERATIONS.md#running-the-proxy).

### 3. Write records yourself

Any process can append `LlmCall` records to a `TraceStore`
(`JsonlTraceStore` for files, `MemoryTraceStore` in tests), or plug its
own provider parsing into `createCaptureFetch` through a
`CaptureAdapter`. A trace written by hand only has to match the
[trace format](docs/OPERATIONS.md#trace-format).

## Redaction

By default every string in a captured request body becomes a hash
placeholder `[R:<sha256-8>:<bytes>]`, except values under a small
structural allowlist such as `type`, `role` and `model`. Identical text
yields an identical placeholder, so `diagnose` finds the same causes on a
redacted trace as on a raw one. `--raw` (CLI) or `raw: true` (library)
stores the request body verbatim, which only makes the excerpts in the
findings human-readable. Responses are never stored in either mode. The
full policy is in [docs/OPERATIONS.md](docs/OPERATIONS.md#redaction-policy).

## Use as a library

The package root is the library; the `cachelens` command lives only in
the bin. The full public API is listed in `src/index.ts`.

```ts
import { evaluateCheck, findAllDiagnoses, readJsonlFile } from "cachelens";

const { calls, warnings } = await readJsonlFile("trace.jsonl");
for (const warning of warnings) console.warn(warning); // skipped lines

for (const { sessionId, call, diagnosis } of findAllDiagnoses(calls)) {
  console.log(sessionId, call.id, diagnosis.cause, diagnosis.byteOffset, diagnosis.wastedUsd);
}

const result = evaluateCheck(calls, { minHitRate: 0.8, maxWastedUsd: 5 });
console.log(result.passed, result.hitRate, result.violations);
```

`minHitRate` is a ratio from 0 to 1 here, unlike the CLI's
`--min-hit-rate`, which takes a percentage.

## Regression gate against a baseline

Absolute thresholds catch a bad trace; a baseline catches a trace that got
worse than `main`. `check --write-baseline <file>` saves this trace's
metrics as a small JSON file (owner-only permissions, mode `0600`):

```json
{
  "version": 1,
  "generatedAt": "2026-10-06T12:00:00.000Z",
  "pricingAsOf": "2026-10-06",
  "calls": 18,
  "hitRate": 0.8595,
  "totalUsd": 0.0438,
  "wastedUsd": 0,
  "wastedUsdPer1kCalls": 0
}
```

`hitRate` is a ratio from 0 to 1, the same unit as `check --json`.
`check --baseline <file>` compares the current trace with it and fails
(exit `1`) on either regression:

- **`hit-rate-drop`**: the hit rate fell by more than
  `--max-hit-rate-drop <pts>` percentage points.
- **`wasted-increase`**: wasted USD per 1,000 calls rose by more than
  `--max-wasted-increase-usd <n>`. Normalising per 1k calls keeps runs of
  different sizes comparable.

Both tolerances default to `0` when `--baseline` is given, so any
regression fails; improvements never fail. Because the wasted-increase
tolerance is always in force with `--baseline`, findings on a model
missing from the pricing table that wasted tokens fail the comparison
with an `unpriced-waste` violation: their dollar cost is unknown. Either tolerance without
`--baseline` is a usage error (exit `2`), and so is a missing, invalid or
wrong-version baseline file. A baseline written with a different
pricing table date prints a warning, since dollar deltas then include
price changes. `--baseline`, `--write-baseline` and the absolute
thresholds combine freely, and `--json` adds `current`, `baseline`,
`deltas` and `tolerances` to the output.

In GitHub Actions, write the baseline on `main` and compare on pull
requests. The comparison step exits `1` on a regression, which fails the
job:

```yaml
name: cache-regression
on:
  push:
    branches: [main]
  pull_request:
jobs:
  cachelens:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: 22
      - run: npm ci
      # Your agent eval run, captured with wrapAnthropic or `cachelens proxy`.
      - run: npm run agent-eval -- --trace trace.jsonl
      - name: Write baseline
        if: github.ref == 'refs/heads/main'
        run: npx cachelens check trace.jsonl --write-baseline cachelens-baseline.json
      - name: Save baseline
        if: github.ref == 'refs/heads/main'
        uses: actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0
        with:
          path: cachelens-baseline.json
          key: cachelens-baseline-${{ github.sha }}
      - name: Restore main's baseline
        if: github.event_name == 'pull_request'
        uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0
        with:
          path: cachelens-baseline.json
          key: cachelens-baseline-${{ github.event.pull_request.base.sha }}
          restore-keys: cachelens-baseline-
          fail-on-cache-miss: true
      - name: Compare with main
        if: github.event_name == 'pull_request'
        run: >-
          npx cachelens check trace.jsonl
          --baseline cachelens-baseline.json
          --max-hit-rate-drop 2
          --max-wasted-increase-usd 0.50
```

`report --html <out.html>` is a useful companion artifact for the same
job: besides cost by step and hit rate it lists every finding (cause,
call, session, step, canonical offset, structural path, wasted USD,
advice), a per-session timeline of calls with token counts and cost, and
the trace warnings, in one self-contained file.

## What a finding looks like

```
session-01 / react-loop (session-01-turn-2)
  dynamic-prefix-content at system[0].text (canonical offset 381, tier: system)

    you found. Current time: 2026-07-24T10:01:00.000Z.","type":"text"}][{"content":[

  wasted: 585 tokens (~$0.0013)
  fix: Move the dynamic content at system[0].text (canonical offset 381) after the last stable cache breakpoint, or exclude it from the cached prefix entirely.
```

Token counts come straight from the provider's `usage` block, and dollar
amounts from the bundled pricing table (as of 2026-10-06). The canonical
offset is a byte position in this project's canonical serialization of
the request: tools, then system, then messages, with structural keys
sorted and `cache_control` markers stripped. It approximates the
vendor's cache keying. It is not a position in the raw request body; use
the structural path to find the spot there.

Each call is compared with the earlier call in the same session that it
could have hit: the same model and provider, at most 1 hour earlier,
sharing the longest common prefix. Whether that partner's cache entry
had already expired is then judged by the `ttl-expiry` rule. Records are sorted by timestamp
first, so interleaved steps and out-of-order lines do not produce false
findings.

## Warnings

Problems with the input never crash the analysis. Each one prints a line
on stderr and lands in the `warnings` array of `--json` output and the
HTML report:

- **Skipped lines.** An invalid JSON line or record is skipped with a
  warning naming the file and line number. In `check`, any skipped line
  fails the gate.
- **`pricing warning`.** A model missing from the pricing table has its
  cost excluded from totals. Its cache misses are still diagnosed with
  wasted tokens, but the wasted dollars show as `n/a` in text output and
  `wastedUsd: null` in JSON. The warning alone does not change the exit
  code. When such findings wasted tokens, `check` fails with an
  `unpriced-waste` violation whenever a dollar gate is active
  (`--max-wasted-usd`, or `--baseline` with its wasted-increase
  tolerance), because the dollar limit cannot be verified.
- **`request warning`.** Covers two cases, and neither changes the exit
  code. A call whose stored request body is not a JSON object is not
  diagnosed. A cache miss with a stable prefix that no rule could
  classify is reported here instead of as a finding.

## Providers

|  | Anthropic | OpenAI |
|---|---|---|
| Cost + hit rate | Full | Full |
| Root-cause diagnosis | All 9 causes | 5 of 9 |

OpenAI's automatic prefix caching has no breakpoints, TTL, or tiers, so
the causes describing that mechanism are gated off rather than guessed.
OpenAI usage reports no cache writes, so wasted dollars for OpenAI
findings are estimates; the library's `Diagnosis` marks them with
`wastedEstimate: true`.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
npm run generate:demo-fixtures      # rewrites fixtures/demo-agent/{naive,fixed}.jsonl
npm run generate:partner-fixtures   # rewrites interleaved, interleaved-expired and out-of-order
```

Node >= 22. `cachelens help` prints:

<!-- cli-help:start -->
```text
cachelens - token-economics profiler for LLM agent pipelines

Usage:
  cachelens <command> [args]

Commands:
  report <trace.jsonl>... [--json | --html <out.html>]
                          Print cost-by-step and cache hit rate; --html adds
                          findings, a per-session timeline and warnings
  diagnose <trace.jsonl>... [--json]
                          Print compiler-style cache-miss root-cause findings.
                          Offsets are canonical offsets: byte positions in the
                          canonical serialization (tools, system, messages; sorted
                          structural keys; cache_control markers stripped), not in
                          the raw request body.
  check <trace.jsonl>... [--max-wasted-usd <n>] [--min-hit-rate <pct>] [--json]
        [--baseline <file> [--max-hit-rate-drop <pts>] [--max-wasted-increase-usd <n>]]
        [--write-baseline <file>]
                          CI gate: exits nonzero when a threshold is violated.
                          --write-baseline saves this trace's metrics as JSON.
                          --baseline fails on a hit-rate drop (percentage points)
                          or a rise in wasted USD per 1k calls beyond the given
                          tolerance; both default to 0 (no regression allowed).
  proxy <out.jsonl> [--port <n>] [--host <addr>] [--upstream <url>] [--session <id>] [--raw]
                          Zero-code-change HTTP reverse proxy to one upstream API;
                          captures every request/response pair to <out.jsonl>.
                          Binds 127.0.0.1 unless --host is given. Requests without
                          an x-cachelens-session header share one session id
                          (--session, default: random per run). Ctrl+C to stop.
  help                    Show this message

report, diagnose and check read every trace file given and analyse them as one
trace. Options a command does not list are rejected.

Exit codes: 0 ok, 1 findings/threshold violation, 2 usage/I/O error.
```
<!-- cli-help:end -->

Proxy operations, the redaction policy, the trace format and threshold
tuning are covered in [docs/OPERATIONS.md](docs/OPERATIONS.md). Release
notes are in [CHANGELOG.md](CHANGELOG.md).
