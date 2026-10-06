import { appendFile, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LlmCall } from "../core/model/call.js";
import type { TraceStore } from "./trace-store.js";
import { validateCallRecord } from "./validate-record.js";

/** Trace files hold prompt bodies: owner-only directory and file permissions. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export interface JsonlTraceStoreOptions {
  /**
   * Receives non-fatal problems: lines skipped by `list()`, and an existing trace file whose
   * permissions could not be tightened to 0600. Default: one `cachelens:` line on stderr each.
   */
  readonly onWarning?: (message: string) => void;
}
export class JsonlTraceStore implements TraceStore {
  /** Tail of the in-process write chain; appends run strictly one after another. */
  private writeChain: Promise<void> = Promise.resolve();
  private dirReady: Promise<unknown> | undefined;
  private modeChecked = false;
  private readonly onWarning: (message: string) => void;
  constructor(
    private readonly filePath: string,
    options: JsonlTraceStoreOptions = {}
  ) {
    this.onWarning =
      options.onWarning ?? ((message) => process.stderr.write(`cachelens: ${message}\n`));
  }
  /**
   * Appends one JSON line. Appends on one store instance are serialized, so
   * concurrent callers never interleave partial lines (a single large
   * `appendFile` is not atomic). Rejects with this append's own error only.
   */
  append(call: LlmCall): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(call)}\n`;
    } catch (error) {
      return Promise.reject(error);
    }
    const write = this.writeChain.then(() => this.writeLine(line));
    this.writeChain = write.catch(() => {});
    return write;
  }
  private async writeLine(line: string): Promise<void> {
    this.dirReady ??= mkdir(dirname(this.filePath), { recursive: true, mode: DIR_MODE });
    try {
      await this.dirReady;
    } catch (error) {
      this.dirReady = undefined;
      throw error;
    }
    if (!this.modeChecked) {
      this.modeChecked = true;
      await this.restrictExistingFile();
    }
    await appendFile(this.filePath, line, { encoding: "utf8", mode: FILE_MODE });
  }
  /**
   * `appendFile`'s mode applies only when it creates the file, so a trace file that already
   * exists (e.g. created 0644 by an older version) is tightened once, before the first append.
   * Failure (EPERM on a file owned by someone else) is a warning, not an append error.
   */
  private async restrictExistingFile(): Promise<void> {
    try {
      const { mode } = await stat(this.filePath);
      if ((mode & 0o777) !== FILE_MODE) await chmod(this.filePath, FILE_MODE);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarning(`could not restrict ${this.filePath} to owner-only (0600): ${detail}`);
    }
  }
  /** Every valid call; each skipped line is reported to `onWarning`. */
  async list(): Promise<readonly LlmCall[]> {
    const { calls, warnings } = await this.listWithWarnings();
    for (const warning of warnings) this.onWarning(warning);
    return calls;
  }
  /** Every valid call plus one message per skipped line, without reporting them. */
  listWithWarnings(): Promise<ReadJsonlResult> {
    return readJsonlFile(this.filePath);
  }
}
export interface ReadJsonlResult {
  readonly calls: LlmCall[];
  /** One human-readable message per skipped line, each naming the file path and 1-based line number. */
  readonly warnings: string[];
}
/**
 * Reads a JSONL trace, skipping (and reporting) lines that are not valid JSON or not valid
 * LlmCall records instead of failing the whole file. A missing file yields an empty result.
 */
export async function readJsonlFile(filePath: string): Promise<ReadJsonlResult> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { calls: [], warnings: [] };
    }
    throw error;
  }
  const calls: LlmCall[] = [];
  const warnings: string[] = [];
  const lines = contents.split("\n");
  const endsWithNewline = contents.endsWith("\n");
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    const location = `${filePath}:${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const isFinalLine = index === lines.length - 1 && !endsWithNewline;
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(
        `${location}: skipped ${isFinalLine ? "truncated final line" : "line"} (invalid JSON: ${detail})`
      );
      return;
    }
    const result = validateCallRecord(parsed);
    if (result.ok) {
      calls.push(result.record);
    } else {
      warnings.push(`${location}: skipped invalid record (${result.reason})`);
    }
  });
  return { calls, warnings };
}
export async function writeJsonlFile(filePath: string, calls: readonly LlmCall[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE });
  const body = calls.map((call) => JSON.stringify(call)).join("\n");
  await writeFile(filePath, body.length > 0 ? `${body}\n` : "", {
    encoding: "utf8",
    mode: FILE_MODE
  });
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
