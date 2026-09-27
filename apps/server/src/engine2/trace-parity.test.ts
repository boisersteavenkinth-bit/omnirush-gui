import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createSessionObservers, observeCollectedSession, type EngineTarget, type ObservedCollector, type ObserverTiming } from "../collector-observer.js";
import type { CollectorChildSession } from "../workspace-collector.js";
import { startEngineFacade, type EngineFacade } from "./facade.js";

/**
 * The uploaded trace does not depend on the engine: the turn observer
 * (collector-observer.ts) follows the same recorded conversation (two
 * parallel sub-agents, fixtures/*-sub.json) once on the 1.x engine and once
 * on the 2.x engine behind the engine adapter, and hands the collector the
 * same trace events, carrying messages and sub-agent sessions with the same
 * fields.
 */

type Tree = { session: Record<string, unknown>; messages: Array<Record<string, unknown>>; children: Tree[] };
const fixture = (name: string): Tree => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"));

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

const NATIVE_PART_TYPES = new Set(["agent-switched", "model-switched", "location-switched", "system", "idle"]);

/**
 * What the 2.x trace lacks or changes against the 1.x trace (the 2.x
 * engine's own fields and parts are additions, engine2/native.ts, and are
 * not reported).
 */
function shapeDiff(a: unknown, b: unknown, path = "$", out: string[] = []): string[] {
  if (typeOf(a) !== typeOf(b)) {
    out.push(`${path}: ${typeOf(a)} != ${typeOf(b)}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const right = path.endsWith(".parts") ? b.filter((part) => !NATIVE_PART_TYPES.has(String((part as { type?: string }).type))) : b;
    if (a.length !== right.length) out.push(`${path}: length ${a.length} != ${right.length}`);
    for (let index = 0; index < Math.min(a.length, right.length); index++) shapeDiff(a[index], right[index], `${path}[${index}]`, out);
    return out;
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const key of ka) if (!kb.includes(key)) out.push(`${path}.${key}: only on 1.x`);
    for (const key of ka) if (kb.includes(key)) shapeDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, out);
  }
  return out;
}

const stops: Array<() => unknown> = [];
afterAll(async () => {
  while (stops.length) await stops.pop()?.();
});

function page(url: URL, list: unknown[]): Response {
  const limit = Number(url.searchParams.get("limit") ?? 0);
  if (!limit) return Response.json(list);
  const end = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : list.length;
  const start = Math.max(0, end - limit);
  return Response.json(list.slice(start, end), start > 0 ? { headers: { "X-Next-Cursor": String(start) } } : {});
}

function flatten(tree: Tree, out: Tree[] = []): Tree[] {
  out.push(tree);
  for (const child of tree.children) flatten(child, out);
  return out;
}

/** The 1.x engine's routes the observer reads, serving a recorded 1.x conversation. */
function startV1Engine(tree: Tree): EngineTarget {
  const sessions = new Map(flatten(tree).map((node) => [String(node.session.id), node]));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/session/status") return Response.json({});
      const match = url.pathname.match(/^\/session\/([^/]+)(?:\/(message|children))?$/);
      const node = match ? sessions.get(decodeURIComponent(match[1]!)) : undefined;
      if (!node) return Response.json({ name: "NotFoundError" }, { status: 404 });
      if (match![2] === "message") return page(url, node.messages);
      if (match![2] === "children") return Response.json(node.children.map((child) => child.session));
      return Response.json(node.session);
    },
  });
  stops.push(() => server.stop(true));
  return { baseUrl: `http://127.0.0.1:${server.port}`, headers: [], search: "", engine: "v1" };
}

/** The 2.x engine's routes the adapter reads, serving the same conversation recorded on 2.x. */
async function startV2Engine(tree: Tree): Promise<EngineTarget> {
  const sessions = new Map(flatten(tree).map((node) => [String(node.session.id), node]));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/event") return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
      if (url.pathname === "/api/session/active") return Response.json({ data: {} });
      if (url.pathname === "/api/session") {
        const parent = url.searchParams.get("parentID");
        const node = parent ? sessions.get(parent) : undefined;
        return Response.json({ data: node ? node.children.map((child) => child.session) : [], cursor: {} });
      }
      const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(message|diff))?$/);
      const node = match ? sessions.get(decodeURIComponent(match[1]!)) : undefined;
      if (!node) return Response.json({ name: "NotFoundError" }, { status: 404 });
      if (match![2] === "message") {
        const list = url.searchParams.get("order") === "desc" ? [...node.messages].reverse() : node.messages;
        return Response.json({ data: list.slice(0, Number(url.searchParams.get("limit") ?? 50)), cursor: {} });
      }
      if (match![2] === "diff") return Response.json({ data: [] });
      return Response.json({ data: node.session });
    },
  });
  stops.push(() => upstream.stop(true));
  const facade: EngineFacade = await startEngineFacade({
    upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    upstreamPassword: "pw",
    username: "u",
    password: "p",
    version: "2.0.18",
    defaultDirectory: "/work/proj",
  });
  stops.push(() => facade.close());
  return { baseUrl: facade.url, headers: [["authorization", `Basic ${Buffer.from("u:p").toString("base64")}`]], search: "", engine: "v1" };
}

