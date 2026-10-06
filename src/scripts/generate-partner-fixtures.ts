import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmCall, RequestParams } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { writeJsonlFile } from "../store/jsonl.js";

/**
 * Healthy-caching traces that file-order pairing misdiagnoses:
 * - interleaved.jsonl: one session alternating two steps with different system prompts.
 * - interleaved-expired.jsonl: the same, spaced so each step's own 5m-TTL prefix expires.
 * - out-of-order.jsonl: one linear session whose lines are in completion order, not request order.
 * naive.jsonl / fixed.jsonl come from generate-demo-fixtures.ts and are not touched here.
 */
const MODEL = "claude-sonnet-4-5";
const REQUEST_PARAMS: RequestParams = { model: MODEL, thinking: { type: "disabled" } };
const BASE_TIMESTAMP_MS = Date.parse("2026-07-25T09:00:00Z");
const TURN_INTERVAL_MS = 30000;
const EXPIRED_INTERVAL_MS = 200000;
const OUTPUT_TOKENS = tokenCount(120);
const TOOLS_TOKENS = 750;
const SYSTEM_TOKENS = 400;
const EXCHANGE_TOKENS = 150;
const QUESTION_TOKENS = 40;

const SEARCH_TOOL = {
  name: "search_web",
  description: "Search the web for current information relevant to the user's question.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"]
  },
  cache_control: { type: "ephemeral" }
};

interface StepSpec {
  readonly name: string;
  readonly system: string;
}

const PLAN_STEP: StepSpec = {
  name: "plan",
  system:
    "You are a planning agent. Break the user's goal into a short ordered list of concrete research steps. Use search_web only to check feasibility."
};
const SUMMARIZE_STEP: StepSpec = {
  name: "summarize",
  system:
    "You are a summarization agent. Condense the research notes you are given into three crisp bullet points with no speculation."
};

function userTurn(step: StepSpec, turn: number): Record<string, unknown> {
  return { role: "user", content: [{ type: "text", text: `${step.name} input ${turn}` }] };
}

function assistantTurn(step: StepSpec, turn: number): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: `${step.name} output ${turn}: done.` }]
  };
}

/** Turn `turn` (1-based) of a step: its own prior exchanges plus a new user message. */
function wireBody(step: StepSpec, turn: number): string {
  const messages: Record<string, unknown>[] = [];
  for (let i = 1; i < turn; i++) {
    messages.push(userTurn(step, i), assistantTurn(step, i));
  }
  messages.push(userTurn(step, turn));
  return JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    tools: [SEARCH_TOOL],
    system: [{ type: "text", text: step.system, cache_control: { type: "ephemeral" } }],
    messages
  });
}

/**
 * Healthy usage for turn `turn` of a step. The step's first turn reads only the shared tools
 * prefix (when `toolsAlreadyCached`) and writes its own system prompt; later turns read the
 * step's whole previous prefix and write only the new exchange.
 */
function healthyUsage(turn: number, toolsAlreadyCached: boolean): LlmCall["usage"] {
  const previousPrefix = TOOLS_TOKENS + SYSTEM_TOKENS + (turn - 1) * EXCHANGE_TOKENS;
  if (turn === 1) {
    return {
      inputTokens: tokenCount(0),
      outputTokens: OUTPUT_TOKENS,
      cacheReadInputTokens: tokenCount(toolsAlreadyCached ? TOOLS_TOKENS : 0),
      cacheCreationInputTokens: tokenCount(
        (toolsAlreadyCached ? 0 : TOOLS_TOKENS) + SYSTEM_TOKENS + QUESTION_TOKENS
      )
    };
  }
  return {
    inputTokens: tokenCount(0),
    outputTokens: OUTPUT_TOKENS,
    cacheReadInputTokens: tokenCount(previousPrefix - EXCHANGE_TOKENS + QUESTION_TOKENS),
    cacheCreationInputTokens: tokenCount(EXCHANGE_TOKENS)
  };
}

