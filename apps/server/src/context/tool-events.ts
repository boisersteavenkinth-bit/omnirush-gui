// The engine's tool-call events for capture context (#20): every tool part
// of a session as it starts running and as it ends, from the opencode event
// stream (v1 `/event` `message.part.updated`; v2 `/api/event`
// `session.tool.*`). A shell call's start reaches ContextCapture.toolEvent
// before its process is spawned, so the network observer can sample it from
// its first milliseconds. Identical in the CLI and the desktop app.

import { sseFrames } from "../session-archive/tool-start.js";
import type { ToolEvent } from "./index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** A tool start or end of one session, or null when `payload` is not one. */
export function toolEventOf(payload: unknown): { sessionId: string; event: ToolEvent } | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.payload) && typeof payload.payload.type === "string") return toolEventOf(payload.payload);
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "message.part.updated") {
    const properties = isRecord(payload.properties) ? payload.properties : null;
    const part = properties && isRecord(properties.part) ? properties.part : null;
    if (!part || part.type !== "tool") return null;
    const state = isRecord(part.state) ? part.state : {};
    const status = state.status === "running" || state.status === "pending" ? "running" : state.status === "completed" ? "completed" : state.status === "error" ? "error" : null;
    const sessionId = text(part.sessionID);
    const callId = text(part.callID) ?? text(part.id);
    const tool = text(part.tool);
    if (!status || !sessionId || !callId || !tool) return null;
    const input = isRecord(state.input) ? state.input : {};
    const time = isRecord(state.time) ? state.time : {};
    const at = status === "running" ? (typeof time.start === "number" ? time.start : undefined) : typeof time.end === "number" ? time.end : undefined;
    return { sessionId, event: { callId, tool, status, command: text(input.command), workdir: text(input.workdir) ?? text(input.cwd), ...(at !== undefined ? { at } : {}) } };
  }
  const v2 = /^session\.(?:next\.)?tool\.(input\.started|called|completed|failed|error|result)$/.exec(type);
  if (v2) {
    const data = isRecord(payload.data) ? payload.data : isRecord(payload.properties) ? payload.properties : null;
    if (!data) return null;
    const sessionId = text(data.sessionID);
    const callId = text(data.callID) ?? text(data.toolCallID) ?? text(data.id);
    const tool = text(data.tool) ?? text(data.name);
    if (!sessionId || !callId || !tool) return null;
    const input = isRecord(data.input) ? data.input : {};
    const status = v2[1] === "input.started" || v2[1] === "called" ? "running" : v2[1] === "completed" || v2[1] === "result" ? "completed" : "error";
    return { sessionId, event: { callId, tool, status, command: text(input.command), workdir: text(input.workdir) ?? text(input.cwd) } };
  }
  return null;
}

export type ToolEventFetch = (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;

const MAX_FRAME_CHARS = 4 * 1024 * 1024;

/** Follows the event stream until `signal` aborts, handing each tool event of `sessionId` to `onEvent`. Never throws. */
export async function watchToolEvents(input: {
  url: string;
  headers: Headers;
  sessionId: string;
  signal: AbortSignal;
  fetch: ToolEventFetch;
  onEvent: (event: ToolEvent) => void;
}): Promise<void> {
  if (input.signal.aborted) return;
  try {
    const headers = new Headers(input.headers);
    headers.set("accept", "text/event-stream");
    const response = await input.fetch(input.url, { headers, signal: input.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = sseFrames(buffer);
      buffer = rest.length > MAX_FRAME_CHARS ? "" : rest;
      for (const raw of payloads) {
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        const found = toolEventOf(payload);
        if (found && found.sessionId === input.sessionId) {
          try {
            input.onEvent(found.event);
          } catch {
            // Capture never stops the stream.
          }
        }
      }
    }
  } catch {
    // Aborted, or the engine went away.
  }
}
