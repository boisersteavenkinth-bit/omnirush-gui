// Mandatory client update, renderer side. The Electron main process derives
// the state (apps/desktop/electron/update-gate.mjs) from /device/me
// `client_update`, the gateway's x-omnirush-update-required header and 426
// `update_required` refusals; these helpers decide what the banner and the
// blocked view say and what "Update now" does.

import { create } from "zustand";

import type { OmniRushUpdateGateState } from "@omnirush/types/desktop-ipc";

export type UpdateGateState = OmniRushUpdateGateState;

export const NO_UPDATE_GATE: UpdateGateState = {
  status: "none",
  current: "",
  minimum: null,
  deadline: null,
  message: null,
  downloadUrl: "https://omnirush.ai/download",
  source: null,
};

type UpdateGateBridge = {
  get?: () => Promise<UpdateGateState>;
  refresh?: () => Promise<UpdateGateState>;
  onChange?: (callback: (state: UpdateGateState) => void) => () => void;
};

declare global {
  interface Window {
    /** Lets evals and screenshots drive the gate without a gateway. */
    __omnirushUpdateGateEval?: (state: Partial<UpdateGateState> | null) => void;
  }
}

function bridge(): UpdateGateBridge | null {
  if (typeof window === "undefined") return null;
  return (window.__OMNIRUSH_ELECTRON__ as { updateGate?: UpdateGateBridge } | undefined)?.updateGate ?? null;
}

/** A state from the bridge, or NO_UPDATE_GATE for anything malformed. */
export function normalizeUpdateGateState(value: unknown): UpdateGateState {
  if (!value || typeof value !== "object") return NO_UPDATE_GATE;
  const raw = value as Partial<UpdateGateState>;
  const status = raw.status === "required" || raw.status === "blocked" ? raw.status : "none";
  const str = (field: unknown) => (typeof field === "string" && field.trim() ? field.trim() : null);
  return {
    status,
    current: str(raw.current) ?? "",
    minimum: str(raw.minimum),
    deadline: str(raw.deadline) && Number.isFinite(Date.parse(String(raw.deadline))) ? String(raw.deadline) : null,
    message: str(raw.message),
    downloadUrl: str(raw.downloadUrl) ?? NO_UPDATE_GATE.downloadUrl,
    source: raw.source === "profile" || raw.source === "header" || raw.source === "rejection" ? raw.source : null,
  };
}

/** "2d 4h", "5h 12m", "12m", or "less than a minute"; null without a deadline. */
export function formatUpdateCountdown(deadline: string | null, now: number): string | null {
  if (!deadline) return null;
  const at = Date.parse(deadline);
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  if (left < 60_000) return "less than a minute";
  const minutes = Math.floor(left / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

/** The banner line: "OmniRush.ai 3.1.0 is required in 5h 12m". */
export function updateBannerText(state: UpdateGateState, appName: string, now: number): string {
  const version = state.minimum ? `${appName} ${state.minimum}` : `A newer ${appName}`;
  const countdown = formatUpdateCountdown(state.deadline, now);
  return countdown ? `${version} is required in ${countdown}` : `${version} is required`;
}

/** The chat input stays disabled while the gate blocks model requests. */
export function chatBlockedByUpdate(state: UpdateGateState): boolean {
  return state.status === "blocked";
}

export type RequiredUpdateAction =
  /** A staged update is ready: install it (Linux AppImage, Windows, Developer ID macOS). */
  | "install"
  /** The updater cannot install this build (ad-hoc macOS, no updater): open the download page. */
  | "open-download"
  /** Start (or keep) the download and install as soon as it is ready. */
  | "download-then-install"
  /** A check or download is running: install when it is ready. */
  | "wait";

/**
 * What "Update now" does, from the shell's updater: `installMode`
 * "manual-dmg" (a macOS build without a Developer ID signature, which
 * Squirrel cannot swap) and an unsupported updater send the user to
 * `download_url`; a failed check or download does too.
 */
export function requiredUpdateAction(input: {
  supported: boolean;
  installMode: "in-place" | "manual-dmg" | null;
  updaterState: string | null | undefined;
}): RequiredUpdateAction {
  if (!input.supported || input.installMode === "manual-dmg") return "open-download";
  switch (input.updaterState) {
    case "ready":
      return "install";
    case "checking":
    case "downloading":
      return "wait";
    case "error":
    case "blocked":
    case "installer-opened":
      return "open-download";
    default:
      return "download-then-install";
  }
}

/** Whether the background download should start now (in-place updaters only, once per gate). */
export function shouldStartBackgroundDownload(input: {
  gate: UpdateGateState;
  supported: boolean;
  installMode: "in-place" | "manual-dmg" | null;
  updaterState: string | null | undefined;
}): boolean {
  if (input.gate.status === "none" || !input.supported || input.installMode === "manual-dmg") return false;
  return !["checking", "downloading", "ready", "installer-opened"].includes(input.updaterState ?? "");
}

type UpdateGateStore = {
  state: UpdateGateState;
  set: (state: UpdateGateState) => void;
};

export const useUpdateGateStore = create<UpdateGateStore>((set) => ({
  state: NO_UPDATE_GATE,
  set: (state) => set({ state }),
}));

let subscribed = false;

/** Subscribes the store to the desktop bridge once; safe to call from every mount. */
export function connectUpdateGate(): void {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  const apply = (value: unknown) => useUpdateGateStore.getState().set(normalizeUpdateGateState(value));
  window.__omnirushUpdateGateEval = (state) => apply(state ? { ...NO_UPDATE_GATE, ...state } : NO_UPDATE_GATE);
  const desktop = bridge();
  if (!desktop) return;
  desktop.onChange?.(apply);
  void desktop.get?.().then(apply).catch(() => undefined);
}

/** Reads /device/me again through the shell (client_update there is authoritative). */
export function refreshUpdateGate(): void {
  void bridge()?.refresh?.().then((value) => useUpdateGateStore.getState().set(normalizeUpdateGateState(value))).catch(() => undefined);
}

export function useUpdateGateState(): UpdateGateState {
  return useUpdateGateStore((store) => store.state);
}

/** True while model requests are refused for this version: the composer is disabled. */
export function useUpdateGateBlocked(): boolean {
  return useUpdateGateStore((store) => chatBlockedByUpdate(store.state));
}
