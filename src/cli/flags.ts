export type CommandName = "report" | "diagnose" | "check" | "proxy";

export type FlagName =
  | "--json"
  | "--html"
  | "--max-wasted-usd"
  | "--min-hit-rate"
  | "--baseline"
  | "--write-baseline"
  | "--max-hit-rate-drop"
  | "--max-wasted-increase-usd"
  | "--port"
  | "--host"
  | "--upstream"
  | "--session"
  | "--raw";

/** The single source of truth for which options each command accepts. */
export const COMMAND_FLAGS: Readonly<Record<CommandName, readonly FlagName[]>> = {
  report: ["--json", "--html"],
  diagnose: ["--json"],
  check: [
    "--json",
    "--max-wasted-usd",
    "--min-hit-rate",
    "--baseline",
    "--write-baseline",
    "--max-hit-rate-drop",
    "--max-wasted-increase-usd"
  ],
  proxy: ["--port", "--host", "--upstream", "--session", "--raw"]
};

/** Option pairs that a command accepts individually but not together. */
const INCOMPATIBLE_FLAGS: readonly (readonly [FlagName, FlagName])[] = [["--html", "--json"]];

/** Options that only mean something alongside another option: [dependent, required]. */
const DEPENDENT_FLAGS: readonly (readonly [FlagName, FlagName])[] = [
  ["--max-hit-rate-drop", "--baseline"],
  ["--max-wasted-increase-usd", "--baseline"]
];

export interface ParsedFlags {
  readonly positional: string[];
  readonly json: boolean;
  readonly html?: string;
  readonly maxWastedUsd?: number;
  readonly minHitRatePercent?: number;
  readonly baseline?: string;
  readonly writeBaseline?: string;
  readonly maxHitRateDropPoints?: number;
  readonly maxWastedIncreaseUsd?: number;
  readonly port?: number;
  readonly upstream?: string;
  readonly host?: string;
  readonly session?: string;
  readonly raw: boolean;
}

export type ParseResult =
  | { readonly ok: true; readonly flags: ParsedFlags }
  | { readonly ok: false; readonly error: string };

interface NumberFlagConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

/** Plain decimal only: rejects "", " ", "0x10", "1e3", "Infinity" that Number() would accept. */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function parseNumberFlag(
  name: string,
  value: string | undefined,
  constraints: NumberFlagConstraints = {}
): number | { error: string } {
  if (value === undefined || !DECIMAL_RE.test(value)) {
    const got = value === undefined ? "nothing" : JSON.stringify(value);
    return { error: `${name} requires a decimal number argument, got ${got}` };
  }
  const parsed = Number(value);
  if (constraints.integer === true && !Number.isInteger(parsed)) {
    return { error: `${name} requires an integer argument` };
  }
  if (constraints.min !== undefined && constraints.max !== undefined) {
    if (parsed < constraints.min || parsed > constraints.max) {
      return { error: `${name} must be between ${constraints.min} and ${constraints.max}` };
    }
  } else if (constraints.min !== undefined && parsed < constraints.min) {
    return { error: `${name} must be at least ${constraints.min}` };
  }
  return parsed;
}

function isFlagName(arg: string): arg is FlagName {
  return Object.values(COMMAND_FLAGS).some((flags) => flags.includes(arg as FlagName));
}

export function parseFlags(command: CommandName, args: readonly string[]): ParseResult {
  const allowed = COMMAND_FLAGS[command];
  const seen = new Set<FlagName>();
  const positional: string[] = [];
  let json = false;
  let raw = false;
  let html: string | undefined;
  let maxWastedUsd: number | undefined;
  let minHitRatePercent: number | undefined;
  let baseline: string | undefined;
  let writeBaseline: string | undefined;
  let maxHitRateDropPoints: number | undefined;
  let maxWastedIncreaseUsd: number | undefined;
  let port: number | undefined;
  let upstream: string | undefined;
  let host: string | undefined;
  let session: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!isFlagName(arg) || !allowed.includes(arg)) {
      return {
        ok: false,
        error: `unknown option for ${command}: ${arg} (accepted: ${allowed.join(", ")})`
      };
    }
    seen.add(arg);
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--raw":
        raw = true;
        break;
      case "--html": {
        const value = args[++i];
        if (value === undefined || value.startsWith("--")) {
          return { ok: false, error: "--html requires a path argument" };
        }
        html = value;
        break;
      }
      case "--baseline":
      case "--write-baseline": {
        const value = args[++i];
        if (value === undefined || value.startsWith("--") || value.length === 0) {
          return { ok: false, error: `${arg} requires a path argument` };
        }
        if (arg === "--baseline") baseline = value;
        else writeBaseline = value;
        break;
      }
      case "--upstream": {
        const value = args[++i];
        if (value === undefined || value.startsWith("--")) {
          return { ok: false, error: "--upstream requires a URL argument" };
        }
        upstream = value;
        break;
      }
      case "--host": {
        const value = args[++i];
        if (value === undefined || value.startsWith("--")) {
          return { ok: false, error: "--host requires an address argument" };
        }
        host = value;
        break;
      }
      case "--session": {
        const value = args[++i];
        if (value === undefined || value.startsWith("--") || value.length === 0) {
          return { ok: false, error: "--session requires an id argument" };
        }
        session = value;
        break;
      }
      case "--max-wasted-usd": {
        const result = parseNumberFlag(arg, args[++i], { min: 0 });
        if (typeof result === "object") return { ok: false, error: result.error };
        maxWastedUsd = result;
        break;
      }
      case "--min-hit-rate": {
        const result = parseNumberFlag(arg, args[++i], { min: 0, max: 100 });
        if (typeof result === "object") return { ok: false, error: result.error };
        minHitRatePercent = result;
        break;
      }
      case "--max-hit-rate-drop": {
        const result = parseNumberFlag(arg, args[++i], { min: 0, max: 100 });
        if (typeof result === "object") return { ok: false, error: result.error };
        maxHitRateDropPoints = result;
        break;
      }
      case "--max-wasted-increase-usd": {
        const result = parseNumberFlag(arg, args[++i], { min: 0 });
        if (typeof result === "object") return { ok: false, error: result.error };
        maxWastedIncreaseUsd = result;
        break;
      }
      case "--port": {
        const result = parseNumberFlag(arg, args[++i], { min: 0, max: 65535, integer: true });
        if (typeof result === "object") return { ok: false, error: result.error };
        port = result;
        break;
      }
    }
  }
  for (const [a, b] of INCOMPATIBLE_FLAGS) {
    if (seen.has(a) && seen.has(b)) {
      return { ok: false, error: `incompatible options: ${a} and ${b} cannot be used together` };
    }
  }
  for (const [dependent, required] of DEPENDENT_FLAGS) {
    if (seen.has(dependent) && !seen.has(required)) {
      return { ok: false, error: `${dependent} requires ${required}` };
    }
  }
  return {
    ok: true,
    flags: {
      positional,
      json,
      raw,
      ...(html !== undefined ? { html } : {}),
      ...(maxWastedUsd !== undefined ? { maxWastedUsd } : {}),
      ...(minHitRatePercent !== undefined ? { minHitRatePercent } : {}),
      ...(baseline !== undefined ? { baseline } : {}),
      ...(writeBaseline !== undefined ? { writeBaseline } : {}),
      ...(maxHitRateDropPoints !== undefined ? { maxHitRateDropPoints } : {}),
      ...(maxWastedIncreaseUsd !== undefined ? { maxWastedIncreaseUsd } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(upstream !== undefined ? { upstream } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(session !== undefined ? { session } : {})
    }
  };
}
