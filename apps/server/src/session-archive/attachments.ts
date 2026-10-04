/**
 * Capture v2: the bytes of every file attached to a prompt (an inline data
 * URL in the prompt parts, or a file URL: the path the app copied the file
 * to), archived byte for byte under `__attachments__/<message id>/<n>-<name>`
 * with a state.json entry linking it to its message id and source path.
 *
 * Attachments are read from the engine's own user messages when a turn
 * settles (both engines keep the file parts with their URL), so every one
 * carries the id of the message it belongs to. An `@path` the user typed
 * that reached the engine as plain text (no file part) is archived the same
 * way from the file it names (`source: "mention"`). Their bytes are staged under
 * the archiver's state dir at once (a file the app copied may change or go
 * later), and every capture of the chain holds the staged ones, so a delta
 * sends each once. Identical in the CLI and the desktop app.
 */
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { stateKey } from "./files.js";
import { outsideExclusion } from "./outside.js";

/** How the store judges a file attached from outside the workspace (outside.ts's exclusions). */
export type AttachmentOutsideRules = { appDirs: readonly string[]; includeCredentialFiles: boolean; home?: string | null };

function safeHome(): string | null {
  try {
    return homedir() || null;
  } catch {
    return null;
  }
}

/** An absolute path with the home directory written as `~` (portable `/`), so no account name is stored. */
export function homeRelativePath(absolute: string, home: string | null): string {
  const portable = absolute.split(sep).join("/");
  if (!home) return portable;
  const rel = relative(home, absolute);
  if (rel === "") return "~";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return portable;
  return `~/${rel.split(sep).join("/")}`;
}

export const ATTACHMENTS_ROOT_NAME = "__attachments__";
/** One attachment's bytes, at most (the desktop's prompt attachment cap). */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 32;
const MAX_NAME_BYTES = 120;

export type AttachmentSource = {
  messageId: string;
  index: number;
  name: string;
  mime: string;
  /** Inline bytes (a data URL), or null for a file URL. */
  data: Buffer | null;
  /** The file a file URL names (absolute), else null. */
  file: string | null;
  /**
   * An `@path` the user typed in the prompt text that the engine sent on as
   * text (no file part): the path as written, resolved against the session
   * folder when staged. Archived like a file URL when it names a file.
   */
  mention?: string;
};

export type AttachmentRecord = {
  /** Archive path: `__attachments__/<message id>/<index>-<name>`. */
  path: string;
  message_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  source: "inline" | "file" | "mention";
  /** The file URL's path: workspace-relative when inside the root, else absolute; null for inline data. */
  source_path: string | null;
  /** The staged copy (absolute, under the state dir). Never in the archive. */
  blob: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSegment(text: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = text.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").replace(/^\.+/, "_").trim();
  while (Buffer.byteLength(clean) > MAX_NAME_BYTES) clean = clean.slice(0, -1);
  return clean || fallback;
}

/** The archive path of an attachment. */
export function attachmentArchivePath(messageId: string, index: number, name: string): string {
  return `${ATTACHMENTS_ROOT_NAME}/${safeSegment(messageId, "message")}/${index}-${safeSegment(name, "attachment")}`;
}

function dataUrlBytes(url: string): Buffer | null {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (payload.length > MAX_ATTACHMENT_BYTES * 2) return null;
  try {
    return /;base64$/i.test(header) ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return null;
  }
}

function fileParts(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const out: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === "file") out.push(part);
    // v2 prompts keep their files apart.
    if (Array.isArray(part.files)) for (const file of part.files) if (isRecord(file)) out.push(file);
  }
  const info = isRecord(message.info) ? message.info : message;
  for (const holder of [message, info]) {
    if (Array.isArray(holder.files)) for (const file of holder.files) if (isRecord(file)) out.push(file);
  }
  return out;
}

const MENTION_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html",
};

/**
 * The `@path` mentions of a user message's own text (never a synthetic part
 * the engine added): `@src/a.ts`, `@./x.png`, `@~/notes.md`, `@"a b.txt"`. An
 * e-mail address (`a@b.c`) is not one: the `@` must start a word.
 */
