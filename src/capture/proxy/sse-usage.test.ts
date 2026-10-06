import { describe, expect, it } from "vitest";
import { createOpenAiSseUsageAccumulator } from "../usage/openai.js";
import { createSseUsageAccumulator } from "./sse-usage.js";

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
describe("createSseUsageAccumulator", () => {
  it("extracts input/cache usage from message_start and output_tokens from the last message_delta", () => {
    const acc = createSseUsageAccumulator();
    acc.push(
      sseEvent("message_start", {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 200
          }
        }
      })
    );
    acc.push(sseEvent("content_block_delta", { type: "content_block_delta" }));
    acc.push(sseEvent("message_delta", { type: "message_delta", usage: { output_tokens: 15 } }));
    acc.push(sseEvent("message_delta", { type: "message_delta", usage: { output_tokens: 42 } }));
    acc.push(sseEvent("message_stop", { type: "message_stop" }));
    expect(acc.finalize()).toEqual({
      inputTokens: 100,
      outputTokens: 42,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 200
    });
  });
  it("handles chunk boundaries splitting a line across pushes", () => {
    const acc = createSseUsageAccumulator();
    const full = sseEvent("message_start", {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    });
    const mid = Math.floor(full.length / 2);
    acc.push(full.slice(0, mid));
    acc.push(full.slice(mid));
    expect(acc.finalize()).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });
  it("decodes a multi-byte UTF-8 character split across Buffer chunks", () => {
    const acc = createSseUsageAccumulator();
    const bytes = Buffer.from(
      sseEvent("message_start", {
        type: "message_start",
        message: { content: "éé", usage: { input_tokens: 11 } }
      }),
      "utf8"
    );
    const splitAt = bytes.indexOf(0xc3) + 1;
    acc.push(bytes.subarray(0, splitAt));
    acc.push(bytes.subarray(splitAt));
    expect(acc.finalize().inputTokens).toBe(11);
  });
  it("flushes an unterminated trailing line at finalize", () => {
    const acc = createSseUsageAccumulator();
    const full = sseEvent("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 7, output_tokens: 0 } }
    });
    acc.push(full.trimEnd());
    expect(acc.finalize().inputTokens).toBe(7);
  });
  it("returns ZERO_USAGE when message_start was never seen", () => {
    const acc = createSseUsageAccumulator();
    acc.push(sseEvent("ping", { type: "ping" }));
    expect(acc.finalize()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });
  it("skips malformed data lines instead of throwing", () => {
    const acc = createSseUsageAccumulator();
    expect(() => acc.push("data: not json\n\n")).not.toThrow();
    expect(acc.finalize().inputTokens).toBe(0);
  });
  it("ignores non-data lines and empty data lines", () => {
    const acc = createSseUsageAccumulator();
    acc.push("event: message_start\n");
    acc.push("data: \n");
    acc.push(": comment\n\n");
    expect(() => acc.finalize()).not.toThrow();
  });
  it("drops an unterminated line longer than the limit with one warning, then keeps parsing", () => {
    const warnings: string[] = [];
    const acc = createSseUsageAccumulator({
      maxLineLength: 1024,
      onWarning: (m) => warnings.push(m)
    });
    acc.push("data: ");
    for (let i = 0; i < 10; i++) acc.push("x".repeat(512));
    acc.push("tail-of-the-huge-line\n\n");
    acc.push(
      sseEvent("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 9, output_tokens: 0 } }
      })
    );
    expect(acc.finalize().inputTokens).toBe(9);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1024");
  });
  it("drops a complete line longer than the limit delivered in a single chunk", () => {
    const warnings: string[] = [];
    const acc = createSseUsageAccumulator({
      maxLineLength: 64,
      onWarning: (m) => warnings.push(m)
    });
    acc.push(
      sseEvent("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 9, output_tokens: 0 }, pad: "p".repeat(100) }
      })
    );
    expect(acc.finalize().inputTokens).toBe(0);
    expect(warnings).toHaveLength(1);
  });
  it("defaults the line limit to 1 MiB", () => {
    const warnings: string[] = [];
    const acc = createSseUsageAccumulator({ onWarning: (m) => warnings.push(m) });
    acc.push(`data: ${"x".repeat(1024 * 1024 + 1)}`);
    expect(warnings).toHaveLength(1);
    acc.finalize();
  });
  it("decodes a multi-byte character split across chunks in the OpenAI accumulator", () => {
    const acc = createOpenAiSseUsageAccumulator();
    const bytes = Buffer.from(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "日本" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 4 }
        }
      })}\n\n`,
      "utf8"
    );
    const splitAt = bytes.indexOf(0xe6) + 1;
    acc.push(bytes.subarray(0, splitAt));
    acc.push(bytes.subarray(splitAt));
    expect(acc.finalize()).toEqual({
      inputTokens: 6,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 4
    });
  });
});
