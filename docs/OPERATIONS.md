# Operations

Running `cachelens` in a real pipeline: the proxy in Docker/CI, what
capture stores and redacts, tuning `check` thresholds, and choosing a
`TraceStore`.

## Running the proxy

`cachelens proxy <out.jsonl> [--port <n>] [--upstream <url>] [--raw]`
starts a plain-HTTP forward proxy (see the README's "Three ways to
capture") and blocks until it receives `SIGINT`/`SIGTERM`, at which point
it stops accepting new connections and exits `0`. There's no separate
daemon mode — run it as the foreground process of whatever supervises it
(a container, a systemd unit, a background shell job).

**Built-in limits.** The proxy responds `504` if upstream goes idle for
60 seconds (no response, or a stall mid-stream) rather than hanging
forever, and `413` if a client request body exceeds 10MB rather than
buffering it unbounded. Both are `startProxy()` options
(`upstreamTimeoutMs`, `maxRequestBodyBytes`) — not yet exposed as CLI
flags, so tune them by calling `startProxy` directly if the defaults
don't fit your traffic. A client disconnecting mid-stream (closing its
own connection early, most relevantly during a long SSE completion) is
detected and aborts the corresponding upstream request rather than
leaving it running.

### Docker

There's no shipped image; this is the Dockerfile shape to build one —
built from this repo, it needs nothing beyond the built CLI:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 8787
ENTRYPOINT ["node", "dist/cli/index.js", "proxy", "/data/trace.jsonl", "--port", "8787"]
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
(`src/capture/redact.ts`) walks the parsed JSON request body and blanks
the *value* of any of these keys, wherever they appear, regardless of
nesting: `text`, `input`, `thinking`, `data` — plus `system` and
`content` whenever their value is a plain string rather than a block
array. That covers message and system-prompt text in both the block form
and the plain-string form, tool `input` payloads, extended-thinking
content, and inline image/document `data`.

**What survives redaction, unmodified:** every structural field the
diagnostic engine needs — `model`, `role`, content-block `type`, tool
`name`, `cache_control` breakpoints, `tool_choice`, `thinking`'s
`type`/`budget_tokens`, and container keys like `messages`/`content`
in their array form (only the payload *leaves* are blanked, not the
container structure). This is why `cachelens diagnose` can still
report an exact structural path (`system[0].text`) and cause even on a
redacted trace — the shape is intact, only the payload content is gone.

**What's never redacted:** anything not nested under one of those four
keys — most notably `usage` (token counts) and the top-level request
parameters (`model`, `tool_choice`, `thinking.type`, `speed`,
`citations.enabled`, and so on), since cost/hit-rate/RCA all depend on
those being real.

Pass `--raw` (CLI) / `raw: true` (`wrapAnthropic`/`wrapOpenAi`/`startProxy`
options) to store the unredacted wire-body instead — useful for local
debugging of a specific diagnosis, not recommended for anything that
leaves your machine. Whichever mode you use, treat trace files
(`*.jsonl`, `*.sqlite`) as sensitive: they contain, at minimum, your
request structure and token/cost data, and with `--raw` the full prompt
and response content.

## Tuning `check` thresholds

`cachelens check <trace.jsonl> [--max-wasted-usd <n>] [--min-hit-rate <pct>]`
evaluates whichever thresholds you pass — an omitted threshold is never
violated, so `cachelens check trace.jsonl` alone always exits `0`
(passes) and is only useful with at least one flag set.

- **`--min-hit-rate <pct>`** — the aggregate cache hit rate
  (`cache_read_input_tokens / (cache_read + input + cache_creation)`
  across the whole trace) must be at or above this percentage. Start from
  your trace's current measured rate (`cachelens report`) minus a small
  margin, not an aspirational number — the gate's job is catching a
  *regression*, not enforcing a target you haven't hit yet. This repo's
  own CI gates `fixtures/demo-agent/fixed.jsonl` at `--min-hit-rate 80`
  against a measured ~86%, a real margin, not a no-op check.
- **`--max-wasted-usd <n>`** — the sum of every diagnosed miss's
  `wastedUsd` in the trace must stay at or below `n`. This is trace-scoped,
  not a monthly budget: it's exactly as large as the traffic represented
  in the file you pass it, so it only makes sense compared trace-to-trace
  at a consistent volume (e.g. one CI run's worth of calls each time), not
  as an absolute dollar ceiling.
- **`--json`** gives the same evaluation as a stable object
  (`passed`, `violations[]` with `kind`/`message`/`actual`/`threshold`) for
  feeding a dashboard or a custom CI annotation instead of parsing the text
  output.

## Storage: jsonl vs sqlite

Both implement the same `TraceStore` interface
(`append`/`list`); the trace file itself is the same portable JSON-per-line
record either way — `JsonlTraceStore` just reads/writes it directly, while
`SqliteTraceStore` wraps a `better-sqlite3` database of the same JSON blobs
plus a `session_id` index.

- **Use `jsonl`** (`JsonlTraceStore`) for CI runs, one-off captures, and
  anything you want to `cat`/`git diff`/hand-inspect directly — it's what
  `cachelens proxy` and the demo fixtures use. It has no query
  capability beyond "read the whole file," which is fine at CI-run scale
  (tens to low thousands of calls).

- **Use `sqlite`** (`SqliteTraceStore`) once you're aggregating a live
  pipeline's traffic over time rather than a single run — the
  `session_id` index makes session-scoped lookups cheap without loading
  every call into memory first. It has no rotation/retention built in;
  manage file size the same way you would for any other local SQLite
  database (archive or truncate the file on your own schedule).

Neither store does redaction itself — that happens once, at capture time,
in `capture/wrap/*.ts` / `capture/proxy/start-proxy.ts` (see above), before
the call ever reaches a `TraceStore`.
