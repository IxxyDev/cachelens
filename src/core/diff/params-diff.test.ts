import { describe, expect, it } from "vitest";
import type { RequestParams } from "../model/call.js";
import {
  buildCanonicalRequest,
  canonicalPrefixComparisonText
} from "../serialize/canonical-request.js";
import { tierAt } from "../serialize/segment-map.js";
import { diffParams } from "./params-diff.js";
import { diffPrefix } from "./prefix-diff.js";

const MODEL = "claude-sonnet-4-5";
function diff(previous: Omit<RequestParams, "model">, current: Omit<RequestParams, "model">) {
  return diffParams({ model: MODEL, ...previous }, { model: MODEL, ...current });
}
describe("diffParams", () => {
  it("returns 'none' when params are unchanged", () => {
    expect(diff({}, {})).toBe("none");
  });
  it("model change -> 'all'", () => {
    expect(diffParams({ model: MODEL }, { model: "claude-opus-4-5" })).toBe("all");
  });
  it("inference_geo change -> 'all' (not in vendor table, conservative)", () => {
    expect(diff({ inferenceGeo: "us" }, { inferenceGeo: "global" })).toBe("all");
  });
  it("tool definitions are not a param: they diverge the canonical tools tier instead", () => {
    const previous = buildCanonicalRequest(
      JSON.stringify({ model: MODEL, tools: [{ name: "a" }], system: "s", messages: [] })
    );
    const current = buildCanonicalRequest(
      JSON.stringify({ model: MODEL, tools: [{ name: "b" }], system: "s", messages: [] })
    );
    expect(diff({}, {})).toBe("none");
    const prefix = diffPrefix(
      canonicalPrefixComparisonText(previous),
      canonicalPrefixComparisonText(current)
    );
    expect(prefix.identical).toBe(false);
    expect(tierAt(current.segments, prefix.divergenceByteOffset)).toBe("tools");
  });
  it("web_search tool toggled -> 'system-and-messages'", () => {
    expect(diff({}, { webSearchEnabled: true })).toBe("system-and-messages");
  });
  it("citations toggled -> 'system-and-messages'", () => {
    expect(diff({ citationsEnabled: false }, { citationsEnabled: true })).toBe(
      "system-and-messages"
    );
  });
  it("speed change -> 'system-and-messages'", () => {
    expect(diff({ speed: "standard" }, { speed: "fast" })).toBe("system-and-messages");
  });
  it("thinking type change -> 'messages-maybe-upstream'", () => {
    expect(diff({ thinking: { type: "disabled" } }, { thinking: { type: "adaptive" } })).toBe(
      "messages-maybe-upstream"
    );
  });
  it("thinking budget_tokens change alone -> 'messages-maybe-upstream'", () => {
    expect(
      diff(
        { thinking: { type: "enabled", budgetTokens: 8000 } },
        { thinking: { type: "enabled", budgetTokens: 16000 } }
      )
    ).toBe("messages-maybe-upstream");
  });
  it("treats an absent thinking config as disabled", () => {
    expect(diff({}, { thinking: { type: "disabled" } })).toBe("none");
  });
  it("output_config.effort change -> 'messages-maybe-upstream'", () => {
    expect(diff({ effort: "high" }, { effort: "low" })).toBe("messages-maybe-upstream");
  });
  it("setting effort to the model default ('high') equals omitting it", () => {
    expect(diff({}, { effort: "high" })).toBe("none");
  });
  it("switching the forced tool name -> 'messages'", () => {
    expect(diff({ toolChoice: "tool:get_weather" }, { toolChoice: "tool:get_time" })).toBe(
      "messages"
    );
    expect(diff({ toolChoice: "tool:get_weather" }, { toolChoice: "tool:get_weather" })).toBe(
      "none"
    );
  });
  it("tool_choice change -> 'messages'", () => {
    expect(diff({ toolChoice: "auto" }, { toolChoice: "any" })).toBe("messages");
  });
  it("images added -> 'messages'", () => {
    expect(diff({}, { imagesPresent: true })).toBe("messages");
  });
  it("images removed -> 'messages'", () => {
    expect(diff({ imagesPresent: true }, {})).toBe("messages");
  });
  it("context_management change -> 'messages'", () => {
    expect(diff({}, { contextManagement: '{"edits":[]}' })).toBe("messages");
  });
  it("the broadest scope wins when several params change at once", () => {
    expect(
      diff({ toolChoice: "auto", speed: "standard" }, { toolChoice: "any", speed: "fast" })
    ).toBe("system-and-messages");
    expect(diff({ toolChoice: "auto", effort: "low" }, { toolChoice: "any", effort: "max" })).toBe(
      "messages-maybe-upstream"
    );
    expect(
      diffParams({ model: MODEL, speed: "standard" }, { model: "claude-opus-4-5", speed: "fast" })
    ).toBe("all");
  });
  it("returns 'none' when every param is unchanged", () => {
    const params: Omit<RequestParams, "model"> = {
      toolChoice: "auto",
      thinking: { type: "enabled", budgetTokens: 4000 },
      effort: "medium",
      contextManagement: "{}",
      inferenceGeo: "us",
      speed: "fast",
      imagesPresent: true,
      citationsEnabled: true,
      webSearchEnabled: true
    };
    expect(diff(params, { ...params, thinking: { type: "enabled", budgetTokens: 4000 } })).toBe(
      "none"
    );
  });
});
