// An attachment the model API refuses (a corrupt PDF the read tool returned,
// an image that is not one) stays in the conversation, so every later request
// carries it again and fails with the same 400: one bad file ends the session.
//
// RejectedAttachments remembers the attachments the model refused (by the
// SHA-256 of their data) and replaces them, in every later request, with a
// short text part: `[file could not be read: <name>]`. Which part was refused
// is not named by the API, so the suspects of a refusal are the request's
// attachments that no earlier accepted request carried (all of them when every
// one was accepted before). The gateway broker (omnirush-gateway-broker.ts)
// retries the failing request at once without the part. Kept in step with the
// CLI's copy (omnirush-cli assets/extensions/omnirush/rejected-attachments.js).
//
// Request shapes understood (anywhere in the JSON body):
//   Responses API      { type: "input_file", filename, file_data | file_url | file_id }
//                      { type: "input_image", image_url | file_id }
//   Chat Completions   { type: "image_url", image_url: { url } }
//                      { type: "file", file: { filename, file_data | file_id } }
//   Messages / pi      { type: "image" | "document", source: { data | url } }
//                      { type: "image", data, mimeType }

import { createHash } from "node:crypto";

const MAX_WALK_DEPTH = 64;

/**
 * Whether a model API error says an attachment could not be used: a 400
 * whose message names a file/image/PDF and calls it invalid, corrupt,
 * unreadable or unsupported.
 */
export function isRejectedAttachmentError(status: unknown, message: unknown): boolean {
  if (Number(status) !== 400) return false;
  const text = String(message ?? "").slice(0, 8192);
  if (!/\b(?:file|files|image|images|pdf|attachment|document|media|input_file|input_image|image_url|file_data)\b/i.test(text)) return false;
  return /invalid|corrupt|badly formatted|malformed|could not (?:be )?(?:process|read|decod|pars|open|load)|unable to (?:process|read|decod|pars|open|load)|failed to (?:process|read|decod|pars|open|load)|not a valid|unsupported|is not supported|cannot be (?:processed|read|decoded|parsed)|did not (?:contain|look like)|no pages/i.test(text);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataUrlName(url: unknown): string | null {
  const mime = /^data:([^;,]+)/i.exec(String(url))?.[1];
  if (!mime) return null;
  return mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "document.pdf" : "attachment";
}

export type AttachmentStyle = "input_text" | "text";
export type AttachmentKind = "image" | "file";
export type Attachment = { fingerprint: string; name: string; kind: AttachmentKind };

function kindOf(data: string): AttachmentKind {
  return /^data:image\//i.test(data) ? "image" : "file";
}

/**
 * Which kind of attachment an error message blames: "image" when it names an
 * image and no file/PDF/document, "file" for the reverse, else null (either).
 */
export function blamedKind(message: unknown): AttachmentKind | null {
  const text = String(message ?? "");
  const image = /\bimages?\b|image_url|input_image/i.test(text);
  const file = /\b(?:files?|pdfs?|documents?)\b|input_file|file_data/i.test(text);
  if (image && !file) return "image";
  if (file && !image) return "file";
  return null;
}

/** The attachment a content part carries ({ data, name, style, kind }), or null. */
export function attachmentOf(part: unknown): { data: string; name: string; style: AttachmentStyle; kind: AttachmentKind } | null {
  if (!isRecord(part) || typeof part.type !== "string") return null;
  const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  switch (part.type) {
    case "input_file": {
      const data = str(part.file_data) ?? str(part.file_url) ?? str(part.file_id);
      return data ? { data, name: str(part.filename) ?? dataUrlName(data) ?? "file", style: "input_text", kind: kindOf(data) } : null;
    }
    case "input_image": {
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url;
      const data = str(url) ?? str(part.file_id);
      return data ? { data, name: str(part.filename) ?? "image", style: "input_text", kind: "image" } : null;
    }
    case "image_url": {
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url;
      const data = str(url);
      return data ? { data, name: "image", style: "text", kind: "image" } : null;
    }
    case "file": {
      const file = isRecord(part.file) ? part.file : null;
      const data = file ? str(file.file_data) ?? str(file.file_id) ?? str(file.url) : null;
      return data && file ? { data, name: str(file.filename) ?? dataUrlName(data) ?? "file", style: "text", kind: kindOf(data) } : null;
    }
    case "image":
    case "document": {
      const source = isRecord(part.source) ? part.source : null;
      const data = str(part.data) ?? (source ? str(source.data) ?? str(source.url) ?? str(source.file_id) : null);
      const name = str(part.filename) ?? str(part.name) ?? str(part.title) ?? (part.type === "image" ? "image" : "document");
      return data ? { data, name, style: "text", kind: part.type === "image" ? "image" : kindOf(data) } : null;
    }
    default:
      return null;
  }
}

export function fingerprint(data: string): string {
  return createHash("sha256").update(String(data)).digest("hex");
}

/** The placeholder that stands in for a refused attachment. */
export function placeholderText(name: string): string {
  const clean = String(name || "file").replace(/[\r\n\]]+/g, " ").slice(0, 200);
  return `[file could not be read: ${clean}]`;
}

