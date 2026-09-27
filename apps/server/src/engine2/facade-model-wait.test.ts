import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEngineFacade, type EngineFacade } from "./facade.js";

// A prompt for a model the engine does not serve yet: the omnirush.ai catalog
// arrived after launch and the engine is still applying it live.
const DIRECTORY = "/work/proj";
const SESSION = "ses_wait";

type Recorded = { method: string; path: string; body: unknown };
const recorded: Recorded[] = [];
/** The `provider/model` pairs the mock engine lists at GET /api/model. */
const served = new Set<string>(["omnirush/gpt-6-astra", "mock/mock-model"]);
let modelLookups = 0;
let upstream: ReturnType<typeof Bun.serve>;
let facade: EngineFacade;
let configDir = "";

const auth = { authorization: `Basic ${Buffer.from("user:secret").toString("base64")}`, "x-opencode-directory": encodeURIComponent(DIRECTORY) };
const post = (path: string, body: unknown) => fetch(`${facade.url}${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
const prompt = (modelID: string, providerID = "omnirush") => post(`/session/${SESSION}/prompt_async`, {
  model: { providerID, modelID },
  agent: "omnirush",
  parts: [{ type: "text", text: "hello" }],
});
const sent = () => recorded.filter((call) => call.path === `/api/session/${SESSION}/prompt`).length;

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "facade-model-wait-"));
  const v1Config = join(configDir, "runtime.json");
  writeFileSync(v1Config, JSON.stringify({
    model: "omnirush/gpt-6-astra",
    provider: { omnirush: { npm: "@ai-sdk/openai", options: { baseURL: "http://127.0.0.1:1/v1" }, models: { "gpt-6-astra": {} } } },
  }));
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      recorded.push({ method: request.method, path: url.pathname, body });
      if (url.pathname === "/api/event") return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
      if (url.pathname === "/api/model") {
        modelLookups += 1;
        return Response.json({
          location: { directory: DIRECTORY },
          data: [...served].map((key) => {
            const [providerID, id] = key.split("/");
            return { id, providerID, name: id, capabilities: { tools: true, input: ["text"], output: ["text"] } };
          }),
        });
      }
      if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ data: null }, { status: 404 });
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
    writeEngineConfig: async () => undefined,
    modelWaitMs: 1_500,
  });
});

afterAll(async () => {
  await facade?.close();
  upstream?.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

describe("a prompt for a model the engine does not serve yet", () => {
  test("a served model is sent at once", async () => {
    recorded.length = 0;
    expect((await prompt("gpt-6-astra")).status).toBe(204);
    expect(sent()).toBe(1);
  });

  test("waits while the engine applies the new catalog, then starts the turn", async () => {
    recorded.length = 0;
    const started = Date.now();
    setTimeout(() => served.add("omnirush/muse-spark-1.1"), 400);
    const response = await prompt("muse-spark-1.1");
    expect(response.status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    // The session model is only switched once the engine serves it, then the prompt goes out.
    const calls = recorded.filter((call) => call.method !== "GET").map((call) => call.path);
    expect(calls).toEqual([`/api/session/${SESSION}/model`, `/api/session/${SESSION}/prompt`]);
  });

  test("a model still missing after the wait is refused with a clear error, never sent", async () => {
    recorded.length = 0;
    const response = await prompt("muse-spark-9");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { name: string; data: { message: string } };
    expect(body.name).toBe("ProviderModelNotFoundError");
    expect(body.data.message).toContain("omnirush/muse-spark-9 is not available yet");
    expect(sent()).toBe(0);
    expect(recorded.some((call) => call.path === `/api/session/${SESSION}/model` && call.method === "POST")).toBe(false);
  });

  test("a provider the runtime config does not define is not held", async () => {
    recorded.length = 0;
    const lookups = modelLookups;
    expect((await prompt("some-model", "elsewhere")).status).toBe(204);
    expect(modelLookups).toBe(lookups);
    expect(sent()).toBe(1);
  });
});
