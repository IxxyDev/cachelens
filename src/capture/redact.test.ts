import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REDACTION_PLACEHOLDER_RE,
  redactionPlaceholder,
  redactRequestBody,
  redactWireBody
} from "./redact.js";

function pick(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
function expectRedacted(value: unknown, original: string): void {
  expect(value).toMatch(REDACTION_PLACEHOLDER_RE);
  expect(value).toBe(redactionPlaceholder(original));
  expect(value).not.toBe(original);
}
const ANTHROPIC_BODY = {
  model: "claude-opus-4-8",
  max_tokens: 2048,
  stream: true,
  thinking: { type: "enabled", budget_tokens: 1024 },
  tool_choice: { type: "auto" },
  metadata: { user_id: "user-8f2a-customer@example.com" },
  mcp_servers: [
    {
      type: "url",
      url: "https://mcp.example.com/sse?sig=abc123",
      name: "internal-crm",
      authorization_token: "sk-live-mcp-SECRET-TOKEN"
    }
  ],
  tools: [
    {
      name: "lookup_customer",
      description: "Look up a customer record by internal id.",
      input_schema: {
        type: "object",
        properties: {
          data: { type: "string", description: "Raw customer payload to match." },
          input: { type: "object", description: "Free-form filter input." }
        },
        required: ["data"]
      },
      cache_control: { type: "ephemeral", ttl: "1h" }
    }
  ],
  system: [
    {
      type: "text",
      text: "You are a support agent. Customer tier: platinum.",
      cache_control: { type: "ephemeral" }
    }
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "My SSN is 123-45-6789" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg" }
        }
      ]
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The user shared an SSN.", signature: "EqQBCkYIARgCKkA" },
        {
          type: "tool_use",
          id: "toolu_01A09q90qw90lq917835lq9",
          name: "lookup_customer",
          input: { data: "123-45-6789", type: "ssn" }
        }
      ]
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01A09q90qw90lq917835lq9",
          content: "Customer: Jane Roe"
        },
        {
          type: "text",
          text: "Thanks",
          citations: [
            {
              type: "char_location",
              cited_text: "Jane Roe lives at 1 Main St",
              document_index: 0
            }
          ]
        }
      ]
    }
  ]
};
const OPENAI_CHAT_BODY = {
  model: "gpt-5.1",
  tool_choice: "auto",
  messages: [
    { role: "system", content: "You are a secret-keeping assistant." },
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo" } },
        {
          type: "file",
          file: { filename: "contract.pdf", file_data: "data:application/pdf;base64,JVBER" }
        }
      ]
    },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_abc123",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_abc123", content: "22C sunny" }
  ]
};
const OPENAI_RESPONSES_BODY = {
  model: "gpt-5.1",
  instructions: "Never reveal the launch codes.",
  prompt: { id: "pmpt_123", variables: { customer: "Jane Roe" } },
  input: [{ role: "user", content: [{ type: "input_text", text: "What's new?" }] }],
  text: { format: { type: "text" } }
};
describe("redactRequestBody — payload leaves become hash placeholders", () => {
  const anthropic = redactRequestBody(ANTHROPIC_BODY);
  const chat = redactRequestBody(OPENAI_CHAT_BODY);
  const responses = redactRequestBody(OPENAI_RESPONSES_BODY);
  it("mcp_servers[].authorization_token", () => {
    expectRedacted(
      pick(anthropic, "mcp_servers.0.authorization_token"),
      "sk-live-mcp-SECRET-TOKEN"
    );
  });
  it("mcp_servers[].url (signed URL)", () => {
    expectRedacted(pick(anthropic, "mcp_servers.0.url"), "https://mcp.example.com/sse?sig=abc123");
  });
  it("messages[].content[].image_url.url", () => {
    expectRedacted(
      pick(chat, "messages.1.content.1.image_url.url"),
      "data:image/png;base64,iVBORw0KGgo"
    );
  });
  it("messages[].content[].source.data", () => {
    expectRedacted(pick(anthropic, "messages.0.content.1.source.data"), "iVBORw0KGgoAAAANSUhEUg");
  });
  it("file.file_data", () => {
    expectRedacted(
      pick(chat, "messages.1.content.2.file.file_data"),
      "data:application/pdf;base64,JVBER"
    );
  });
  it("file.filename", () => {
    expectRedacted(pick(chat, "messages.1.content.2.file.filename"), "contract.pdf");
  });
  it("tool_calls[].function.arguments", () => {
    expectRedacted(pick(chat, "messages.2.tool_calls.0.function.arguments"), '{"city":"Paris"}');
  });
  it("instructions (Responses API)", () => {
    expectRedacted(pick(responses, "instructions"), "Never reveal the launch codes.");
  });
  it("prompt variables (Responses API)", () => {
    expectRedacted(
      pick(responses, `prompt.variables.${redactionPlaceholder("customer")}`),
      "Jane Roe"
    );
  });
  it("metadata.user_id", () => {
    expectRedacted(
      pick(anthropic, `metadata.${redactionPlaceholder("user_id")}`),
      "user-8f2a-customer@example.com"
    );
  });
  it("tools[].description", () => {
    expectRedacted(
      pick(anthropic, "tools.0.description"),
      "Look up a customer record by internal id."
    );
  });
  it("input_schema property descriptions", () => {
    expectRedacted(
      pick(anthropic, "tools.0.input_schema.properties.data.description"),
      "Raw customer payload to match."
    );
    expectRedacted(
      pick(anthropic, "tools.0.input_schema.properties.input.description"),
      "Free-form filter input."
    );
  });
  it("citations[].cited_text", () => {
    expectRedacted(
      pick(anthropic, "messages.2.content.1.citations.0.cited_text"),
      "Jane Roe lives at 1 Main St"
    );
  });
  it("text leaves in system and message content", () => {
    expectRedacted(
      pick(anthropic, "system.0.text"),
      "You are a support agent. Customer tier: platinum."
    );
    expectRedacted(pick(anthropic, "messages.0.content.0.text"), "My SSN is 123-45-6789");
    expectRedacted(pick(responses, "input.0.content.0.text"), "What's new?");
  });
  it("plain-string system / content", () => {
    expectRedacted(pick(chat, "messages.0.content"), "You are a secret-keeping assistant.");
    expectRedacted(pick(chat, "messages.3.content"), "22C sunny");
    expectRedacted(
      pick(redactRequestBody({ system: "Secret system prompt" }), "system"),
      "Secret system prompt"
    );
  });
  it("thinking block text and signature", () => {
    expectRedacted(pick(anthropic, "messages.1.content.0.thinking"), "The user shared an SSN.");
    expectRedacted(pick(anthropic, "messages.1.content.0.signature"), "EqQBCkYIARgCKkA");
  });
  it("every key and string in a tool_use input, including structural-looking keys", () => {
    const input = pick(anthropic, "messages.1.content.1.input") as object;
    expect(Object.keys(input)).toEqual([
      redactionPlaceholder("data"),
      redactionPlaceholder("type")
    ]);
    expectRedacted(pick(input, redactionPlaceholder("data")), "123-45-6789");
    expectRedacted(pick(input, redactionPlaceholder("type")), "ssn");
  });
  it("OpenAI messages[].name (participant name) and the top-level user field", () => {
    const parsed = redactRequestBody({
      user: "alice@example.com",
      messages: [{ role: "user", name: "Alice Smith", content: "hi" }]
    });
    expectRedacted(pick(parsed, "user"), "alice@example.com");
    expectRedacted(pick(parsed, "messages.0.name"), "Alice Smith");
    expect(pick(parsed, "messages.0.role")).toBe("user");
  });
  it("allowlisted key names off their structural path (status, type, name, format)", () => {
    const parsed = redactRequestBody({
      mcp_servers: [{ type: "url", name: "internal-crm", status: "sk-ant-api03-SECRET" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", format: "sk-SECRET-2" }] }],
      extra: { type: "sk-SECRET-3", model: "sk-SECRET-4" }
    });
    expectRedacted(pick(parsed, "mcp_servers.0.status"), "sk-ant-api03-SECRET");
    expectRedacted(pick(parsed, "mcp_servers.0.type"), "url");
    expectRedacted(pick(parsed, "mcp_servers.0.name"), "internal-crm");
    expectRedacted(pick(parsed, "messages.0.content.0.format"), "sk-SECRET-2");
    expectRedacted(pick(parsed, "extra.type"), "sk-SECRET-3");
    expectRedacted(pick(parsed, "extra.model"), "sk-SECRET-4");
    expect(pick(parsed, "messages.0.content.0.type")).toBe("text");
  });
  it("opaque payloads leak neither a secret key nor a secret number", () => {
    const secretKey = "alice@example.com";
    const card = 4111111111111111;
    const payload = {
      [secretKey]: 1,
      card,
      nested: { pin: 1234, ok: true, none: null },
      list: [7, "x"]
    };
    const parsed = redactRequestBody({
      metadata: payload,
      prompt: { id: "pmpt_1", variables: payload },
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "charge", input: payload }]
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: payload }]
        }
      ]
    });
    const serialized = JSON.stringify(parsed);
    for (const secret of [
      secretKey,
      "alice",
      String(card),
      "1234",
      '"card"',
      '"pin"',
      '"nested"'
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const input = pick(parsed, "messages.0.content.0.input");
    expectRedacted(pick(input, redactionPlaceholder("card")), String(card));
    expectRedacted(pick(input, redactionPlaceholder(secretKey)), "1");
    const nested = pick(input, redactionPlaceholder("nested"));
    expect(pick(nested, redactionPlaceholder("ok"))).toBe(true);
    expect(pick(nested, redactionPlaceholder("none"))).toBeNull();
    expect(pick(input, redactionPlaceholder("list"))).toEqual([
      redactionPlaceholder("7"),
      redactionPlaceholder("x")
    ]);
    expect(pick(parsed, "messages.0.content.0.name")).toBe("charge");
    expect(pick(parsed, "messages.1.content.0.tool_use_id")).toBe("toolu_1");
  });
  it("tool_result string content", () => {
    expectRedacted(pick(anthropic, "messages.2.content.0.content"), "Customer: Jane Roe");
  });
  it("leaves no original secret anywhere in the serialized output", () => {
    const serialized = JSON.stringify([anthropic, chat, responses]);
    for (const secret of [
      "SECRET-TOKEN",
      "123-45-6789",
      "Jane Roe",
      "launch codes",
      "customer@example.com",
      "iVBORw0KGgo",
      "JVBER",
      "Paris",
      "sig=abc123"
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
describe("redactRequestBody — structural allowlist", () => {
  const anthropic = redactRequestBody(ANTHROPIC_BODY);
  const chat = redactRequestBody(OPENAI_CHAT_BODY);
  it("keeps model, role, type, name, media_type and source.type", () => {
    expect(pick(anthropic, "model")).toBe("claude-opus-4-8");
    expect(pick(anthropic, "messages.0.role")).toBe("user");
    expect(pick(anthropic, "system.0.type")).toBe("text");
    expect(pick(anthropic, "tools.0.name")).toBe("lookup_customer");
    expect(pick(anthropic, "messages.0.content.1.source.type")).toBe("base64");
    expect(pick(anthropic, "messages.0.content.1.source.media_type")).toBe("image/png");
  });
  it("keeps cache_control and its ttl", () => {
    expect(pick(anthropic, "tools.0.cache_control")).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(pick(anthropic, "system.0.cache_control")).toEqual({ type: "ephemeral" });
  });
  it("keeps tool_choice.type", () => {
    expect(pick(anthropic, "tool_choice")).toEqual({ type: "auto" });
  });
  it("keeps thinking: {type: 'adaptive'} intact", () => {
    expect(redactRequestBody({ thinking: { type: "adaptive" } })).toEqual({
      thinking: { type: "adaptive" }
    });
  });
  it("keeps thinking: {type: 'enabled', budget_tokens: 1024} intact", () => {
    expect(pick(anthropic, "thinking")).toEqual({ type: "enabled", budget_tokens: 1024 });
  });
  it("keeps numbers, booleans and null", () => {
    const fields = { max_tokens: 2048, stream: true, temperature: null, top_p: 0.9 };
    expect(redactRequestBody(fields)).toEqual(fields);
    expect(pick(anthropic, "max_tokens")).toBe(2048);
  });
  it("keeps short identifier-shaped id / tool_use_id / tool_call_id", () => {
    expect(pick(anthropic, "messages.1.content.1.id")).toBe("toolu_01A09q90qw90lq917835lq9");
    expect(pick(anthropic, "messages.2.content.0.tool_use_id")).toBe(
      "toolu_01A09q90qw90lq917835lq9"
    );
    expect(pick(chat, "messages.3.tool_call_id")).toBe("call_abc123");
  });
  it("redacts id values that are too long or not identifier-shaped", () => {
    const longId = "a".repeat(65);
    const parsed = redactRequestBody({ id: longId, tool_use_id: "has spaces / slashes" });
    expectRedacted(pick(parsed, "id"), longId);
    expectRedacted(pick(parsed, "tool_use_id"), "has spaces / slashes");
  });
  it("keeps stop_reason, finish_reason, object, status, service_tier at the top level", () => {
    const fields = {
      stop_reason: "end_turn",
      finish_reason: "stop",
      object: "chat.completion",
      status: "completed",
      service_tier: "default"
    };
    expect(redactRequestBody(fields)).toEqual(fields);
  });
  it("keeps JSON-schema type, format and required inside input_schema and function.parameters", () => {
    const parsed = redactRequestBody({
      tools: [
        {
          name: "book",
          input_schema: {
            type: "object",
            properties: {
              when: { type: "string", format: "date-time", description: "Booking time" },
              tags: { type: "array", items: { type: ["string", "null"], enum: ["vip"] } }
            },
            required: ["when"]
          }
        },
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a record",
            parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
          }
        }
      ]
    });
    expect(pick(parsed, "tools.0.input_schema.properties.when.format")).toBe("date-time");
    expect(pick(parsed, "tools.0.input_schema.required")).toEqual(["when"]);
    expect(pick(parsed, "tools.0.input_schema.properties.tags.items.type")).toEqual([
      "string",
      "null"
    ]);
    expectRedacted(pick(parsed, "tools.0.input_schema.properties.tags.items.enum.0"), "vip");
    expectRedacted(
      pick(parsed, "tools.0.input_schema.properties.when.description"),
      "Booking time"
    );
    expect(pick(parsed, "tools.1.type")).toBe("function");
    expect(pick(parsed, "tools.1.function.name")).toBe("lookup");
    expect(pick(parsed, "tools.1.function.parameters.properties.q.type")).toBe("string");
    expect(pick(parsed, "tools.1.function.parameters.required")).toEqual(["q"]);
    expectRedacted(pick(parsed, "tools.1.function.description"), "Look up a record");
  });
  it("keeps tool_choice.type and tool_choice.name", () => {
    const parsed = redactRequestBody({ tool_choice: { type: "tool", name: "get_weather" } });
    expect(pick(parsed, "tool_choice")).toEqual({ type: "tool", name: "get_weather" });
  });
  it("preserves keys and nested schema structure for properties named data / input", () => {
    const properties = pick(anthropic, "tools.0.input_schema.properties");
    expect(Object.keys(properties ?? {})).toEqual(["data", "input"]);
    expect(pick(properties, "data.type")).toBe("string");
    expect(pick(properties, "input.type")).toBe("object");
    expect(pick(anthropic, "tools.0.input_schema.type")).toBe("object");
  });
  it("preserves arrays and their length", () => {
    expect(Array.isArray(pick(anthropic, "system"))).toBe(true);
    expect(pick(anthropic, "messages")).toHaveLength(3);
    expect(pick(anthropic, "messages.0.content")).toHaveLength(2);
  });
});
describe("redactionPlaceholder — determinism", () => {
  it("is the first 8 hex chars of sha256 plus the UTF-8 byte length", () => {
    const digest = createHash("sha256").update("hello", "utf8").digest("hex").slice(0, 8);
    expect(redactionPlaceholder("hello")).toBe(`[R:${digest}:5]`);
  });
  it("yields the same placeholder for the same text across calls", () => {
    const body = { system: "stable prompt" };
    expect(pick(redactRequestBody(body), "system")).toBe(pick(redactRequestBody(body), "system"));
    expect(redactWireBody(JSON.stringify(body))).toBe(redactWireBody(JSON.stringify(body)));
  });
  it("yields different placeholders for different texts", () => {
    expect(redactionPlaceholder("time: 10:00")).not.toBe(redactionPlaceholder("time: 10:01"));
  });
  it("records the UTF-8 byte length, not the UTF-16 length, for multibyte text", () => {
    const text = "Привет 👋";
    expect(redactionPlaceholder(text)).toMatch(/:17\]$/);
    expect(Buffer.byteLength(text, "utf8")).toBe(17);
    expect(text.length).not.toBe(17);
  });
  it("handles the empty string", () => {
    expect(redactionPlaceholder("")).toMatch(/^\[R:[0-9a-f]{8}:0\]$/);
  });
});
describe("redactRequestBody — prototype pollution", () => {
  it("does not pollute Object.prototype from a top-level __proto__ key", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    const result = redactRequestBody(parsed) as object;
    expect(pick({}, "polluted")).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({
      polluted: true
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(parsed);
  });
  it("does not pollute from nested __proto__ / constructor / prototype keys", () => {
    const body: unknown = JSON.parse(
      '{"messages":[{"role":"user","content":[{"type":"text","text":"hi","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}]}]}'
    );
    const block = pick(redactRequestBody(body), "messages.0.content.0") as object;
    expect(pick({}, "polluted")).toBeUndefined();
    expect(Object.getPrototypeOf(block)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(block, "__proto__")?.value).toEqual({
      polluted: true
    });
    expect(Object.getOwnPropertyDescriptor(block, "constructor")?.value).toEqual({
      prototype: { polluted: true }
    });
    expect(JSON.stringify(block)).toContain('"__proto__":{"polluted":true}');
  });
});
describe("redactWireBody", () => {
  const SAMPLE = JSON.stringify(ANTHROPIC_BODY);
  it("returns the raw body unchanged when raw: true is passed", () => {
    expect(redactWireBody(SAMPLE, { raw: true })).toBe(SAMPLE);
  });
  it("redacts the serialized body by default", () => {
    const redacted = redactWireBody(SAMPLE);
    expect(redacted).not.toContain("123-45-6789");
    expect(JSON.parse(redacted)).toEqual(redactRequestBody(ANTHROPIC_BODY));
  });
  it("returns a placeholder for unparseable input instead of throwing", () => {
    expect(() => redactWireBody("not json")).not.toThrow();
    expect(JSON.parse(redactWireBody("not json"))).toEqual({ redacted: "unparseable-body" });
  });
});
