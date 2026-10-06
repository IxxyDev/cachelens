import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRICING_AS_OF } from "../core/pricing/table.js";
import { run } from "./index.js";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXED = join(ROOT, "fixtures/demo-agent/fixed.jsonl");
const NAIVE = join(ROOT, "fixtures/demo-agent/naive.jsonl");

function createIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: (text: string) => out.push(text),
      writeErr: (text: string) => err.push(text)
    },
    out: () => out.join(""),
    err: () => err.join("")
  };
}

describe("check --write-baseline / --baseline on the demo fixtures", () => {
  let dir: string;
  let baselinePath: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cachelens-baseline-"));
    baselinePath = join(dir, "baseline.json");
    const { io } = createIo();
    expect(await run(["check", FIXED, "--write-baseline", baselinePath], io)).toBe(0);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a version-1 artifact with owner-only permissions", () => {
    const artifact = JSON.parse(readFileSync(baselinePath, "utf8"));
    expect(artifact).toEqual({
      version: 1,
      generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      pricingAsOf: PRICING_AS_OF,
      calls: 18,
      hitRate: expect.closeTo(0.8595, 4),
      totalUsd: expect.any(Number),
      wastedUsd: 0,
      wastedUsdPer1kCalls: 0
    });
    expect(statSync(baselinePath).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing file's permissions when overwriting it", async () => {
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "{}", { mode: 0o644 });
    const { io } = createIo();
    expect(await run(["check", FIXED, "--write-baseline", existing], io)).toBe(0);
    expect(statSync(existing).mode & 0o777).toBe(0o600);
  });

  it("combines with thresholds: writes the baseline and still fails a violated threshold", async () => {
    const path = join(dir, "naive-baseline.json");
    const { io, out } = createIo();
    expect(await run(["check", NAIVE, "--min-hit-rate", "80", "--write-baseline", path], io)).toBe(
      1
    );
    expect(out()).toContain("[min-hit-rate]");
    expect(JSON.parse(readFileSync(path, "utf8")).calls).toBe(18);
  });

  it("fixed vs a baseline from fixed passes and prints current vs baseline", async () => {
    const { io, out } = createIo();
    expect(await run(["check", FIXED, "--baseline", baselinePath], io)).toBe(0);
    expect(out()).toContain("PASS");
    expect(out()).toContain("hit rate:      86.0% (baseline 86.0%, delta +0.0 points");
    expect(out()).toContain("wasted/1k:     $0.0000 per 1k calls (baseline $0.0000");
  });

  it("naive vs a baseline from fixed fails with exit 1 and both regressions", async () => {
    const { io, out } = createIo();
    expect(await run(["check", NAIVE, "--baseline", baselinePath], io)).toBe(1);
    expect(out()).toContain("FAIL");
    expect(out()).toContain("[hit-rate-drop]");
    expect(out()).toContain("[wasted-increase]");
    expect(out()).toContain("delta -47.0 points");
  });

  it("naive passes when both tolerances are large enough", async () => {
    const { io, out } = createIo();
    const args = ["--max-hit-rate-drop", "50", "--max-wasted-increase-usd", "3"];
    expect(await run(["check", NAIVE, "--baseline", baselinePath, ...args], io)).toBe(0);
    expect(out()).toContain("PASS");
  });

  it("one tolerance alone leaves the other at its default of 0", async () => {
    const { io, out } = createIo();
    const args = ["--baseline", baselinePath, "--max-hit-rate-drop", "50"];
    expect(await run(["check", NAIVE, ...args], io)).toBe(1);
    expect(out()).not.toContain("[hit-rate-drop]");
    expect(out()).toContain("[wasted-increase]");
  });

  it("--json adds current, baseline, deltas and tolerances while keeping the existing fields", async () => {
    const { io, out } = createIo();
    expect(await run(["check", NAIVE, "--baseline", baselinePath, "--json"], io)).toBe(1);
    const parsed = JSON.parse(out());
    expect(parsed).toMatchObject({
      passed: false,
      callCount: 18,
      findingsCount: 15,
      totalCostUsd: expect.any(Number),
      totalWastedUsd: expect.any(Number),
      hitRate: expect.closeTo(0.3894, 4),
      warnings: []
    });
    expect(parsed.current).toEqual({
      calls: 18,
      hitRate: parsed.hitRate,
      totalUsd: parsed.totalCostUsd,
      wastedUsd: parsed.totalWastedUsd,
      wastedUsdPer1kCalls: expect.closeTo((parsed.totalWastedUsd / 18) * 1000, 10)
    });
    expect(parsed.baseline).toEqual(JSON.parse(readFileSync(baselinePath, "utf8")));
    expect(parsed.deltas.hitRatePoints).toBeCloseTo(-47.01, 1);
    expect(parsed.deltas.wastedUsdPer1kCalls).toBeCloseTo(parsed.current.wastedUsdPer1kCalls, 10);
    expect(parsed.tolerances).toEqual({ maxHitRateDropPoints: 0, maxWastedIncreaseUsdPer1k: 0 });
    expect(parsed.violations.map((v: { kind: string }) => v.kind)).toEqual([
      "hit-rate-drop",
      "wasted-increase"
    ]);
  });

  it("--json without --baseline has current metrics and no baseline fields", async () => {
    const { io, out } = createIo();
    expect(await run(["check", FIXED, "--json"], io)).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed.current.calls).toBe(18);
    expect(parsed).not.toHaveProperty("baseline");
    expect(parsed).not.toHaveProperty("deltas");
  });

  it("warns when the baseline was priced with a different pricing table", async () => {
    const stale = join(dir, "stale.json");
    const artifact = JSON.parse(readFileSync(baselinePath, "utf8"));
    writeFileSync(stale, JSON.stringify({ ...artifact, pricingAsOf: "2025-01-01" }));
    const { io, out, err } = createIo();
    expect(await run(["check", FIXED, "--baseline", stale, "--json"], io)).toBe(0);
    expect(err()).toContain("priced as of 2025-01-01");
    expect(JSON.parse(out()).warnings).toEqual([expect.stringContaining("2025-01-01")]);
  });

  describe("an unusable baseline exits 2 naming the file", () => {
    it.each([
      ["wrong version", JSON.stringify({ version: 2 }), "unsupported version 2"],
      ["missing field", JSON.stringify({ version: 1, generatedAt: "x" }), '"pricingAsOf"'],
      ["invalid JSON", "{not json", "not valid JSON"]
    ])("%s", async (_label, content, reason) => {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, content);
      const { io, out, err } = createIo();
      expect(await run(["check", FIXED, "--baseline", bad], io)).toBe(2);
      expect(err()).toContain(bad);
      expect(err()).toContain(reason);
      expect(out()).toBe("");
    });

    it("missing file", async () => {
      const missing = join(dir, "missing.json");
      const { io, err } = createIo();
      expect(await run(["check", FIXED, "--baseline", missing], io)).toBe(2);
      expect(err()).toContain(missing);
    });
  });

  it.each([["--max-hit-rate-drop"], ["--max-wasted-increase-usd"]])(
    "%s without --baseline exits 2",
    async (flag) => {
      const { io, err } = createIo();
      expect(await run(["check", FIXED, flag, "1"], io)).toBe(2);
      expect(err()).toContain(`${flag} requires --baseline`);
    }
  );
});

describe("check --baseline on a model without pricing", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cachelens-baseline-unpriced-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an unknown model id cannot disarm the baseline dollar gate", async () => {
    const baselinePath = join(dir, "fixed-baseline.json");
    expect(await run(["check", FIXED, "--write-baseline", baselinePath], createIo().io)).toBe(0);
    const unpriced = join(dir, "naive-unpriced.jsonl");
    const lines = readFileSync(NAIVE, "utf8").trim().split("\n");
    writeFileSync(
      unpriced,
      `${lines
        .map((line) => {
          const call = JSON.parse(line);
          return JSON.stringify({ ...call, params: { ...call.params, model: "claude-unknown-9" } });
        })
        .join("\n")}\n`,
      "utf8"
    );
    const { io, out } = createIo();
    const code = await run(
      [
        "check",
        unpriced,
        "--baseline",
        baselinePath,
        "--max-wasted-increase-usd",
        "0",
        "--max-hit-rate-drop",
        "100",
        "--json"
      ],
      io
    );
    expect(code).toBe(1);
    const json = JSON.parse(out());
    expect(json.passed).toBe(false);
    expect(json.violations.map((v: { kind: string }) => v.kind)).toEqual(["unpriced-waste"]);
  });
});
