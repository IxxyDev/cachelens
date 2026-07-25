import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider.js";
describe("resolveProvider", () => {
  it("defaults to anthropic when provider is absent (back-compat with traces recorded before the provider field existed)", () => {
    expect(resolveProvider({})).toBe("anthropic");
  });
  it("defaults to anthropic when provider is explicitly undefined", () => {
    expect(resolveProvider({ provider: undefined })).toBe("anthropic");
  });
  it("returns anthropic when explicitly set", () => {
    expect(resolveProvider({ provider: "anthropic" })).toBe("anthropic");
  });
  it("returns openai when explicitly set", () => {
    expect(resolveProvider({ provider: "openai" })).toBe("openai");
  });
});
