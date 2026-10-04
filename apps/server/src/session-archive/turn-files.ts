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
 * A shell command that reaches files without naming each one is expanded
 * too (expandShellTargets): a glob word (`for f in /data/*`, `cat dir/*.txt`)
 * names every file it matches, and an outside folder the command names
 * (`find /data -exec ...`, `ls /data`, the folder of an outside script it
 * ran) contributes the files read or modified during the call (atime or
 * mtime within the tool call's time window; best effort where the file
 * system does not update atime). Folders are walked without following
 * symlinks, within caps, and never the file system root, the home folder,
 * a temp root, a system folder, an ancestor of the workspace, or a folder
 * the archive excludes.
 *
 * The archive's exclusions apply to both: credential files and stores, the
 * app's state, dependency and cache folders, symlinks, special files, and
 * files over MAX_OUTSIDE_FILE_BYTES.
 */
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { HASH_READ_BYTES, OPEN_ENTRY_FLAGS, isArchiveCredentialPath } from "./manifest.js";
import { MAX_OUTSIDE_FILE_BYTES, outsideArchivePath, outsideExclusion } from "./outside.js";
import { isHomeSettingsFolder, isSecretFolder } from "../context/privacy.js";

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
/** Shell expansion caps (per turn): globs and folders expanded, files one glob or folder adds, directory entries read. */
const MAX_TURN_EXPANSIONS = 32;
const MAX_EXPANSION_FILES = 256;
const MAX_EXPANSION_ENTRIES = 20_000;
const MAX_EXPANSION_DEPTH = 6;
/** Clock and timestamp granularity slack around a tool call's window. */
const CALL_WINDOW_SLACK_MS = 2_000;
/** Folders never walked when a command names them or a glob starts in them. */
const SKIPPED_EXPANSION_DIRS = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".cache"]);
const SYSTEM_FOLDER = /^\/(?:usr|etc|bin|sbin|lib|lib32|lib64|libx32|proc|sys|dev|run|boot|var\/lib|var\/log|var\/cache|snap|System|Library|private\/etc|private\/var\/db|Applications)(?:\/|$)/;

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

/**
 * Glob words of a shell command that look like paths (`/data/*`,
 * `dir/*.txt`, `~/x/**\/*.csv`): `*`, `?` or `[...]` in a word with a `/`.
 * Words with a variable, a command substitution or a brace are left out.
 */
