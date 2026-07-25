import type { LlmCall } from "../core/model/call.js";
export interface TraceStore {
  append(call: LlmCall): Promise<void>;
  list(): Promise<readonly LlmCall[]>;
}
