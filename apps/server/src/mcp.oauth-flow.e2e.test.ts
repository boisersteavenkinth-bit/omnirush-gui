import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Full MCP OAuth flow e2e:
 *
 *   real opencode engine (sidecar binary, started as the app starts it: the
 *   2.x engine behind the 1.x engine adapter, managed-opencode.ts)
 *     -> mock OAuth MCP server (scripts/mock-oauth-mcp-server.mjs)
 *     -> discovery + dynamic client registration + PKCE (S256)
 *     -> authorization redirect ("the browser")
 *     -> token exchange (PKCE verified by the mock)
 *     -> authenticated streamable-HTTP MCP connect (tools/list)
 *
 * The test plays the role of the user's browser by following the
 * authorization URL and the resulting redirect to the engine's loopback
 * callback. This is the same flow the OmniRush.ai desktop app drives through
 * the OAuth modal (apps/app .../connections/mcp-auth-modal.tsx).
 *
 * Skipped automatically when the opencode sidecar binary is not present
 * (e.g. CI runners that never ran prepare:sidecar).
 */

const repoRoot = resolve(import.meta.dir, "../../..");
const sidecarDir = join(repoRoot, "apps/desktop/resources/sidecars");

function findSidecar(): string | null {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const names =
    process.platform === "darwin"
      ? [`opencode-${arch}-apple-darwin`]
      : process.platform === "linux"
        ? [`opencode-${arch}-unknown-linux-gnu`, `opencode-${arch}-unknown-linux-musl`]
        : [];
  for (const name of names) {
    const candidate = join(sidecarDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";

const enginePath = findSidecar();
const describeMaybe = enginePath ? describe : describe.skip;

const MCP_NAME = "mock-oauth-flow";

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("failed to allocate a free port");
  return port;
}

describeMaybe("mcp oauth flow against mock provider", () => {
  let mockProc: ChildProcess;
  let engine: ManagedOpencodeServer;
  let mockPort = 0;
  let workDir = "";
  let dataDir = "";

  const mockUrl = () => `http://127.0.0.1:${mockPort}`;

  async function engineFetch(path: string, init?: RequestInit) {
    const url = new URL(`${engine.url}${path}`);
    url.searchParams.set("directory", workDir);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`);
    return fetch(url, { ...init, headers });
  }

  /** The OAuth credential the engine stored for the server (2.x keeps it with the server's integration). */
  async function storedCredentials(): Promise<Array<{ id: string }>> {
    const servers = (await (await engineFetch("/api/mcp")).json()) as { data: Array<{ name: string; integrationID?: string }> };
    const integrationID = servers.data.find((server) => server.name === MCP_NAME)?.integrationID;
    if (!integrationID) return [];
    const integration = (await (await engineFetch(`/api/integration/${encodeURIComponent(integrationID)}`)).json()) as { data?: { connections?: Array<{ type: string; id: string }> } };
    return (integration.data?.connections ?? []).filter((connection) => connection.type === "credential");
  }

  beforeAll(async () => {
    mockPort = await getFreePort();

    workDir = mkdtempSync(join(tmpdir(), "mcp-oauth-ws-"));
    dataDir = mkdtempSync(join(tmpdir(), "mcp-oauth-data-"));
    writeFileSync(
      join(workDir, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [MCP_NAME]: { type: "remote", url: `${mockUrl()}/mcp`, enabled: true, oauth: {} },
        },
      }),
    );

    mockProc = spawn("node", [join(repoRoot, "scripts/mock-oauth-mcp-server.mjs")], {
      env: { ...process.env, PORT: String(mockPort), AUTO_APPROVE: "1", STRICT_REFRESH_TOKENS: "1" },
      stdio: "ignore",
    });
    await waitFor(
      async () => {
        const res = await fetch(`${mockUrl()}/health`);
        return res.ok ? true : null;
      },
      10_000,
      "mock oauth server",
    );

    engine = await createManagedOpencodeServer({
      bin: enginePath!,
      cwd: workDir,
      env: {
        XDG_DATA_HOME: join(dataDir, "xdg-data"),
        XDG_CONFIG_HOME: join(dataDir, "xdg-config"),
        XDG_STATE_HOME: join(dataDir, "xdg-state"),
        XDG_CACHE_HOME: join(dataDir, "xdg-cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OMNIRUSH_ENGINE_PLUGINS: "0",
        OMNIRUSH_ENGINE2_CONFIG_DIR: join(dataDir, "engine2"),
      },
    });
    await waitFor(
      async () => {
        const res = await engineFetch("/mcp");
        return res.ok ? true : null;
      },
      30_000,
      "opencode engine",
    );
  }, 60_000);

  afterAll(async () => {
    await engine?.close();
    mockProc?.kill();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "engine completes browser OAuth (discovery, DCR, PKCE) and connects",
    async () => {
      // Initially the MCP requires auth.
      const before = (await (await engineFetch("/mcp")).json()) as Record<string, { status: string }>;
      expect(before[MCP_NAME]).toBeDefined();
      expect(before[MCP_NAME].status).not.toBe("connected");

      // Start the OAuth flow: engine performs discovery + dynamic client
      // registration and hands back the authorization URL it would open
      // in the user's browser.
      const startRes = await engineFetch(`/mcp/${MCP_NAME}/auth`, { method: "POST" });
      expect(startRes.ok).toBe(true);
      const started = (await startRes.json()) as { authorizationUrl?: string; url?: string };
      const authorizationUrl = started.authorizationUrl ?? started.url;
      expect(authorizationUrl).toBeTruthy();
      const authUrl = new URL(authorizationUrl!);
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(authUrl.searchParams.get("state")).toBeTruthy();

      // Play the browser: visit the authorization URL. The mock
      // auto-approves and 302s to the engine's loopback callback.
      const authorizeRes = await fetch(authorizationUrl!, { redirect: "manual" });
      expect(authorizeRes.status).toBe(302);
      const callbackUrl = authorizeRes.headers.get("location");
      expect(callbackUrl).toBeTruthy();
      const cb = new URL(callbackUrl!);
      expect(cb.searchParams.get("code")).toBeTruthy();
      expect(cb.searchParams.get("state")).toBe(authUrl.searchParams.get("state"));

      // Follow the redirect into the engine's loopback callback server,
      // falling back to the manual callback endpoint (the path used for
      // remote workspaces where the loopback is unreachable).
      let callbackDelivered = false;
      try {
        const res = await fetch(callbackUrl!);
        callbackDelivered = res.ok;
      } catch {
        callbackDelivered = false;
      }
      if (!callbackDelivered) {
        const manual = await engineFetch(`/mcp/${MCP_NAME}/auth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: cb.searchParams.get("code") }),
        });
        expect(manual.ok).toBe(true);
      }

      // The engine exchanges the code (mock verifies PKCE) and connects.
      const connected = await waitFor(
        async () => {
          const res = await engineFetch("/mcp");
          if (!res.ok) return null;
          const statuses = (await res.json()) as Record<string, { status: string }>;
          return statuses[MCP_NAME]?.status === "connected" ? statuses : null;
        },
        30_000,
        "mcp connected status",
      );
      expect(connected[MCP_NAME].status).toBe("connected");

      // Tokens are persisted for reuse across restarts (a credential of the server's integration).
      expect((await storedCredentials()).length).toBeGreaterThan(0);

      // The mock saw the full, authenticated MCP handshake.
      const log = (await (await fetch(`${mockUrl()}/requests`)).json()) as {
        requests: Array<{ method: string; path: string }>;
      };
      const paths = log.requests.map((r) => `${r.method} ${r.path}`);
      expect(paths).toContain("POST /register");
      expect(paths).toContain("GET /authorize");
      expect(paths).toContain("POST /token");
      expect(paths).toContain("POST /mcp");
    },
    90_000,
  );

  test(
    "engine silently refreshes an expired access token without re-authorization",
    async () => {
      const before = await storedCredentials();
      expect(before.length).toBeGreaterThan(0);

      // Only assert on traffic that happens after this point.
      const markLog = (await (await fetch(`${mockUrl()}/requests`)).json()) as { requests: Array<unknown> };
      const mark = markLog.requests.length;

      // Kill every live access token server-side (refresh grants stay
      // valid). The engine's next MCP round-trip gets a 401 challenge —
      // exactly what an expired access token looks like in production.
      const expire = await fetch(`${mockUrl()}/admin/expire-access-tokens`, { method: "POST" });
      expect(expire.ok).toBe(true);

      // Force a fresh authenticated round-trip: re-register the MCP so the
      // engine reconnects using its stored tokens.
      const reregister = await engineFetch("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: MCP_NAME,
          config: { type: "remote", url: `${mockUrl()}/mcp`, enabled: true, oauth: {} },
        }),
      });
      expect(reregister.ok).toBe(true);

      const connected = await waitFor(
        async () => {
          const res = await engineFetch("/mcp");
          if (!res.ok) return null;
          const statuses = (await res.json()) as Record<string, { status: string }>;
          return statuses[MCP_NAME]?.status === "connected" ? statuses : null;
        },
        30_000,
        "mcp reconnected after access-token expiry",
      );
      expect(connected[MCP_NAME].status).toBe("connected");

      // Recovery must have used the refresh grant — never a new browser
      // authorization or a re-registration.
      const log = (await (await fetch(`${mockUrl()}/requests`)).json()) as {
        requests: Array<{ method: string; path: string; grantType?: string }>;
      };
      const afterMark = log.requests.slice(mark);
      expect(
        afterMark.some((r) => r.method === "POST" && r.path === "/token" && r.grantType === "refresh_token"),
      ).toBe(true);
      expect(afterMark.some((r) => r.path === "/authorize")).toBe(false);
      expect(afterMark.some((r) => r.method === "POST" && r.path === "/register")).toBe(false);

      // The rotated tokens were persisted for the next restart.
      expect((await storedCredentials()).length).toBeGreaterThan(0);
    },
    60_000,
  );

  test("logout removes stored tokens and drops the connection", async () => {
    const remove = await engineFetch(`/mcp/${MCP_NAME}/auth`, { method: "DELETE" });
    expect(remove.ok).toBe(true);
    expect(await storedCredentials()).toEqual([]);
  }, 30_000);
});
