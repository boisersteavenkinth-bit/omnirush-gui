import { afterAll, describe, expect, test } from "bun:test";

import { OmniRushTitleRecovery } from "./omnirush-title-recovery.js";

/**
 * The 2.x engine's side of title recovery: the plugin bridge hands the
 * plugin the real outgoing request ("omnirush.http.request") and its response
 * ("omnirush.http.response"). The private marker header never leaves, and an
 * optional parameter the provider rejects is retried without it.
 */

const HEADER = "x-omnirush-title-attempt";
const seen: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>;
    seen.push({ headers: request.headers, body });
    if ("temperature" in body) {
      return Response.json({ error: { code: "unsupported_parameter", param: "temperature", message: "temperature is not supported" } }, { status: 400 });
    }
    return Response.json({ ok: true });
  },
});
afterAll(() => provider.stop(true));

type Hooks = Record<string, (...args: any[]) => Promise<void>>;
async function plugin(): Promise<{ hooks: Hooks; logs: Array<{ outcome: string; parameter?: string }> }> {
  const logs: Array<{ outcome: string; parameter?: string }> = [];
  const hooks = (await OmniRushTitleRecovery({
    client: { app: { log: async (input) => { logs.push(input.body.extra); } } },
  })) as unknown as Hooks;
  return { hooks, logs };
}

/** What the engine does around one model request: headers from chat.headers, then the http hooks. */
async function send(hooks: Hooks, agent: string, body: Record<string, unknown>): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: "Bearer k" };
  await hooks["chat.headers"]!({ sessionID: "ses_1", agent, model: { id: "m", providerID: "p" } }, { headers });
  const event = { request: new Request(`http://127.0.0.1:${provider.port}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }) } as { request: Request; response?: Response };
  await hooks["omnirush.http.request"]!(event);
  const response = await fetch(event.request);
  const after = { request: event.request, response };
  await hooks["omnirush.http.response"]!(after);
  return after.response;
}

describe("title recovery on the 2.x engine's http hooks", () => {
  test("the marker never reaches the provider; a rejected temperature is retried without it", async () => {
    seen.length = 0;
    const { hooks, logs } = await plugin();
    const response = await send(hooks, "title", { model: "m", temperature: 0.5, messages: [] });
    expect(response.status).toBe(200);
    expect(seen.length).toBe(2);
    for (const request of seen) expect(request.headers.get(HEADER)).toBeNull();
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer k");
    expect("temperature" in seen[0]!.body).toBe(true);
    expect("temperature" in seen[1]!.body).toBe(false);
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer k");
    expect(logs.map((log) => log.outcome)).toEqual(["started", "request_rejected", "retrying_parameter", "accepted_after_recovery"]);
    expect(logs[2]!.parameter).toBe("temperature");
  });

  test("an accepted title request goes out once, without the marker", async () => {
    seen.length = 0;
    const { hooks, logs } = await plugin();
    const response = await send(hooks, "title", { model: "m", messages: [] });
    expect(response.status).toBe(200);
    expect(seen.length).toBe(1);
    expect(seen[0]!.headers.get(HEADER)).toBeNull();
    expect(logs.map((log) => log.outcome)).toEqual(["started", "accepted"]);
  });

  test("other agents' requests are left alone (no retry, no rewrite)", async () => {
    seen.length = 0;
    const { hooks } = await plugin();
    const response = await send(hooks, "build", { model: "m", temperature: 0.5, messages: [] });
    expect(response.status).toBe(400);
    expect(seen.length).toBe(1);
    expect(seen[0]!.headers.get(HEADER)).toBeNull();
  });
});
