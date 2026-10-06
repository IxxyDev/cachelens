# Changelog

All notable changes to this project are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-10-06

### Breaking

- **Redaction placeholder format.** Redacted strings are now
  `[R:<sha256-8>:<bytes>]` hash placeholders under a structural
  allowlist, instead of a fixed `[REDACTED]` marker under a short
  denylist. Code matching the old marker must use
  `REDACTION_PLACEHOLDER_RE`.
- **Package root is the library.** `import ... from "cachelens"` now
  loads the library API listed in `src/index.ts`. The CLI is reachable
  only through the `cachelens` bin.
- **`readJsonlFile` returns `{ calls, warnings }`** instead of an array,
  and skips invalid lines instead of throwing.
- **SQLite store removed.** `SqliteTraceStore` and the `better-sqlite3`
  dependency are gone; the package has no runtime dependencies. Use
  `JsonlTraceStore`.
- **Proxy binds `127.0.0.1` by default.** Pass `--host` (or the `host`
  option) to listen on other interfaces.
- **One session per proxy start.** Requests without an
  `x-cachelens-session` header share one session id, set with
  `--session` or generated at startup, instead of a random id per
  request.
- **`RequestParams.thinking` shape.** It is now
  `{ type: "adaptive" | "enabled" | "disabled", budgetTokens? }` instead
  of a boolean plus `thinkingBudgetTokens`. Old traces are still read and
  normalized.
- **Wrappers record asynchronously.** `wrapAnthropic` / `wrapOpenAi`
  return the response before the record is written. Await `flush()` on a
  capturing fetch from `createAnthropicCaptureFetch` /
  `createOpenAiCaptureFetch` before a short-lived process exits.
- **`createCaptureFetch` from `cachelens/capture/wrap/anthropic`
  removed.** It was a deprecated alias of `createAnthropicCaptureFetch`
  and clashed with the generic `createCaptureFetch(adapter, options)`
  exported from the package root. Use `createAnthropicCaptureFetch`.
- **`RequestParams.toolChoice` names a forced tool.** A forced tool is
  recorded as `type:name` (`"tool:get_weather"`, `"function:lookup"`)
  instead of just the type, so switching the forced tool is diagnosed as
  a param change. Comparing a 1.x trace with a 2.0 trace of a forced-tool
  request reports one spurious `tool_choice` change.
- **Records with a bad TTL split are skipped.** A record whose
  `usage.cacheCreation5mInputTokens` / `cacheCreation1hInputTokens` is
  not a finite number >= 0, or whose sum exceeds
  `cacheCreationInputTokens`, is skipped with a line-numbered warning.
- **Unknown model is no longer fatal.** A model missing from the pricing
  table prints a pricing warning and is left out of cost totals, instead
  of failing the command with exit `2`.
- **Unpriced models are diagnosed.** Their cache misses produce findings
  with wasted tokens but no dollar figure: `n/a` in text output,
  `wastedUsd: null` (and `wastedUsdByTier: null`) in `diagnose --json`.
  Code reading `wastedUsd` must handle `null`.

### Added

- `check --baseline <file>` / `--write-baseline <file>` regression gate,
  with `--max-hit-rate-drop` and `--max-wasted-increase-usd` tolerances.
- `report --html` findings table, per-session timeline and warnings
  section.
- Library entry at the package root, including `createCaptureFetch`,
  diagnosis, pricing and store APIs.
- Cache-partner selection: each call is compared with the earlier
  same-session, same-model call at most 1 hour earlier that shares the
  longest canonical prefix, after sorting by timestamp. TTL expiry is
  judged against that partner by the `ttl-expiry` rule instead of
  filtering partners by TTL.
- `unpriced-waste` check violation: any active dollar gate
  (`--max-wasted-usd`, or `--baseline` with its wasted-increase
  tolerance) fails when findings on models without pricing wasted
  tokens, since the dollar limit cannot be verified.
- Byte-estimated `prefix-too-short`: the shared prefix's canonical
  bytes are compared with the model's minimum cacheable length at about
  4 bytes per token, without a token-count API call.
- Pricing table as of 2026-10-06 (`PRICING_AS_OF`), with Fable 5.1,
  Opus 5.5, Sonnet 5.5 and current OpenAI models, per-model cache-read
  multipliers and minimum cacheable lengths, and 5m/1h write prices.
- OpenAI streaming usage: Chat Completions `include_usage` chunks and
  Responses `response.completed` events, in the wrappers and the proxy.
- Provider-aware proxy: successful (`2xx`) `POST` requests to OpenAI
  completion paths (`/v1/chat/completions`, `/v1/responses`,
  `/v1/completions`) are recorded as OpenAI calls; other paths are
  proxied without recording.
  Adds `--host`, `--session` and the `x-cachelens-step` header.
- Capture filter: the proxy records only successful (`2xx`) `POST`
  requests to `/v1/messages`, `/v1/chat/completions`, `/v1/responses`
  and `/v1/completions`. `count_tokens`, embeddings, model listings,
  `GET` requests and error responses are proxied without being recorded.
