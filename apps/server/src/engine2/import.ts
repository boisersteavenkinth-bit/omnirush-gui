/**
 * One-time import of the sessions the opencode 2.x engine stored into the
 * 1.x engine's store.
 *
 * OmniRush.ai desktop 2.2.0 – 3.x ran the opencode 2.x engine, which kept its
 * sessions in `<data>/opencode/opencode.db` (2.x tables: `session_v2`,
 * `session_message`; on its first start it had moved the 1.x sessions of
 * earlier releases in there too). The app now runs OmniRush.ai's build of the
 * 1.x engine (1.18.32), whose store is `<engine data>/omnirush/opencode.db` (engine-data-home.ts) and which
 * cannot read the 2.x tables. So that no session is lost, each 2.x session is
 * copied once into the 1.x store:
 *
 *   - the 2.x store is opened read-only and never changed (engine2/store.ts),
 *     so an older OmniRush.ai still opens it;
 *   - each session becomes the 1.x export document `{info, messages:[{info, parts}]}`
 *     (engine2/shapes.ts) and is written by the engine itself, `opencode import <file>`,
 *     run in the session's folder (the 1.x engine keys sessions by project), with
 *     no plugins, no project config and no network;
 *   - the import keeps every id, so a session imported twice is written once;
 *   - what was imported, skipped (its folder is gone) or failed is recorded in
 *     `<engine data>/omnirush/desktop-engine2-import.json`; a failed session is tried again on
 *     the next launches (at most MAX_ATTEMPTS times), a skipped one whenever its folder
 *     is back.
 *
 * Runs in the background after the engine started; sessions appear in the
 * app's lists as they are imported.
 */
import { spawn } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { v1Messages, v1Session, type V1Message } from "./shapes.js";
import { isEngine2Store, listEngine2Sessions, readEngine2Session, type Engine2StoredSession } from "./store.js";
import { isRecord, num, record, str, type JsonRecord } from "./util.js";
import { engineDataDir, engineDataEnv, userDataHome } from "../engine-data-home.js";

export { ENGINE2_IMPORT_MANIFEST } from "./imported.js";
import { ENGINE2_IMPORT_MANIFEST } from "./imported.js";
const MAX_ATTEMPTS = 3;
const IMPORT_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 30 * 60_000;

/** The part types the 1.x engine stores (SessionV1.Part); anything else is left out. */
const V1_PART_TYPES = new Set(["text", "reasoning", "file", "tool", "step-start", "step-finish", "snapshot", "patch", "agent", "retry", "compaction", "subtask"]);

export type Engine2ImportLog = (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;

type ManifestEntry = { at: number; messages?: number; attempts?: number; error?: string; reason?: string; from?: string };
type Manifest = {
  version: 1;
  source: string;
  imported: Record<string, ManifestEntry>;
  failed: Record<string, ManifestEntry>;
  skipped: Record<string, ManifestEntry>;
};

export type Engine2ImportResult = {
  source: string | null;
  imported: string[];
  skipped: string[];
  failed: string[];
  /** Already imported on an earlier launch. */
  done: number;
};

export type Engine2ImportOptions = {
  /** The 1.x engine binary. */
  bin: string;
  /** The engine's environment (HOME / XDG_DATA_HOME decide both stores). */
  env: NodeJS.ProcessEnv;
  log?: Engine2ImportLog;
  /** Tests: where the 2.x store and the manifest are. */
  sourcePath?: string;
  targetDataDir?: string;
  timeoutMs?: number;
};

/** The 2.x engine's store, as the 2.x engine resolved it; null when an explicit store is in use. */
export function engine2StorePath(env: NodeJS.ProcessEnv): string | null {
  if (env.OPENCODE_DB?.trim()) return null;
  return join(userDataHome(env), "opencode", "opencode.db");
}

/** The 1.x engine's data directory: the desktop engine's own (engine-data-home.ts). */
export function engine1DataDir(env: NodeJS.ProcessEnv): string {
  return engineDataDir(env);
}

/**
 * Whether the import is switched off (OMNIRUSH_ENGINE2_IMPORT=0, or a test
 * run without OMNIRUSH_ENGINE2_IMPORT=1: tests never touch the real stores) or
 * cannot apply (an explicit OPENCODE_DB).
 */
export function engine2ImportDisabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.OMNIRUSH_ENGINE2_IMPORT?.trim();
  if (flag === "0" || env.OPENCODE_DB?.trim()) return true;
  return env.NODE_ENV === "test" && flag !== "1";
}

