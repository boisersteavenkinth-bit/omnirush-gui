/**
 * Capture v2: the git state of every repository a session works in.
 *
 *   - the root's own repository (`position: "root"`);
 *   - repositories in subfolders (`"nested"`): a folder holding `.git` (a
 *     directory, or a gitfile: a submodule or a linked worktree) found by
 *     the archive scan;
 *   - a repository whose work tree starts above the root (`"above"`): the
 *     root is a folder inside it; its relative position is recorded
 *     (`path: "../.."`), its `.git` is never archived (it is outside the
 *     project folder), only this metadata.
 *
 * Each gets HEAD, branch (also on an unborn branch: a repository without
 * commits), the remote without userinfo, the tracked-file count, the dirty
 * files with their status, the staged files and the stash count; or, when
 * git cannot read it, why (`error`).
 *
 * Why the old git blocks came back empty while the agent's own git commands
 * worked, and what this runner does about each:
 *   - `dubious ownership` (a folder owned by another user: a container
 *     running as root on a mounted checkout, a shared drive): git refuses
 *     the repository. The capture retries once with `safe.directory` set to
 *     that repository only, with fsmonitor and hooks off, and records it;
 *   - git environment inherited from the launching process (`GIT_DIR`,
 *     `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ... when started from a git hook or
 *     `git rebase -x`) pointing git somewhere else: removed;
 *   - short timeouts under load (5 s for `rev-parse` while a full scan
 *     hashes the tree): 20 s here, and a timeout is reported, not hidden;
 *   - a repository created by the agent (`git init`, `git clone`) after the
 *     session started, or in a subfolder: found again at every state;
 *   - a plain-folder or touched-files chain never read git at all: every
 *     v2 state reads the repositories, whatever the chain's marker.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { gitSkipReason } from "../command-guard.js";

export type RepoPosition = "root" | "nested" | "above";
export type RepoError = "timeout" | "dubious_ownership" | "not_a_repository" | "git_missing" | "failed";

export type RepoState = {
  path: string;
  position: RepoPosition;
  git_dir: string | null;
  gitfile: boolean;
  head: string | null;
  branch: string | null;
  unborn: boolean;
  remote: string | null;
  tracked_files: number | null;
  dirty: boolean;
  dirty_files: Array<{ path: string; status: string }>;
  dirty_truncated: boolean;
  staged_files: string[];
  stash_count: number;
  archived: "byte_exact" | "metadata_only";
  safe_directory_override?: true;
  error: RepoError | null;
};

export const MAX_REPOS = 64;
const MAX_DIRTY_LISTED = 500;
/** One repository item of state.json stays far below the reader's 1 MiB item cap (backend spec 19.3). */
const MAX_LISTED_PATH_BYTES = 128 * 1024;

/** The first items of `items` whose paths fit `MAX_LISTED_PATH_BYTES` (and MAX_DIRTY_LISTED), and whether any was left out. */
function boundedList<T>(items: readonly T[], pathOf: (item: T) => string): { kept: T[]; truncated: boolean } {
  const kept: T[] = [];
  let bytes = 0;
  for (const item of items) {
    bytes += Buffer.byteLength(pathOf(item)) + 32;
    if (kept.length >= MAX_DIRTY_LISTED || bytes > MAX_LISTED_PATH_BYTES) return { kept, truncated: true };
    kept.push(item);
  }
  return { kept, truncated: false };
}
const GIT_TIMEOUT_MS = 20_000;
/** Variables that redirect git away from the folder it is run in. */
const REDIRECTING_GIT_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_EXEC_PATH",
];

/** The environment capture git runs with: no redirecting variables, no prompts, no optional locks, C locale. */
export function captureGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of REDIRECTING_GIT_ENV) delete env[name];
  for (const name of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete env[name];
  let home = homedir();
  try {
    home = realpathSync(home);
  } catch {
    // As given.
  }
  const ceiling = base.GIT_CEILING_DIRECTORIES;
  env.GIT_CEILING_DIRECTORIES = home ? (ceiling ? `${ceiling}${delimiter}${home}` : home) : ceiling ?? "";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

export type RepoGitRun = { ok: boolean; stdout: Buffer; stderr: string; timedOut: boolean; missing: boolean; truncated: boolean };

/** One git run in `cwd`, read-only settings, bounded output; never throws. `onChunk` streams stdout instead of keeping it. */
export async function runRepoGit(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; timeoutMs?: number; safeDirectory?: string; onChunk?: (chunk: Buffer) => void } = {},
): Promise<RepoGitRun> {
  // A Mac without the Command Line Tools: the git shim would open the installer (command-guard.ts).
  if (await gitSkipReason()) return { ok: false, stdout: Buffer.alloc(0), stderr: "", timedOut: false, missing: true, truncated: false };
  return spawnRepoGit(cwd, args, options);
}

