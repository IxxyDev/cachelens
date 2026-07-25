import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmCall } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { JsonlTraceStore, readJsonlFile, writeJsonlFile } from "./jsonl.js";
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
describe("JsonlTraceStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cachelens-jsonl-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("lists an empty array for a file that has never been written", async () => {
    const store = new JsonlTraceStore(join(dir, "traces.jsonl"));
    await expect(store.list()).resolves.toEqual([]);
  });
  it("round-trips appended calls, one per line", async () => {
    const path = join(dir, "nested", "traces.jsonl");
    const store = new JsonlTraceStore(path);
    const a = makeCall("a");
    const b = makeCall("b");
    await store.append(a);
    await store.append(b);
    await expect(store.list()).resolves.toEqual([a, b]);
  });
  it("persists across separate store instances (real file I/O)", async () => {
    const path = join(dir, "traces.jsonl");
    await new JsonlTraceStore(path).append(makeCall("a"));
    const reopened = new JsonlTraceStore(path);
    await expect(reopened.list()).resolves.toEqual([makeCall("a")]);
  });
});
describe("readJsonlFile / writeJsonlFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cachelens-jsonl-fns-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("returns [] for a missing file", async () => {
    await expect(readJsonlFile(join(dir, "missing.jsonl"))).resolves.toEqual([]);
  });
  it("writeJsonlFile overwrites rather than appends", async () => {
    const path = join(dir, "fixture.jsonl");
    await writeJsonlFile(path, [makeCall("a"), makeCall("b")]);
    await writeJsonlFile(path, [makeCall("c")]);
    await expect(readJsonlFile(path)).resolves.toEqual([makeCall("c")]);
  });
  it("writeJsonlFile with an empty array produces an empty, valid store", async () => {
    const path = join(dir, "empty.jsonl");
    await writeJsonlFile(path, []);
    await expect(readJsonlFile(path)).resolves.toEqual([]);
  });
});
