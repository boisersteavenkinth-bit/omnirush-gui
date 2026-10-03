/**
 * The files a turn touched, from its engine messages (both engines record
 * tool calls as `{ type: "tool", tool, state: { input } }` parts): the paths
 * of its file tools (read, write, edit, apply_patch, ...) and the paths named
 * in the shell commands it ran. recordTurnFiles
 *
 *   - reports each existing file outside the workspace to the project
 *     archive (archived under `__outside__/`, outside.ts), and
 *   - records one "artifact" trace event per file the turn read (inside the
 *     workspace or not), per file outside the workspace it wrote, and per
 *     existing file its shell commands named, with `access` ("read", "write",
 *     "shell") beside the event's path, sha256 and bytes. A read-only turn,
 *     which changes nothing a turn diff or the workspace artifacts would
 *     show, still says which files it read. Paths are workspace-relative, or
 *     the `__outside__/...` archive path (`outside: true`).
 *
 * The archive's exclusions apply to both: credential files and stores, the
 * app's state, dependency and cache folders, symlinks, special files, and
 * files over MAX_OUTSIDE_FILE_BYTES.
 */
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { HASH_READ_BYTES, OPEN_ENTRY_FLAGS, isArchiveCredentialPath } from "./manifest.js";
import { MAX_OUTSIDE_FILE_BYTES, outsideArchivePath, outsideExclusion } from "./outside.js";

export type TurnFileAccess = "read" | "write" | "shell";
export type TurnFileEvidence = { path: string; access: TurnFileAccess };

const READ_TOOLS = new Set(["read", "view", "cat", "file_read", "read_file", "open", "read_many_files", "readfile"]);
const WRITE_TOOLS = new Set([
  "write", "edit", "multiedit", "multi_edit", "create", "file_write", "write_file", "patch", "apply_patch", "str_replace",
  "str_replace_editor", "str_replace_based_edit_tool", "notebook_edit", "notebookedit", "replace", "move", "rename",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "zsh", "run_command", "run_shell_command", "exec", "terminal", "local_shell", "powershell", "cmd"]);
const PATH_KEYS = ["filePath", "file_path", "filepath", "path", "filename", "file_name", "target_path", "notebook_path", "absolute_path", "source", "destination"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const CWD_KEYS = ["workdir", "cwd", "directory", "working_directory"];
/** Paths looked at per turn, and events recorded per turn: a runaway turn cannot stall the capture. */
const MAX_TURN_CANDIDATES = 1_024;
const MAX_TURN_FILE_EVENTS = 500;
const MAX_PATH_CHARS = 4_096;
const MAX_COMMAND_CHARS = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase().split(/[.:/]/).at(-1) ?? "";
  return name || null;
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!path || path.length > MAX_PATH_CHARS || path.includes("\0") || path.includes("\n") || path.includes("://")) return null;
  return path;
}

/** `~/x` with the home directory, anything else as it is. */
function expandHome(path: string, home: string | null): string | null {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return home ? join(home, path.slice(2)) : null;
  if (path.startsWith("~")) return null;
  return path;
}

/** Paths of an apply_patch body (`*** Add File: x`, `*** Update File: x`, `*** Move to: x`). */
function patchPaths(value: unknown): string[] {
  if (typeof value !== "string" || value.length > MAX_COMMAND_CHARS) return [];
  const paths: string[] = [];
  for (const match of value.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to):[ \t]*(.+)$/gm)) {
    const path = match[1]?.trim().split(/\s+->\s+/u)[0];
    if (path) paths.push(path);
  }
  return paths;
}

/** Splits a shell command into words: quotes, backslash escapes and the control operators are honoured. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const end = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && index + 1 < command.length && '"\\$`'.includes(command[index + 1]!)) word += command[++index]!;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < command.length && sep === "/") {
      word += command[++index]!;
      started = true;
    } else if (/\s/.test(char) || ";|&<>()`".includes(char)) {
      end();
    } else {
      word += char;
      started = true;
    }
  }
  end();
  return words;
}

/**
 * Path candidates of a shell command: its words that look like paths
 * (`/abs`, `~/x`, `./x`, `../x`, `dir/file`, `file.ext`, the value of
 * `--opt=/abs`), and absolute paths quoted inside its words (a script passed
 * with `-c`). Whether one is a file is checked later.
 */
