/**
 * Mandatory client update: what omnirush.ai says about this app's version.
 *
 * Three signals, newest wins:
 * - `client_update` on /device/me (and on the sign-in and refresh JSON):
 *   `{required, product, current, minimum, deadline, blocked, message,
 *   download_url}`. Only `product: "gui"` (or none) applies to this app.
 * - `x-omnirush-update-required: <minimum>; deadline=<iso>` on gateway
 *   responses before the deadline.
 * - HTTP 426 `{"error":{"code":"update_required",...}}` on model requests
 *   after it.
 *
 * Required: a banner with a countdown, the update downloads in the
 * background. Blocked (the server says so, a 426 came back, or the deadline
 * passed): a full-screen "Update required" view. Neither ever stops session
 * uploads or project archives: those routes are never blocked, and the
 * capture service keeps flushing whatever this version recorded.
 */

export const UPDATE_GATE_CHANNEL = "omnirush:update-gate:changed";
export const DEFAULT_DOWNLOAD_URL = "https://omnirush.ai/download";

/**
 * @typedef {{
 *   required: boolean,
 *   blocked: boolean,
 *   current: string | null,
 *   minimum: string | null,
 *   deadline: string | null,
 *   message: string | null,
 *   downloadUrl: string | null,
 * }} ClientUpdate
 *
 * @typedef {{
 *   status: "none" | "required" | "blocked",
 *   current: string,
 *   minimum: string | null,
 *   deadline: string | null,
 *   message: string | null,
 *   downloadUrl: string,
 *   source: "profile" | "header" | "rejection" | null,
 * }} UpdateGateState
 */

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoTime(value) {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(Date.parse(raw)).toISOString() : null;
}

function httpsUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function versionParts(value) {
  const raw = text(value)?.replace(/^v/i, "");
  if (!raw) return null;
  const [core, prerelease = ""] = raw.split("+", 1)[0].split("-", 2);
  const release = core.split(".").map((part) => Number(part));
  if (!release.length || release.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return { release, prerelease };
}

/** -1, 0 or 1; null when either side is not a version. A prerelease ranks below its release. */
export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < Math.max(a.release.length, b.release.length); index += 1) {
    const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * `client_update` from a /device/me, sign-in or refresh payload. Null when
 * absent, malformed, or addressed to another product (the CLI).
 * @returns {ClientUpdate | null}
 */
export function parseClientUpdate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const product = text(value.product)?.toLowerCase() ?? null;
  if (product && product !== "gui") return null;
  return {
    required: value.required === true,
    blocked: value.blocked === true,
    current: text(value.current),
    minimum: text(value.minimum),
    deadline: isoTime(value.deadline),
    message: text(value.message),
    downloadUrl: httpsUrl(value.download_url),
  };
}

/**
 * `x-omnirush-update-required: 3.1.0; deadline=2026-10-05T12:00:00Z`.
 * @returns {{ minimum: string, deadline: string | null } | null}
 */
export function parseUpdateRequiredHeader(value) {
  const raw = text(value);
  if (!raw) return null;
  const [first, ...params] = raw.split(";").map((part) => part.trim());
  if (!first || !versionParts(first)) return null;
  let deadline = null;
  for (const param of params) {
    const [name, ...rest] = param.split("=");
    if (name?.trim().toLowerCase() === "deadline") deadline = isoTime(rest.join("=").replace(/^"|"$/g, ""));
  }
  return { minimum: first.replace(/^v/i, ""), deadline };
}

/**
 * The app's view of the update requirement. `signal()` takes any of the
 * three inputs; `onChange` hears every change in the derived state.
 * @param {{ appVersion: string, onChange?: (state: UpdateGateState) => void, now?: () => number, log?: (message: string) => void }} options
 */
export function createUpdateGate({ appVersion, onChange = () => {}, now = () => Date.now(), log = () => {} }) {
  /** @type {{ required: boolean, blocked: boolean, minimum: string | null, deadline: string | null, message: string | null, downloadUrl: string | null, source: UpdateGateState["source"] }} */
  let facts = { required: false, blocked: false, minimum: null, deadline: null, message: null, downloadUrl: null, source: null };
  let last = "";
  let timer = null;

  /** A minimum this version already meets never gates it (a stale header, a server mistake). */
  function satisfied(minimum) {
    const order = minimum ? compareVersions(appVersion, minimum) : null;
    return order !== null && order >= 0;
  }

  /** @returns {UpdateGateState} */
  function state() {
    const pastDeadline = facts.deadline !== null && Date.parse(facts.deadline) <= now();
    const active = (facts.required || facts.blocked) && !satisfied(facts.minimum);
    const status = !active ? "none" : facts.blocked || pastDeadline ? "blocked" : "required";
    return {
      status,
      current: appVersion,
      minimum: active ? facts.minimum : null,
      deadline: active ? facts.deadline : null,
      message: active ? facts.message : null,
      downloadUrl: facts.downloadUrl ?? DEFAULT_DOWNLOAD_URL,
      source: active ? facts.source : null,
    };
  }

  function publish() {
    const next = state();
    const key = JSON.stringify(next);
    if (key !== last) {
      last = key;
      log(`[update-gate] ${next.status}${next.minimum ? ` (minimum ${next.minimum}, deadline ${next.deadline ?? "none"}, via ${next.source})` : ""}`);
      onChange(next);
    }
    // Flip to blocked when the deadline passes while the app is open.
    if (timer) clearTimeout(timer);
    timer = null;
    if (next.status === "required" && next.deadline) {
      const wait = Math.min(Math.max(Date.parse(next.deadline) - now(), 0) + 500, 2 ** 31 - 1);
      timer = setTimeout(publish, wait);
      timer.unref?.();
    }
  }

  /**
   * @param {{ kind: "profile", clientUpdate: ClientUpdate | null }
   *   | { kind: "header", value: string | null | undefined }
   *   | { kind: "rejection", message?: string | null }} input
   */
  function signal(input) {
    if (input.kind === "profile") {
      const update = input.clientUpdate;
      // The account server's own answer is authoritative, in both directions.
      if (!update || (!update.required && !update.blocked)) {
        facts = { ...facts, required: false, blocked: false, minimum: null, deadline: null, message: null, source: null,
          downloadUrl: update?.downloadUrl ?? facts.downloadUrl };
      } else {
        facts = {
          required: true,
          blocked: update.blocked,
          minimum: update.minimum ?? facts.minimum,
          deadline: update.deadline ?? facts.deadline,
          message: update.message,
          downloadUrl: update.downloadUrl ?? facts.downloadUrl,
          source: "profile",
        };
      }
    } else if (input.kind === "header") {
      const parsed = parseUpdateRequiredHeader(input.value);
      if (!parsed || satisfied(parsed.minimum)) return state();
      facts = {
        ...facts,
        required: true,
        minimum: parsed.minimum,
        deadline: parsed.deadline ?? facts.deadline,
        source: facts.blocked ? facts.source : "header",
      };
    } else if (input.kind === "rejection") {
      facts = {
        ...facts,
        required: true,
        blocked: true,
        message: text(input.message) ?? facts.message,
        source: "rejection",
      };
    }
    publish();
    return state();
  }

  // Only changes are published: the launch state ("none") is not one.
  last = JSON.stringify(state());

  function dispose() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { state, signal, dispose };
}