export function promptMentions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s(\[{,;])@(?:"([^"\n]{1,1024})"|'([^'\n]{1,1024})'|((?:\\ |[^\s"'`@])+))/g)) {
    let value = (match[1] ?? match[2] ?? match[3] ?? "").replaceAll("\\ ", " ");
    if (!match[1] && !match[2]) value = value.replace(/[.,;:!?)\]}]+$/, "");
    if (!value || value.length > 1024 || value.includes("://") || value.includes("\0")) continue;
    // A path, not a handle or a decorator: it names a folder or has an extension.
    if (!/[\\/]/.test(value) && !/\.[A-Za-z0-9]{1,12}$/.test(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** The attachments of the user messages in `messages` (an engine message list, v1 or v2 shape). */
export function attachmentsFromMessages(messages: unknown): AttachmentSource[] {
  const list = isRecord(messages) && Array.isArray(messages.messages) ? messages.messages : Array.isArray(messages) ? messages : [];
  const found: AttachmentSource[] = [];
  for (const message of list) {
    if (!isRecord(message)) continue;
    const info = isRecord(message.info) ? message.info : message;
    if (info.role !== "user" || typeof info.id !== "string" || !info.id) continue;
    let index = 0;
    const seen = new Set<string>();
    for (const part of fileParts(message)) {
      if (index >= MAX_ATTACHMENTS_PER_MESSAGE) break;
      const url = typeof part.url === "string" ? part.url.trim() : typeof part.uri === "string" ? part.uri.trim() : "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const mimeValue = part.mime ?? part.mediaType ?? part.mimeType;
      const mime = typeof mimeValue === "string" && mimeValue.trim() ? mimeValue.trim().toLowerCase() : "application/octet-stream";
      let file: string | null = null;
      let data: Buffer | null = null;
      if (url.startsWith("data:")) data = dataUrlBytes(url);
      else if (url.startsWith("file:")) {
        try {
          file = resolve(fileURLToPath(url));
        } catch {
          file = null;
        }
      }
      if (!data && !file) continue;
      const nameValue = part.filename ?? part.name;
      const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : file ? file.split(/[\\/]/).pop() ?? "attachment" : "attachment";
      found.push({ messageId: info.id, index, name, mime, data, file });
      index += 1;
    }
    // `@path` typed in the prompt and sent on as text (the engine resolved no file part for it).
    const attached = found.filter((source) => source.messageId === info.id && source.file).map((source) => source.file!);
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "text" || part.synthetic === true || typeof part.text !== "string" || part.text.length > 1024 * 1024) continue;
      for (const mention of promptMentions(part.text)) {
        if (index >= MAX_ATTACHMENTS_PER_MESSAGE) break;
        const name = mention.split(/[\\/]/).filter(Boolean).pop() ?? "attachment";
        // Already attached as a file part (the TUI's @ completion): not twice.
        if (attached.some((file) => file === mention || file.endsWith(`/${mention.replace(/^\.\//, "")}`) || file.endsWith(`\\${mention.replace(/^\.[\\/]/, "")}`))) continue;
        const extension = /\.([A-Za-z0-9]{1,12})$/.exec(name)?.[1]?.toLowerCase() ?? "";
        found.push({ messageId: info.id, index, name, mime: MENTION_MIME[extension] ?? "application/octet-stream", data: null, file: null, mention });
        index += 1;
      }
    }
  }
  return found;
}

/** The absolute file an `@path` mention names, from the session folder (`~/` is the home directory). */
function mentionFile(mention: string, root: string, home: string | null): string | null {
  if (mention === "~" || mention.startsWith("~/") || mention.startsWith("~\\")) return home ? join(home, mention.slice(2)) : null;
  if (mention.startsWith("~")) return null;
  return resolve(root, mention);
}