export function shellPathCandidates(command: string): string[] {
  if (command.length > MAX_COMMAND_CHARS) command = command.slice(0, MAX_COMMAND_CHARS);
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    const path = value?.replace(/[.,:;]+$/, "");
    if (path && path.length <= MAX_PATH_CHARS && !path.includes("://") && !/[*?[\]{}$]/.test(path)) out.add(path);
  };
  for (const word of shellWords(command)) {
    if (word.startsWith("-")) {
      const equals = word.indexOf("=");
      if (equals > 0) add(word.slice(equals + 1));
      continue;
    }
    if (word.includes("=") && !word.includes("/")) continue;
    if (/^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])/.test(word) || word.includes("/") || /^[^/\\]+\.[A-Za-z0-9]{1,12}$/.test(word)) add(word);
  }
  // Absolute paths inside a word (python -c "open('/tmp/x.bin')", a heredoc).
  for (const match of command.matchAll(/(?<![\w.~$:/-])((?:~|[A-Za-z]:)?[\\/][^\s'"`;|&<>(){}[\],]+)/g)) add(match[1]);
  return [...out];
}

/** Every file path a turn's tool calls name, absolute, with how it was touched (deduplicated, bounded). */
export function turnFileEvidence(messages: unknown, root: string, home: string | null = safeHome()): TurnFileEvidence[] {
  const found = new Map<string, TurnFileAccess>();
  const rank: Record<TurnFileAccess, number> = { write: 3, read: 2, shell: 1 };
  const add = (raw: string | null, access: TurnFileAccess, cwd: string) => {
    if (!raw || found.size >= MAX_TURN_CANDIDATES) return;
    const expanded = expandHome(raw, home);
    if (!expanded) return;
    const absolute = resolve(cwd, expanded);
    const previous = found.get(absolute);
    if (!previous || rank[access] > rank[previous]) found.set(absolute, access);
  };
  const list = Array.isArray(messages) ? messages : isRecord(messages) && Array.isArray(messages.messages) ? messages.messages : [];
  for (const message of list) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool") continue;
      const name = toolName(part.tool ?? part.name);
      if (!name) continue;
      const state = isRecord(part.state) ? part.state : {};
      const input = isRecord(state.input) ? state.input : isRecord(part.input) ? part.input : null;
      if (!input) continue;
      const cwdValue = CWD_KEYS.map((key) => cleanPath(input[key])).find(Boolean);
      const cwd = cwdValue ? resolve(root, expandHome(cwdValue, home) ?? ".") : root;
      if (SHELL_TOOLS.has(name)) {
        for (const key of COMMAND_KEYS) {
          const value = input[key];
          const command = typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(" ") : null;
          if (command) for (const candidate of shellPathCandidates(command)) add(candidate, "shell", cwd);
        }
        continue;
      }
      const access: TurnFileAccess | null = READ_TOOLS.has(name) ? "read" : WRITE_TOOLS.has(name) ? "write" : null;
      if (!access) continue;
      for (const key of PATH_KEYS) add(cleanPath(input[key]), access, cwd);
      if (Array.isArray(input.paths)) for (const value of input.paths) add(cleanPath(value), access, cwd);
      if (Array.isArray(input.edits)) for (const edit of input.edits) if (isRecord(edit)) add(cleanPath(edit.filePath ?? edit.file_path ?? edit.path), access, cwd);
      for (const key of ["patchText", "patch", "input", "content"]) for (const path of patchPaths(input[key])) add(path, "write", cwd);
    }
  }
  return [...found].map(([path, access]) => ({ path, access }));
}

function safeHome(): string | null {
  try {
    return homedir() || null;
  } catch {
    return null;
  }
}

function within(parent: string, child: string): string | null {
  const rel = relative(parent, child);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

async function sha256Of(absolute: string, size: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, OPEN_ENTRY_FLAGS);
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(HASH_READ_BYTES, Math.max(1, size)));
    let remaining = size;
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    return remaining === 0 ? hash.digest("hex") : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export type TurnFilesInput = {
  sessionId: string;
  /** The session's workspace root. */
  root: string;
  /** The turn's engine messages (or `{ messages }`). */
  messages: unknown;
  collector: { recordTrace(sessionId: string, type: string, data?: unknown): void };
  /** The project archive: each existing outside file is reported as touched (absolute). */
  archive?: { pathTouched(sessionId: string, path: string): void } | null;
  /** App state/temp/data directories: never reported or recorded. */
  excludedDirs?: readonly string[];
  includeCredentialFiles?: boolean;
  home?: string | null;
};

export type TurnFilesResult = { outside: string[]; records: Array<{ path: string; access: TurnFileAccess; bytes: number; sha256: string; outside: boolean }> };

/** See the module comment. Never throws. */
export async function recordTurnFiles(input: TurnFilesInput): Promise<TurnFilesResult> {
  const result: TurnFilesResult = { outside: [], records: [] };
  try {
    const home = input.home === undefined ? safeHome() : input.home;
    const evidence = turnFileEvidence(input.messages, input.root, home);
    if (evidence.length === 0) return result;
    const roots = new Set([resolve(input.root)]);
    try {
      roots.add(await realpath(input.root));
    } catch {
      // The root went away: every path is judged as given.
    }
    const appDirs = new Set<string>();
    for (const dir of input.excludedDirs ?? []) {
      appDirs.add(resolve(dir));
      try {
        appDirs.add(await realpath(dir));
      } catch {
        // Not created.
      }
    }
    const context = { appDirs: [...appDirs], home, includeCredentialFiles: input.includeCredentialFiles === true };
    const seen = new Set<string>();
    for (const { path: given, access } of evidence) {
      let absolute = given;
      try {
        // The folder as its real path; the file itself is never followed.
        absolute = join(await realpath(dirname(given)), basename(given));
      } catch {
        continue;
      }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      let stats;
      try {
        stats = await lstat(absolute);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      const rel = [...roots].map((root) => within(root, absolute)).find((value) => value !== null) ?? null;
      let recordPath: string;
      if (rel !== null) {
        // Inside the workspace: the turn diff and the workspace artifacts carry what it wrote; reads are recorded.
        if (access === "write") continue;
        if (!context.includeCredentialFiles && isArchiveCredentialPath(rel)) continue;
        if (context.appDirs.some((dir) => within(dir, absolute) !== null)) continue;
        recordPath = rel;
      } else {
        const archivePath = outsideArchivePath(absolute);
        if (!archivePath || outsideExclusion(absolute, context)) continue;
        if (stats.size > MAX_OUTSIDE_FILE_BYTES) continue;
        try {
          input.archive?.pathTouched(input.sessionId, absolute);
        } catch {
          // The archive's bookkeeping never stops a capture.
        }
        result.outside.push(absolute);
        recordPath = archivePath;
      }
      if (result.records.length >= MAX_TURN_FILE_EVENTS || stats.size > MAX_OUTSIDE_FILE_BYTES) continue;
      const sha256 = await sha256Of(absolute, stats.size);
      if (!sha256) continue;
      const record = { path: recordPath, access, bytes: stats.size, sha256, outside: rel === null };
      result.records.push(record);
      input.collector.recordTrace(input.sessionId, "artifact", {
        path: record.path,
        sha256: record.sha256,
        bytes: record.bytes,
        access: record.access,
        ...(record.outside ? { outside: true } : {}),
      });
    }
  } catch {
    // Best effort: the turn's capture goes on without its file record.
  }
  return result;
}
