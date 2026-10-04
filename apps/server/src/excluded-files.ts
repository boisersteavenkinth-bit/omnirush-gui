// The files a snapshot left out, so a replay knows what it is missing:
// `excluded_files` on every snapshot envelope, written after files[] (when
// the snapshot cap's omissions are known).
//
// Each entry names the path (in its upload form, scrubbed like every other
// path), its size, the SHA-256 of its bytes on disk and why it was left out:
//   privacy       a denylisted path (credentials, keys, app data); never hashed
//   too_large     over the per-file cap
//   binary        not text
//   gitignored    ignored by git (a wholly ignored folder is one entry, `dir/`)
//   snapshot_cap  over the file-count or byte budget of the snapshot (the
//                 SHA-256 is the manifest's, of the redacted text)
// At most MAX_EXCLUDED_ENTRIES are listed; `truncated_count` says how many
// more there were, and `counts` has every reason's full total. A file is
// hashed only when it is at most MAX_EXCLUDED_HASH_FILE_BYTES, within a
// per-snapshot read budget, and a hash is reused while the file's size,
// mtime and inode stay the same.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import nodePath from "node:path";

import { gitSkipReason } from "./command-guard.js";

export type ExcludedReason = "privacy" | "too_large" | "binary" | "gitignored" | "snapshot_cap";
export type ExcludedEntry = { path: string; size: number | null; sha256: string | null; reason: ExcludedReason };
export type ExcludedFilesBlock = {
  schema: 1;
  entries: ExcludedEntry[];
  truncated_count: number;
  counts: Partial<Record<ExcludedReason, number>>;
};

export const MAX_EXCLUDED_ENTRIES = 5_000;
export const MAX_EXCLUDED_HASH_FILE_BYTES = 64 * 1024 * 1024;
/** Bytes read for hashing per snapshot; past it, entries go without a SHA-256. */
export const EXCLUDED_HASH_BUDGET_BYTES = 256 * 1024 * 1024;
const MAX_GITIGNORED_LISTED = 20_000;
/** The serialized block's cap; the snapshot reserves this much of its budget. */
export const MAX_EXCLUDED_FILES_BYTES = 1024 * 1024;

type Pending = { path: string; reason: ExcludedReason; size?: number | null; sha256?: string | null };
export type HashCache = Map<string, { stamp: string; sha256: string }>;

export class ExcludedFiles {
  private readonly pending = new Map<string, Pending>();
  private readonly counts: Partial<Record<ExcludedReason, number>> = {};

  constructor(
    private readonly root: string,
    private readonly options: { uploadPath: (path: string) => string; hashes?: HashCache; hashBudgetBytes?: number },
  ) {}

  /** Records one left-out file; the first reason given for a path wins. Every call counts. */
  add(path: string, reason: ExcludedReason, info: { size?: number | null; sha256?: string | null } = {}): void {
    if (!path) return;
    if (this.pending.has(path)) return;
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
    this.pending.set(path, { path, reason, ...info });
  }

  count(reason: ExcludedReason): number {
    return this.counts[reason] ?? 0;
  }

  /** The block, with sizes and digests filled in (bounded; never throws). */
  async finish(): Promise<ExcludedFilesBlock> {
    const listed = [...this.pending.values()].slice(0, MAX_EXCLUDED_ENTRIES);
    let budget = this.options.hashBudgetBytes ?? EXCLUDED_HASH_BUDGET_BYTES;
    const entries: ExcludedEntry[] = [];
    let bytes = 200;
    for (const item of listed) {
      const directory = item.path.endsWith("/");
      let size = item.size ?? null;
      let sha256 = item.sha256 || null;
      if (!directory && (size === null || (sha256 === null && item.reason !== "privacy"))) {
        const full = nodePath.join(this.root, item.path);
        try {
          const info = await lstat(full);
          if (info.isFile()) {
            size = info.size;
            if (sha256 === null && item.reason !== "privacy" && info.size <= MAX_EXCLUDED_HASH_FILE_BYTES) {
              const stamp = `${info.size}:${Math.trunc(info.mtimeMs)}:${info.ino}`;
              const cached = this.options.hashes?.get(item.path);
              if (cached && cached.stamp === stamp) sha256 = cached.sha256;
              else if (info.size <= budget) {
                budget -= info.size;
                sha256 = await hashFile(full);
                if (sha256) this.options.hashes?.set(item.path, { stamp, sha256 });
              }
            }
          }
        } catch {
          // Gone since the listing: listed without size or digest.
        }
      }
      const uploadPath = this.options.uploadPath(directory ? item.path.slice(0, -1) : item.path);
      const entry: ExcludedEntry = { path: directory ? `${uploadPath}/` : uploadPath, size, sha256, reason: item.reason };
      bytes += JSON.stringify(entry).length + 1;
      if (bytes > MAX_EXCLUDED_FILES_BYTES) break;
      entries.push(entry);
    }
    return { schema: 1, entries, truncated_count: Math.max(0, this.pending.size - entries.length), counts: { ...this.counts } };
  }
}

function hashFile(path: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => resolvePromise(null));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/**
 * The untracked files git ignores under `root`, a wholly ignored folder as
 * one `dir/` entry (`git ls-files --others --ignored --exclude-standard
 * --directory`). Empty when git cannot answer or must not run.
 */
export async function listGitIgnored(root: string): Promise<string[]> {
  if (await gitSkipReason()) return [];
  return new Promise((resolvePromise) => {
    execFile("git", ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
      encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 15_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout) => {
      if (error) return resolvePromise([]);
      resolvePromise(Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean).slice(0, MAX_GITIGNORED_LISTED));
    });
  });
}
