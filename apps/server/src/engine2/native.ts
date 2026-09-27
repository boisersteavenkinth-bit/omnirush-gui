/**
 * The 2.x engine's own fields, kept next to the 1.x shape.
 *
 * engine2/shapes.ts writes every message and part in the 1.x shape the app,
 * the viewer, the admin converter and the CLI's trace format read. The 2.x
 * engine records more than 1.x did (provider response ids and service tier,
 * raw finish reasons, the step's snapshots and changed files, stream timing,
 * whether a tool ran provider-side, structured tool content, native tool
 * names and inputs, agent/model switches, turn outcomes, …). This module adds
 * all of it to the same records, additively:
 *
 *   - a 2.x field whose name the 1.x record does not use is added under that
 *     name, as-is (`info.rawFinish`, `info.providerState`, `part.executed`,
 *     `part.time.ran`, `state.content`, …);
 *   - a 2.x field whose 1.x counterpart has the same value is not repeated;
 *   - objects both engines write (`time`, `tokens`, `error`, tool `state` and
 *     `metadata`) are merged key by key, so the 2.x keys sit next to the 1.x ones;
 *   - a 2.x value under a name the 1.x record already uses with another value
 *     or shape (a patch's native file list, a streaming tool's status) goes
 *     under `v2.<name>` on the same record, so the 1.x value keeps its place;
 *     a tool's native input keeps there only the entries the 1.x input lacks
 *     (`state.v2.input.path` next to `state.input.filePath`);
 *   - 2.x records 1.x never listed (agent/model/location switches, system
 *     context, idle markers with the turn outcome) become parts of the nearest
 *     conversation message, typed by their 2.x type (`"model-switched"`, …);
 *   - a `data:` URI the 1.x record already carries byte for byte (an image
 *     prompt's file part, a tool attachment) is written once: the 2.x copy
 *     says `sameAs:<where>` instead of repeating the bytes.
 */
import type { V1Message } from "./shapes.js";
import { isRecord, promptFileUrl, type JsonRecord } from "./util.js";

/** Where a 2.x value goes when its name is taken on the 1.x record by another value. */
export const NATIVE_COLLISIONS = "v2";

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => deepEqual(item, other[index]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((key) => deepEqual((a as JsonRecord)[key], (b as JsonRecord)[key]));
}

/**
 * Adds `native`'s fields to `target` (see the module comment). `nested` names
 * the keys whose objects are merged key by key; its value gives the keys to
 * merge one level further down. Objects in `target` are copied before they
 * change, so a 1.x value shared between records is never altered.
 */
export function mergeNative(target: JsonRecord, native: JsonRecord, nested: Record<string, Record<string, unknown>> = {}): JsonRecord {
  for (const [key, value] of Object.entries(native)) {
    if (value === undefined || key === NATIVE_COLLISIONS) continue;
    if (!(key in target)) {
      target[key] = value;
      continue;
    }
    const current = target[key];
    if (deepEqual(current, value)) continue;
    if (key in nested && isRecord(current) && isRecord(value)) {
      target[key] = mergeNative({ ...current }, value, nested[key] as Record<string, Record<string, unknown>>);
      continue;
    }
    const bucket: JsonRecord = isRecord(target[NATIVE_COLLISIONS]) ? { ...(target[NATIVE_COLLISIONS] as JsonRecord) } : {};
    bucket[key] = value;
    target[NATIVE_COLLISIONS] = bucket;
  }
  return target;
}

/** `value`, with `data:` URIs the 1.x record already holds (`known`: uri → where) written as `sameAs:<where>`. */
function elideKnownDataUris(value: unknown, known: Map<string, string>): unknown {
  if (known.size === 0) return value;
  if (typeof value === "string") return value.startsWith("data:") && known.has(value) ? `sameAs:${known.get(value)}` : value;
  if (Array.isArray(value)) return value.map((item) => elideKnownDataUris(item, known));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, elideKnownDataUris(item, known)]));
}

