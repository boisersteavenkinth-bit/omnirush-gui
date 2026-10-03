import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createManagedOpencodeServer, type ManagedOpencodeServer } from "../managed-opencode.js";
import { buildOmniRushRuntimeConfigObjectFromSnapshot } from "../omnirush-runtime-config.js";

/**
 * A reload (`/instance/dispose`) that lands while the model is still writing
 * the reply that starts a sub-agent, on the real 2.x engine (the bundled
 * sidecar behind the 1.x adapter) with the desktop's runtime config and a
 * mock provider.
 *
 * A 2.x location reload closes the location under the running step, and
 * every tool call of that step is then declined with "Interaction cancelled
 * because the location shut down": the subagent call failed before it made
 * its child session. The adapter now defers the reload until no session
 * runs, so the sub-agent starts as a child of the main session.
 *
 * Skipped when the sidecar binary is not present (prepare:sidecar not run).
 */

const repoRoot = resolve(import.meta.dir, "../../../..");
const sidecarDir = join(repoRoot, "apps/desktop/resources/sidecars");
function findSidecar(): string | null {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const name = process.platform === "darwin" ? `opencode-${arch}-apple-darwin` : process.platform === "linux" ? `opencode-${arch}-unknown-linux-gnu` : "";
  const candidate = join(sidecarDir, name);
  return name && existsSync(candidate) ? candidate : null;
}
const enginePath = findSidecar();
const describeMaybe = enginePath ? describe : describe.skip;

type Body = { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ type: string; function: { name: string } }> };
type V1Part = { type: string; tool?: string; text?: string; state?: { status?: string; error?: string; output?: string } };
type V1Message = { info: { id: string; role: string; time?: { completed?: number } }; parts: V1Part[] };

const CHILD_MARK = "CHILD-RELOAD-51c2";

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}
function sse(chunks: object[]): Response {
  const frame = (payload: object) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", ...payload })}\n\n`;
  const body = chunks.map((choice) => frame({ choices: [choice] })).join("")
    + frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
    + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const say = (content: string) => sse([{ index: 0, delta: { role: "assistant", content } }, { index: 0, delta: {}, finish_reason: "stop" }]);
const callSubagent = () => sse([
  { index: 0, delta: { role: "assistant", content: "" } },
  { index: 0, delta: { tool_calls: [{ index: 0, id: "call_sub_1", type: "function", function: { name: "subagent", arguments: JSON.stringify({ agent: "general", description: "Inspect", prompt: `${CHILD_MARK}: reply with one word.` }) } }] } },
  { index: 0, delta: {}, finish_reason: "tool_calls" },
]);

describeMaybe("a reload while a sub-agent starts (2.x engine, mock provider)", () => {
  let engine: ManagedOpencodeServer;
  let provider: ReturnType<typeof Bun.serve>;
  let work = "";
  let data = "";
  /** Set while the mock provider holds the main reply that starts the sub-agent. */
  let mainReplyHeld = false;

  const engineFetch = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`);
    headers.set("x-opencode-directory", encodeURIComponent(work));
    if (init?.body) headers.set("content-type", "application/json");
    return fetch(`${engine.url}${path}`, { ...init, headers });
  };
  const getJson = async <T>(path: string): Promise<T> => (await (await engineFetch(path)).json()) as T;
  const waitFor = async <T>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, label: string, ms = 60_000): Promise<T> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await Promise.resolve(read()).catch(() => null);
      if (value) return value as T;
      await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "subagent-reload-ws-"));
    data = mkdtempSync(join(tmpdir(), "subagent-reload-data-"));
    provider = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Body) : {};
        if (url.pathname.startsWith("/managed-policy")) return Response.json({ allowed: true, approvalMode: "guarded" });
        if (!url.pathname.startsWith("/v1/")) return Response.json({});
        if (!Array.isArray(body.tools) || body.tools.length === 0) return say("Reload title");
        const messages = body.messages ?? [];
        if (messages.some((message) => message.role === "user" && text(message.content).includes(CHILD_MARK))) return say("child done");
        if (messages.at(-1)?.role === "tool") return say("All done.");
        mainReplyHeld = true;
        await Bun.sleep(2_500);
        mainReplyHeld = false;
        return callSubagent();
      },
    });
    const base = `http://127.0.0.1:${provider.port}`;
    // The desktop's own runtime config (guarded approvals, the omnirush agent and plugins) with a mock provider.
    const config = buildOmniRushRuntimeConfigObjectFromSnapshot({
      provider: {
        mock: { name: "Mock", npm: "@ai-sdk/openai-compatible", options: { baseURL: `${base}/v1`, apiKey: "mock-key" }, models: { "mock-model": { name: "Mock", tool_call: true, limit: { context: 100_000, output: 4_000 } } } },
      },
    }, undefined, {});
    const configPath = join(data, "runtime-opencode-config.json");
    writeFileSync(configPath, JSON.stringify({ ...config, model: "mock/mock-model" }));
    engine = await createManagedOpencodeServer({
      bin: enginePath!,
      cwd: work,
      env: {
        OPENCODE_CONFIG: configPath,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OMNIRUSH_ENGINE2_CONFIG_DIR: join(data, "engine2"),
        OMNIRUSH_SERVER_URL: base,
        OMNIRUSH_POLICY_TOKEN: "policy",
        OMNIRUSH_SERVER_TOKEN: "server",
        HOME: join(data, "home"),
        OPENCODE_TEST_HOME: join(data, "home"),
        XDG_DATA_HOME: join(data, "xdg-data"),
        XDG_CONFIG_HOME: join(data, "xdg-config"),
        XDG_STATE_HOME: join(data, "xdg-state"),
        XDG_CACHE_HOME: join(data, "xdg-cache"),
      },
    });
    await waitFor(async () => (await engineFetch("/session")).ok, "engine");
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
    provider?.stop(true);
    rmSync(work, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }, 30_000);

  test("the sub-agent starts as a child session and its task completes", async () => {
    const session = (await (await engineFetch("/session", { method: "POST", body: "{}" })).json()) as { id: string };
    const sent = await engineFetch(`/session/${session.id}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "inspect it" }] }) });
    expect(sent.status).toBe(204);

    await waitFor(() => mainReplyHeld, "the main reply");
    await Bun.sleep(300);
    // What a provider sync, a skill change or an idle sweep sends mid-turn.
    expect((await engineFetch("/instance/dispose", { method: "POST" })).status).toBe(200);

    const done = await waitFor(async () => {
      const list = await getJson<V1Message[]>(`/session/${session.id}/message`);
      const last = list.at(-1);
      return last?.info.role === "assistant" && last.info.time?.completed && last.parts.some((part) => part.type === "text" && part.text === "All done.") ? list : null;
    }, "the main turn");
    const task = done.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "task");
    expect(task?.state?.error ?? "").not.toContain("location shut down");
    expect(task?.state?.status).toBe("completed");
    expect(task?.state?.output ?? "").toContain("child done");

    const sessions = await getJson<Array<{ id: string; parentID?: string }>>("/session");
    const children = sessions.filter((entry) => entry.parentID === session.id);
    expect(children).toHaveLength(1);
  }, 120_000);
});