function spawnRepoGit(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; timeoutMs?: number; safeDirectory?: string; onChunk?: (chunk: Buffer) => void },
): Promise<RepoGitRun> {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  return new Promise((resolvePromise) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0;
    let errTotal = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (ok: boolean, missing = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), timedOut, missing, truncated });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
      finish(false);
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    timer.unref?.();
    const config = [
      "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      ...(options.safeDirectory ? ["-c", `safe.directory=${options.safeDirectory}`] : []),
    ];
    try {
      child = spawn("git", ["-C", cwd, ...config, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: captureGitEnv() });
    } catch {
      finish(false, true);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.onChunk) {
        options.onChunk(chunk);
        return;
      }
      if (truncated) return;
      const room = maxBytes - total;
      if (chunk.length > room) {
        out.push(chunk.subarray(0, room));
        total = maxBytes;
        truncated = true;
        child?.kill("SIGKILL");
        return;
      }
      out.push(chunk);
      total += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errTotal < 16 * 1024) {
        err.push(chunk);
        errTotal += chunk.length;
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish(false, error.code === "ENOENT"));
    child.on("close", (code) => finish(!timedOut && (truncated || code === 0)));
  });
}

function errorOf(run: RepoGitRun): RepoError {
  if (run.missing) return "git_missing";
  if (run.timedOut) return "timeout";
  if (/dubious ownership|safe\.directory/i.test(run.stderr)) return "dubious_ownership";
  if (/not a git repository/i.test(run.stderr)) return "not_a_repository";
  return "failed";
}

function portable(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Strips `user:password@` from a remote URL (scheme form) and the password from an scp form. */
export function stripRemoteCredentials(url: string): string {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/@]*@)?(.*)$/i.exec(trimmed);
  if (scheme) return `${scheme[1]}${scheme[2]}`;
  const scp = /^([^/@:\s]+)(?::[^@/]*)?@([^/:\s]+:.*)$/.exec(trimmed);
  if (scp) return `${scp[1]}@${scp[2]}`;
  return trimmed;
}

type Located = { top: string; gitDir: string; safeDirectory?: string } | { error: RepoError };

async function locate(dir: string): Promise<Located> {
  const args = ["rev-parse", "--show-toplevel", "--absolute-git-dir"];
  let run = await runRepoGit(dir, args, { maxBytes: 64 * 1024 });
  let safeDirectory: string | undefined;
  if (!run.ok && errorOf(run) === "dubious_ownership") {
    // Only this repository, never `*`: the user's own folder the agent works in.
    const match = /repository at '([^']+)'/.exec(run.stderr);
    safeDirectory = match?.[1] ?? dir;
    run = await runRepoGit(dir, args, { maxBytes: 64 * 1024, safeDirectory });
  }
  if (!run.ok) return { error: errorOf(run) };
  const [top, gitDir] = run.stdout.toString("utf8").split(/\r?\n/);
  if (!top || !gitDir) return { error: "not_a_repository" };
  return { top, gitDir, ...(safeDirectory ? { safeDirectory } : {}) };
}

function within(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return portable(rel);
}

/** Parses `git status --porcelain=v1 -z` into dirty and staged files. */
export function parsePorcelainZ(text: string): { dirty: Array<{ path: string; status: string }>; staged: string[] } {
  const dirty: Array<{ path: string; status: string }> = [];
  const staged: string[] = [];
  const parts = text.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index]!;
    if (item.length < 4) continue;
    const status = item.slice(0, 2);
    const path = item.slice(3);
    dirty.push({ path, status });
    if (status[0] !== " " && status[0] !== "?" && status[0] !== "!") staged.push(path);
    // A rename or copy is followed by its source path.
    if (status[0] === "R" || status[0] === "C") index += 1;
  }
  return { dirty, staged };
}

