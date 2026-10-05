import { afterEach, describe, expect, test } from "bun:test";

import { OmniRushBudgetWrap } from "./omnirush-budget-wrap.js";

const previousAdapter = process.env.OMNIRUSH_ENGINE_ADAPTER_URL;
const previousAuthorization = process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION;

afterEach(() => {
  if (previousAdapter === undefined) delete process.env.OMNIRUSH_ENGINE_ADAPTER_URL;
  else process.env.OMNIRUSH_ENGINE_ADAPTER_URL = previousAdapter;
  if (previousAuthorization === undefined) delete process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION;
  else process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION = previousAuthorization;
});

describe("account budget wrap plugin", () => {
  test("waits for session idle, then compacts without inserting a trace message", async () => {
    process.env.OMNIRUSH_ENGINE_ADAPTER_URL = "http://adapter.test";
    process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION = "Bearer adapter";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const hooks = await OmniRushBudgetWrap({
      directory: "/workspace/project",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(null, { status: 204 });
      },
    });

    const modelHeaders: Record<string, string> = {};
    await hooks["chat.headers"]!({ sessionID: "ses_1", model: { providerID: "omnirush" } }, { headers: modelHeaders });
    expect(modelHeaders["x-omnirush-session-id"]).toBe("ses_1");

    await hooks["omnirush.http.response"]!({
      request: new Request("http://gateway.test/v1/responses", {
        headers: { "x-omnirush-session-id": "ses_1" },
      }),
      response: new Response(null, {
        status: 200,
        headers: { "x-omnirush-wrap-required": "1" },
      }),
    });
    await hooks.event!({ event: { type: "session.updated", properties: { sessionID: "ses_1" } } });
    expect(calls).toHaveLength(0);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://adapter.test/session/ses_1/summarize");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe("{}");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer adapter");
    expect(new Headers(calls[0]!.init?.headers).get("x-opencode-directory")).toBe(encodeURIComponent("/workspace/project"));
  });

  test("the backend wrap-up response clears the pending marker", async () => {
    process.env.OMNIRUSH_ENGINE_ADAPTER_URL = "http://adapter.test";
    const calls: string[] = [];
    const hooks = await OmniRushBudgetWrap({
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });

    const request = new Request("http://gateway.test/v1/responses", {
      headers: { "x-omnirush-session-id": "ses_2" },
    });
    await hooks["omnirush.http.response"]!({
      request,
      response: new Response(null, { status: 200, headers: { "x-omnirush-wrap-required": "1" } }),
    });
    await hooks["omnirush.http.response"]!({
      request,
      response: new Response(null, { status: 200, headers: { "x-omnirush-wrap-up": "1" } }),
    });
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_2" } } });
    expect(calls).toHaveLength(0);
  });

  test("a failed wrap retries on the next idle without showing the toast again", async () => {
    process.env.OMNIRUSH_ENGINE_ADAPTER_URL = "http://adapter.test";
    const toasts: string[] = [];
    let attempts = 0;
    const hooks = await OmniRushBudgetWrap({
      client: { tui: { showToast: async ({ body }) => { toasts.push(body.title); } } },
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: attempts < 3 ? 500 : 204 });
      },
    });
    const request = new Request("http://gateway.test/v1/responses", {
      headers: { "x-omnirush-session-id": "ses_3" },
    });
    const required = () => hooks["omnirush.http.response"]!({
      request,
      response: new Response(null, { status: 200, headers: { "x-omnirush-wrap-required": "1" } }),
    });
    await required();
    for (let idle = 0; idle < 3; idle += 1) {
      // Every answer of the retried turns still asks for the wrap.
      await required();
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_3" } } });
    }
    expect(attempts).toBe(3);
    expect(toasts).toEqual(["Wrapping up", "Wrap up complete"]);
  });
});
