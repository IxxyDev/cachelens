import { describe, expect, it } from "vitest";
import type { LlmCall } from "../model/call.js";
import { tokenCount } from "../model/types.js";
import { noCorroborationAdapter } from "./corroboration.js";
function makeCall(): LlmCall {
  return {
    id: "call-1",
    sessionId: "s",
    stepName: "step",
    timestamp: 0,
    params: { model: "claude-sonnet-4-5" },
    payload: { wireBody: "{}" },
    usage: {
      inputTokens: tokenCount(0),
      outputTokens: tokenCount(0),
      cacheCreationInputTokens: tokenCount(0),
      cacheReadInputTokens: tokenCount(0)
    }
  };
}
describe("noCorroborationAdapter", () => {
  it("always resolves to undefined — absence, not contradiction", async () => {
    await expect(
      noCorroborationAdapter.corroborate(makeCall(), "dynamic-prefix-content")
    ).resolves.toBeUndefined();
  });
});
