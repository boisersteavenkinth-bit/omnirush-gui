import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { OmniRushBudgetWrap } from "./omnirush-budget-wrap.js";

const originalFetch = globalThis.fetch;
const originalServer = process.env.OMNIRUSH_SERVER_URL;
const originalToken = process.env.OMNIRUSH_SERVER_TOKEN;
const gatewayHeaders = new Map<string, Record<string, string>>();

beforeAll(() => {
  process.env.OMNIRUSH_SERVER_URL = "http://localhost:3579";
  process.env.OMNIRUSH_SERVER_TOKEN = "local-token";
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    return new Response("{}", { status: 200, headers: gatewayHeaders.get(headers.get("x-omnirush-session-id") ?? "") ?? {} });
  }, originalFetch);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalServer === undefined) delete process.env.OMNIRUSH_SERVER_URL;
  else process.env.OMNIRUSH_SERVER_URL = originalServer;
  if (originalToken === undefined) delete process.env.OMNIRUSH_SERVER_TOKEN;
  else process.env.OMNIRUSH_SERVER_TOKEN = originalToken;
});

type Hooks = Awaited<ReturnType<typeof OmniRushBudgetWrap>>;

async function modelRequest(hooks: Hooks, sessionID: string, answer: Record<string, string>, agent?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  await hooks["chat.headers"]!({ sessionID, agent, model: { providerID: "omnirush", id: "gpt-6-astra" } }, { headers });
  gatewayHeaders.set(sessionID, answer);
  await (await fetch("http://gateway.test/v1/responses", { method: "POST", headers, body: "{}" })).text();
  return headers;
}

function operation(init?: RequestInit): string {
  const body: unknown = JSON.parse(String(init?.body));
  if (!body || typeof body !== "object" || !("input" in body)) return "";
  const input = body.input;
  if (!input || typeof input !== "object" || !("args" in input)) return "";
  const args = input.args;
  return args && typeof args === "object" && "operation" in args ? String(args.operation) : "";
}

describe("account budget wrap plugin", () => {
  test("compacts only after acceptance, with the selected model and private marker", async () => {
    const controls: string[] = [];
    let compactCalls = 0;
    let hooks: Hooks;
    hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/experimental/ui-control/request")) {
          const action = operation(init);
          controls.push(action);
          return Response.json({ ok: true, result: { choice: action === "offer" ? "accept" : "ok" } });
        }
        if (url.endsWith("/session/ses_accept/summarize")) {
          compactCalls += 1;
          expect(JSON.parse(String(init?.body))).toEqual({ providerID: "omnirush", modelID: "gpt-6-astra" });
          const headers = await modelRequest(hooks, "ses_accept", { "x-omnirush-wrap-up": "1" }, "compaction");
          expect(headers["x-omnirush-context-wrap"]).toBe("1");
          await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "ses_accept" } } });
          return new Response("true", { status: 200 });
        }
        throw new Error("unexpected URL: " + url);
      },
    });
    try {
      const headers = await modelRequest(hooks, "ses_accept", {
        "x-omnirush-wrap-required": "1",
        "x-omnirush-wrap-offer-id": "allowance-1",
        "x-omnirush-wrap-scopes": "day",
      });
      expect(headers["x-omnirush-context-wrap"]).toBeUndefined();
      expect(compactCalls).toBe(0);
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_accept" } } });
      await Bun.sleep(30);
      expect(controls).toContain("offer");
      expect(controls).toContain("finish");
      expect(compactCalls).toBe(1);
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_accept" } } });
      await Bun.sleep(10);
      expect(compactCalls).toBe(1);
    } finally { await hooks.dispose!(); }
  });

  test("declining leaves the session running and never compacts it", async () => {
    let compactCalls = 0;
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async (input) => {
        if (String(input).includes("/experimental/ui-control/request")) return Response.json({ ok: true, result: { choice: "decline" } });
        compactCalls += 1;
        return new Response("true", { status: 200 });
      },
    });
    try {
      await modelRequest(hooks, "ses_decline", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-2" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_decline" } } });
      await Bun.sleep(30);
      expect(compactCalls).toBe(0);
    } finally { await hooks.dispose!(); }
  });

  test("no connected window keeps the offer pending without compaction", async () => {
    let controlCalls = 0;
    const hooks = await OmniRushBudgetWrap({
      serverUrl: "http://127.0.0.1:4096",
      fetch: async () => { controlCalls += 1; return Response.json({ ok: false, error: "window away" }); },
    });
    try {
      await modelRequest(hooks, "ses_away", { "x-omnirush-wrap-required": "1", "x-omnirush-wrap-offer-id": "allowance-3" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_away" } } });
      await Bun.sleep(30);
      expect(controlCalls).toBeGreaterThan(0);
      const headers: Record<string, string> = {};
      await hooks["chat.headers"]!({ sessionID: "ses_away", model: { providerID: "omnirush", id: "gpt-6-astra" } }, { headers });
      expect(headers["x-omnirush-context-wrap"]).toBeUndefined();
    } finally { await hooks.dispose!(); }
  });
});
