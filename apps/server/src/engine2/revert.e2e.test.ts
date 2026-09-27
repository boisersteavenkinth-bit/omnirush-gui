import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createManagedOpencodeServer, type ManagedOpencodeServer } from "../managed-opencode.js";

/**
 * Revert, undo revert and a prompt after a revert on the real 2.x engine
 * (the bundled sidecar behind the 1.x adapter) against a mock provider whose
 * turns edit a file in a git project:
 *
 *   - revert restores the files to the chosen point and reports the revert
 *     point on the session, keeping the later messages until it is final;
 *   - undo revert brings the files and the revert-free session back;
 *   - a prompt after a revert finalises it: the reverted turns are gone from
 *     the history (`message.removed` for each), the model never sees them and
 *     the new turn continues from the reverted files.
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
type V1Message = { info: { id: string; role: string; time?: { completed?: number } }; parts: Array<{ type: string; text?: string }> };

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
const callTool = (id: string, name: string, args: object) => sse([
  { index: 0, delta: { role: "assistant", content: "" } },
  { index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
  { index: 0, delta: {}, finish_reason: "tool_calls" },
]);

describeMaybe("revert on the 2.x engine (mock provider, real files)", () => {
  let engine: ManagedOpencodeServer;
  let provider: ReturnType<typeof Bun.serve>;
  let work = "";
  let data = "";
  const seen: Body[] = [];
  const events: Array<{ type: string; properties: Record<string, any> }> = [];
  const eventAbort = new AbortController();

  const engineFetch = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`);
    headers.set("x-opencode-directory", encodeURIComponent(work));
    if (init?.body) headers.set("content-type", "application/json");
    return fetch(`${engine.url}${path}`, { ...init, headers });
  };
  const getJson = async <T>(path: string): Promise<T> => (await (await engineFetch(path)).json()) as T;
  const postJson = async <T>(path: string, body: object): Promise<T> => {
    const response = await engineFetch(path, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  };
  const waitFor = async <T>(read: () => Promise<T | null | undefined | false>, label: string, ms = 60_000): Promise<T> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await read().catch(() => null);
      if (value) return value as T;
      await Bun.sleep(250);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const file = () => readFileSync(join(work, "a.txt"), "utf8");
  const messages = (sessionID: string) => getJson<V1Message[]>(`/session/${sessionID}/message`);
  const userTexts = async (sessionID: string) => (await messages(sessionID))
    .filter((message) => message.info.role === "user")
    .map((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""));
  /** Sends `EDIT n` and waits for the turn that writes `v{n}` to a.txt and answers `ok n`. */
  const edit = async (sessionID: string, n: number) => {
    const sent = await engineFetch(`/session/${sessionID}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ model: { providerID: "mock", modelID: "mock-model" }, parts: [{ type: "text", text: `EDIT ${n}` }] }),
    });
    expect(sent.status).toBe(204);
    await waitFor(async () => {
      const list = await messages(sessionID);
      const last = list.at(-1);
      return last?.info.role === "assistant" && last.info.time?.completed && last.parts.some((part) => part.type === "text" && part.text === `ok ${n}`);
    }, `turn ${n}`);
    await waitFor(async () => {
      const status = await getJson<Record<string, { type: string }>>("/session/status");
      return !status[sessionID] || status[sessionID]!.type === "idle";
    }, `idle after turn ${n}`);
    expect(file()).toBe(`v${n}\n`);
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "revert-ws-"));
    data = mkdtempSync(join(tmpdir(), "revert-data-"));
    writeFileSync(join(work, "a.txt"), "v0\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    provider = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Body) : {};
        if (url.pathname.startsWith("/managed-policy")) return Response.json({ allowed: true, approvalMode: "full" });
        if (!url.pathname.startsWith("/v1/")) return Response.json({});
        if (!Array.isArray(body.tools) || body.tools.length === 0) return say("Revert title");
        seen.push(body);
        const list = body.messages ?? [];
        const lastUser = [...list].reverse().find((message) => message.role === "user");
        const n = Number(/EDIT (\d+)/.exec(text(lastUser?.content))?.[1] ?? "0");
        if (list.at(-1)?.role === "tool") return say(`ok ${n}`);
        const write = body.tools.find((tool) => tool.function.name === "write") ? "write" : body.tools[0]!.function.name;
        return callTool(`call_${n}_${seen.length}`, write, { path: join(work, "a.txt"), content: `v${n}\n` });
      },
    });
    const base = `http://127.0.0.1:${provider.port}`;
    const configPath = join(data, "runtime-opencode-config.json");
    writeFileSync(configPath, JSON.stringify({
      model: "mock/mock-model",
      permission: { "*": "allow" },
      provider: {
        mock: { name: "Mock", npm: "@ai-sdk/openai-compatible", options: { baseURL: `${base}/v1`, apiKey: "mock-key" }, models: { "mock-model": { name: "Mock", tool_call: true, limit: { context: 100_000, output: 4_000 } } } },
      },
    }));
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
    // The 1.x event stream, as the app reads it.
    void (async () => {
      const response = await engineFetch("/event", { signal: eventAbort.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
          if (!line) continue;
          try {
            const parsed = JSON.parse(line.slice(5));
            events.push(parsed.payload ?? parsed);
          } catch {
            // not JSON
          }
        }
      }
    })().catch(() => undefined);
  }, 120_000);

  afterAll(async () => {
    eventAbort.abort();
    await engine?.close();
    provider?.stop(true);
    rmSync(work, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }, 30_000);

  test("revert, undo revert, and a prompt after revert", async () => {
    const session = await postJson<{ id: string }>("/session", {});
    const sessionID = session.id;
    await edit(sessionID, 1);
    await edit(sessionID, 2);
    await edit(sessionID, 3);
    const before = await messages(sessionID);
    const users = before.filter((message) => message.info.role === "user");
    expect(users).toHaveLength(3);
    const boundary = users[1]!.info.id;
    const beforeIDs = before.map((message) => message.info.id);
    const reverted = beforeIDs.slice(beforeIDs.indexOf(boundary));

    // Revert to the second prompt: the files go back to before it, the session
    // carries the revert point, and the later messages are kept (hidden by the app).
    const afterRevert = await postJson<{ revert?: { messageID: string } }>(`/session/${sessionID}/revert`, { messageID: boundary });
    expect(afterRevert.revert?.messageID).toBe(boundary);
    expect(file()).toBe("v1\n");
    expect((await getJson<{ revert?: { messageID: string } }>(`/session/${sessionID}`)).revert?.messageID).toBe(boundary);
    expect((await messages(sessionID)).map((message) => message.info.id)).toEqual(beforeIDs);
    await waitFor(async () => events.some((event) => event.type === "session.updated" && event.properties.info?.id === sessionID && event.properties.info?.revert?.messageID === boundary), "session.updated with the revert point");

    // Undo: the files and the full history come back.
    const afterUnrevert = await postJson<{ revert?: unknown }>(`/session/${sessionID}/unrevert`, {});
    expect(afterUnrevert.revert).toBeUndefined();
    expect(file()).toBe("v3\n");
    expect((await getJson<{ revert?: unknown }>(`/session/${sessionID}`)).revert).toBeUndefined();
    expect((await messages(sessionID)).map((message) => message.info.id)).toEqual(beforeIDs);
    await waitFor(async () => {
      const last = events.filter((event) => event.type === "session.updated" && event.properties.info?.id === sessionID).at(-1);
      return last && !last.properties.info.revert;
    }, "session.updated without a revert point");

    // Revert again and send a new prompt: the revert becomes final.
    await postJson(`/session/${sessionID}/revert`, { messageID: boundary });
    expect(file()).toBe("v1\n");
    seen.length = 0;
    await edit(sessionID, 4);
    const sentToModel = seen.map((body) => (body.messages ?? []).map((message) => text(message.content)).join("\n")).join("\n");
    expect(sentToModel).toContain("EDIT 1");
    expect(sentToModel).toContain("EDIT 4");
    expect(sentToModel).not.toContain("EDIT 2");
    expect(sentToModel).not.toContain("EDIT 3");
    expect(await userTexts(sessionID)).toEqual(["EDIT 1", "EDIT 4"]);
    const after = await messages(sessionID);
    for (const id of reverted) expect(after.some((message) => message.info.id === id)).toBe(false);
    expect((await getJson<{ revert?: unknown }>(`/session/${sessionID}`)).revert).toBeUndefined();
    await waitFor(async () => reverted.every((id) => events.some((event) => event.type === "message.removed" && event.properties.messageID === id)), "message.removed for each reverted message");

    // Undo after the revert is final is a no-op: the new turn and its file stay.
    await postJson(`/session/${sessionID}/unrevert`, {});
    expect(file()).toBe("v4\n");
    expect(await userTexts(sessionID)).toEqual(["EDIT 1", "EDIT 4"]);
  }, 240_000);
});
