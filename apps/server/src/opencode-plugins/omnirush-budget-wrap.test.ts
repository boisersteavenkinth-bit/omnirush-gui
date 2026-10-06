import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { OmniRushBudgetWrap } from "./omnirush-budget-wrap.js";

/**
 * The engine sends model requests through the global fetch: the plugin wraps
 * it and reads the backend's wrap headers on the requests it marked in
 * `chat.headers`. The model responses here come from a stand-in global fetch.
 */
const gatewayHeaders = new Map<string, Record<string, string>>();
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    return new Response("{}", { status: 200, headers: gatewayHeaders.get(headers.get("x-omnirush-session-id") ?? "") ?? {} });
  }, originalFetch);
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

type Hooks = Awaited<ReturnType<typeof OmniRushBudgetWrap>>;

/** One model request of `sessionID` as the engine sends it: headers from chat.headers, then the global fetch. */
async function modelRequest(hooks: Hooks, sessionID: string, answer: Record<string, string>): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  await hooks["chat.headers"]!({ sessionID, model: { providerID: "omnirush", id: "gpt-6-astra" } }, { headers });
  gatewayHeaders.set(sessionID, answer);
  await (await fetch("http://gateway.test/v1/responses", { method: "POST", headers, body: "{}" })).text();
}

describe("account budget wrap plugin", () => {
  test("waits for session idle, then compacts on the session's model without inserting a trace message", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const hooks = await OmniRushBudgetWrap({
      directory: "/workspace/project",
      serverUrl: new URL("http://127.0.0.1:4096"),
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response("true", { status: 200 });
      },
    });

    const modelHeaders: Record<string, string> = {};
    await hooks["chat.headers"]!({ sessionID: "ses_1", model: { providerID: "omnirush", id: "gpt-6-astra" } }, { headers: modelHeaders });
    expect(modelHeaders["x-omnirush-session-id"]).toBe("ses_1");
    const otherHeaders: Record<string, string> = {};
    await hooks["chat.headers"]!({ sessionID: "ses_1", model: { providerID: "openai", id: "gpt-x" } }, { headers: otherHeaders });
    expect(otherHeaders["x-omnirush-session-id"]).toBeUndefined();

    await modelRequest(hooks, "ses_1", { "x-omnirush-wrap-required": "1" });
    await hooks.event!({ event: { type: "session.updated", properties: { sessionID: "ses_1" } } });
    expect(calls).toHaveLength(0);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4096/session/ses_1/summarize");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ providerID: "omnirush", modelID: "gpt-6-astra" });
    expect(new Headers(calls[0]!.init?.headers).get("x-opencode-directory")).toBe(encodeURIComponent("/workspace/project"));

    // Done: the next idle does nothing.
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    expect(calls).toHaveLength(1);
  });

  test("the backend wrap-up response clears the pending marker", async () => {
    const calls: string[] = [];
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("true", { status: 200 });
      },
    });

    await modelRequest(hooks, "ses_2", { "x-omnirush-wrap-required": "1" });
    await modelRequest(hooks, "ses_2", { "x-omnirush-wrap-up": "1" });
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_2" } } });
    expect(calls).toHaveLength(0);
  });

  test("a request without the marker never starts a wrap", async () => {
    const calls: string[] = [];
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("true", { status: 200 });
      },
    });
    gatewayHeaders.set("", { "x-omnirush-wrap-required": "1" });
    await (await fetch("http://gateway.test/v1/responses", { method: "POST", body: "{}" })).text();
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_4" } } });
    expect(calls).toHaveLength(0);
  });

  test("a failed wrap retries on the next idle without showing the toast again", async () => {
    const toasts: string[] = [];
    let attempts = 0;
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      client: { tui: { showToast: async ({ body }) => { toasts.push(body.title); } } },
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: attempts < 3 ? 500 : 200 });
      },
    });
    await modelRequest(hooks, "ses_3", { "x-omnirush-wrap-required": "1" });
    for (let idle = 0; idle < 3; idle += 1) {
      // Every answer of the retried turns still asks for the wrap.
      await modelRequest(hooks, "ses_3", { "x-omnirush-wrap-required": "1" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_3" } } });
    }
    expect(attempts).toBe(3);
    expect(toasts).toEqual(["Wrapping up", "Wrap up complete"]);
  });
});