- Several trace files per `report` / `diagnose` / `check` run, analysed
  as one trace.
- `warnings` array in every `--json` output; pricing and request
  warnings on stderr. Request warnings cover unparseable request bodies
  and cache misses with a stable prefix that no rule could classify.
- Optional `usage.cacheCreation5mInputTokens` /
  `cacheCreation1hInputTokens` fields from Anthropic
  `usage.cache_creation`.
- `generate:partner-fixtures` npm script and the `interleaved.jsonl`,
  `interleaved-expired.jsonl` and `out-of-order.jsonl` demo traces, plus
  a `never-cached.jsonl` trace for the byte-estimated
  `prefix-too-short` path.
- Trace format reference in `docs/OPERATIONS.md`.
- `JsonlTraceStore.listWithWarnings()` and a `JsonlTraceStore` `onWarning`
  option; `list()` now reports skipped lines to it instead of dropping
  them.
- `--json` runs that fail with exit `2` print `{ "error", "exitCode" }`
  on stdout.

### Changed

- Demo fixtures use `claude-sonnet-5-5`. Hit rates are unchanged
  (38.9% naive, 86.0% fixed); costs follow the Sonnet 5.5 price.
- Offsets in findings are documented and labelled as canonical offsets.

### Fixed

- **C1** Installed `cachelens` bin no longer exits silently when run
  through an npm symlink.
- **C2** Trace records are validated, so missing usage fields can no
  longer turn metrics into `NaN` and pass `check`.
- **C3** `diagnose` finds the same causes on a default (redacted) trace
  as on a raw one.
- **H1** SDK wrappers no longer block streaming responses or record zero
  usage for streams.
- **H2** Pricing table updated: new models, correct Fable 5.1 prices and
  per-model cache-read multipliers.
- **H3** `cache_control` markers are stripped before diffing, so moving
  a breakpoint no longer causes false findings.
- **H4** Cache-partner selection is time-sorted and prefix-based instead
  of using the previous line in the file.
- **H5** Redaction is an allowlist: credentials, image data, tool
  arguments and descriptions are hashed.
- **H6** `ttl-expiry` is detected when the request extends the previous
  prefix, not only when it is identical.
- **H7** Concurrent appends are serialized, and a broken line is skipped
  with a line-numbered warning instead of failing the trace.
- **M1** Proxy binds loopback by default.
- **M2** Trace files are created `0600`, directories `0700`. An existing
  trace file is tightened to `0600` on the first append, and
  `report --html` writes `0600`.
- **M3** Proxy shares one session id per run and records OpenAI traffic
  with the right provider and cached tokens.
- **M4** `breakpoint-misplacement` requires a cache read and points at
  block boundaries.
- **M5** Cache writes are priced by TTL (5m 1.25x, 1h 2x), using the
  provider's reported split when present.
- **M6** Request params cover effort, context management, inference geo
  and the current thinking shape.
- **M7** Redaction keeps `thinking.type`, budgets and nested schema keys.
- **M8** Wasted tokens are capped at the reusable prefix.
- **M9** OpenAI findings carry an estimated waste instead of $0.
- **M10** A non-JSON request body produces a warning instead of exit `2`.
- **M11** Usage gate handles multi-turn sessions where caching never
  started.
- **M12** `prefix-too-short` is reachable, and corroboration and
  count-tokens adapters are exported.
- **M13** Strict decimal number flags, every trace file is read, and
  unknown or conflicting options exit `2`.
- **M14** Offsets are labelled canonical offsets and documented as such.
- **M15** Unusable SQLite store and its native dependency removed.
- Capture errors without an `onError` handler are no longer silent: the
  first one is printed to stderr, further ones are counted at exit.
- `dist/scripts` (fixture generators) is no longer in the npm package.
- **M16** Coverage thresholds apply per file to all of `src/`.
- **M17** End-to-end tests run the built CLI on the demo fixtures.
- **M18** CI actions pinned by commit SHA with a `permissions` block.
- **LOW, proxy:** `413` closes the connection, response capture is
  capped at 10 MiB, `5xx` bodies are not echoed to the client, cleartext
  upstreams warn, and `Connection`-listed headers are stripped.
- **LOW, parsing:** SSE parsing handles split multi-byte characters and
  bounds line length; redaction handles `__proto__` keys.
- **LOW, core:** token-count cache keys use SHA-256, an empty trace
  reports `no-calls`, and per-tool breakpoints are located.
- **LOW, code health:** diagnosis and check run once per command, and
  duplicated helpers and dead exports were consolidated.
- **LOW, fixtures and tests:** demo model updated, the unused `turn`
  parameter removed, the system-prompt timestamp follows each session's
  day, and flaky or tautological tests were fixed.
- **LOW, documentation:** CLI help, README and `docs/OPERATIONS.md`
  match the code (HTTP reverse proxy, Node 22 Docker image, stall
  behaviour, `--json` scope, MiB units, no SQLite, `--raw` scope, real
  docs anchor in `diagnose` output).

## [1.0.0]

- Initial release.