type Entry =
  | { kind: "trace"; type: string; data?: unknown }
  | { kind: "model"; model: unknown }
  | { kind: "child"; child: CollectorChildSession }
  | { kind: "flush"; final?: unknown };

class RecordingCollector implements ObservedCollector {
  readonly enabled = true;
  readonly entries: Entry[] = [];
  async sessionCheckpoint() {
    return { resumed: false };
  }
  async setSessionCheckpoint() {}
  recordTrace(_sessionId: string, type: string, data?: unknown) {
    this.entries.push({ kind: "trace", type, ...(data === undefined ? {} : { data }) });
  }
  recordSessionModel(_sessionId: string, model: unknown) {
    this.entries.push({ kind: "model", model });
  }
  async childCheckpoints() {
    return {};
  }
  async childSessionIds() {
    return [];
  }
  recordChildSession(_sessionId: string, child: CollectorChildSession) {
    this.entries.push({ kind: "child", child });
  }
  captureSnapshot() {}
  flushTrace(_sessionId: string, final?: unknown) {
    this.entries.push({ kind: "flush", ...(final === undefined ? {} : { final }) });
  }
}

const timing: Partial<ObserverTiming> = { sleep: async () => undefined };

async function observe(target: EngineTarget, sessionId: string): Promise<RecordingCollector> {
  const collector = new RecordingCollector();
  const archive = { turnFollowed: () => undefined, turnCompleted: () => undefined, turnIncomplete: () => undefined };
  await observeCollectedSession({ collector, archive, observers: createSessionObservers(), sessionId, target, timing });
  return collector;
}

/** Sub-agents start concurrently: children are compared by the task they were given. */
function childKey(child: CollectorChildSession): string {
  const first = (child.messages as Array<{ parts?: Array<{ text?: string }> }>)[0];
  return String(first?.parts?.[0]?.text ?? "");
}

describe("the uploaded trace over the 2.x engine matches the 1.x engine's", () => {
  test("two parallel sub-agents: same events, messages and sub-agent sessions", async () => {
    const v1 = fixture("v1-sub");
    const v2 = fixture("v2-sub");
    // As the engine records it in the app: no variant picked reads as "default" on each step.
    for (const node of flatten(v2)) for (const message of node.messages) if (message.type === "assistant" && message.model && typeof message.model === "object") (message.model as Record<string, unknown>).variant = "default";
    const before = await observe(startV1Engine(v1), String(v1.session.id));
    const after = await observe(await startV2Engine(v2), String(v2.session.id));
    const labels = (collector: RecordingCollector) => collector.entries.map((entry) => (entry.kind === "trace" ? entry.type : entry.kind));
    expect(labels(after)).toEqual(labels(before));
    expect(labels(after)).toContain("child");

    const final = (collector: RecordingCollector) => (collector.entries.find((entry) => entry.kind === "flush" && entry.final !== undefined) as { final: { messages: unknown[] } }).final;
    expect(shapeDiff(final(before).messages, final(after).messages)).toEqual([]);

    const children = (collector: RecordingCollector) => collector.entries
      .flatMap((entry) => (entry.kind === "child" ? [entry.child] : []))
      .sort((a, b) => childKey(a).localeCompare(childKey(b)));
    const [left, right] = [children(before), children(after)];
    expect(right.length).toBe(2);
    left.forEach((child, index) => {
      const other = right[index]!;
      expect(Object.keys(other).sort()).toEqual(Object.keys(child).sort());
      expect(other.agent).toBe(child.agent);
      expect(String(other.title)).toMatch(/\(@general subagent\)$/);
      expect(shapeDiff(child.messages, other.messages)).toEqual([]);
    });

    // The session.model event: the same provider, model, variant and agent.
    const model = (collector: RecordingCollector) => collector.entries.find((entry) => entry.kind === "model");
    expect(model(after)).toBeDefined();
    expect(model(after)).toEqual(model(before));
  });
});