export function shellGlobCandidates(command: string): string[] {
  if (command.length > MAX_COMMAND_CHARS) command = command.slice(0, MAX_COMMAND_CHARS);
  const out = new Set<string>();
  for (const word of shellWords(command)) {
    if (word.startsWith("-") || word.length > MAX_PATH_CHARS || word.includes("://") || /[$`{}]/.test(word)) continue;
    if (!word.includes("/") || !/[*?[]/.test(word)) continue;
    out.add(word);
  }
  return [...out];
}

/** A shell command's glob and folder targets, absolute, with the call's time window (ms) when the engine recorded it. */
export type ShellTarget = { path: string; glob: boolean; start: number | null; end: number | null };

function callWindow(state: Record<string, unknown>): { start: number | null; end: number | null } {
  const time = isRecord(state.time) ? state.time : {};
  const start = typeof time.start === "number" && Number.isFinite(time.start) && time.start > 0 ? time.start : null;
  const end = typeof time.end === "number" && Number.isFinite(time.end) && time.end > 0 ? time.end : null;
  return { start, end };
}

/** The glob words and path words (folder candidates) of a turn's shell commands, absolute, with each call's window. */
export function turnShellTargets(messages: unknown, root: string, home: string | null = safeHome()): ShellTarget[] {
  const out: ShellTarget[] = [];
  const list = Array.isArray(messages) ? messages : isRecord(messages) && Array.isArray(messages.messages) ? messages.messages : [];
  for (const message of list) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool") continue;
      const name = toolName(part.tool ?? part.name);
      if (!name || !SHELL_TOOLS.has(name)) continue;
      const state = isRecord(part.state) ? part.state : {};
      const input = isRecord(state.input) ? state.input : isRecord(part.input) ? part.input : null;
      if (!input) continue;
      const cwdValue = CWD_KEYS.map((key) => cleanPath(input[key])).find(Boolean);
      const cwd = cwdValue ? resolve(root, expandHome(cwdValue, home) ?? ".") : root;
      const window = callWindow(state);
      for (const key of COMMAND_KEYS) {
        const value = input[key];
        const command = typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(" ") : null;
        if (!command) continue;
        const push = (raw: string, glob: boolean) => {
          if (out.length >= MAX_TURN_CANDIDATES) return;
          const expanded = expandHome(raw, home);
          if (expanded) out.push({ path: resolve(cwd, expanded), glob, ...window });
        };
        for (const word of shellGlobCandidates(command)) push(word, true);
        for (const word of shellPathCandidates(command)) push(word, false);
      }
    }
  }
  return out;
}

/** One glob component as a regular expression (`*`, `?`, `[...]`/`[!...]`), or null when it has no glob. */
function componentPattern(component: string): RegExp | null {
  if (!/[*?[]/.test(component)) return null;
  let source = "";
  for (let index = 0; index < component.length; index += 1) {
    const char = component[index]!;
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const close = component.indexOf("]", index + 2);
      if (close < 0) {
        source += "\\[";
        continue;
      }
      let body = component.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      source += `[${negated ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      index = close;
    } else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "u");
  } catch {
    return null;
  }
}

type ExpansionContext = {
  roots: string[];
  home: string | null;
  temps: string[];
  exclusion: (absolute: string) => unknown;
  budget: { entries: number };
};

function tempFolders(): string[] {
  const out = new Set<string>();
  for (const value of [tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP, "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"]) {
    if (value && isAbsolute(value)) out.add(resolve(value));
  }
  return [...out];
}

/**
 * A folder that is never walked: the file system root or a top-level
 * folder, the home folder or an ancestor of it, a temp root itself, a system
 * folder, the workspace or an ancestor of it, a secret store, a folder the
 * archive excludes (app state, dependency/cache folders).
 */
function unsafeFolder(dir: string, context: ExpansionContext): boolean {
  const portable = dir.replaceAll("\\", "/");
  if (resolve(dir) === resolve(dir, "/") || /^[A-Za-z]:[\\/]?$/.test(dir) || /^\/[^/]*$/.test(portable) || /^[A-Za-z]:[\\/][^\\/]*$/.test(dir)) return true;
  if (context.home && (resolve(dir) === resolve(context.home) || within(dir, context.home) !== null)) return true;
  if (context.temps.some((temp) => resolve(temp) === resolve(dir) || within(dir, temp) !== null)) return true;
  if (/^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+(?:\/T)?$/.test(portable)) return true;
  if (sep === "/" && SYSTEM_FOLDER.test(portable)) return true;
  if (/^[A-Za-z]:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData)(?:\\|$)/i.test(dir)) return true;
  if (context.roots.some((root) => resolve(root) === resolve(dir) || within(dir, root) !== null)) return true;
  if (isSecretFolder(dir)) return true;
  return context.exclusion(dir) !== null;
}

/** The files a glob matches (no dotfiles unless the component starts with `.`; symlinks never followed). */
async function expandGlob(pattern: string, context: ExpansionContext): Promise<string[]> {
  const parts = pattern.split(sep === "\\" ? /[\\/]/ : "/");
  const first = parts.findIndex((part) => /[*?[]/.test(part));
  if (first <= 0) return [];
  const base = parts.slice(0, first).join(sep) || sep;
  let realBase: string;
  try {
    realBase = await realpath(base);
  } catch {
    return [];
  }
  if (unsafeFolder(realBase, context)) return [];
  const rest = parts.slice(first);
  const found: string[] = [];
  const walk = async (dir: string, index: number, depth: number): Promise<void> => {
    if (found.length >= MAX_EXPANSION_FILES || context.budget.entries <= 0 || depth > MAX_EXPANSION_DEPTH * 2) return;
    const component = rest[index];
    if (component === undefined) return;
    const last = index === rest.length - 1;
    if (component === "**") {
      // Zero folders, then each folder below (bounded).
      await walk(dir, index + 1, depth + 1);
      if (depth >= MAX_EXPANSION_DEPTH) return;
    }
    const literal = component !== "**" && !/[*?[]/.test(component);
    if (literal) {
      const next = join(dir, component);
      if (last) found.push(next);
      else {
        try {
          const stats = await lstat(next);
          if (stats.isDirectory() && !SKIPPED_EXPANSION_DIRS.has(component)) await walk(next, index + 1, depth + 1);
        } catch {
          // Not there.
        }
      }
      return;
    }
    const matcher = component === "**" ? null : componentPattern(component);
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (found.length >= MAX_EXPANSION_FILES || context.budget.entries <= 0) return;
      context.budget.entries -= 1;
      if (child.name.startsWith(".") && !(component.startsWith("."))) continue;
      const path = join(dir, child.name);
      if (component === "**") {
        if (child.isDirectory() && !SKIPPED_EXPANSION_DIRS.has(child.name) && !isSecretFolder(child.name)) await walk(path, index, depth + 1);
        continue;
      }
      if (!matcher?.test(child.name)) continue;
      if (last) {
        if (child.isFile()) found.push(path);
      } else if (child.isDirectory() && !SKIPPED_EXPANSION_DIRS.has(child.name) && !isSecretFolder(child.name)) {
        await walk(path, index + 1, depth + 1);
      }
    }
  };
  await walk(realBase, 0, 0);
  return found;
}

/**
 * The files under an outside folder that were read or modified during a
 * tool call: atime or mtime within [start - slack, end + slack]. Walked
 * without following symlinks, regenerable and secret folders skipped.
 */
async function changedDuringCall(dir: string, start: number, end: number, context: ExpansionContext): Promise<string[]> {
  const found: string[] = [];
  const low = start - CALL_WINDOW_SLACK_MS;
  const high = end + CALL_WINDOW_SLACK_MS;
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > MAX_EXPANSION_DEPTH || found.length >= MAX_EXPANSION_FILES || context.budget.entries <= 0) return;
    let children;
    try {
      children = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (found.length >= MAX_EXPANSION_FILES || context.budget.entries <= 0) return;
      context.budget.entries -= 1;
      const path = join(folder, child.name);
      if (child.isDirectory()) {
        if (!SKIPPED_EXPANSION_DIRS.has(child.name) && !isSecretFolder(child.name)) await walk(path, depth + 1);
        continue;
      }
      if (!child.isFile()) continue;
      try {
        const stats = await lstat(path);
        const used = (stats.atimeMs >= low && stats.atimeMs <= high) || (stats.mtimeMs >= low && stats.mtimeMs <= high);
        if (stats.isFile() && used) found.push(path);
      } catch {
        // Gone.
      }
    }
  };
  await walk(dir, 0);
  return found;
}

