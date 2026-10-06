# Operations

Running `cachelens` in a real pipeline: the proxy in Docker/CI, what
capture stores and redacts, reading `diagnose` output, tuning `check`
thresholds, choosing a `TraceStore`, and the trace file format.

## Running the proxy

`cachelens proxy <out.jsonl> [--port <n>] [--host <addr>] [--upstream <url>] [--session <id>] [--raw]`
starts a plain-HTTP reverse proxy to one upstream API (see the README's
[Three ways to capture](../README.md#three-ways-to-capture)) and blocks
until it receives `SIGINT`/`SIGTERM`. It then stops accepting new
connections, waits for in-flight records to be written, and exits `0`. There's no separate
daemon mode — run it as the foreground process of whatever supervises it
(a container, a systemd unit, a background shell job).

**Defaults.** The proxy binds `127.0.0.1` only; pass `--host 0.0.0.0` (or
another address) to accept connections from other machines or containers.
A non-loopback bind prints a startup warning: anyone who can reach the port
can send requests upstream with the API key your clients attach.
The startup line prints the address and port actually bound; without
`--port` the proxy picks a free port. The default upstream is
`https://api.anthropic.com`; `--upstream <url>` changes it. The upstream
is an origin (`scheme://host[:port]`): any path component is ignored and
the client's request path and query are forwarded as-is, so
`--upstream http://gateway/base` plus a request to `/v1/messages`
reaches the upstream as `/v1/messages`, not `/base/v1/messages`. Requests
without an `x-cachelens-session` header all share one session id, generated
once per proxy start or set with `--session <id>`. The
`x-cachelens-step` header sets the step name (default `proxy`). Paths `/v1/chat/completions`,
`/v1/responses`, `/v1/completions` and `/v1/embeddings` are parsed as
OpenAI, every other path as Anthropic. Only successful (`2xx`)
`POST` requests to `/v1/messages`, `/v1/chat/completions`, `/v1/responses`
and `/v1/completions` are recorded, as with the SDK wrappers; everything
else (`count_tokens`, `/v1/models`, embeddings, `4xx`/`5xx` responses) is
proxied without being recorded. Paths are matched by suffix, so a base
URL with a prefix such as `/anthropic/v1/messages` is still recorded; if
the first 10 proxied requests record nothing, the proxy warns once to check
the base URL path. An `http://` upstream that is
not a loopback host triggers a startup warning, because API keys and
prompts would travel unencrypted. Upstream `5xx` bodies are logged to
stderr (first 4 KiB) and replaced by `{"error":"upstream error"}` for the
client, keeping the upstream status and headers such as `retry-after`.
Other statuses are relayed unchanged.

**Built-in limits.** The upstream connection times out after 60 seconds
without activity. What the client sees depends on how far the response
got:

- **No response headers yet.** The proxy answers `504` with
  `cachelens proxy: upstream timed out`. A `5xx` response that stalls
  mid-body also ends in `504`.
- **Headers already sent (a stall mid-stream).** The status line is gone,
  so the proxy destroys the client connection. The client sees a
  truncated response or a connection reset, never a `504`, and the call
  is not recorded.

A client request body over 10 MiB is answered with `413` and the
connection is closed, without contacting upstream. A non-streaming
response larger than 10 MiB (after decompression) still reaches the
client in full, but is recorded with zero usage and a stderr warning;
streamed (SSE) responses are parsed incrementally and have no such cap.
All three are `startProxy()` options (`upstreamTimeoutMs`,
`maxRequestBodyBytes`, `maxCaptureBytes`), not CLI flags, so tune them
by calling `startProxy` directly if the defaults don't fit your
traffic. A client disconnecting mid-stream (closing its
own connection early, most relevantly during a long SSE completion) is
detected and aborts the corresponding upstream request rather than
leaving it running.

### Docker

There's no shipped image; this is the Dockerfile shape to build one —
built from this repo, it needs nothing beyond the built CLI:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 8787
ENTRYPOINT ["node", "dist/cli/index.js", "proxy", "/data/trace.jsonl", "--port", "8787", "--host", "0.0.0.0"]
```

```bash
docker build -t cachelens-proxy .
docker run -p 8787:8787 -v "$(pwd)/traces:/data" cachelens-proxy
```

Point your agent process's `baseURL` at `http://<container-host>:8787`
instead of the provider's API — same as running the proxy directly, just
with the container's network address instead of `localhost`.

### CI

The proxy is a live process, not something to unit-test against a real
upstream inside CI. This repo's own `.github/workflows/ci.yml` treats it
as build-and-wiring verification only: it confirms the compiled CLI lists
`proxy` in `--help` and that invoking it without the required output-file
argument fails with exit code `2` and the documented usage message — not
an end-to-end network test. If you need `cachelens` inside a CI job
itself (rather than testing the proxy in isolation), prefer `cachelens
check` (below) over standing up the proxy as a CI step: `check` reads a
trace file you've already captured and is a single synchronous command,
with no process lifecycle to manage.

## Redaction policy

By default (`raw: false` / no `--raw` flag), every captured wire-body is
redacted before it's written to a `TraceStore`. Redaction
(`src/capture/redact.ts`) walks the parsed JSON request body with
path-based rules. A string value survives only at a known structural
position. Every other string becomes a deterministic hash placeholder.
Redaction hides the text. It does not hide the shape of the request,
so a redacted trace is not free of information about the prompt.

**Placeholder format.** A redacted string becomes
`[R:<hash>:<bytes>]`, where `<hash>` is the first 8 hex characters of the
SHA-256 of the original UTF-8 text and `<bytes>` is its UTF-8 byte length.
For example, `"Current time: 10:00"` becomes
`[R:cac1265e:19]`. The same text always yields the same placeholder, and
different text yields a different one. That is what lets the prefix diff
see exactly where two requests diverge without seeing what they say. Code
that needs to recognise a placeholder can use the exported
`REDACTION_PLACEHOLDER_RE`.

**String values that survive, by path.** Only these positions keep their
text:

- Request top level: `model`, and `stop_reason`, `finish_reason`,
  `service_tier`, `object`, `status`.
- `tool_choice.type`, `tool_choice.name` and `tool_choice.function.name`.
- `thinking.type`.
- `cache_control.type` and `cache_control.ttl` on the request, on
  `tools[]`, on `system[]` blocks and on content blocks.
- `system[].type`.
- `messages[].role` and `messages[].type`, and `messages[].tool_calls[].type`
  and `.function.name`. The Responses API `input[]` array follows the same
  rules as `messages[]`.
- `messages[].content[].type`, and `source.type` and `source.media_type`
  on image and document blocks. Blocks nested in a `tool_result`'s
  content array follow the same rules.
- The tool name `name` on `tool_use` blocks.
- `tools[].name` and `tools[].type`, and `tools[].function.name`.
- JSON-schema structure inside `tools[].input_schema` and
  `tools[].function.parameters`: `type`, `format` and `required` at any
  depth. Schema `description`, `title`, `enum` and `default` strings are
  hashed.
- Identifiers under `id`, `tool_use_id`, `tool_call_id` and `call_id` at
  the positions above, but only when they are at most 64 characters of
  `[A-Za-z0-9_\-:.]`. Any other value under those keys is hashed.

The same key name anywhere else is hashed. For example, a `status`,
`type` or `name` inside `mcp_servers[]` or an unknown field is hashed, and
so is OpenAI's participant `messages[].name` and the top-level `user`.

**Other values that survive.** Outside opaque payloads, object keys,
numbers, booleans, `null`, and array length and order are kept. So an
`input_schema.properties.data` keeps its property name and nested `type`,
and `max_tokens` and `thinking.budget_tokens` stay real.

**Opaque payloads.** These objects carry arbitrary caller data:

- a `tool_use` block's `input`
- a `tool_result` block's `content` when it is a JSON object
- the Responses API `prompt.variables`
- the top-level `metadata`

Inside them, every string, every number and every object key is
replaced by a placeholder. Numbers are hashed from their decimal text,
and key order is kept. Only booleans, `null` and array shapes survive.

**Everything else is hashed.** That includes:

- message and system text, in block and plain-string form
- thinking text and signatures
- tool and schema descriptions
- image and document `data`, `image_url.url` and `file.file_data`
- `tool_calls[].function.arguments`
- the Responses API `instructions`
- `mcp_servers[]` tokens, URLs and names
- `citations[].cited_text`

**Detection does not need `--raw`.** `cachelens diagnose`, `check` and the
aggregate reports find the same causes on a redacted trace as on a raw
one: the structural path, tier and cause are identical, because a change
in the text is a change in its placeholder. Byte offsets are canonical
offsets: positions in the canonical serialization of the redacted request
(tools, system, messages; structural keys sorted; `cache_control`
markers stripped; redaction placeholders padded), not in the raw
wire-body. The only thing you lose is the human-readable
excerpt in the advice output, which shows placeholders instead of the
diverging text.

Pass `--raw` (CLI) / `raw: true` (`wrapAnthropic`/`wrapOpenAi`/`startProxy`
options) to store the unredacted request body instead. Response bodies
are never stored in either mode; only their `usage` token counts are. Use it only when you
need to read the actual diverging text during local debugging. It's not
recommended for anything that leaves your machine. Whichever mode you
use, treat trace files (`*.jsonl`) as sensitive. A redacted
trace still contains request structure, tool names, token/cost data, and
hashes that can confirm a guess of short, low-entropy text. With `--raw`
they contain the full request bodies: prompts, tool definitions and tool
results.

**Canonical serializer.** Before comparing two requests, `diagnose` pads
each placeholder to the byte length of the text it replaced, so
canonical offsets and tier sizes match those of the raw request. Sizes are approximate in two cases. A value shorter than its placeholder keeps the placeholder's length. Inside opaque payloads, hashed keys and hashed numbers are not padded back to their original size.
In opaque payloads such as `tool_use.input`, offsets in a redacted trace
are therefore approximate and point to the start of the changed value,
and the byte-based `prefix-too-short` estimate is conservative there.

## Reading `diagnose` output

Each finding names a cause, the call, the structural path (for example
`system[0].text`) and the canonical offset where the request first
diverged from the call it could have hit. That partner call is the
earlier call in the same session with the same model and provider,
at most 1 hour earlier, that shares the longest common canonical prefix.
Whether the partner's cache entry had expired is judged afterwards by
the `ttl-expiry` rule. Calls are sorted by timestamp first, so line
order in the file does not matter. The scan runs from the newest
candidate backwards and stops early at the first call whose whole
canonical text is a prefix of the current one. A conversation that
branches and rolls back can therefore be compared with a shorter partner
than the longest one available; this is rare and accepted.

`prefix-too-short` needs no token-count API call: the shared prefix's
canonical byte length is compared with the model's minimum cacheable
length at an estimated 4 bytes per token.

Wasted tokens are capped at the prefix the partner could actually have
supplied. Cache writes are priced with the usage's own 5m/1h split when
the provider reported one (5m at 1.25x input, 1h at 2x). Without a split,
they are priced at the 1h rate only when every breakpoint asks for 1h,
otherwise at the 5m rate. OpenAI does not report cache writes, so OpenAI
waste is an estimate (`wastedEstimate: true` on the library's
`Diagnosis`).

### Wasted by tier

When one miss invalidates more than one cache tier (tools, system,
messages), the text output adds a `wasted by tier` breakdown. The split
is approximate: the finding's total wasted USD is divided between the
invalidated tiers in proportion to their byte lengths in the canonical
serialization, not measured per tier. Treat it as a pointer to where the
bulk of the re-written prefix lives; only the total is backed by the
provider's `usage` numbers.

## Tuning `check` thresholds

`cachelens check <trace.jsonl>... [--max-wasted-usd <n>] [--min-hit-rate <pct>]`
evaluates whichever thresholds you pass — an omitted threshold is never
violated, so `cachelens check trace.jsonl` alone exits `0` unless the
trace is empty, has a skipped (invalid) line, or yields a non-finite
metric. It is only useful with at least one threshold set. Numbers must
be plain decimals (`80`, `0.5`); anything else is a usage error
(exit `2`).

- **`--min-hit-rate <pct>`** — the aggregate cache hit rate
  (`cache_read_input_tokens / (cache_read + input + cache_creation)`
  across the whole trace) must be at or above this percentage. Start from
  your trace's current measured rate (`cachelens report`) minus a small
  margin, not an aspirational number — the gate's job is catching a
  *regression*, not enforcing a target you haven't hit yet. This repo's
  own CI gates `fixtures/demo-agent/fixed.jsonl` at `--min-hit-rate 80`
  against a measured 86.0%, a real margin, not a no-op check.
- **`--max-wasted-usd <n>`** — the sum of every diagnosed miss's
  `wastedUsd` in the trace must stay at or below `n`. This is trace-scoped,
  not a monthly budget: it's exactly as large as the traffic represented
  in the file you pass it, so it only makes sense compared trace-to-trace
  at a consistent volume (e.g. one CI run's worth of calls each time), not
  as an absolute dollar ceiling. Findings on a model missing from the
  pricing table have no dollar figure; when they wasted any tokens, this
  threshold fails with an `unpriced-waste` violation, because the limit
  cannot be verified. The same applies to `--baseline` below.
- **`--json`** gives the same evaluation as a stable object
  (`passed`, `violations[]` with `kind`/`message`/`actual`/`threshold`) for
  feeding a dashboard or a custom CI annotation instead of parsing the text
  output. It also carries `current` metrics and, with `--baseline`, the
  `baseline`, `deltas` and `tolerances` used.
- **`--baseline <file>`** compares against a previous run's
  `--write-baseline <file>` artifact instead of a fixed number, which is
  usually the better regression gate: write it on `main`, compare on each
  pull request (see the README for a GitHub Actions example).
  `--max-hit-rate-drop <pts>` is in percentage points and
  `--max-wasted-increase-usd <n>` in wasted USD per 1,000 calls; both
  default to `0` (no regression allowed). The wasted-increase tolerance
  is always in force with `--baseline`, so wasted tokens on an unpriced
  model fail it with `unpriced-waste` even when no dollar threshold is
  set. Start with a small tolerance,
  for example `--max-hit-rate-drop 2`, if your traces vary run to run.
  Regenerate the baseline after a pricing-table update: `check` warns when
  the baseline's `pricingAsOf` differs from the current one.

## Storage

Both stores implement the same `TraceStore` interface (`append`/`list`),
exported from the `cachelens` package entry. There is no other backend;
the SQLite store was removed in 2.0.0, and the package has no runtime
dependencies.

- **`JsonlTraceStore`** (`cachelens`, or the `cachelens/store/jsonl`
  subpath) writes one JSON record per line. Files are created with mode
  `0600` and directories with `0700`; an existing file with wider
  permissions is tightened to `0600` on the first append (a failure, such
  as `EPERM` on a file you don't own, is reported to the `onWarning`
  option and does not stop the append). Appends on one store instance are
  serialized, so concurrent calls never interleave partial lines. It is
  what `cachelens proxy` and the demo fixtures use, and the only format
  the CLI reads. It has no query capability beyond "read the whole file",
  which is fine at CI-run scale (tens to low thousands of calls). For
  traffic collected over time, rotate files (e.g. one per run or per day)
  and pass several to `report`/`diagnose`/`check`; they are analysed as
  one trace, and a session split across files is still one session.
  `list()` reports each skipped line to `onWarning` (default: stderr);
  `listWithWarnings()` returns `{ calls, warnings }` without printing.

- **`MemoryTraceStore`** keeps calls in an array. Use it in tests, or to
  capture in-process and pass `await store.list()` straight to
  `findAllDiagnoses` / `evaluateCheck` without touching disk.

`readJsonlFile(path)` returns `{ calls, warnings }`. A missing file
yields no calls and no warnings. Neither store does redaction itself;
that happens once, at capture time, in the SDK wrappers and the proxy
(see above), before the call ever reaches a `TraceStore`.

## Trace format

A trace is a UTF-8 JSONL file: one `LlmCall` record per line, as defined
in `src/core/model/call.ts`. Blank lines are ignored. Readers validate
every line (`src/store/validate-record.ts`). A line that is not valid
JSON, or not a valid record, is skipped with a warning such as
`trace.jsonl:7: skipped invalid record (usage.inputTokens must be a
finite number >= 0, got missing)`. The rest of the file is still read.
Unknown extra fields are kept but ignored.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Unique call id. Capture uses a random UUID. |
| `sessionId` | string | yes | Groups calls; partners are only looked for inside one session. |
| `stepName` | string | yes | Pipeline step, used for cost-by-step. |
| `parentCallId` | string | no | Id of the call that spawned this one. |
| `timestamp` | number | yes | Request start, milliseconds since the Unix epoch. Calls are sorted by it. |
| `durationMs` | number >= 0 | no | Wall time until the response finished. |
| `provider` | `"anthropic"` or `"openai"` | no | Absent means `anthropic`. |
| `params` | object | yes | Request parameters, below. |
| `payload.wireBody` | string | yes | The request body as sent, redacted unless captured with `--raw`. |
| `usage` | object | yes | Token counts from the response, below. |

`params` fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `model` | string | yes | Model id as sent; `unknown` when the body could not be parsed. |
| `toolChoice` | string | no | `tool_choice` type, plus `:<name>` for a forced tool or function (`tool:get_weather`), or its JSON. |
| `thinking` | object | no | `{ "type": "adaptive" \| "enabled" \| "disabled", "budgetTokens"?: number }`. Absent when the request had no `thinking`. |
| `effort` | string | no | `output_config.effort`. |
| `contextManagement` | string | no | Sorted-key JSON of `context_management`. |
| `inferenceGeo` | string | no | `inference_geo`. |
| `speed` | string | no | `speed`. |
| `imagesPresent` | boolean | no | An image block is present. |
| `citationsEnabled` | boolean | no | A block enables citations. |
| `webSearchEnabled` | boolean | no | A server `web_search` tool is present. |

`usage` fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `inputTokens` | number >= 0 | yes | Uncached input tokens. |
| `outputTokens` | number >= 0 | yes | Output tokens. |
| `cacheReadInputTokens` | number >= 0 | yes | Input tokens served from the cache. |
| `cacheCreationInputTokens` | number >= 0 | yes | Input tokens written to the cache. |
| `cacheCreation5mInputTokens` | number | no | Anthropic `usage.cache_creation.ephemeral_5m_input_tokens`, when reported. |
| `cacheCreation1hInputTokens` | number | no | Anthropic `usage.cache_creation.ephemeral_1h_input_tokens`, when reported. |

**OpenAI usage.** OpenAI reports cached tokens as part of the prompt
total. Capture subtracts them, so for OpenAI calls `inputTokens`
**excludes** cached tokens, `cacheReadInputTokens` carries them, and
`cacheCreationInputTokens` is always `0`. A hand-written OpenAI trace
must follow the same convention, or hit rates and costs come out wrong.

**Cache-write split.** The two `cacheCreation5m/1hInputTokens` fields are
optional. When either is present, cost uses that split; otherwise every
cache write is priced at the TTL the request's breakpoints declare. Each
must be a finite number >= 0, and together they may not exceed
`cacheCreationInputTokens`; a record that breaks either rule is skipped
with a line-numbered warning (and fails `check` as an invalid record).

**Legacy records.** Traces written by 1.x stored `params.thinking` as a
boolean, with an optional `params.thinkingBudgetTokens`. Readers still
accept them: `true` becomes `{ "type": "enabled" }` (plus `budgetTokens`
when present), and `false` removes the field. No other field is coerced.