/** The state of the repository whose work tree is `top`, as seen from `root`. */
export async function readRepoState(root: string, located: { top: string; gitDir: string; safeDirectory?: string }, position: RepoPosition, gitfile: boolean): Promise<RepoState> {
  const { top, gitDir, safeDirectory } = located;
  const opt = (extra: { maxBytes?: number; timeoutMs?: number } = {}) => ({ ...extra, ...(safeDirectory ? { safeDirectory } : {}) });
  let tracked = 0;
  const [head, branch, remotes, status, lsFiles, stash] = await Promise.all([
    runRepoGit(top, ["rev-parse", "--verify", "-q", "HEAD"], opt()),
    runRepoGit(top, ["symbolic-ref", "--short", "-q", "HEAD"], opt()),
    runRepoGit(top, ["remote"], opt()),
    runRepoGit(top, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], opt({ maxBytes: 4 * 1024 * 1024 })),
    runRepoGit(top, ["ls-files", "-z"], {
      ...opt(),
      onChunk: (chunk) => {
        for (const byte of chunk) if (byte === 0) tracked += 1;
      },
    }),
    runRepoGit(top, ["rev-list", "--walk-reflogs", "--count", "refs/stash"], opt()),
  ]);
  const headText = head.ok ? head.stdout.toString("utf8").trim() : "";
  const branchText = branch.ok ? branch.stdout.toString("utf8").trim() : "";
  const names = remotes.ok ? remotes.stdout.toString("utf8").split(/\r?\n/).map((name) => name.trim()).filter(Boolean) : [];
  const remoteName = names.includes("origin") ? "origin" : names[0];
  const remoteUrl = remoteName ? await runRepoGit(top, ["remote", "get-url", remoteName], opt()) : null;
  const parsed = status.ok ? parsePorcelainZ(status.stdout.toString("utf8")) : { dirty: [], staged: [] };
  const dirtyListed = boundedList(parsed.dirty, (item) => item.path);
  const stagedListed = boundedList(parsed.staged, (path) => path);
  const relTop = relative(root, top);
  const insideRoot = within(root, gitDir) !== null;
  const failed = [status, lsFiles].find((run) => !run.ok && !run.truncated);
  return {
    path: portable(relTop),
    position,
    git_dir: insideRoot ? within(root, gitDir) : null,
    gitfile,
    head: /^[0-9a-f]{40,64}$/.test(headText) ? headText : null,
    branch: branchText || null,
    unborn: !/^[0-9a-f]{40,64}$/.test(headText) && Boolean(branchText),
    remote: remoteUrl?.ok ? stripRemoteCredentials(remoteUrl.stdout.toString("utf8").trim()) || null : null,
    tracked_files: lsFiles.ok ? tracked : null,
    dirty: parsed.dirty.length > 0,
    dirty_files: dirtyListed.kept,
    dirty_truncated: dirtyListed.truncated || stagedListed.truncated || status.truncated,
    staged_files: stagedListed.kept,
    stash_count: stash.ok ? Number.parseInt(stash.stdout.toString("utf8").trim(), 10) || 0 : 0,
    archived: position !== "above" && insideRoot ? "byte_exact" : "metadata_only",
    ...(safeDirectory ? { safe_directory_override: true as const } : {}),
    error: failed ? errorOf(failed) : null,
  };
}

/** A repository marker git could not read: recorded with the reason. */
function unreadable(root: string, dir: string, position: RepoPosition, gitfile: boolean, error: RepoError): RepoState {
  return {
    path: portable(relative(root, dir)), position, git_dir: null, gitfile, head: null, branch: null, unborn: false, remote: null,
    tracked_files: null, dirty: false, dirty_files: [], dirty_truncated: false, staged_files: [], stash_count: 0, archived: "metadata_only", error,
  };
}

/**
 * Every repository of the session: `markers` are the root-relative paths of
 * the `.git` entries the archive scan found (`.git`, `sub/x/.git`), with
 * whether each is a gitfile. The root's enclosing repository (above the
 * root) is found by git itself, never above home.
 */
export async function discoverRepos(root: string, markers: ReadonlyArray<{ path: string; gitfile: boolean }>): Promise<RepoState[]> {
  const absRoot = resolve(root);
  const repos: RepoState[] = [];
  const seenTops = new Set<string>();
  const ordered = [...markers].sort((left, right) => left.path.split("/").length - right.path.split("/").length).slice(0, MAX_REPOS);
  const hasRootMarker = ordered.some((marker) => marker.path === ".git");
  if (!hasRootMarker) {
    // The root inside a larger repository (or none).
    const located = await locate(absRoot);
    if ("top" in located) {
      const rel = relative(absRoot, located.top);
      if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`))) {
        seenTops.add(located.top);
        repos.push(await readRepoState(absRoot, located, "above", false));
      }
    } else if (located.error === "dubious_ownership" || located.error === "timeout" || located.error === "git_missing") {
      repos.push(unreadable(absRoot, absRoot, "above", false, located.error));
    }
  }
  for (const marker of ordered) {
    const dir = marker.path === ".git" ? absRoot : join(absRoot, ...marker.path.split("/").slice(0, -1));
    const position: RepoPosition = marker.path === ".git" ? "root" : "nested";
    const located = await locate(dir);
    if ("error" in located) {
      repos.push(unreadable(absRoot, dir, position, marker.gitfile, located.error));
      continue;
    }
    // `.git` folders of a repository's own internals or a broken marker resolving elsewhere are not repositories of their own.
    if (resolve(located.top) !== resolve(dir) && realpathOr(located.top) !== realpathOr(dir)) continue;
    if (seenTops.has(located.top)) continue;
    seenTops.add(located.top);
    repos.push(await readRepoState(absRoot, located, position, marker.gitfile));
  }
  return repos;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `path` (absolute) holds a `.git` gitfile, and where it points. */
export async function readGitfile(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4096) return null;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(path, "utf8"));
    return match ? resolve(dirname(path), match[1]!) : null;
  } catch {
    return null;
  }
}