/**
 * The files a turn's shell commands reached without naming them: glob
 * matches, and the files read or modified during the call under an outside
 * folder the command names (or the folder of an outside file it names).
 * Absolute, deduplicated, bounded. Never throws.
 */
export async function expandShellTargets(
  targets: readonly ShellTarget[],
  root: string,
  options: { home?: string | null; exclusion?: (absolute: string) => unknown; tempRoots?: readonly string[] } = {},
): Promise<string[]> {
  const out = new Set<string>();
  try {
    const home = options.home === undefined ? safeHome() : options.home;
    const roots = [resolve(root)];
    try {
      roots.push(await realpath(root));
    } catch {
      // Gone: the root as given.
    }
    const context: ExpansionContext = {
      roots,
      home,
      temps: [...(options.tempRoots ?? tempFolders())],
      exclusion: options.exclusion ?? (() => null),
      budget: { entries: MAX_EXPANSION_ENTRIES },
    };
    const insideRoot = (path: string) => roots.some((candidate) => within(candidate, path) !== null);
    const scanned = new Set<string>();
    let expansions = 0;
    for (const target of targets) {
      if (expansions >= MAX_TURN_EXPANSIONS || context.budget.entries <= 0) break;
      if (target.glob) {
        expansions += 1;
        for (const file of await expandGlob(target.path, context)) out.add(file);
        continue;
      }
      // A folder (or the folder of a file) outside the workspace, with the call's window: files used during the call.
      if (target.start === null || insideRoot(target.path)) continue;
      let stats;
      try {
        stats = await lstat(target.path);
      } catch {
        continue;
      }
      let dir: string;
      if (stats.isDirectory()) dir = target.path;
      else if (stats.isFile()) dir = dirname(target.path);
      else continue;
      try {
        dir = await realpath(dir);
      } catch {
        continue;
      }
      if (scanned.has(dir) || insideRoot(dir) || unsafeFolder(dir, context)) continue;
      if (isHomeSettingsFolder(dir, home)) continue;
      scanned.add(dir);
      expansions += 1;
      const end = target.end ?? target.start;
      for (const file of await changedDuringCall(dir, target.start, Math.max(end, target.start), context)) out.add(file);
    }
  } catch {
    // Best effort.
  }
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
    // Files reached through a glob, a folder or a script the commands named (bounded; see expandShellTargets).
    const named = new Set(evidence.map((item) => item.path));
    const expansionDirs = (input.excludedDirs ?? []).map((dir) => resolve(dir));
    const expanded = await expandShellTargets(turnShellTargets(input.messages, input.root, home), input.root, {
      home,
      exclusion: (absolute) => outsideExclusion(absolute, { appDirs: expansionDirs, home, includeCredentialFiles: input.includeCredentialFiles === true }),
    });
    for (const path of expanded) {
      if (named.has(path) || evidence.length >= MAX_TURN_CANDIDATES + MAX_EXPANSION_FILES) continue;
      named.add(path);
      evidence.push({ path, access: "shell" });
    }
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
        if (!context.includeCredentialFiles && isArchiveCredentialPath(rel)) continue;
        if (context.appDirs.some((dir) => within(dir, absolute) !== null)) continue;
        // Capture v2 (#14): a file the turn read, wrote or named in a command counts as touched, so a
        // gitignored one (a dataset, a generated output, a venv's tool) is archived byte for byte.
        try {
          input.archive?.pathTouched(input.sessionId, rel);
        } catch {
          // The archive's bookkeeping never stops a capture.
        }
        if (access === "write") continue;
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
