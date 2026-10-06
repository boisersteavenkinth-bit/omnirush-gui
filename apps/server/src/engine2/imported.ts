/**
 * Which sessions came from the opencode 2.x engine's store (engine2/import.ts).
 *
 * A session imported from the 2.x store and continued on the 1.x engine keeps
 * its earlier turns as the 2.x engine recorded them (its tool calls and
 * results are never rewritten). Uploads of such a session say so
 * (`environment.imported_from`, e.g. "opencode 2.0.18"), so a reader can tell
 * why its earlier turns look like 2.x. The import manifest is the record;
 * it is read from disk (the uploader may run in another thread) and re-read
 * when it changes.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { engineDataDir } from "../engine-data-home.js";

/** The import manifest's file name, in the engine's data directory. */
export const ENGINE2_IMPORT_MANIFEST = "desktop-engine2-import.json";

let cache: { path: string; mtimeMs: number; imported: Record<string, { from?: unknown }> } | null = null;

/** "opencode <2.x version>" for a session imported from the 2.x store; null for any other session. */
export function engine2ImportedFrom(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!sessionId) return null;
  const path = join(engineDataDir(env), ENGINE2_IMPORT_MANIFEST);
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (!cache || cache.path !== path || cache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { imported?: Record<string, { from?: unknown }> };
      cache = { path, mtimeMs, imported: parsed && typeof parsed.imported === "object" && parsed.imported ? parsed.imported : {} };
    }
  } catch {
    return null;
  }
  const entry = cache.imported[sessionId];
  if (!entry) return null;
  return typeof entry.from === "string" && entry.from ? entry.from : "opencode 2.x";
}
