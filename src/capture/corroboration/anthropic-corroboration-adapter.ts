import type { CorroborationAdapter } from "../../core/diagnose/corroboration.js";
import type { Corroboration, CorroborationStatus } from "../../core/diagnose/taxonomy.js";
import type { FetchLike, FetchResponseLike } from "../wrap/anthropic.js";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const UNCONFIRMED_BETA_PATH = "/v1/messages/cache-diagnostics";
export interface AnthropicCorroborationAdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly endpointPath?: string;
  readonly anthropicVersion?: string;
  readonly fetch?: FetchLike;
}
export function createAnthropicCorroborationAdapter(
  options: AnthropicCorroborationAdapterOptions
): CorroborationAdapter {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const endpointPath = options.endpointPath ?? UNCONFIRMED_BETA_PATH;
  const anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  return {
    async corroborate(call, cause) {
      try {
        const response = await fetchImpl(`${baseUrl}${endpointPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": anthropicVersion
          },
          body: JSON.stringify({ call_id: call.id, cause })
        });
        return await parseResponse(response);
      } catch {
        return undefined;
      }
    }
  };
}
async function parseResponse(response: FetchResponseLike): Promise<Corroboration | undefined> {
  if (!response.ok) {
    return undefined;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  const status = (
    body as {
      status?: unknown;
    }
  ).status;
  if (!isCorroborationStatus(status)) {
    return undefined;
  }
  const note = (
    body as {
      note?: unknown;
    }
  ).note;
  return { status, ...(typeof note === "string" ? { note } : {}) };
}
function isCorroborationStatus(value: unknown): value is CorroborationStatus {
  return value === "confirmed" || value === "contradicted" || value === "unavailable";
}
