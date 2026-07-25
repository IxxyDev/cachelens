import { describe, expect, it } from "vitest";
import { redactWireBody } from "./redact.js";
const SAMPLE_BODY = JSON.stringify({
  model: "claude-opus-4-8",
  system: [{ type: "text", text: "You are a helpful assistant with SECRET instructions." }],
  messages: [{ role: "user", content: [{ type: "text", text: "My SSN is 123-45-6789" }] }],
  tools: [{ name: "get_weather", description: "Get current weather" }]
});
describe("redactWireBody", () => {
  it("blanks string leaves under payload-carrying keys by default", () => {
    const redacted = redactWireBody(SAMPLE_BODY);
    const parsed = JSON.parse(redacted);
    expect(parsed.system[0].text).toBe("[REDACTED]");
    expect(parsed.messages[0].content[0].text).toBe("[REDACTED]");
  });
  it("preserves non-payload structure needed for diagnosis and reporting", () => {
    const redacted = redactWireBody(SAMPLE_BODY);
    const parsed = JSON.parse(redacted);
    expect(parsed.model).toBe("claude-opus-4-8");
    expect(parsed.system[0].type).toBe("text");
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.tools[0].name).toBe("get_weather");
  });
  it("returns the raw body unchanged when raw: true is passed", () => {
    expect(redactWireBody(SAMPLE_BODY, { raw: true })).toBe(SAMPLE_BODY);
  });
  it("returns a placeholder for unparseable input instead of throwing", () => {
    expect(() => redactWireBody("not json")).not.toThrow();
    expect(JSON.parse(redactWireBody("not json"))).toEqual({ redacted: "unparseable-body" });
  });
  it("blanks a plain-string system field (not just the array-of-blocks form)", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      system: "You are a helpful assistant with SECRET instructions.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
    const parsed = JSON.parse(redactWireBody(body));
    expect(parsed.system).toBe("[REDACTED]");
    expect(parsed.model).toBe("claude-opus-4-8");
  });
  it("blanks plain-string message content (the common non-block shape)", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "My SSN is 123-45-6789" }]
    });
    const parsed = JSON.parse(redactWireBody(body));
    expect(parsed.messages[0].content).toBe("[REDACTED]");
    expect(parsed.messages[0].role).toBe("user");
  });
  it("keeps traversing array-form system and content rather than blanking the container", () => {
    const parsed = JSON.parse(redactWireBody(SAMPLE_BODY));
    expect(Array.isArray(parsed.system)).toBe(true);
    expect(Array.isArray(parsed.messages[0].content)).toBe(true);
  });
  it("redacts nested tool_use input payloads", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "lookup", input: { query: "classified topic" } }]
        }
      ]
    });
    const parsed = JSON.parse(redactWireBody(body));
    expect(parsed.messages[0].content[0].input).toBe("[REDACTED]");
    expect(parsed.messages[0].content[0].name).toBe("lookup");
  });
});