/** The tool states 1.x keeps for a call that never finished: an aborted call is an error. */
function settleTool(part: JsonRecord, end: number): JsonRecord {
  const state = record(part, "state");
  const status = str(state, "status");
  if (!state || (status !== "pending" && status !== "running")) return part;
  const start = num(record(state, "time"), "start") ?? end;
  return {
    ...part,
    state: {
      status: "error",
      input: isRecord(state.input) ? state.input : {},
      error: "Tool execution aborted",
      ...(isRecord(state.metadata) ? { metadata: state.metadata } : {}),
      time: { start, end: Math.max(start, end) },
    },
  };
}

/** One message as the 1.x engine stores it: only 1.x part types, finished steps closed. */
function storedMessage(message: V1Message): V1Message {
  const info = { ...message.info };
  const time = isRecord(info.time) ? { ...info.time } : {};
  const created = num(time, "created") ?? 0;
  let end = created;
  for (const part of message.parts) {
    const partTime = record(part, "time") ?? record(record(part, "state"), "time");
    end = Math.max(end, num(partTime, "end") ?? 0, num(partTime, "start") ?? 0);
  }
  if (info.role === "assistant" && num(time, "completed") === undefined) {
    time.completed = end;
    info.time = time;
  }
  const parts = message.parts
    .filter((part) => V1_PART_TYPES.has(String(part.type)))
    .map((part) => (part.type === "tool" ? settleTool(part, num(time, "completed") ?? end) : part));
  return { info, parts };
}

/**
 * The 1.x engine lists a message's parts by part id, and a session's messages
 * by creation time, then id. Part ids are renumbered in their order
 * (`prt_<message>_<ordinal>`), and a message that would sort before the one it
 * follows (a user-run shell command's prompt and reply share a creation time)
 * is created a millisecond after it.
 */
function inStoredOrder(messages: V1Message[]): V1Message[] {
  let previous: { created: number; id: string } | null = null;
  return messages.map((message) => {
    const id = String(message.info.id ?? "");
    const time = isRecord(message.info.time) ? { ...message.info.time } : {};
    let created = num(time, "created") ?? 0;
    if (previous && (created < previous.created || (created === previous.created && id <= previous.id))) {
      created = previous.created + 1;
      time.created = created;
      if (num(time, "completed") !== undefined && num(time, "completed")! < created) time.completed = created;
    }
    previous = { created, id };
    const core = id.startsWith("msg_") ? id.slice(4) : id;
    const parts = message.parts.map((part, index) => ({ ...part, id: `prt_${core}_${String(index).padStart(4, "0")}` }));
    return { info: { ...message.info, time }, parts };
  });
}

/** A stored 2.x session as the 1.x export document `opencode import` reads. */
export function v1ImportDocument(stored: Engine2StoredSession): { info: JsonRecord; messages: V1Message[] } | null {
  const info = v1Session(stored.session, { version: str(stored.session, "version") ?? "2" });
  if (!info) return null;
  const directory = str(info, "directory") || undefined;
  const model = record(stored.session, "model");
  const variant = str(model, "variant");
  const messages = v1Messages(stored.messages, {
    sessionID: String(info.id),
    directory,
    root: stored.worktree ?? "/",
    agent: str(stored.session, "agent"),
    model: model && str(model, "id") && str(model, "providerID")
      ? { providerID: str(model, "providerID")!, modelID: str(model, "id")!, ...(variant && variant !== "default" ? { variant } : {}) }
      : undefined,
    child: Boolean(str(stored.session, "parentID")),
  }).map(storedMessage);
  return { info, messages: inStoredOrder(messages) };
}

