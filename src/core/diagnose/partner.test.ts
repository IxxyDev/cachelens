import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import type { Provider } from "../model/provider.js";
import { tokenCount } from "../model/types.js";
import {
  MAX_PARTNER_CANDIDATES,
  type PartnerCache,
  type PartnerStats,
  selectPartner
} from "./partner.js";

const MINUTE_MS = 60 * 1000;

function makeCall(params: {
  readonly id: string;
  readonly timestamp: number;
  readonly system: string;
  readonly model?: string;
  readonly provider?: Provider;
  readonly ttl?: "5m" | "1h";
  readonly messages?: readonly string[];
}): LlmCall {
  const cacheControl = params.ttl
    ? { type: "ephemeral", ...(params.ttl === "1h" ? { ttl: "1h" } : {}) }
    : undefined;
  return {
    id: params.id,
    sessionId: "s",
    stepName: "step",
    timestamp: params.timestamp,
    params: { model: params.model ?? "claude-sonnet-4-5" },
    payload: {
      wireBody: JSON.stringify({
        tools: [],
        system: [
          {
            type: "text",
            text: params.system,
            ...(cacheControl ? { cache_control: cacheControl } : {})
          }
        ],
        messages: (params.messages ?? []).map((content) => ({ role: "user", content }))
      })
    },
    usage: {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(0),
      cacheReadInputTokens: tokenCount(0)
    },
    ...(params.provider ? { provider: params.provider } : {})
  };
}

