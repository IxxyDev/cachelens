import { statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmCall } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { JsonlTraceStore, readJsonlFile, writeJsonlFile } from "./jsonl.js";

const mkdirCalls = vi.hoisted(() => ({ count: 0 }));
const chmodFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      mkdirCalls.count++;
      return actual.mkdir(...args);
    },
    chmod: (...args: Parameters<typeof actual.chmod>) =>
      chmodFailure.error ? Promise.reject(chmodFailure.error) : actual.chmod(...args)
  };
});
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
  it("creates the directory owner-only (0700) and the file owner-only (0600)", async () => {
    const nested = join(dir, "private", "deeper");
    const path = join(nested, "traces.jsonl");
    await new JsonlTraceStore(path).append(makeCall("a"));
    if (process.platform !== "win32") {
      expect(statSync(nested).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "private")).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
  it("tightens an existing 0644 trace file to 0600 on the first append", async () => {
    const path = join(dir, "legacy.jsonl");
    await writeFile(path, `${JSON.stringify(makeCall("old"))}\n`, { mode: 0o644 });
    await chmod(path, 0o644);
    const warnings: string[] = [];
    await new JsonlTraceStore(path, { onWarning: (m) => warnings.push(m) }).append(makeCall("new"));
    expect(warnings).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
  it("warns instead of failing when the existing file cannot be chmod-ed (EPERM)", async () => {
    const path = join(dir, "foreign.jsonl");
    await writeFile(path, "", { mode: 0o644 });
    await chmod(path, 0o644);
    chmodFailure.error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    try {
      const warnings: string[] = [];
      const store = new JsonlTraceStore(path, { onWarning: (m) => warnings.push(m) });
      await store.append(makeCall("a"));
      await store.append(makeCall("b"));
      expect(warnings).toEqual([expect.stringContaining("operation not permitted")]);
      expect(warnings[0]).toContain(path);
      await expect(store.listWithWarnings()).resolves.toMatchObject({ warnings: [] });
    } finally {
      chmodFailure.error = undefined;
    }
  });
  it("reports to stderr by default when no onWarning is given", async () => {
    const path = join(dir, "default-warning.jsonl");
    await writeFile(path, "not json\n", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(new JsonlTraceStore(path).list()).resolves.toEqual([]);
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^cachelens: .*:1: skipped/));
    } finally {
      stderr.mockRestore();
    }
  });
  it("retries directory creation after a failed append instead of caching the failure", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "a file where the directory should be", "utf8");
    const store = new JsonlTraceStore(join(blocker, "traces.jsonl"));
    await expect(store.append(makeCall("a"))).rejects.toThrow();
    await rm(blocker);
    await store.append(makeCall("b"));
    await expect(store.list()).resolves.toEqual([makeCall("b")]);
  });
  it("warns with the stringified reason when chmod rejects with a non-Error", async () => {
    const path = join(dir, "odd.jsonl");
    await writeFile(path, "", { mode: 0o644 });
    await chmod(path, 0o644);
    chmodFailure.error = "weird failure" as unknown as Error;
    try {
      const warnings: string[] = [];
      await new JsonlTraceStore(path, { onWarning: (m) => warnings.push(m) }).append(makeCall("a"));
      expect(warnings).toEqual([expect.stringContaining("weird failure")]);
    } finally {
      chmodFailure.error = undefined;
    }
  });
  it("list() reports skipped lines to onWarning; listWithWarnings() returns them", async () => {
    const path = join(dir, "partial.jsonl");
    await writeFile(path, `${JSON.stringify(makeCall("a"))}\nnot json\n`, "utf8");
    const warnings: string[] = [];
    const store = new JsonlTraceStore(path, { onWarning: (m) => warnings.push(m) });
    await expect(store.list()).resolves.toEqual([makeCall("a")]);
    expect(warnings).toEqual([expect.stringContaining(`${path}:2`)]);
    const result = await store.listWithWarnings();
    expect(result.calls).toEqual([makeCall("a")]);
    expect(result.warnings).toEqual(warnings);
    expect(warnings).toHaveLength(1);
  });
  it("writeJsonlFile creates the file owner-only (0600)", async () => {
    const path = join(dir, "fresh", "fixture.jsonl");
    await writeJsonlFile(path, [makeCall("a")]);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
  it("serializes 50 concurrent ~600 KB appends so no line is interleaved", async () => {
    const path = join(dir, "concurrent.jsonl");
    const store = new JsonlTraceStore(path);
    const big = "x".repeat(600 * 1024);
    const calls = Array.from({ length: 50 }, (_, i) => ({
      ...makeCall(`call-${i}`),
      payload: { wireBody: `${i}:${big}` }
    }));
    await Promise.all(calls.map((call) => store.append(call)));
    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(50);
    const ids = lines.map((line) => (JSON.parse(line) as LlmCall).id);
    expect(new Set(ids).size).toBe(50);
    expect(ids).toEqual(calls.map((c) => c.id));
  });
  it("one failing append does not poison later appends on the same store", async () => {
    const path = join(dir, "after-failure.jsonl");
    const store = new JsonlTraceStore(path);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const bad = { ...makeCall("bad"), params: circular } as unknown as LlmCall;
    await expect(store.append(bad)).rejects.toThrow();
    await store.append(makeCall("good"));
    await expect(store.list()).resolves.toEqual([makeCall("good")]);
  });
  it("creates the directory once per store, not once per append", async () => {
    const store = new JsonlTraceStore(join(dir, "once", "traces.jsonl"));
    const before = mkdirCalls.count;
    await Promise.all([store.append(makeCall("a")), store.append(makeCall("b"))]);
    await store.append(makeCall("c"));
    expect(mkdirCalls.count - before).toBe(1);
    await expect(store.list()).resolves.toHaveLength(3);
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
  it("rethrows read errors other than a missing file (e.g. a directory)", async () => {
    await expect(readJsonlFile(dir)).rejects.toMatchObject({ code: "EISDIR" });
  });
  it("returns [] for a missing file", async () => {
    await expect(readJsonlFile(join(dir, "missing.jsonl"))).resolves.toEqual({
      calls: [],
      warnings: []
    });
  });
  it("writeJsonlFile overwrites rather than appends", async () => {
    const path = join(dir, "fixture.jsonl");
    await writeJsonlFile(path, [makeCall("a"), makeCall("b")]);
    await writeJsonlFile(path, [makeCall("c")]);
    await expect(readJsonlFile(path)).resolves.toEqual({ calls: [makeCall("c")], warnings: [] });
  });
  it("writeJsonlFile with an empty array produces an empty, valid store", async () => {
    const path = join(dir, "empty.jsonl");
    await writeJsonlFile(path, []);
    await expect(readJsonlFile(path)).resolves.toEqual({ calls: [], warnings: [] });
  });
  it("skips an invalid record with a line-numbered warning and keeps loading", async () => {
    const path = join(dir, "mixed.jsonl");
    const { cacheReadInputTokens: _omit, ...usage } = makeCall("bad").usage;
    const lines = [
      JSON.stringify(makeCall("a")),
      JSON.stringify(makeCall("b")),
      JSON.stringify({ ...makeCall("bad"), usage }),
      JSON.stringify(makeCall("c"))
    ];
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    const result = await readJsonlFile(path);
    expect(result.calls.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`${path}:3`);
    expect(result.warnings[0]).toContain("usage.cacheReadInputTokens");
  });
  it("reports the 1-based file line number for invalid JSON, counting blank lines", async () => {
    const path = join(dir, "corrupt.jsonl");
    const lines = [JSON.stringify(makeCall("a")), "", "{not json", JSON.stringify(makeCall("b"))];
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    const result = await readJsonlFile(path);
    expect(result.calls.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.startsWith(`${path}:3: skipped line (invalid JSON`)).toBe(true);
  });
  it("warns about a truncated final line but keeps the earlier calls", async () => {
    const path = join(dir, "truncated.jsonl");
    const full = JSON.stringify(makeCall("b"));
    await writeFile(path, `${JSON.stringify(makeCall("a"))}\n${full.slice(0, 20)}`, "utf8");
    const result = await readJsonlFile(path);
    expect(result.calls.map((c) => c.id)).toEqual(["a"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`${path}:2: skipped truncated final line`);
  });
  it("accepts CRLF line endings and a trailing newline without warnings", async () => {
    const path = join(dir, "crlf.jsonl");
    const body = [makeCall("a"), makeCall("b")].map((c) => JSON.stringify(c)).join("\r\n");
    await writeFile(path, `${body}\r\n`, "utf8");
    await expect(readJsonlFile(path)).resolves.toEqual({
      calls: [makeCall("a"), makeCall("b")],
      warnings: []
    });
  });
});
