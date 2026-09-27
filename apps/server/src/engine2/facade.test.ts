import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEngineFacade, type EngineFacade } from "./facade.js";

type Tree = { session: Record<string, unknown>; messages: Array<Record<string, unknown>>; children: Tree[] };
const tree: Tree = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "v2-p1.json"), "utf8"));
const SESSION = String(tree.session.id);
const DIRECTORY = "/work/proj";

type Recorded = { method: string; path: string; query: Record<string, string>; body: unknown };
const recorded: Recorded[] = [];
let eventSink: ((event: unknown) => void) | null = null;
let upstream: ReturnType<typeof Bun.serve>;
let facade: EngineFacade;
let configDir = "";
const written: unknown[] = [];

const auth = { authorization: `Basic ${Buffer.from("user:secret").toString("base64")}`, "x-opencode-directory": encodeURIComponent(DIRECTORY) };
const get = (path: string) => fetch(`${facade.url}${path}`, { headers: auth });
const post = (path: string, body: unknown) => fetch(`${facade.url}${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "facade-test-"));
  const v1Config = join(configDir, "runtime.json");
  writeFileSync(v1Config, JSON.stringify({ model: "mock/mock-model", provider: { mock: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://x/v1" }, models: { "mock-model": {} } } } }));
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:engine-pw").toString("base64")}`) return new Response("", { status: 401 });
      const query = Object.fromEntries(url.searchParams);
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      recorded.push({ method: request.method, path: url.pathname, query, body });
      const json = (value: unknown, status = 200) => Response.json(value, { status });
      if (url.pathname === "/api/event") {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            eventSink = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            eventSink({ id: "evt_0", type: "server.connected", data: {} });
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === `/api/session/${SESSION}` && request.method === "GET") return json({ data: tree.session });
      if (url.pathname === `/api/session/${SESSION}/message`) {
        const messages = query.order === "desc" ? [...tree.messages].reverse() : tree.messages;
        return json({ data: messages.slice(0, Number(query.limit ?? 50)), cursor: {} });
      }
      if (url.pathname === "/api/session/active") return json({ data: {} });
      if (url.pathname === "/api/session" && request.method === "POST") return json({ data: { ...tree.session, id: "ses_new", title: undefined } });
      if (url.pathname === "/api/permission/request") {
        return json({ location: { directory: DIRECTORY }, data: [{ id: "per_1", sessionID: SESSION, action: "shell", resources: ["rm -rf build"], metadata: {} }] });
      }
      if (url.pathname === "/api/mcp") return json({ location: { directory: DIRECTORY }, data: [{ name: "cloud", status: { status: "connected" } }, { name: "broken", status: { status: "failed", error: "boom" } }] });
      if (url.pathname === "/api/agent") return json({ location: { directory: DIRECTORY }, data: [{ id: "general", description: "General", mode: "subagent", permissions: [{ action: "subagent", resource: "*", effect: "allow" }] }] });
      if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") return new Response(null, { status: 204 });
      return json({ data: null }, 404);
    },
  });
  facade = await startEngineFacade({
    upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    upstreamPassword: "engine-pw",
    username: "user",
    password: "secret",
    version: "2.0.18",
    defaultDirectory: DIRECTORY,
    v1ConfigPath: v1Config,
    writeEngineConfig: async (config) => {
      written.push(config);
    },
  });
});

