import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CLI_ENTRY, ensureDistBuilt } from "./build-dist.js";

const ROOT = resolve(import.meta.dirname, "../..");

/** Runs the built CLI as a separate process, exactly as CI and users do. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: ROOT,
    encoding: "utf8"
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("built CLI (node dist/cli/index.js) on the demo fixtures", () => {
  beforeAll(() => ensureDistBuilt(), 120_000);

  it("diagnose on the naive trace exits 1 and reports at least one finding", () => {
    const { status, stdout } = cli("diagnose", "fixtures/demo-agent/naive.jsonl", "--json");
    expect(status).toBe(1);
    const report = JSON.parse(stdout) as { findingCount: number; findings: unknown[] };
    expect(report.findingCount).toBeGreaterThanOrEqual(1);
    expect(report.findings).toHaveLength(report.findingCount);
  });

  it("diagnose on the naive trace exits 1 in text mode too", () => {
    const { status, stdout } = cli("diagnose", "fixtures/demo-agent/naive.jsonl");
    expect(status).toBe(1);
    expect(stdout).toMatch(/^cachelens diagnose — \d+ findings?/);
  });

  it.each(["interleaved", "out-of-order"])("diagnose finds nothing in the %s trace", (name) => {
    const { status, stdout } = cli("diagnose", `fixtures/demo-agent/${name}.jsonl`, "--json");
    expect(status).toBe(0);
    expect((JSON.parse(stdout) as { findingCount: number }).findingCount).toBe(0);
  });

  it("check on the fixed trace passes an 80% hit-rate gate (exit 0)", () => {
    const { status, stdout } = cli(
      "check",
      "fixtures/demo-agent/fixed.jsonl",
      "--min-hit-rate",
      "80"
    );
    expect(status).toBe(0);
    expect(stdout).toContain("PASS");
  });

  it("report --json on the fixed trace prints parseable JSON with a hitRate", () => {
    const { status, stdout } = cli("report", "fixtures/demo-agent/fixed.jsonl", "--json");
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as { hitRate: unknown; callCount: unknown };
    expect(typeof report.hitRate).toBe("number");
    expect(report.hitRate).toBeGreaterThan(0.8);
    expect(report.callCount).toBeGreaterThan(0);
  });

  it("check rejects a hex --min-hit-rate as a usage error (exit 2)", () => {
    const { status, stdout, stderr } = cli(
      "check",
      "fixtures/demo-agent/fixed.jsonl",
      "--min-hit-rate",
      "0x10"
    );
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--min-hit-rate");
  });
});
