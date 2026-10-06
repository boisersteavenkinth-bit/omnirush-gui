/**
 * A read-only view of the opencode 2.x engine's session store (its
 * `opencode.db`, as OmniRush.ai desktop 2.2.0 – 3.x left it), in the shapes
 * the 2.x engine's own API answered with:
 *
 *   - a session (`session_v2` row) as `GET /api/session/:id` gave it:
 *     `{id, projectID, parentID, title, agent, model, cost, tokens, time, location, revert, …}`;
 *   - its messages (`session_message` rows, in `seq` order) as
 *     `GET /api/session/:id/message` gave them: `{id, type, ...data}`.
 *
 * The file is opened read-only and never written: the 2.x store stays as it
 * was, so an older OmniRush.ai still opens it.
 */
import { existsSync } from "node:fs";
import { isRecord, type JsonRecord } from "./util.js";

export type Engine2StoredSession = {
  session: JsonRecord;
  messages: JsonRecord[];
  /** The 2.x project's worktree (its git root, or "/" without one). */
  worktree?: string;
};

type Row = Record<string, unknown>;
type Reader = { all: (sql: string, ...params: unknown[]) => Row[]; close: () => void };

async function openReadOnly(path: string): Promise<Reader> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { readonly: true });
    return {
      all: (sql, ...params) => db.query(sql).all(...(params as never[])) as Row[],
      close: () => db.close(),
    };
  }
  // A literal specifier would make Bun's bundler try to resolve node:sqlite.
  const specifier = "node:sqlite";
  const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as Row[],
    close: () => db.close(),
  };
}

function json(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compact<T extends JsonRecord>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}

/** A `session_v2` row as the 2.x API's session record. */
export function engine2SessionRecord(row: Row): JsonRecord {
  const model = json(row.model);
  const revert = json(row.revert);
  const permissions = json(row.permission);
  const metadata = json(row.metadata);
  return compact({
    id: String(row.id),
    slug: text(row.slug),
    projectID: text(row.project_id),
    parentID: text(row.parent_id),
    title: text(row.title),
    agent: text(row.agent),
    model: isRecord(model) ? model : undefined,
    cost: number(row.cost),
    tokens: {
      input: number(row.tokens_input) ?? 0,
      output: number(row.tokens_output) ?? 0,
      reasoning: number(row.tokens_reasoning) ?? 0,
      cache: { read: number(row.tokens_cache_read) ?? 0, write: number(row.tokens_cache_write) ?? 0 },
    },
    time: compact({
      created: number(row.time_created) ?? 0,
      updated: number(row.time_updated) ?? number(row.time_created) ?? 0,
      archived: number(row.time_archived),
    }),
    location: { directory: text(row.directory) ?? "" },
    subpath: text(row.path),
    revert: isRecord(revert) ? revert : undefined,
    permissions: Array.isArray(permissions) ? permissions : undefined,
    metadata: isRecord(metadata) ? metadata : undefined,
    version: text(row.version),
  });
}

/** A `session_message` row as the 2.x API's message record. */
export function engine2MessageRecord(row: Row): JsonRecord | null {
  const data = json(row.data);
  if (!isRecord(data)) return null;
  return { id: String(row.id), ...data, type: String(row.type) };
}

/** Whether `path` is a 2.x engine store (it has the 2.x session tables). */
export async function isEngine2Store(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  let reader: Reader | null = null;
  try {
    reader = await openReadOnly(path);
    const tables = new Set(reader.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name)));
    return tables.has("session_v2") && tables.has("session_message");
  } catch {
    return false;
  } finally {
    reader?.close();
  }
}

/** The ids of the stored sessions, oldest first. */
export async function listEngine2Sessions(path: string): Promise<string[]> {
  const reader = await openReadOnly(path);
  try {
    return reader.all("SELECT id FROM session_v2 ORDER BY time_created, id").map((row) => String(row.id));
  } finally {
    reader.close();
  }
}

/** One stored session with its messages, or null when it is gone. */
export async function readEngine2Session(path: string, sessionID: string): Promise<Engine2StoredSession | null> {
  const reader = await openReadOnly(path);
  try {
    const row = reader.all("SELECT * FROM session_v2 WHERE id = ?", sessionID)[0];
    if (!row) return null;
    const messages = reader
      .all("SELECT id, type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq, id", sessionID)
      .map(engine2MessageRecord)
      .filter((message): message is JsonRecord => message !== null);
    let worktree: string | undefined;
    if (typeof row.project_id === "string") {
      try {
        worktree = text(reader.all("SELECT worktree FROM project WHERE id = ?", row.project_id)[0]?.worktree);
      } catch {
        worktree = undefined;
      }
    }
    return { session: engine2SessionRecord(row), messages, ...(worktree ? { worktree } : {}) };
  } finally {
    reader.close();
  }
}
