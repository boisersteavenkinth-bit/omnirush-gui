/** Offer an account-level quota wrap in the desktop GUI.
 *
 * The backend decides when a grant needs wrapping and publishes a private
 * response header on the model response. The engine sends model requests
 * through the global fetch, which this plugin wraps to read that header on
 * requests it marked (`chat.headers`). Once the engine reports the session
 * idle it asks the desktop window for an explicit, persistent choice. Only an
 * accepted offer asks the engine to compact on the model it last ran on.
 * The compaction record itself contains the generated handoff summary; no
 * warning or synthetic prompt is written to the session trace.
 */
const REQUIRED_HEADER = "x-omnirush-wrap-required";
const WRAP_UP_HEADER = "x-omnirush-wrap-up";
const OFFER_HEADER = "x-omnirush-wrap-offer-id";
const SESSION_HEADER = "x-omnirush-session-id";
type ModelRef = { providerID: string; modelID: string };
type Offer = { id: string; scopes: string; watching: boolean; inFlight: boolean; approved: boolean; backendWrapped: boolean; compacted: boolean };
const pending = new Map<string, Offer>();
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

let installed = false;
const listeners = new Set<(sessionID: string, headers: Headers) => void>();

/** Wraps the global fetch once: a marked model request's response headers are read, nothing else changes. */
function install(): void {
  if (installed) return;
  installed = true;
  const base = globalThis.fetch;
  const patched = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const sessionID = headers.get(SESSION_HEADER)?.trim() ?? "";
    const response = await base(input, init);
    if (sessionID) for (const listener of listeners) listener(sessionID, response.headers);
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
  let disposed = false;
  const server = (process.env.OMNIRUSH_SERVER_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.OMNIRUSH_SERVER_TOKEN ?? process.env.OMNIRUSH_POLICY_TOKEN ?? "").trim();

  async function control(id: string, args: Record<string, string>): Promise<string> {
    if (!server || !token) return "unavailable";
    try {
      const response = await fetcher(server + "/experimental/ui-control/request", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "query", input: { id, args } }),
      });
      if (!response.ok) return "unavailable";
      const result: unknown = await response.json();
      if (!record(result) || result.ok !== true || !record(result.result)) return "unavailable";
      const choice = result.result.choice;
      return typeof choice === "string" ? choice : "ok";
    } catch {
      return "unavailable";
    }
  }

  const update = (sessionID: string, entry: Offer, operation: string) =>
    control("budget.wrap.update", { sessionID, offerID: entry.id, scopes: entry.scopes, operation });

  const noteBudgetResponse = (sessionID: string, headers: Headers) => {
    const current = pending.get(sessionID);
    if (headers.get(WRAP_UP_HEADER) === "1") {
      if (current?.approved) current.backendWrapped = true;
      return;
    }
    if (headers.get(REQUIRED_HEADER) !== "1") {
      if (current && !current.inFlight) {
        pending.delete(sessionID);
        void update(sessionID, current, "clear");
      }
      return;
    }
    const id = headers.get(OFFER_HEADER) || `legacy:${headers.get("x-omnirush-wrap-scopes") ?? ""}`;
    if (current?.id === id) return;
    if (current) void update(sessionID, current, "clear");
    remember(pending, sessionID, {
      id, scopes: headers.get("x-omnirush-wrap-scopes") || "token", watching: false,
      inFlight: false, approved: false, backendWrapped: false, compacted: false,
    });
  };
  listeners.add(noteBudgetResponse);

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
    entry.approved = true;
    await notify("Wrapping up", "Saving this session's handoff now.", "info");
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
      if (!entry.compacted || !entry.backendWrapped) throw new Error("the wrap was not confirmed by the engine and gateway");
      await notify(
        "Wrap up complete",
        "Your handoff is saved. You can keep working while tokens remain.",
        "info",
      );
      await update(sessionID, entry, "finish");
      pending.delete(sessionID);
    } catch {
      // A failed wrap requires a fresh click. Never retry on the next idle.
      entry.approved = false;
      entry.inFlight = false;
      await update(sessionID, entry, "fail");
      await notify("Wrap up did not finish", "Choose Wrap up again to retry, or keep working.", "warning");
    }
  }

  async function watch(sessionID: string): Promise<void> {
    const entry = pending.get(sessionID);
    if (!entry || entry.watching || entry.inFlight) return;
    entry.watching = true;
    while (!disposed && pending.get(sessionID) === entry && !entry.inFlight) {
      const offered = await update(sessionID, entry, "offer");
      if (offered === "decline" || offered === "done") { pending.delete(sessionID); break; }
      if (offered === "accept") { await compact(sessionID); continue; }
      await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    }
    entry.watching = false;
  }

  return {
    "chat.headers": async (input: { sessionID?: string; agent?: string; model?: { providerID?: string; id?: string; modelID?: string } }, output: { headers: Record<string, string> }) => {
      const sessionID = input?.sessionID?.trim() ?? "";
      if (!sessionID || input.model?.providerID !== "omnirush") return;
      output.headers[SESSION_HEADER] = sessionID;
      if (input.agent === "compaction" && pending.get(sessionID)?.approved) output.headers["x-omnirush-context-wrap"] = "1";
      const modelID = input.model.id ?? input.model.modelID;
      if (modelID) remember(models, sessionID, { providerID: input.model.providerID, modelID });
    },
    event: async ({ event }: { event: unknown }) => {
      if (!record(event)) return;
      const sessionID = sessionIDFromEvent(event);
      if (!sessionID) return;
      if (event.type === "session.compacted") {
        const entry = pending.get(sessionID);
        if (entry?.inFlight) entry.compacted = true;
      }
      if (event.type === "session.idle") void watch(sessionID);
    },
    dispose: async () => {
      disposed = true;
      listeners.delete(noteBudgetResponse);
      pending.clear();
      models.clear();
    },
  };
};
