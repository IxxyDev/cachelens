import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureDistBuilt } from "../e2e/build-dist.js";

const ROOT = resolve(import.meta.dirname, "../..");
const BIN = join(ROOT, "dist/cli/index.js");

/**
 * Runs the built CLI the way npm installs it: through a symlink (npm `bin` entries are symlinks,
 * so process.argv[1] differs from the module's own resolved path).
 */
describe("built bin entry invoked through a symlink", () => {
  let dir: string;
  let link: string;
  beforeAll(() => {
    ensureDistBuilt();
    dir = mkdtempSync(join(tmpdir(), "cachelens-bin-"));
    link = join(dir, "cachelens");
    symlinkSync(BIN, link);
  }, 120_000);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--help prints usage and exits 0", () => {
    const result = spawnSync(process.execPath, [link, "--help"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("cachelens <command>");
  });

  it("check on the fixed demo fixture passes the 80% gate", () => {
    const result = spawnSync(
      process.execPath,
      [link, "check", "fixtures/demo-agent/fixed.jsonl", "--min-hit-rate", "80"],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
  });

  it("check on the naive demo fixture fails through the symlink (the gate is live)", () => {
    const result = spawnSync(
      process.execPath,
      [link, "check", "fixtures/demo-agent/naive.jsonl", "--min-hit-rate", "80"],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL");
  });

  it("help output matches the README usage block verbatim", () => {
    const help = execFileSync(process.execPath, [link, "help"], { encoding: "utf8" });
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const block = readme.match(
      /<!-- cli-help:start -->\n```text\n([\s\S]*?)```\n<!-- cli-help:end -->/
    );
    expect(block?.[1]).toBe(help);
  });
});
