import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmCall, RequestParams } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { writeJsonlFile } from "../store/jsonl.js";
const MODEL = "claude-sonnet-4-5";
const SESSION_COUNT = 3;
const TURNS_PER_SESSION = 6;
const TURN_INTERVAL_MS = 60000;
const BASE_TIMESTAMP_MS = Date.parse("2026-07-24T10:00:00Z");
const TOOLS_TOKENS = tokenCount(750);
const SYSTEM_STATIC_TOKENS = tokenCount(350);
const SYSTEM_DYNAMIC_TOKENS = tokenCount(15);
const EXCHANGE_TOKENS = tokenCount(180);
const NEW_QUESTION_TOKENS = tokenCount(40);
const OUTPUT_TOKENS = tokenCount(160);
const REQUEST_PARAMS: RequestParams = { model: MODEL, thinking: { type: "disabled" } };
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
const SYSTEM_INSTRUCTIONS =
  "You are a research assistant. Use the search_web tool to find current information before answering. Be concise and cite what you found.";
function question(turn: number): string {
  return `Question ${turn}: what is the latest development in topic ${turn}?`;
}
function toolQuery(turn: number): string {
  return `topic ${turn} latest development`;
}
function toolResult(turn: number): string {
  return `Search result summary for topic ${turn}: several relevant updates found.`;
}
function answer(turn: number): string {
  return `Based on the search, here is a concise answer about topic ${turn}.`;
}
interface MessageBlock {
  readonly role: "user" | "assistant";
  readonly content: readonly Record<string, unknown>[];
}
function resolvedExchange(turn: number): MessageBlock[] {
  return [
    { role: "user", content: [{ type: "text", text: question(turn) }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check that." },
        {
          type: "tool_use",
          id: `toolu_${turn}`,
          name: "search_web",
          input: { query: toolQuery(turn) }
        }
      ]
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `toolu_${turn}`, content: toolResult(turn) }]
    },
    { role: "assistant", content: [{ type: "text", text: answer(turn) }] }
  ];
}
function messagesForTurn(turn: number): MessageBlock[] {
  const priorExchanges = Array.from({ length: turn - 1 }, (_, i) => resolvedExchange(i + 1)).flat();
  return [...priorExchanges, { role: "user", content: [{ type: "text", text: question(turn) }] }];
}
function systemBlocks(
  variant: "naive" | "fixed",
  turn: number,
  timestampIso: string
): Record<string, unknown>[] {
  const text =
    variant === "naive"
      ? `${SYSTEM_INSTRUCTIONS} Current time: ${timestampIso}.`
      : SYSTEM_INSTRUCTIONS;
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}
function wireBody(variant: "naive" | "fixed", turn: number, timestampIso: string): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    tools: [SEARCH_TOOL],
    system: systemBlocks(variant, turn, timestampIso),
    messages: messagesForTurn(turn)
  });
}
function buildSessionCalls(variant: "naive" | "fixed", sessionIndex: number): LlmCall[] {
  const sessionId = `session-${String(sessionIndex).padStart(2, "0")}`;
  const calls: LlmCall[] = [];
  for (let turn = 1; turn <= TURNS_PER_SESSION; turn++) {
    const timestampIso = new Date(BASE_TIMESTAMP_MS + (turn - 1) * TURN_INTERVAL_MS).toISOString();
    const isFirstTurn = turn === 1;
    const cacheReadInputTokens = isFirstTurn
      ? 0
      : variant === "naive"
        ? TOOLS_TOKENS
        : TOOLS_TOKENS + SYSTEM_STATIC_TOKENS + EXCHANGE_TOKENS * (turn - 1);
    const cacheCreationInputTokens = isFirstTurn
      ? TOOLS_TOKENS +
        SYSTEM_STATIC_TOKENS +
        (variant === "naive" ? SYSTEM_DYNAMIC_TOKENS : 0) +
        NEW_QUESTION_TOKENS
      : variant === "naive"
        ? SYSTEM_STATIC_TOKENS +
          SYSTEM_DYNAMIC_TOKENS +
          EXCHANGE_TOKENS * (turn - 1) +
          NEW_QUESTION_TOKENS
        : NEW_QUESTION_TOKENS;
    calls.push({
      id: `${sessionId}-turn-${turn}`,
      sessionId,
      stepName: "react-loop",
      timestamp: BASE_TIMESTAMP_MS + (sessionIndex - 1) * 86400000 + (turn - 1) * TURN_INTERVAL_MS,
      params: REQUEST_PARAMS,
      payload: { wireBody: wireBody(variant, turn, timestampIso) },
      usage: {
        inputTokens: tokenCount(0),
        outputTokens: OUTPUT_TOKENS,
        cacheCreationInputTokens: tokenCount(cacheCreationInputTokens),
        cacheReadInputTokens: tokenCount(cacheReadInputTokens)
      }
    });
  }
  return calls;
}
function buildTrace(variant: "naive" | "fixed"): LlmCall[] {
  return Array.from({ length: SESSION_COUNT }, (_, i) => buildSessionCalls(variant, i + 1)).flat();
}
async function main(): Promise<void> {
  const fixturesDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "fixtures",
    "demo-agent"
  );
  const naive = buildTrace("naive");
  const fixed = buildTrace("fixed");
  await writeJsonlFile(resolve(fixturesDir, "naive.jsonl"), naive);
  await writeJsonlFile(resolve(fixturesDir, "fixed.jsonl"), fixed);
  process.stdout.write(`Wrote ${naive.length} calls to fixtures/demo-agent/naive.jsonl\n`);
  process.stdout.write(`Wrote ${fixed.length} calls to fixtures/demo-agent/fixed.jsonl\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
