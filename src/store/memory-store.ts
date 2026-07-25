import type { LlmCall } from "../core/model/call.js";
import type { TraceStore } from "./trace-store.js";
export class MemoryTraceStore implements TraceStore {
  private readonly calls: LlmCall[] = [];
  async append(call: LlmCall): Promise<void> {
    this.calls.push(call);
  }
  async list(): Promise<readonly LlmCall[]> {
    return [...this.calls];
  }
}
