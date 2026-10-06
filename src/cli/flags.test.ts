import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmCall } from "../core/model/call.js";
import { tokenCount } from "../core/model/types.js";
import { COMMAND_FLAGS, parseNumberFlag } from "./flags.js";
import { run } from "./index.js";

function makeCall(id: string, sessionId: string, timestamp: number, system: string): LlmCall {
  return {
    id,
    sessionId,
    stepName: "step",
    timestamp,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: JSON.stringify({ tools: [], system, messages: [] }) },
    usage: {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(500000),
      cacheReadInputTokens: tokenCount(0)
    }
  };
}

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

describe("parseNumberFlag", () => {
  it.each(["", " ", "0x10", "abc", "1e3", "Infinity", "1.", ".5", "+1"])(
    "rejects %j and names the flag",
    (value) => {
      const result = parseNumberFlag("--min-hit-rate", value);
      expect(result).toEqual({ error: expect.stringContaining("--min-hit-rate") });
    }
  );
  it.each([
    ["0", 0],
    ["80", 80],
    ["0.5", 0.5],
    ["-0", -0]
  ])("accepts %j", (value, expected) => {
    expect(parseNumberFlag("--max-wasted-usd", value)).toBe(expected);
  });
});

describe("cli numeric and per-command option validation", () => {
  let dir: string;
  let trace: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cachelens-flags-"));
    trace = join(dir, "t.jsonl");
    writeFileSync(trace, `${JSON.stringify(makeCall("1", "s", 0, "x"))}\n`, "utf8");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const flag of [
    "--min-hit-rate",
    "--max-wasted-usd",
    "--max-hit-rate-drop",
    "--max-wasted-increase-usd"
  ]) {
    for (const value of ["", " ", "0x10", "abc", "-1"]) {
      it(`check ${flag} ${JSON.stringify(value)} exits 2 naming the flag`, async () => {
        const { io, out, err } = createIo();
        const args = ["check", trace, "--baseline", join(dir, "b.json"), flag, value];
        expect(await run(args, io)).toBe(2);
        expect(err()).toContain(flag);
        expect(out()).toBe("");
      });
    }
  }

  it.each([["--baseline"], ["--write-baseline"]])(
    "check %s without a path exits 2",
    async (flag) => {
      const { io, err } = createIo();
      expect(await run(["check", trace, flag], io)).toBe(2);
      expect(err()).toContain(`${flag} requires a path argument`);
    }
  );

  it("proxy --port 0x10 exits 2 naming the flag", async () => {
    const { io, err } = createIo();
    expect(await run(["proxy", join(dir, "o.jsonl"), "--port", "0x10"], io)).toBe(2);
    expect(err()).toContain("--port");
  });

  it.each([
    [["report", "--port", "1"]],
    [["check", "--html", "out.html"]],
    [["diagnose", "--min-hit-rate", "80"]],
    [["diagnose", "--raw"]],
    [["proxy", "--json"]],
    [["report", "--bogus"]]
  ])("%j exits 2 with unknown option", async (args) => {
    const [command, ...rest] = args;
    const { io, err } = createIo();
    const target = command === "proxy" ? join(dir, "o.jsonl") : trace;
    expect(await run([command as string, target, ...rest], io)).toBe(2);
    expect(err()).toContain("unknown option");
    expect(err()).toContain(rest[0] as string);
  });

  it("report --html together with --json exits 2 with incompatible options", async () => {
    const { io, err } = createIo();
    expect(await run(["report", trace, "--json", "--html", join(dir, "r.html")], io)).toBe(2);
    expect(err()).toContain("incompatible options");
  });

  it("proxy rejects a second positional output file", async () => {
    const { io, err } = createIo();
    expect(await run(["proxy", join(dir, "a.jsonl"), join(dir, "b.jsonl")], io)).toBe(2);
    expect(err()).toContain("Usage");
  });

  it("every allowlisted option is documented in help", async () => {
    const { io, out } = createIo();
    await run(["help"], io);
    for (const flags of Object.values(COMMAND_FLAGS)) {
      for (const flag of flags) {
        expect(out()).toContain(flag);
      }
    }
  });
});

describe("cli with multiple trace files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cachelens-multi-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  function write(name: string, lines: readonly string[]): string {
    const path = join(dir, name);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  }

  it("diagnose treats a session split across two files as one session", async () => {
    const first = write("a.jsonl", [JSON.stringify(makeCall("call-1", "s1", 0, "ts=1000"))]);
    const second = write("b.jsonl", [JSON.stringify(makeCall("call-2", "s1", 1000, "ts=2000"))]);
    const { io, out } = createIo();
    expect(await run(["diagnose", first, second, "--json"], io)).toBe(1);
    const json = JSON.parse(out());
    expect(json.callCount).toBe(2);
    expect(json.findingCount).toBe(1);
    expect(json.findings[0].sessionId).toBe("s1");
  });

  it("report counts calls from every file", async () => {
    const first = write("a.jsonl", [JSON.stringify(makeCall("1", "s1", 0, "x"))]);
    const second = write("b.jsonl", [JSON.stringify(makeCall("2", "s2", 0, "x"))]);
    const { io, out } = createIo();
    expect(await run(["report", first, second, "--json"], io)).toBe(0);
    expect(JSON.parse(out()).callCount).toBe(2);
  });

  it("check gates every file: a violation in the second file fails the run", async () => {
    const clean = write("a.jsonl", [JSON.stringify(makeCall("1", "s1", 0, "x"))]);
    const broken = write("b.jsonl", [JSON.stringify(makeCall("2", "s2", 0, "x")), "{not json"]);
    const { io, out, err } = createIo();
    expect(await run(["check", clean, broken, "--json"], io)).toBe(1);
    const json = JSON.parse(out());
    expect(json.callCount).toBe(2);
    expect(json.violations.map((v: { kind: string }) => v.kind)).toEqual(["invalid-records"]);
    expect(json.warnings).toEqual([expect.stringContaining(`${broken}:2`)]);
    expect(err()).toContain(`warning: ${broken}:2`);
  });

  it("a missing second file exits 2", async () => {
    const clean = write("a.jsonl", [JSON.stringify(makeCall("1", "s1", 0, "x"))]);
    const missing = join(dir, "missing.jsonl");
    const { io, err } = createIo();
    expect(await run(["check", clean, missing], io)).toBe(2);
    expect(err()).toContain(missing);
  });

  it("diagnose and report --json carry reader warnings, deduplicated", async () => {
    const path = write("a.jsonl", [
      JSON.stringify({ ...makeCall("1", "s1", 0, "x"), params: { model: "claude-unknown-9" } }),
      JSON.stringify({ ...makeCall("2", "s1", 1, "x"), params: { model: "claude-unknown-9" } }),
      "{not json"
    ]);
    for (const command of ["diagnose", "report"]) {
      const { io, out } = createIo();
      await run([command, path, "--json"], io);
      const { warnings } = JSON.parse(out()) as { warnings: string[] };
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(`${path}:3`);
      expect(warnings[1]).toContain('"claude-unknown-9"');
    }
  });
});