/**
 * Usage for turn `turn` (>= 2) of a step whose own prefix expired since its previous turn while
 * the shared tools prefix stayed warm (the other step read it in between): only the tools are
 * read, everything after them is written again.
 */
function expiredUsage(turn: number): LlmCall["usage"] {
  const previousPrefix = TOOLS_TOKENS + SYSTEM_TOKENS + (turn - 1) * EXCHANGE_TOKENS;
  return {
    inputTokens: tokenCount(0),
    outputTokens: OUTPUT_TOKENS,
    cacheReadInputTokens: tokenCount(TOOLS_TOKENS),
    cacheCreationInputTokens: tokenCount(previousPrefix + QUESTION_TOKENS - TOOLS_TOKENS)
  };
}

/**
 * Two steps alternating A,B,A,B. With `expired`, calls are EXPIRED_INTERVAL_MS apart, so each
 * step's own 5m-TTL prefix has expired by its next turn (2 x 200 s > 5 min) and is re-written.
 */
function buildInterleavedTrace(turnsPerStep = 6, expired = false): LlmCall[] {
  const sessionId = expired ? "interleaved-expired-01" : "interleaved-01";
  const intervalMs = expired ? EXPIRED_INTERVAL_MS : TURN_INTERVAL_MS;
  const calls: LlmCall[] = [];
  let index = 0;
  for (let turn = 1; turn <= turnsPerStep; turn++) {
    for (const step of [PLAN_STEP, SUMMARIZE_STEP]) {
      calls.push({
        id: `${sessionId}-${step.name}-${turn}`,
        sessionId,
        stepName: step.name,
        timestamp: BASE_TIMESTAMP_MS + index * intervalMs,
        params: REQUEST_PARAMS,
        payload: { wireBody: wireBody(step, turn) },
        usage: expired && turn > 1 ? expiredUsage(turn) : healthyUsage(turn, index > 0)
      });
      index++;
    }
  }
  return calls;
}

/** Completion order: each pair of adjacent requests finishes in reverse (the later one is faster). */
function buildOutOfOrderTrace(turns = 8): LlmCall[] {
  const sessionId = "out-of-order-01";
  const requestOrder: LlmCall[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    requestOrder.push({
      id: `${sessionId}-turn-${turn}`,
      sessionId,
      stepName: "react-loop",
      timestamp: BASE_TIMESTAMP_MS + (turn - 1) * TURN_INTERVAL_MS,
      params: REQUEST_PARAMS,
      payload: { wireBody: wireBody(PLAN_STEP, turn) },
      usage: healthyUsage(turn, false)
    });
  }
  const completionOrder: LlmCall[] = [];
  for (let i = 0; i < requestOrder.length; i += 2) {
    const pair = requestOrder.slice(i, i + 2).reverse();
    completionOrder.push(...pair);
  }
  return completionOrder;
}

async function main(): Promise<void> {
  const fixturesDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "fixtures",
    "demo-agent"
  );
  const interleaved = buildInterleavedTrace();
  const interleavedExpired = buildInterleavedTrace(6, true);
  const outOfOrder = buildOutOfOrderTrace();
  await writeJsonlFile(resolve(fixturesDir, "interleaved.jsonl"), interleaved);
  await writeJsonlFile(resolve(fixturesDir, "interleaved-expired.jsonl"), interleavedExpired);
  await writeJsonlFile(resolve(fixturesDir, "out-of-order.jsonl"), outOfOrder);
  process.stdout.write(
    `Wrote ${interleaved.length} calls to fixtures/demo-agent/interleaved.jsonl\n`
  );
  process.stdout.write(
    `Wrote ${interleavedExpired.length} calls to fixtures/demo-agent/interleaved-expired.jsonl\n`
  );
  process.stdout.write(
    `Wrote ${outOfOrder.length} calls to fixtures/demo-agent/out-of-order.jsonl\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