function readManifest(path: string, source: string): Manifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed) && parsed.version === 1) {
      return {
        version: 1,
        source,
        imported: isRecord(parsed.imported) ? (parsed.imported as Manifest["imported"]) : {},
        failed: isRecord(parsed.failed) ? (parsed.failed as Manifest["failed"]) : {},
        skipped: isRecord(parsed.skipped) ? (parsed.skipped as Manifest["skipped"]) : {},
      };
    }
  } catch {
    // none yet
  }
  return { version: 1, source, imported: {}, failed: {}, skipped: {} };
}

function writeManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/** An exclusive lock beside the manifest, so two app processes never import at once. */
function takeLock(path: string): (() => void) | null {
  const lock = `${path}.lock`;
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
  } catch {
    // raced: the open below decides
  }
  try {
    mkdirSync(dirname(lock), { recursive: true });
    closeSync(openSync(lock, "wx"));
  } catch {
    return null;
  }
  return () => {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  };
}

const SECRET_ENV = /^(OPENCODE_SERVER_(USERNAME|PASSWORD)|OPENCODE_PASSWORD|OMNIRUSH_ENCRYPTION_KEY|OMNIRUSH_(ACCESS|REFRESH)_TOKEN)$/;

/** The engine environment for `opencode import`: same stores, no plugins, project or user config, no network. */
function importEnv(env: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (typeof value === "string" && !SECRET_ENV.test(name)) out[name] = value;
  delete out.OPENCODE_CONFIG_CONTENT;
  out.OPENCODE_CONFIG = join(configDir, "opencode.json");
  out.OPENCODE_CONFIG_DIR = configDir;
  out.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  out.OPENCODE_PURE = "1";
  out.OPENCODE_DISABLE_AUTOUPDATE = "1";
  out.OPENCODE_DISABLE_MODELS_FETCH = "1";
  out.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  out.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  out.npm_config_audit = "false";
  // The engine writes the import into its own store (the desktop's data home).
  Object.assign(out, engineDataEnv(env) ?? {});
  return out;
}

function runImport(bin: string, file: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: output.slice(-2_000) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["import", file], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
      resolve({ ok: false, output });
      return;
    }
    const timer = setTimeout(() => {
      output += `\nimport timed out after ${timeoutMs}ms`;
      try {
        child.kill("SIGKILL");
      } catch {
        // gone
      }
      done(false);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      output += error.message;
      done(false);
    });
    child.once("close", (code) => done(code === 0));
  });
}

