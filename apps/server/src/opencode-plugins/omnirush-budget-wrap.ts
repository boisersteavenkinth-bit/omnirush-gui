/** Automatically finish an account-level quota wrap in the desktop GUI.
 *
 * The backend decides when a grant needs wrapping and publishes a private
 * response header on the model response. The engine sends model requests
 * through the global fetch, which this plugin wraps to read that header on
 * requests it marked (`chat.headers`). Once the engine reports the session
 * idle it asks the engine to compact the session on the model it last ran on.
 * The compaction record itself contains the generated handoff summary; no
 * warning or synthetic prompt is written to the session trace.
 */
const REQUIRED_HEADER = "x-omnirush-wrap-required";
const WRAP_UP_HEADER = "x-omnirush-wrap-up";
const SESSION_HEADER = "x-omnirush-session-id";
type ModelRef = { providerID: string; modelID: string };
const pending = new Map<string, { inFlight: boolean; announced?: boolean }>();
/** The model each session last sent a request on (the compaction runs on it). */
const models = new Map<string, ModelRef>();
const MAX_TRACKED_SESSIONS = 256;
type BudgetFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type BudgetClient = {
  tui?: { showToast?: (input: { query?: { directory?: string }; body: { title: string; message: string; variant: string; duration: number } }) => Promise<unknown> };
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIDFromEvent(event: unknown): string {
  if (!record(event) || !record(event.properties)) return "";
  const properties = event.properties;
  return typeof properties.sessionID === "string" ? properties.sessionID : "";
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_SESSIONS) map.delete(map.keys().next().value as string);
}

/** Records what a model response says about the session's wrap. */
function noteBudgetResponse(sessionID: string, headers: Headers): void {
  if (!sessionID) return;
  if (headers.get(WRAP_UP_HEADER) === "1") {
    pending.delete(sessionID);
    return;
  }
  if (headers.get(REQUIRED_HEADER) === "1" && !pending.has(sessionID)) remember(pending, sessionID, { inFlight: false });
}

let installed = false;

/** Wraps the global fetch once: a marked model request's response headers are read, nothing else changes. */
function install(): void {
  if (installed) return;
  installed = true;
  const base = globalThis.fetch;
  const patched = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const sessionID = headers.get(SESSION_HEADER)?.trim() ?? "";
    const response = await base(input, init);
    if (sessionID) noteBudgetResponse(sessionID, response.headers);
    return response;
  };
  globalThis.fetch = Object.assign(patched, base);
}

function basicAuthorization(): string {
  const password = process.env.OPENCODE_SERVER_PASSWORD?.trim() ?? "";
  if (!password) return "";
  const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export const OmniRushBudgetWrap = async (input: {
  directory?: string;
  /** The engine's own server (the plugin input's `serverUrl`). */
  serverUrl?: URL | string;
  fetch?: BudgetFetch;
  client?: BudgetClient;
}) => {
  install();
  const baseUrl = String(input.serverUrl ?? "").replace(/\/+$/, "");
  const authorization = basicAuthorization();
  const fetcher = input.fetch ?? globalThis.fetch;

  async function notify(title: string, message: string, variant: "info" | "warning"): Promise<void> {
    const body = { title, message, variant, duration: 12_000 };
    try {
      await input.client?.tui?.showToast?.({
        ...(input.directory ? { query: { directory: input.directory } } : {}),
        body,
      });
    } catch {
      // The headless adapter may not implement the native TUI endpoint.
    }
    // The desktop shell has its own notification center. The server-scoped
    // control request is consumed by the connected window and never becomes a
    // session message or trace part.
    const server = (process.env.OMNIRUSH_SERVER_URL ?? "").trim().replace(/\/+$/, "");
    const token = (process.env.OMNIRUSH_SERVER_TOKEN ?? process.env.OMNIRUSH_POLICY_TOKEN ?? "").trim();
    if (!server || !token) return;
    await fetcher(server + "/experimental/ui-control/request", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "command",
        input: { id: "notifications.show", args: { title, body: message, severity: variant } },
      }),
    }).catch(() => undefined);
  }

  async function compact(sessionID: string): Promise<void> {
    const entry = pending.get(sessionID);
    const model = models.get(sessionID);
    if (!entry || entry.inFlight || !baseUrl || !model) return;
    entry.inFlight = true;
    // Once per wrap: a failed summarize retries on the next idle without
    // showing the toast again.
    if (!entry.announced) {
      entry.announced = true;
      await notify("Wrapping up", "Your token allowance is nearly exhausted. Saving a handoff now.", "warning");
    }
    try {
      const response = await fetcher(
        baseUrl + "/session/" + encodeURIComponent(sessionID) + "/summarize",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
            ...(input.directory ? { "x-opencode-directory": encodeURIComponent(input.directory) } : {}),
          },
          body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID }),
        },
      );
      if (!response.ok) throw new Error("automatic budget wrap returned " + response.status);
      await notify(
        "Wrap up complete",
        "This session was wrapped because your token allowance was nearly exhausted. Please continue after receiving more tokens.",
        "info",
      );
      pending.delete(sessionID);
    } catch {
      // Leave the pending marker so the next idle event can retry. This path
      // never inserts a prompt or diagnostic message into the user's trace.
      entry.inFlight = false;
    }
  }

  return {
    "chat.headers": async (input: { sessionID?: string; model?: { providerID?: string; id?: string; modelID?: string } }, output: { headers: Record<string, string> }) => {
      const sessionID = input?.sessionID?.trim() ?? "";
      if (!sessionID || input.model?.providerID !== "omnirush") return;
      output.headers[SESSION_HEADER] = sessionID;
      const modelID = input.model.id ?? input.model.modelID;
      if (modelID) remember(models, sessionID, { providerID: input.model.providerID, modelID });
    },
    event: async ({ event }: { event: unknown }) => {
      if (!record(event) || event.type !== "session.idle") return;
      const sessionID = sessionIDFromEvent(event);
      if (sessionID) await compact(sessionID);
    },
    dispose: async () => {
      pending.clear();
      models.clear();
    },
  };
};
