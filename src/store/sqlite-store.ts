import Database from "better-sqlite3";
import type { LlmCall } from "../core/model/call.js";
import type { TraceStore } from "./trace-store.js";
interface CallRow {
  readonly data: string;
}
export class SqliteTraceStore implements TraceStore {
  private readonly db: Database.Database;
  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calls_session_id ON calls (session_id);
    `);
  }
  async append(call: LlmCall): Promise<void> {
    this.db
      .prepare(`INSERT INTO calls (id, session_id, step_name, timestamp, data)
         VALUES (@id, @sessionId, @stepName, @timestamp, @data)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           step_name = excluded.step_name,
           timestamp = excluded.timestamp,
           data = excluded.data`)
      .run({
        id: call.id,
        sessionId: call.sessionId,
        stepName: call.stepName,
        timestamp: call.timestamp,
        data: JSON.stringify(call)
      });
  }
  async list(): Promise<readonly LlmCall[]> {
    const rows = this.db.prepare("SELECT data FROM calls ORDER BY rowid ASC").all() as CallRow[];
    return rows.map((row) => JSON.parse(row.data) as LlmCall);
  }
  close(): void {
    this.db.close();
  }
}
