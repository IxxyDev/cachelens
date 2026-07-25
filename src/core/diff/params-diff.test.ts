import { describe, expect, it } from "vitest";
import { diffParams } from "./params-diff.js";
describe("diffParams", () => {
  it("returns 'none' when params are unchanged", () => {
    expect(diffParams({ model: "claude-sonnet-4-5" }, { model: "claude-sonnet-4-5" })).toBe("none");
  });
  it("returns 'all' on a model change", () => {
    expect(diffParams({ model: "claude-sonnet-4-5" }, { model: "claude-opus-4-5" })).toBe("all");
  });
  it("returns 'system-and-messages' on a thinking change, surviving tools", () => {
    expect(
      diffParams(
        { model: "claude-sonnet-4-5", thinking: false },
        { model: "claude-sonnet-4-5", thinking: true }
      )
    ).toBe("system-and-messages");
  });
  it("returns 'system-and-messages' on a tool_choice change", () => {
    expect(
      diffParams(
        { model: "claude-sonnet-4-5", toolChoice: "auto" },
        { model: "claude-sonnet-4-5", toolChoice: "any" }
      )
    ).toBe("system-and-messages");
  });
  it("returns 'system-and-messages' on a thinking budget_tokens change alone (thinking stays enabled both times)", () => {
    expect(
      diffParams(
        { model: "claude-sonnet-4-5", thinking: true, thinkingBudgetTokens: 8000 },
        { model: "claude-sonnet-4-5", thinking: true, thinkingBudgetTokens: 16000 }
      )
    ).toBe("system-and-messages");
  });
  it("returns 'none' when budget_tokens is unset on both sides", () => {
    expect(
      diffParams(
        { model: "claude-sonnet-4-5", thinking: true },
        { model: "claude-sonnet-4-5", thinking: true }
      )
    ).toBe("none");
  });
  it("returns 'system-and-messages' on a speed change", () => {
    expect(
      diffParams(
        { model: "claude-sonnet-4-5", speed: "standard" },
        { model: "claude-sonnet-4-5", speed: "fast" }
      )
    ).toBe("system-and-messages");
  });
  it("returns 'system-and-messages' when images newly appear", () => {
    expect(
      diffParams(
        { model: "claude-sonnet-4-5" },
        { model: "claude-sonnet-4-5", imagesPresent: true }
      )
    ).toBe("system-and-messages");
  });
  it("returns 'system-and-messages' when citations toggle on", () => {
    expect(
      diffParams(
        { model: "claude-sonnet-4-5", citationsEnabled: false },
        { model: "claude-sonnet-4-5", citationsEnabled: true }
      )
    ).toBe("system-and-messages");
  });
  it("returns 'none' when speed/images/citations are all unchanged", () => {
    expect(
      diffParams(
        { model: "claude-sonnet-4-5", speed: "fast", imagesPresent: true, citationsEnabled: true },
        { model: "claude-sonnet-4-5", speed: "fast", imagesPresent: true, citationsEnabled: true }
      )
    ).toBe("none");
  });
});
