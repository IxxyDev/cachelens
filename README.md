# cachelens

Prompt-cache economics for LLM agent pipelines: cost distribution, cache
hit rate, byte-level root-cause diagnosis for cache misses, and a CI gate
that fails the build when the numbers regress. A tracing dashboard shows
the hit rate dropping; `cachelens diagnose` tells you which line of the
prompt did it, what it cost, and how to fix it.

## Quick start

Capture a trace with the SDK wrapper (JS/TS, one-line change):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "cachelens/capture/wrap/anthropic";
import { JsonlTraceStore } from "cachelens/store/jsonl";

const client = wrapAnthropic((fetch) => new Anthropic({ fetch }), {
  store: new JsonlTraceStore("./trace.jsonl"),
  sessionId: "session-1",
  stepName: "planner"
});
```

or with zero code changes, from any language:

```bash
cachelens proxy trace.jsonl --port 8787
# point your client's baseURL at http://localhost:8787
```

Then inspect and gate:

```bash
cachelens report trace.jsonl        # cost by step, cache hit rate
cachelens diagnose trace.jsonl      # root-cause findings per miss
cachelens check trace.jsonl --min-hit-rate 80 --max-wasted-usd 5
```

`check` exits `1` when a threshold is violated, so it drops straight into
CI. `wrapOpenAi` (`cachelens/capture/wrap/openai`) is the same shape for
the OpenAI SDK. Every command takes `--json`; `report --html` writes a
self-contained artifact.

## What a finding looks like

```
session-01 / react-loop (session-01-turn-2)
  dynamic-prefix-content at system[0].text (wire-body offset 432, tier: system)

    you found. Current time: 2026-07-24T10:01:00.000Z.","cache_control":{"type":"eph

  wasted: 585 tokens (~$0.0020)
  fix: Move the dynamic content at system[0].text (wire-body offset 432) after the last stable cache breakpoint, or exclude it from the cached prefix entirely.
```

Token counts and dollar amounts come straight from the provider's
`usage` block. The byte offset comes from this project's canonical
serializer, an approximation of the vendor's cache keying.

## Providers

|  | Anthropic | OpenAI |
|---|---|---|
| Cost + hit rate | Full | Full |
| Root-cause diagnosis | All 9 causes | 5 of 9 |

OpenAI's automatic prefix caching has no breakpoints, TTL, or tiers, so
the causes describing that mechanism are gated off rather than guessed.

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
```

Node >= 22. `cachelens help` lists every command and flag; exit codes:
`0` ok, `1` findings or threshold violation, `2` usage or I/O error.

Proxy operations, the redaction policy, and threshold tuning are
covered in [docs/OPERATIONS.md](docs/OPERATIONS.md).