afterAll(async () => {
  await facade?.close();
  upstream?.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

describe("1.x engine adapter over the 2.x engine", () => {
  test("requires the per-boot Basic credentials", async () => {
    const response = await fetch(`${facade.url}/global/health`);
    expect(response.status).toBe(401);
    expect(await (await get("/global/health")).json()).toEqual({ healthy: true, version: "2.0.18" });
  });

  test("renders the engine config from the 1.x runtime file at start", () => {
    const config = written.at(-1) as Record<string, unknown>;
    expect(config.model).toBe("mock/mock-model");
    expect((config.providers as Record<string, { package: string }>).mock.package).toBe("@opencode/ai/providers/openai-compatible");
  });

  test("message pages read newest first with the 1.x cursor", async () => {
    const all = (await (await get(`/session/${SESSION}/message`)).json()) as Array<{ info: { id: string; role: string } }>;
    expect(all.map((message) => message.info.role)).toEqual(["user", "assistant", "assistant", "assistant", "assistant"]);
    const page = await get(`/session/${SESSION}/message?limit=2`);
    const newest = (await page.json()) as Array<{ info: { id: string } }>;
    expect(newest.map((message) => message.info.id)).toEqual(all.slice(3).map((message) => message.info.id));
    const cursor = page.headers.get("x-next-cursor");
    expect(cursor).toBeTruthy();
    const older = (await (await get(`/session/${SESSION}/message?limit=2&before=${cursor}`)).json()) as Array<{ info: { id: string } }>;
    expect(older.map((message) => message.info.id)).toEqual(all.slice(1, 3).map((message) => message.info.id));
    const one = (await (await get(`/session/${SESSION}/message/${all[0]!.info.id}`)).json()) as { info: { role: string } };
    expect(one.info.role).toBe("user");
  });

  test("a session reads with the agent and model of its latest step", async () => {
    const info = (await (await get(`/session/${SESSION}`)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ id: SESSION, directory: DIRECTORY, agent: "build", model: { id: "mock-model", providerID: "mock", variant: "default" }, version: "2.0.18" });
  });

  test("prompt_async applies model, variant, agent and system, then sends text and files", async () => {
    recorded.length = 0;
    const response = await post(`/session/${SESSION}/prompt_async`, {
      messageID: "msg_client_1",
      model: { providerID: "omnirush", modelID: "gpt-6-astra" },
      variant: "high",
      agent: "omnirush",
      system: "Extra system",
      parts: [
        { type: "text", text: "hello" },
        { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" },
      ],
    });
    expect(response.status).toBe(204);
    const calls = recorded.map((call) => `${call.method} ${call.path}`);
    expect(calls).toEqual([
      `POST /api/session/${SESSION}/model`,
      `POST /api/session/${SESSION}/agent`,
      `PUT /api/experimental/session/${SESSION}/instructions/entries/omnirush.system`,
      `POST /api/session/${SESSION}/prompt`,
    ]);
    expect(recorded[0]!.body).toEqual({ model: { providerID: "omnirush", id: "gpt-6-astra", variant: "high" } });
    expect(recorded[1]!.body).toEqual({ agent: "omnirush" });
    expect(recorded[2]!.body).toEqual({ value: "Extra system" });
    expect(recorded[3]!.body).toEqual({ id: "msg_client_1", text: "hello", files: [{ uri: "data:image/png;base64,AAAA", name: "a.png" }] });
    // The same selection is not sent again.
    recorded.length = 0;
    await post(`/session/${SESSION}/prompt_async`, { model: { providerID: "omnirush", modelID: "gpt-6-astra" }, variant: "high", agent: "omnirush", system: "Extra system", parts: [{ type: "text", text: "again" }] });
    expect(recorded.map((call) => call.path)).toEqual([`/api/session/${SESSION}/prompt`]);
  });

  test("permissions list and reply in 1.x form", async () => {
    const list = (await (await get("/permission")).json()) as Array<Record<string, unknown>>;
    expect(list).toEqual([{ id: "per_1", sessionID: SESSION, permission: "bash", patterns: ["rm -rf build"], metadata: {}, always: ["rm -rf build"] }]);
    recorded.length = 0;
    expect((await post("/permission/per_1/reply", { reply: "always" })).status).toBe(200);
    expect(recorded.at(-1)).toMatchObject({ method: "POST", path: `/api/session/${SESSION}/permission/per_1/reply`, body: { decision: "always" } });
  });

  test("MCP status and agents in 1.x form", async () => {
    expect(await (await get("/mcp")).json()).toEqual({ cloud: { status: "connected" }, broken: { status: "failed", error: "boom" } });
    const agents = (await (await get("/agent")).json()) as Array<Record<string, unknown>>;
    expect(agents).toEqual([{ name: "general", description: "General", mode: "subagent", permission: [{ permission: "task", pattern: "*", action: "allow" }], options: {} }]);
  });

  test("provider keys delivered at runtime reach the engine config", async () => {
    expect((await fetch(`${facade.url}/auth/mock`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ type: "api", key: "sk-1" }) })).status).toBe(200);
    const config = written.at(-1) as { providers: Record<string, { settings: Record<string, unknown> }> };
    expect(config.providers.mock.settings.apiKey).toBe("sk-1");
  });

  test("the event stream speaks 1.x and keeps to the request's directory", async () => {
    const controller = new AbortController();
    const response = await fetch(`${facade.url}/event`, { headers: auth, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const pump = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
        }
      }
    })().catch(() => undefined);
    await Bun.sleep(100);
    eventSink!({ type: "session.execution.started", location: { directory: "/elsewhere" }, data: { sessionID: "ses_other" } });
    eventSink!({ type: "session.execution.started", location: { directory: DIRECTORY }, data: { sessionID: SESSION } });
    eventSink!({ type: "session.execution.succeeded", location: { directory: DIRECTORY }, data: { sessionID: SESSION } });
    await Bun.sleep(200);
    controller.abort();
    await pump;
    const mine = events.filter((event) => event.type !== "server.connected" && event.type !== "server.heartbeat");
    expect(mine.map((event) => `${event.type}:${String(event.properties.sessionID)}`)).toEqual([
      `session.status:${SESSION}`,
      `session.status:${SESSION}`,
      `session.idle:${SESSION}`,
    ]);
  });
});