function without(record: JsonRecord, ...keys: string[]): JsonRecord {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

const STATE_NESTED = { metadata: {}, time: {} };
const INFO_NESTED = { time: {}, tokens: { cache: {} }, error: { data: {} } };

/** Adds a 2.x content entry's own fields to the 1.x part built from it. */
function enrichPart(part: JsonRecord, entry: JsonRecord): void {
  if (part.type === "tool") {
    const state = isRecord(part.state) ? part.state : undefined;
    const known = new Map<string, string>();
    const attachments = state && Array.isArray(state.attachments) ? state.attachments : [];
    attachments.forEach((attachment, index) => {
      if (isRecord(attachment) && typeof attachment.url === "string") known.set(attachment.url, `state.attachments[${index}].url`);
    });
    const native = elideKnownDataUris(entry, known) as JsonRecord;
    // The call id is the 1.x `callID`; the part keeps its own id.
    const { id: callID, state: nativeState, ...rest } = native;
    mergeNative(part, rest);
    if (callID !== part.callID) mergeNative(part, { id: callID });
    if (state && isRecord(nativeState)) {
      const merged = mergeNative({ ...state }, nativeState, STATE_NESTED);
      // A native input differs from the 1.x one by its key names (`path` for `filePath`, `agent` for
      // `subagent_type`): only the native entries the 1.x input lacks are kept, so no value is written twice.
      const bucket = isRecord(merged[NATIVE_COLLISIONS]) ? (merged[NATIVE_COLLISIONS] as JsonRecord) : undefined;
      if (bucket && isRecord(bucket.input) && isRecord(state.input)) {
        const v1Input = state.input as JsonRecord;
        bucket.input = Object.fromEntries(Object.entries(bucket.input).filter(([key, value]) => !deepEqual(v1Input[key], value)));
      }
      part.state = merged;
    }
    return;
  }
  mergeNative(part, entry, { time: {} });
}

/** A 2.x assistant message's fields (and those of its content entries) on its 1.x message. */
export function enrichAssistant(message: V1Message, native: JsonRecord): void {
  message.info = mergeNative({ ...message.info }, without(native, "content"), INFO_NESTED);
  const content = Array.isArray(native.content) ? native.content.filter(isRecord) : [];
  const ordinals = { text: 0, reasoning: 0 };
  const byId = new Map(message.parts.map((part) => [String(part.id), part]));
  const core = String(message.info.id).replace(/^msg_/, "");
  for (const entry of content) {
    let id: string | undefined;
    if (entry.type === "text") id = `prt_${core}_t${ordinals.text++}`;
    else if (entry.type === "reasoning") id = `prt_${core}_r${ordinals.reasoning++}`;
    else if (entry.type === "tool" && typeof entry.id === "string") id = `prt_${core}_c_${entry.id}`;
    const part = id ? byId.get(id) : undefined;
    if (part) enrichPart(part, entry);
  }
}

/** A 2.x user (or synthetic) message's fields on its 1.x message; native file entries on the file parts. */
export function enrichPrompt(message: V1Message, native: JsonRecord): void {
  const known = new Map<string, string>();
  message.parts.forEach((part, index) => {
    if (part.type === "file" && typeof part.url === "string") known.set(part.url, `parts[${index}].url`);
  });
  // Inline file bytes the file part already holds as its `data:` URL are not repeated.
  const files = (Array.isArray(native.files) ? native.files : []).map((file) => {
    if (!isRecord(file) || typeof file.data !== "string" || typeof file.uri === "string") return file;
    const url = promptFileUrl(file);
    const where = url ? known.get(url) : undefined;
    return where ? { ...file, data: `sameAs:${where}` } : file;
  });
  if (Array.isArray(native.files)) native = { ...native, files };
  message.info = mergeNative({ ...message.info }, elideKnownDataUris(native, known) as JsonRecord, INFO_NESTED);
  const fileParts = message.parts.filter((part) => part.type === "file");
  files.forEach((file, index) => {
    const part = fileParts[index];
    if (!part || !isRecord(file)) return;
    // Inline bytes stay on the message's `files` (the part's `data:` URL holds them), and the
    // engine's `source: {type: "inline"}` is not a 1.x file source (a path the UI shows as a
    // document), so neither goes on the part.
    const { uri, data: _data, source, ...rest } = file;
    const v1Source = isRecord(source) && ["file", "symbol", "resource"].includes(String(source.type));
    mergeNative(part, v1Source ? { ...rest, source } : rest);
    if (uri !== part.url) mergeNative(part, { uri });
  });
}

/** 2.x records the 1.x engine never listed, as parts of the nearest conversation message. */
const CONTEXT_TYPES = new Set(["agent-switched", "model-switched", "location-switched", "system", "idle"]);

export function isContextRecord(native: JsonRecord): boolean {
  return CONTEXT_TYPES.has(String(native.type));
}

/**
 * Adds the 2.x fields to the 1.x messages mapped from `natives` (`mapped`
 * names the 1.x messages each native message became) and places the context
 * records: an idle marker closes the message before it, every other record
 * joins the message after it (the last message when none follows).
 */
export function withNativeFields(messages: V1Message[], natives: JsonRecord[], mapped: Map<JsonRecord, V1Message[]>, sessionID: string): V1Message[] {
  const pending: JsonRecord[] = [];
  let previous: V1Message | undefined;
  const attach = (host: V1Message, record: JsonRecord, atEnd: boolean) => {
    const part = { ...record, sessionID, messageID: host.info.id };
    host.parts = atEnd ? [...host.parts, part] : [part, ...host.parts];
  };
  for (const native of natives) {
    if (isContextRecord(native)) {
      if (native.type === "idle" && previous) attach(previous, native, true);
      else pending.push(native);
      continue;
    }
    const targets = mapped.get(native) ?? [];
    if (targets.length === 0) continue;
    const type = String(native.type);
    if (type === "assistant") enrichAssistant(targets[0]!, native);
    else if (type === "user" || type === "synthetic" || type === "skill") enrichPrompt(targets[0]!, native);
    else {
      // shell and compaction became a prompt and a reply: the reply carries the record's fields.
      const reply = targets[targets.length - 1]!;
      reply.info = mergeNative({ ...reply.info }, native, INFO_NESTED);
    }
    for (const record of pending.splice(0).reverse()) attach(targets[0]!, record, false);
    previous = targets[targets.length - 1];
  }
  if (pending.length && messages.length) for (const record of pending) attach(messages[messages.length - 1]!, record, true);
  return messages;
}
