import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmCall } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { SqliteTraceStore } from "./sqlite-store.js";
function makeCall(id: string, overrides: Partial<LlmCall> = {}): LlmCall {
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
    },
    ...overrides
  };
}
describe("SqliteTraceStore", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cachelens-sqlite-"));
    dbPath = join(dir, "traces.db");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("starts empty", async () => {
    const store = new SqliteTraceStore(dbPath);
    await expect(store.list()).resolves.toEqual([]);
    store.close();
  });
  it("returns appended calls in insertion order", async () => {
    const store = new SqliteTraceStore(dbPath);
    const a = makeCall("a");
    const b = makeCall("b");
    await store.append(a);
    await store.append(b);
    await expect(store.list()).resolves.toEqual([a, b]);
    store.close();
  });
  it("round-trips the full LlmCall shape, including optional fields", async () => {
    const store = new SqliteTraceStore(dbPath);
    const call = makeCall("a", { parentCallId: "parent-1", durationMs: 250 });
    await store.append(call);
    const [loaded] = await store.list();
    expect(loaded).toEqual(call);
    store.close();
  });
  it("persists across separate store instances (real file I/O)", async () => {
    const first = new SqliteTraceStore(dbPath);
    await first.append(makeCall("a"));
    first.close();
    const reopened = new SqliteTraceStore(dbPath);
    await expect(reopened.list()).resolves.toEqual([makeCall("a")]);
    reopened.close();
  });
  it("upserts on a repeated id rather than duplicating the row", async () => {
    const store = new SqliteTraceStore(dbPath);
    await store.append(makeCall("a", { timestamp: 1 }));
    await store.append(makeCall("a", { timestamp: 2 }));
    const calls = await store.list();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timestamp).toBe(2);
    store.close();
  });
});
