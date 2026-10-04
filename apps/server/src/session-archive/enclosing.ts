/**
 * Capture v2: the `.git` of the repository a session folder sits inside.
 *
 * A session started in a subfolder of a repository (`repo/packages/app`)
 * archived only that subfolder, so its archive had no git at all. The
 * enclosing repository's git directory is archived byte for byte under
 * `__enclosing_repo__/.git/` (credentials removed from the archived config,
 * like every other repository's), never any other file of the repository
 * outside the session folder. `state.json` says where it belongs: the
 * repository's `repos` item (`position: "above"`, `path: "../.."`) gets
 * `git_dir: "__enclosing_repo__/.git"`, `archived: "byte_exact"` and
 * `session_subdir` (the session folder inside the work tree, `packages/app`).
 *
 * Replay: put the folder at `<session_subdir>` of an empty directory and move
 * `__enclosing_repo__/.git` to that directory's top.
 *
 * Left out (metadata only, listed in `excluded`): a repository whose `.git`
 * is a gitfile (a linked worktree or submodule: its objects live elsewhere),
 * one at or above the home directory (git's discovery stops there), one in
 * the app's own state, and a `.git` over MAX_ENCLOSING_GIT_BYTES. Identical
 * in the CLI and the desktop app.
 */
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExcludedList } from "./capture-v2.js";
import {
  ENCLOSING_REPO_ROOT_NAME,
  emptyExcludedCounts,
  emptyScanMetrics,
  scanArchiveTree,
  scrubConfigEntry,
  type ArchiveHashCache,
  type ExcludedCounts,
  type ScanOptions,
  type ScannedEntry,
} from "./manifest.js";
import { isGitConfigPath } from "./git-scrub.js";
import { runRepoGit, type RepoState } from "./repos.js";

export { ENCLOSING_REPO_ROOT_NAME };
/** The archive path of the enclosing repository's git directory. */
export const ENCLOSING_GIT_DIR = `${ENCLOSING_REPO_ROOT_NAME}/.git`;
/** A larger enclosing `.git` is left out (listed as too_large). */
export const MAX_ENCLOSING_GIT_BYTES = 1024 * 1024 * 1024;

export type EnclosingRepo = {
  /** The work tree's top, absolute. */
  top: string;
  /** Its git directory (`<top>/.git`), absolute. */
  gitDir: string;
  /** The session folder inside the work tree (`packages/app`), portable. */
  sessionSubdir: string;
};

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The repository whose work tree holds `root` from above (not `root` itself), or null. */
export async function findEnclosingRepo(root: string): Promise<EnclosingRepo | null> {
  const run = await runRepoGit(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { maxBytes: 64 * 1024 });
  if (!run.ok) return null;
  const [top, gitDir] = run.stdout.toString("utf8").split(/\r?\n/);
  if (!top || !gitDir) return null;
  const absRoot = resolve(root);
  const rel = relative(resolve(top), absRoot);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  // Only a real `<top>/.git` folder: a gitfile's objects live elsewhere.
  if (resolve(gitDir) !== resolve(top, ".git")) return null;
  try {
    const stats = await lstat(gitDir);
    if (!stats.isDirectory()) return null;
  } catch {
    return null;
  }
  return { top: resolve(top), gitDir: resolve(gitDir), sessionSubdir: rel.split(sep).join("/") };
}

/** Whether the bytes under `dir` stay within `cap` (lstat only, stops as soon as they do not). */
async function withinBytes(dir: string, cap: number): Promise<boolean> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let names;
    try {
      names = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await lstat(path)).size;
      } catch {
        continue;
      }
      if (total > cap) return false;
    }
  }
  return true;
}

/** Archive entries in the shape the archiver merges (like an outside scan), and the repository they came from. */
export type EnclosingScan = { entries: ScannedEntry[]; gone: Set<string>; excluded: ExcludedCounts; repo: EnclosingRepo | null };

/**
 * The enclosing repository's `.git` as archive entries under
 * ENCLOSING_GIT_DIR (read from their own absolute paths at pack time), or
 * none. Never throws.
 */
export async function scanEnclosingGit(
  root: string,
  options: { appDirs?: readonly string[]; home?: string | null; hashCache?: ArchiveHashCache; excludedList?: ExcludedList; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<EnclosingScan> {
  const empty: EnclosingScan = { entries: [], gone: new Set(), excluded: emptyExcludedCounts(), repo: null };
  let repo: EnclosingRepo | null;
  try {
    repo = await findEnclosingRepo(root);
  } catch {
    return empty;
  }
  if (!repo) return empty;
  const home = options.home ?? null;
  if (home && inside(repo.top, resolve(home))) return { ...empty, repo: null };
  if ((options.appDirs ?? []).some((dir) => inside(resolve(dir), repo.gitDir))) return { ...empty, repo: null };
  if (!(await withinBytes(repo.gitDir, options.maxBytes ?? MAX_ENCLOSING_GIT_BYTES))) {
    options.excludedList?.add({ path: ENCLOSING_GIT_DIR, type: "dir", reason: "too_large" });
    return { ...empty, repo: null };
  }
  try {
    const metrics = emptyScanMetrics();
    // No ignore rules inside a git directory (the CLI's scan would otherwise ask git about each path).
    const scanOptions = {
      includeIgnored: true,
      ...(options.hashCache ? { hashCache: options.hashCache } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      metrics,
    } as ScanOptions;
    const scan = await scanArchiveTree(repo.gitDir, scanOptions);
    const entries: ScannedEntry[] = [{
      path: ENCLOSING_REPO_ROOT_NAME, type: "dir", size: 0, sha256: null, mode: 0o755, mtime: 0, statKey: "0:0:0:0", dev: 0,
    }];
    const gitStats = await lstat(repo.gitDir, { bigint: true });
    entries.push({ path: ENCLOSING_GIT_DIR, type: "dir", size: 0, sha256: null, mode: Number(gitStats.mode & 0o7777n), mtime: Number(gitStats.mtimeNs / 1_000_000_000n), statKey: "0:0:0:0", dev: Number(gitStats.dev) });
    for (const entry of scan.entries) {
      // A symlink inside .git is never followed nor archived (pack reads files by absolute path only).
      if (entry.type === "symlink") {
        options.excludedList?.add({ path: `${ENCLOSING_GIT_DIR}/${entry.path}`, type: "file", reason: "special" });
        continue;
      }
      const source = join(repo.gitDir, ...entry.path.split("/"));
      const path = `${ENCLOSING_GIT_DIR}/${entry.path}`;
      if (entry.type === "dir") {
        entries.push({ ...entry, path });
        continue;
      }
      const moved: ScannedEntry = { ...entry, path, source };
      if (isGitConfigPath(path)) {
        if (moved.size > 1024 * 1024) {
          options.excludedList?.add({ path, type: "file", reason: "too_large", size: moved.size });
          continue;
        }
        delete moved.source;
        if (!(await scrubConfigEntry(source, moved, metrics))) continue;
      }
      entries.push(moved);
    }
    return { entries, gone: new Set(), excluded: scan.excluded, repo };
  } catch {
    return empty;
  }
}

/** The `repos` items of state.json with the enclosing repository marked as archived (see the module comment). */
export function markEnclosingRepo(repos: RepoState[], enclosing: EnclosingRepo | null): RepoState[] {
  if (!enclosing) return repos;
  return repos.map((repo) => repo.position === "above"
    ? { ...repo, git_dir: ENCLOSING_GIT_DIR, archived: "byte_exact" as const, session_subdir: enclosing.sessionSubdir }
    : repo);
}