/** Every attachment of a request body (or message list), in order: { fingerprint, name }. */
export function attachmentsIn(body: unknown): Attachment[] {
  const out: Attachment[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const attachment = attachmentOf(value);
    if (attachment) {
      out.push({ fingerprint: fingerprint(attachment.data), name: attachment.name, kind: attachment.kind });
      return;
    }
    for (const key of Object.keys(value)) walk(value[key], depth + 1);
  };
  walk(body, 0);
  return out;
}

/**
 * A copy of `body` with every attachment whose fingerprint `isBad` accepts
 * replaced by a text part of the same API style; `replaced` lists their names.
 * The body is returned as is (same object) when nothing is replaced.
 */
export function replaceAttachments<T>(body: T, isBad: (fingerprint: string) => boolean): { body: T; replaced: string[] } {
  const replaced: string[] = [];
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > MAX_WALK_DEPTH) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const out = walk(item, depth + 1);
        if (out !== item) changed = true;
        return out;
      });
      return changed ? next : value;
    }
    if (!isRecord(value)) return value;
    const attachment = attachmentOf(value);
    if (attachment) {
      if (!isBad(fingerprint(attachment.data))) return value;
      replaced.push(attachment.name);
      return { type: attachment.style, text: placeholderText(attachment.name) };
    }
    let next: Record<string, unknown> = value;
    for (const key of Object.keys(value)) {
      const out = walk(value[key], depth + 1);
      if (out !== value[key]) {
        if (next === value) next = { ...value };
        next[key] = out;
      }
    }
    return next;
  };
  const out = walk(body, 0) as T;
  return { body: out, replaced };
}

export class RejectedAttachments {
  /** Carried by a request the model accepted. */
  private readonly accepted = new Set<string>();
  /** fingerprint -> name: refused; replaced from now on. */
  private readonly bad = new Map<string, string>();

  constructor(private readonly maxEntries = 10_000) {}

  get size(): number {
    return this.bad.size;
  }

  isBad(fp: string): boolean {
    return this.bad.has(fp);
  }

  /** The request's attachments (fingerprints) and its body with the refused ones replaced. */
  prepare<T>(body: T): { body: T; attachments: Attachment[]; replaced: string[] } {
    const attachments = attachmentsIn(body);
    if (attachments.length === 0 || this.bad.size === 0) return { body, attachments, replaced: [] };
    const { body: next, replaced } = replaceAttachments(body, (fp) => this.bad.has(fp));
    return { body: next, attachments, replaced };
  }

  /** The model answered a request that carried these attachments. */
  accept(attachments: readonly Attachment[]): void {
    for (const { fingerprint: fp } of attachments) {
      if (this.bad.has(fp)) continue;
      if (this.accepted.size >= this.maxEntries) this.accepted.clear();
      this.accepted.add(fp);
    }
  }

  /**
   * The model refused a request carrying these attachments for one of them:
   * marks the suspects as refused and returns them ([] when there is nothing
   * left to leave out). Suspects: the attachments not refused yet, narrowed to
   * the ones no accepted request carried, then to the kind the error message
   * blames (`message`: "The file you uploaded..." blames files, not images),
   * each step only when it leaves some.
   */
  reject(attachments: readonly Attachment[], message = ""): Attachment[] {
    const open = attachments.filter((item) => !this.bad.has(item.fingerprint));
    const fresh = open.filter((item) => !this.accepted.has(item.fingerprint));
    let suspects = fresh.length > 0 ? fresh : open;
    const blamed = blamedKind(message);
    const ofKind = blamed ? suspects.filter((item) => item.kind === blamed) : [];
    if (ofKind.length > 0) suspects = ofKind;
    for (const item of suspects) {
      if (this.bad.size >= this.maxEntries) break;
      this.bad.set(item.fingerprint, item.name);
      this.accepted.delete(item.fingerprint);
    }
    return suspects;
  }
}
