import { describe, expect, it } from "vitest";
import type { LlmCall } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { MemoryTraceStore } from "./memory-store.js";

function makeCall(id: string): LlmCall {
  return {
    id,
    sessionId: "session-1",
    stepName: "step-1",
    timestamp: 1000,
    params: { model: "claude-opus-4-8" },
    payload: { wireBody: '{"model":"claude-opus-4-8"}' },
    usage: {
      inputTokens: tokenCount(10),
      outputTokens: tokenCount(5),
      cacheCreationInputTokens: tokenCount(0),
      cacheReadInputTokens: tokenCount(0)
    }
  };
}
describe("MemoryTraceStore", () => {
  it("starts empty", async () => {
    const store = new MemoryTraceStore();
    await expect(store.list()).resolves.toEqual([]);
  });
  it("returns appended calls in insertion order", async () => {
    const store = new MemoryTraceStore();
    const a = makeCall("a");
    const b = makeCall("b");
    await store.append(a);
    await store.append(b);
    await expect(store.list()).resolves.toEqual([a, b]);
  });
  it("returns a snapshot that later appends do not mutate", async () => {
    const store = new MemoryTraceStore();
    await store.append(makeCall("a"));
    const snapshot = await store.list();
    await store.append(makeCall("b"));
    expect(snapshot).toHaveLength(1);
  });
});