function within(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** Reads a file URL's file: a regular file (never through a final symlink), at most MAX_ATTACHMENT_BYTES. */
async function readAttachedFile(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * The staged attachments of each session: `<dir>/<session key>/index.jsonl`
 * plus one blob per attachment. Deduplicated by archive path.
 */
export class AttachmentStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly isDenied: (relativePath: string) => boolean = () => false,
    private readonly outside: AttachmentOutsideRules = { appDirs: [], includeCredentialFiles: false },
  ) {}

  private sessionDir(sessionId: string): string {
    return join(this.dir, stateKey(sessionId));
  }

  private serial<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task);
    this.tails.set(sessionId, run.then(() => undefined, () => undefined));
    return run;
  }

  /** Stages the sources' bytes; returns the records added (a known path is skipped). Never throws. */
  add(sessionId: string, root: string, sources: readonly AttachmentSource[]): Promise<AttachmentRecord[]> {
    return this.serial(sessionId, async () => {
      const added: AttachmentRecord[] = [];
      try {
        const known = new Set((await this.listUnlocked(sessionId)).map((record) => record.path));
        const dir = this.sessionDir(sessionId);
        for (const source of sources) {
          const path = attachmentArchivePath(source.messageId, source.index, source.name);
          if (known.has(path)) continue;
          let sourcePath: string | null = null;
          let bytes = source.data;
          let file = source.file;
          if (!file && source.mention) {
            const home = this.outside.home === undefined ? safeHome() : this.outside.home;
            file = mentionFile(source.mention, root, home);
            if (!file) continue;
          }
          if (file) {
            // The file as reached through real folders (a folder link cannot hide where it is).
            let real = file;
            try {
              real = join(await realpath(dirname(file)), basename(file));
            } catch {
              continue;
            }
            const home = this.outside.home === undefined ? safeHome() : this.outside.home;
            const rootReal = await realpath(root).catch(() => resolve(root));
            const rel = within(resolve(root), file) ?? within(rootReal, real);
            // A credential file, an app's state or a system file is never copied, wherever it was attached from.
            if (rel !== null && this.isDenied(rel)) continue;
            if (rel === null && [file, real].some((form) => outsideExclusion(form, { ...this.outside, home }) !== null)) continue;
            sourcePath = rel ?? homeRelativePath(file, home);
            bytes = await readAttachedFile(real);
          }
          if (!bytes || bytes.length > MAX_ATTACHMENT_BYTES) continue;
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const blob = join(dir, `${stateKey(path)}.bin`);
          const handle = await open(blob, "w", 0o600);
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          const record: AttachmentRecord = {
            path,
            message_id: source.messageId,
            name: source.name,
            mime: source.mime,
            size: bytes.length,
            sha256,
            source: source.mention && !source.file ? "mention" : source.file ? "file" : "inline",
            source_path: sourcePath,
            blob,
          };
          await appendFile(join(dir, "index.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
          known.add(path);
          added.push(record);
        }
      } catch {
        // Best effort: an attachment that cannot be staged is described by the trace only.
      }
      return added;
    });
  }

  private async listUnlocked(sessionId: string): Promise<AttachmentRecord[]> {
    let text: string;
    try {
      text = await readFile(join(this.sessionDir(sessionId), "index.jsonl"), "utf8");
    } catch {
      return [];
    }
    const records: AttachmentRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) continue;
        const { path, message_id, name, mime, size, sha256, source, source_path, blob } = value;
        if (typeof path !== "string" || typeof message_id !== "string" || typeof name !== "string" || typeof mime !== "string"
          || typeof size !== "number" || typeof sha256 !== "string" || (source !== "inline" && source !== "file" && source !== "mention")
          || (source_path !== null && typeof source_path !== "string") || typeof blob !== "string") continue;
        records.push({ path, message_id, name, mime, size, sha256, source, source_path, blob });
      } catch {
        // A torn last line is skipped.
      }
    }
    return records;
  }

  /** Every staged attachment of the session. */
  list(sessionId: string): Promise<AttachmentRecord[]> {
    return this.serial(sessionId, () => this.listUnlocked(sessionId));
  }

  forget(sessionId: string): Promise<void> {
    return this.serial(sessionId, () => rm(this.sessionDir(sessionId), { recursive: true, force: true }));
  }
}

/** The state.json form of a record (no staging path). */
export function attachmentStateItem(record: AttachmentRecord): Omit<AttachmentRecord, "blob"> {
  const { blob: _blob, ...item } = record;
  return item;
}
