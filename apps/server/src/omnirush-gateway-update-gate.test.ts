import { describe, expect, test } from "bun:test";

import { OmniRushGatewayBroker, type GatewayUpdateSignal } from "./omnirush-gateway-broker.js";

const HEADER = "3.1.0; deadline=2026-10-05T12:00:00Z";
const REFUSAL = {
  error: { type: "update_required", code: "update_required", message: "Update OmniRush.ai to 3.1.0 to keep using models." },
};

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Call = { path: string; method: string; sessionId: string | null };

/** A gateway that refuses model requests with 426 once `blocked` is set, and always accepts uploads and archives. */
function gateway(options: { blocked: () => boolean; header?: string | null }) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, method: init?.method ?? "GET", sessionId: headers.get("x-omnirush-session-id") });
    const extra: Record<string, string> = options.header ? { "x-omnirush-update-required": options.header } : {};
    if (url.pathname.endsWith("/collect")) return Response.json({ ok: true }, { headers: extra });
    if (url.pathname.includes("/archives")) return Response.json({ key: "k" }, { headers: extra });
    if (url.pathname.endsWith("/responses")) {
      if (options.blocked()) return Response.json(REFUSAL, { status: 426, headers: extra });
      return new Response("data: {\"type\":\"response.completed\",\"response\":{}}\n\ndata: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream", ...extra },
      });
    }
    return Response.json({ detail: "not_mocked" }, { status: 404 });
  };
  return { calls, fetcher };
}

function broker(fetcher: Fetcher, signals: GatewayUpdateSignal[], invalidated: { count: number }) {
  return new OmniRushGatewayBroker({
    credentials: {
      gatewayUrl: "https://gateway.example/omnirush/v1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      invalidate: async () => {
        invalidated.count += 1;
      },
    },
    engineToken: "local-engine-token",
    fetch: fetcher,
    onUpdateSignal: (signal) => signals.push(signal),
  });
}

function modelRequest(sessionId = "ses_gate") {
  return new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer local-engine-token",
      "Content-Type": "application/json",
      "x-omnirush-session-id": sessionId,
    },
    body: JSON.stringify({ model: "gpt-6-astra", input: "hi", stream: true }),
  });
}

describe("mandatory update signals in the gateway broker", () => {
  test("passes the x-omnirush-update-required header on and leaves the stream intact", async () => {
    const signals: GatewayUpdateSignal[] = [];
    const { fetcher } = gateway({ blocked: () => false, header: HEADER });
    const response = await broker(fetcher, signals, { count: 0 }).handle(modelRequest(), "responses");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-omnirush-update-required")).toBe(HEADER);
    expect(await response.text()).toContain("response.completed");
    expect(signals).toEqual([{ kind: "header", value: HEADER }]);
  });

  test("a 426 update_required is a rejection signal and a readable, non-retried refusal", async () => {
    const signals: GatewayUpdateSignal[] = [];
    const invalidated = { count: 0 };
    const { fetcher } = gateway({ blocked: () => true });
    const response = await broker(fetcher, signals, invalidated).handle(modelRequest(), "responses");
    expect(response.status).toBe(426);
    expect(response.headers.get("x-should-retry")).toBe("false");
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("update_required");
    // The server's own words name the version to install.
    expect(body.error.message).toBe(REFUSAL.error.message);
    expect(signals).toEqual([{ kind: "rejection", message: REFUSAL.error.message }]);
    // A refused version is not a revoked session: nothing is signed out or discarded.
    expect(invalidated.count).toBe(0);
  });

  test("a bare 426 update_required gets readable copy", async () => {
    const signals: GatewayUpdateSignal[] = [];
    const fetcher = async () => Response.json({ detail: "update_required" }, { status: 426 });
    const response = await broker(fetcher, signals, { count: 0 }).handle(modelRequest(), "responses");
    expect(response.status).toBe(426);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("update_required");
    expect(body.error.message).toContain("no longer supported");
    expect(signals).toEqual([{ kind: "rejection", message: null }]);
  });

  test("an update_required body without 426 still counts; other refusals do not", async () => {
    const signals: GatewayUpdateSignal[] = [];
    let status = 403;
    let payload: unknown = REFUSAL;
    const fetcher = async () => Response.json(payload, { status });
    const subject = broker(fetcher, signals, { count: 0 });
    await subject.handle(modelRequest(), "responses");
    status = 429;
    payload = { detail: "daily_grant_exhausted" };
    await subject.handle(modelRequest(), "responses");
    expect(signals).toEqual([{ kind: "rejection", message: REFUSAL.error.message }]);
  });

  test("session uploads and project archives keep flowing after the version is blocked", async () => {
    const signals: GatewayUpdateSignal[] = [];
    let blocked = false;
    const { calls, fetcher } = gateway({ blocked: () => blocked, header: HEADER });
    const subject = broker(fetcher, signals, { count: 0 });

    expect((await subject.handle(modelRequest("ses_one"), "responses")).status).toBe(200);
    expect((await subject.uploadSession("ses_one", new Uint8Array([1, 2, 3]))).status).toBe(200);

    blocked = true;
    expect((await subject.handle(modelRequest("ses_one"), "responses")).status).toBe(426);
    // The uploader's queue is not stopped by the refusal: later envelopes of
    // the same session, and archive calls, still reach the gateway.
    expect((await subject.uploadSession("ses_one", new Uint8Array([4, 5, 6]))).status).toBe(200);
    expect((await subject.uploadSession("ses_two", new Uint8Array([7]))).status).toBe(200);
    expect((await subject.archiveRequest("archives/key", { method: "GET" })).status).toBe(200);
    expect(subject.enabled).toBe(true);

    const uploads = calls.filter((call) => call.path.endsWith("/collect"));
    expect(uploads.map((call) => call.sessionId)).toEqual(["ses_one", "ses_one", "ses_two"]);
    expect(signals.some((signal) => signal.kind === "rejection")).toBe(true);
    // The header on upload answers is heard too (uploads, not only model calls).
    expect(signals.filter((signal) => signal.kind === "header").length).toBeGreaterThanOrEqual(4);
  });

  test("a listener that throws never breaks a model request or an upload", async () => {
    const { fetcher } = gateway({ blocked: () => true, header: HEADER });
    const subject = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "a", refreshToken: "r" },
      engineToken: "local-engine-token",
      fetch: fetcher,
      onUpdateSignal: () => {
        throw new Error("listener failed");
      },
    });
    expect((await subject.handle(modelRequest(), "responses")).status).toBe(426);
    expect((await subject.uploadSession("ses_gate", new Uint8Array([1]))).status).toBe(200);
  });
});

