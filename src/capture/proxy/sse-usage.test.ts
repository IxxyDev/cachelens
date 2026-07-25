import { describe, expect, it } from "vitest";
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
});