/** Imports every 2.x session not imported yet. Never throws; a run already in progress elsewhere is skipped. */
export async function importEngine2Sessions(options: Engine2ImportOptions): Promise<Engine2ImportResult> {
  const log = options.log ?? (() => undefined);
  const source = options.sourcePath ?? engine2StorePath(options.env);
  const result: Engine2ImportResult = { source, imported: [], skipped: [], failed: [], done: 0 };
  if (!source || (!options.sourcePath && engine2ImportDisabled(options.env))) return result;
  if (!(await isEngine2Store(source))) return result;
  const manifestPath = join(options.targetDataDir ?? engine1DataDir(options.env), ENGINE2_IMPORT_MANIFEST);
  const release = takeLock(manifestPath);
  if (!release) {
    log("info", "engine2 session import already running elsewhere");
    return result;
  }
  const work = mkdtempSync(join(tmpdir(), "omnirush-engine2-import-"));
  try {
    const configDir = join(work, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), "{}\n", "utf8");
    const env = importEnv(options.env, configDir);
    const manifest = readManifest(manifestPath, source);
    let ids: string[];
    try {
      ids = await listEngine2Sessions(source);
    } catch (error) {
      log("warn", "engine2 session store could not be read", { error: error instanceof Error ? error.message : String(error) });
      return result;
    }
    for (const id of ids) {
      if (manifest.imported[id]) {
        result.done += 1;
        continue;
      }
      const attempts = manifest.failed[id]?.attempts ?? 0;
      if (attempts >= MAX_ATTEMPTS) {
        result.failed.push(id);
        continue;
      }
      let document: ReturnType<typeof v1ImportDocument> = null;
      try {
        const stored = await readEngine2Session(source, id);
        document = stored ? v1ImportDocument(stored) : null;
      } catch (error) {
        manifest.failed[id] = { at: Date.now(), attempts: attempts + 1, error: error instanceof Error ? error.message : String(error) };
        result.failed.push(id);
        writeManifest(manifestPath, manifest);
        continue;
      }
      if (!document) continue;
      const directory = String(document.info.directory ?? "");
      if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) {
        manifest.skipped[id] = { at: Date.now(), reason: "directory_missing" };
        result.skipped.push(id);
        writeManifest(manifestPath, manifest);
        continue;
      }
      const file = join(work, `${id}.json`);
      writeFileSync(file, JSON.stringify(document), "utf8");
      const run = await runImport(options.bin, file, directory, env, options.timeoutMs ?? IMPORT_TIMEOUT_MS);
      rmSync(file, { force: true });
      if (run.ok && run.output.includes(`Imported session: ${id}`)) {
        manifest.imported[id] = { at: Date.now(), messages: document.messages.length, from: `opencode ${String(document.info.version ?? "2.x")}` };
        delete manifest.failed[id];
        delete manifest.skipped[id];
        result.imported.push(id);
      } else {
        manifest.failed[id] = { at: Date.now(), attempts: attempts + 1, error: run.output.trim().split("\n").slice(-3).join(" ").slice(0, 500) };
        result.failed.push(id);
        log("warn", "engine2 session import failed", { session: id, attempts: attempts + 1 });
      }
      writeManifest(manifestPath, manifest);
    }
    if (result.imported.length || result.failed.length || result.skipped.length) {
      log("info", "engine2 session import finished", {
        imported: result.imported.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
        done: result.done,
      });
    }
    return result;
  } catch (error) {
    log("warn", "engine2 session import stopped", { error: error instanceof Error ? error.message : String(error) });
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
    release();
  }
}

/**
 * Provider and MCP sign-ins the opencode engine kept in its data directory
 * (`auth.json`, `mcp-auth.json` in `<data>/opencode`, shared with the earlier
 * 1.x and 2.x engines): copied once into OmniRush.ai's engine data directory,
 * where it now reads them. A file already there is never replaced.
 */
export function adoptOpencodeCredentials(env: NodeJS.ProcessEnv, log?: Engine2ImportLog): string[] {
  if (engine2ImportDisabled(env)) return [];
  const from = join(userDataHome(env), "opencode");
  const to = engine1DataDir(env);
  const copied: string[] = [];
  for (const name of ["auth.json", "mcp-auth.json"]) {
    const source = join(from, name);
    const target = join(to, name);
    try {
      if (!existsSync(source) || existsSync(target)) continue;
      mkdirSync(to, { recursive: true });
      copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
      chmodSync(target, 0o600);
      copied.push(name);
    } catch (error) {
      log?.("warn", "engine sign-in file could not be copied", { file: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (copied.length) log?.("info", "engine sign-ins copied from the opencode data directory", { files: copied.join(",") });
  return copied;
}

let running: Promise<Engine2ImportResult> | null = null;

/** Starts the import once per process (later calls get the same run). */
export function startEngine2SessionImport(options: Engine2ImportOptions): Promise<Engine2ImportResult> {
  running ??= importEngine2Sessions(options);
  return running;
}
