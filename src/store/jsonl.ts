import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmCall } from "../core/model/call.js";
import type { TraceStore } from "./trace-store.js";
export class JsonlTraceStore implements TraceStore {
  constructor(private readonly filePath: string) {}
  async append(call: LlmCall): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(call)}\n`, "utf8");
  }
  async list(): Promise<readonly LlmCall[]> {
    return readJsonlFile(this.filePath);
  }
}
export async function readJsonlFile(filePath: string): Promise<LlmCall[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LlmCall);
}
export async function writeJsonlFile(filePath: string, calls: readonly LlmCall[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const body = calls.map((call) => JSON.stringify(call)).join("\n");
  await writeFile(filePath, body.length > 0 ? `${body}\n` : "", "utf8");
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