describe("X-OmniRush-Client on every broker request", () => {
  test("model calls, uploads, file uploads, archive API, catalog, voice and refresh name gui/<version>", async () => {
    const seen: Array<{ path: string; client: string | null }> = [];
    let expired = true;
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({ path: url.pathname, client: headers.get("x-omnirush-client") });
      if (url.pathname.endsWith("/device/refresh")) {
        expired = false;
        return Response.json({ access_token: "a2", refresh_token: "r2", gateway_url: "https://gateway.example/omnirush/v1" });
      }
      if (url.pathname.endsWith("/responses") && expired) return Response.json({ detail: "expired" }, { status: 401 });
      return Response.json({ ok: true });
    };
    const fileHeaders: Array<Record<string, string>> = [];
    const subject = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "a1", refreshToken: "r1" },
      engineToken: "local-engine-token",
      fetch: fetcher,
      clientVersion: "3.0.3",
      uploadFile: async (_url, init) => {
        fileHeaders.push(init.headers);
        return Response.json({ ok: true });
      },
    });
    expect((await subject.handle(modelRequest(), "responses")).status).toBe(200);
    await subject.uploadSession("ses_gate", new Uint8Array([1]));
    await subject.uploadSessionFile("ses_gate", "/dev/null", 0);
    await subject.archiveRequest("archives/key", { method: "GET" });
    await subject.modelCatalog();
    await subject.voiceStatus();
    const paths = seen.map((entry) => entry.path);
    for (const path of ["/omnirush/v1/responses", "/omnirush/device/refresh", "/omnirush/collect", "/omnirush/archives/key", "/omnirush/v1/models", "/omnirush/v1/audio/transcriptions"]) {
      expect(paths).toContain(path);
    }
    expect(seen.every((entry) => entry.client === "gui/3.0.3")).toBe(true);
    expect(fileHeaders).toHaveLength(1);
    expect(fileHeaders[0]?.["X-OmniRush-Client"]).toBe("gui/3.0.3");
    // The session id and bearer still go with it.
    expect(fileHeaders[0]?.["X-OmniRush-Session-ID"]).toBe("ses_gate");
  });

  test("a standalone server without an app version sends no client header", async () => {
    let client: string | null = "unset";
    const subject = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "a", refreshToken: "r" },
      engineToken: "local-engine-token",
      fetch: async (_input, init) => {
        client = new Headers(init?.headers).get("x-omnirush-client");
        return Response.json({ ok: true });
      },
    });
    await subject.handle(modelRequest(), "responses");
    expect(client).toBeNull();
  });
});