describe("selectPartner", () => {
  it("returns undefined for a cold start (no earlier calls)", () => {
    const current = makeCall({ id: "c", timestamp: 0, system: "abc" });
    expect(selectPartner(current, [])).toBeUndefined();
  });

  it("prefers a same-model call over a more similar call on another model", () => {
    const sameModel = makeCall({ id: "same", timestamp: 0, system: "shared prefix, then A" });
    const otherModel = makeCall({
      id: "other",
      timestamp: MINUTE_MS,
      system: "shared prefix, then B and more",
      model: "claude-haiku-4-5"
    });
    const current = makeCall({
      id: "c",
      timestamp: 2 * MINUTE_MS,
      system: "shared prefix, then B and more!"
    });
    expect(selectPartner(current, [sameModel, otherModel])?.id).toBe("same");
  });

  it("returns undefined when only other-model or other-provider calls exist", () => {
    const otherModel = makeCall({ id: "m", timestamp: 0, system: "x", model: "claude-haiku-4-5" });
    const otherProvider = makeCall({ id: "p", timestamp: 0, system: "x", provider: "openai" });
    const current = makeCall({ id: "c", timestamp: MINUTE_MS, system: "x" });
    expect(selectPartner(current, [otherModel, otherProvider])).toBeUndefined();
  });

  it("keeps a 5m-TTL candidate older than 5 minutes: expiry is judged against the partner", () => {
    const fiveMinute = makeCall({ id: "5m", timestamp: 0, system: "same text", ttl: "5m" });
    const current = makeCall({ id: "c", timestamp: 6 * MINUTE_MS, system: "same text" });
    expect(selectPartner(current, [fiveMinute])?.id).toBe("5m");
  });

  it("excludes a candidate older than one hour, whatever its TTL", () => {
    const oneHour = makeCall({ id: "1h", timestamp: 0, system: "same text", ttl: "1h" });
    const current = makeCall({ id: "c", timestamp: 61 * MINUTE_MS, system: "same text" });
    expect(selectPartner(current, [oneHour])).toBeUndefined();
  });

  it("picks the longest common prefix over the most recent call", () => {
    const stepA = makeCall({ id: "a", timestamp: 0, system: "plan: long shared instructions v1" });
    const stepB = makeCall({ id: "b", timestamp: MINUTE_MS, system: "summarize: other" });
    const current = makeCall({
      id: "c",
      timestamp: 2 * MINUTE_MS,
      system: "plan: long shared instructions v1 extended"
    });
    expect(selectPartner(current, [stepA, stepB])?.id).toBe("a");
  });

  it("breaks a tie in prefix length in favour of the most recent call", () => {
    const older = makeCall({ id: "older", timestamp: 0, system: "same text A" });
    const newer = makeCall({ id: "newer", timestamp: MINUTE_MS, system: "same text B" });
    const current = makeCall({ id: "c", timestamp: 2 * MINUTE_MS, system: "same text C" });
    expect(selectPartner(current, [older, newer])?.id).toBe("newer");
  });

  it("serializes each call once per cache", () => {
    const earlier = makeCall({ id: "e", timestamp: 0, system: "x" });
    const current = makeCall({ id: "c", timestamp: MINUTE_MS, system: "x" });
    const cache: PartnerCache = new Map();
    selectPartner(current, [earlier], cache);
    const cachedEntry = cache.get(earlier);
    selectPartner(current, [earlier], cache);
    expect(cache.size).toBe(2);
    expect(cache.get(earlier)).toBe(cachedEntry);
  });

  it("skips an unparseable candidate and returns undefined for an unparseable current call", () => {
    const good = makeCall({ id: "good", timestamp: 0, system: "same text" });
    const bad: LlmCall = {
      ...makeCall({ id: "bad", timestamp: MINUTE_MS, system: "x" }),
      payload: { wireBody: "{not json" }
    };
    const current = makeCall({ id: "c", timestamp: 2 * MINUTE_MS, system: "same text" });
    const cache: PartnerCache = new Map();
    expect(selectPartner(current, [good, bad], cache)?.id).toBe("good");
    expect(cache.get(bad)).toBeNull();
    expect(selectPartner(bad, [good], cache)).toBeUndefined();
  });

  it("stops at the newest candidate whose whole text is a prefix of the current one", () => {
    const oldest = makeCall({ id: "oldest", timestamp: 0, system: "s", messages: ["q1"] });
    const previous = makeCall({
      id: "previous",
      timestamp: MINUTE_MS,
      system: "s",
      messages: ["q1", "q2"]
    });
    const current = makeCall({
      id: "c",
      timestamp: 2 * MINUTE_MS,
      system: "s",
      messages: ["q1", "q2", "q3"]
    });
    const cache: PartnerCache = new Map();
    expect(selectPartner(current, [oldest, previous], cache)?.id).toBe("previous");
    expect(cache.has(oldest)).toBe(false);
  });

  it(`compares at most the ${MAX_PARTNER_CANDIDATES} most recent same-model candidates`, () => {
    const best = makeCall({ id: "best", timestamp: 0, system: "shared long prefix: X" });
    const recent = Array.from({ length: MAX_PARTNER_CANDIDATES }, (_, i) =>
      makeCall({ id: `r${i}`, timestamp: 1000 + i, system: `shared ${i}` })
    );
    const otherModel = Array.from({ length: 10 }, (_, i) =>
      makeCall({ id: `m${i}`, timestamp: 500 + i, system: "x", model: "claude-haiku-4-5" })
    );
    const current = makeCall({ id: "c", timestamp: MINUTE_MS, system: "shared long prefix: Y" });
    const stats: PartnerStats = { comparisons: 0 };
    expect(selectPartner(current, [best, ...recent], new Map(), stats)?.id).not.toBe("best");
    expect(stats.comparisons).toBe(MAX_PARTNER_CANDIDATES);
    expect(selectPartner(current, [best, ...otherModel, ...recent.slice(1)])?.id).toBe("best");
  });

  it("does at most one comparison per call on a long linear session (1000 growing calls)", () => {
    const calls: LlmCall[] = [];
    const messages: string[] = [];
    for (let i = 0; i < 1000; i++) {
      messages.push(`turn ${i}: ${"lorem ipsum ".repeat(20)}`);
      calls.push(
        makeCall({ id: `t${i}`, timestamp: i * 1000, system: "stable", messages: [...messages] })
      );
    }
    const cache: PartnerCache = new Map();
    const stats: PartnerStats = { comparisons: 0 };
    for (let i = 1; i < calls.length; i++) {
      const current = calls[i];
      if (!current) continue;
      expect(selectPartner(current, calls.slice(0, i), cache, stats)?.id).toBe(`t${i - 1}`);
    }
    // Each call's previous turn is a full prefix of it, so the scan stops after one comparison.
    expect(stats.comparisons).toBe(calls.length - 1);
    // Every call is serialized exactly once.
    expect(cache.size).toBe(calls.length);
  });
});
