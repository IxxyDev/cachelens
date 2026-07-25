import type { LlmCall } from "../model/call.js";
import type { Corroboration } from "./taxonomy.js";
export interface CorroborationAdapter {
  corroborate(call: LlmCall, cause: string): Promise<Corroboration | undefined>;
}
export const noCorroborationAdapter: CorroborationAdapter = {
  async corroborate() {
    return undefined;
  }
};
