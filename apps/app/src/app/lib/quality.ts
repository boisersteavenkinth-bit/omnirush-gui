// Quality rewards, renderer side. The Electron main process reads `quality`
// from /device/me (apps/desktop/electron/quality.mjs) and spins the wheel
// with the device credential; these helpers decide what the sidebar badge,
// the notice popup and the spin dialog show. The server picks every prize:
// the app only animates the wheel to `segmentIndex` and renders its flags.

import { create } from "zustand";

import type {
  OmniRushAccountQuality,
  OmniRushAccountStatus,
  OmniRushQualityNotice,
  OmniRushQualitySpin,
  OmniRushQualitySpinOutcome,
  OmniRushQualityTier,
  OmniRushWheelSegment,
} from "@omnirush/types/desktop-ipc";

import { compactTokenCount } from "./omnirush-usage";

export type AccountQuality = OmniRushAccountQuality;
export type QualitySpin = OmniRushQualitySpin;
export type QualitySpinOutcome = OmniRushQualitySpinOutcome;
export type QualityTier = OmniRushQualityTier;
export type WheelSegment = OmniRushWheelSegment;
export type QualityNotice = OmniRushQualityNotice;

/** The wheel as the API documents it; used until GET /me/quality answers. */
export const DEFAULT_WHEEL_SEGMENTS: WheelSegment[] = [
  { tokens: 250_000, weight: 35 },
  { tokens: 500_000, weight: 30 },
  { tokens: 1_000_000, weight: 20 },
  { tokens: 2_000_000, weight: 10 },
  { tokens: 5_000_000, weight: 4 },
  { tokens: 10_000_000, weight: 1 },
];

const TIER_LABELS: Record<QualityTier, string> = {
  new: "New",
  standard: "Standard",
  gold: "Gold",
  coaching: "Coaching",
  limited: "Limited",
};

export function qualityTierLabel(tier: QualityTier): string {
  return TIER_LABELS[tier] ?? "Standard";
}

/** The badge's text: "Gold", or "Gold · Preview" while spins pay nothing. */
export function qualityBadgeText(quality: AccountQuality): string {
  return quality.preview ? `${qualityTierLabel(quality.tier)} · Preview` : qualityTierLabel(quality.tier);
}

/** The badge's tooltip: the hint to the next tier and, while limited, the token cut. */
export function qualityBadgeTitle(quality: AccountQuality): string {
  const parts = [`Quality: ${qualityTierLabel(quality.tier)}`];
  if (quality.tokensMultiplier < 1) parts.push(`tokens ×${quality.tokensMultiplier}`);
  if (quality.preview) parts.push("preview: spins pay 0 tokens");
  const head = parts.join(" · ");
  return quality.nextTierHint ? `${head}\n${quality.nextTierHint}` : head;
}

/** Whether the spin button can spin now: spins left, and not all of them held back by a resting wheel. */
export function canSpinNow(quality: AccountQuality | null | undefined): boolean {
  if (!quality || quality.spinsAvailable <= 0) return false;
  return !quality.resting || quality.reproSpinsAvailable > 0;
}

// --- Notices, nudges: once per id ---------------------------------------

export const NOTICE_SEEN_STORAGE_KEY = "omnirush.quality.lastNoticeId.v1";
export const NUDGE_SEEN_STORAGE_KEY = "omnirush.quality.lastNudgeId.v1";
export const SOUND_STORAGE_KEY = "omnirush.quality.sound.v1";

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readPref(key: string, storage: KeyValueStore | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string, storage: KeyValueStore | null = defaultStorage()): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // A full or blocked storage only means the notice may show once more.
  }
}

/** The newest notice: `notices[0]`, or `notice` from a server without the list. */
export function latestNotice(quality: AccountQuality | null | undefined): QualityNotice | null {
  if (!quality) return null;
  return quality.notices?.[0] ?? quality.notice ?? null;
}

/** The notice to pop up, or null when it was already seen (a new id is a new notice). */
export function noticeToShow(quality: AccountQuality | null | undefined, lastSeenId: string | null): QualityNotice | null {
  const notice = latestNotice(quality);
  return notice && notice.id !== lastSeenId ? notice : null;
}

/** The server's nudge, once per id. Never guessed on the client. */
export function nudgeToShow(
  quality: AccountQuality | null | undefined,
  lastSeenId: string | null,
): { id: string; text: string } | null {
  const nudge = quality?.nudge ?? null;
  return nudge && nudge.id !== lastSeenId ? nudge : null;
}

/** Coaching (and its reminders) reads as "here is how to get spins". */
export function isCoachingNotice(notice: QualityNotice | null, quality: AccountQuality | null | undefined): boolean {
  if (notice?.kind) return notice.kind === "tier-coaching" || notice.kind === "reminder-coaching";
  return quality?.tier === "coaching";
}

// --- The wheel's geometry -------------------------------------------------

export type WheelSlice = { index: number; start: number; end: number; mid: number; segment: WheelSegment };

/**
 * Slices in degrees clockwise from the top (where the pointer is), sized by
 * `weight` so the wheel shows the real odds; equal slices when no weight is
 * usable.
 */
export function wheelSlices(segments: WheelSegment[]): WheelSlice[] {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.weight), 0);
  let start = 0;
  return segments.map((segment, index) => {
    const share = total > 0 ? Math.max(0, segment.weight) / total : 1 / segments.length;
    const end = index === segments.length - 1 ? 360 : start + share * 360;
    const slice = { index, start, end, mid: (start + end) / 2, segment };
    start = end;
    return slice;
  });
}

function mod360(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** The slice under the pointer when the wheel is turned `rotation` degrees clockwise. */
export function sliceAtPointer(slices: WheelSlice[], rotation: number): number {
  const at = mod360(-rotation);
  const found = slices.find((slice) => at >= slice.start && at < slice.end);
  return found ? found.index : slices.length - 1;
}

/**
 * The rotation that stops slice `index` under the pointer, at least `turns`
 * full turns past `from`. `offset` (-1..1) moves the stop inside the slice
 * (0 is its middle), so the pointer never stops on a boundary.
 */
export function wheelTargetRotation(
  segments: WheelSegment[],
  index: number,
  from = 0,
  turns = 5,
  offset = 0,
): number {
  const slices = wheelSlices(segments);
  const slice = slices[Math.min(Math.max(0, index), slices.length - 1)];
  if (!slice) return from;
  const half = (slice.end - slice.start) / 2;
  const clamped = Math.max(-0.7, Math.min(0.7, offset));
  const stopAt = slice.mid + clamped * half;
  const base = from + turns * 360;
  return base + mod360(-stopAt - base);
}

/**
 * The spin's shape over time: a short acceleration, a long deceleration
 * that overshoots the stop by `overshoot` degrees, and a settle back onto
 * it. `progress` is 0..1; the result goes from `from` to `to`.
 */
export function wheelAngleAt(progress: number, from: number, to: number, overshoot = 0): number {
  const p = Math.min(1, Math.max(0, progress));
  const distance = to - from;
  const ACCEL = 0.12;
  const SETTLE = 0.88;
  // Velocity ramps up linearly over ACCEL and decays as a cubic after it, so
  // the curve is smooth where the phases meet. Normalised so it ends on `to + overshoot`.
  const accelArea = ACCEL / 2;
  const decelArea = (SETTLE - ACCEL) / 4;
  const total = accelArea + decelArea;
  const reach = distance + overshoot;
  if (p >= SETTLE) {
    const q = (p - SETTLE) / (1 - SETTLE);
    const ease = q * q * (3 - 2 * q);
    return to + overshoot * (1 - ease);
  }
  if (p <= ACCEL) {
    const area = (p * p) / (2 * ACCEL);
    return from + reach * (area / total);
  }
  const d = (p - ACCEL) / (SETTLE - ACCEL);
  const area = accelArea + ((SETTLE - ACCEL) * (1 - (1 - d) ** 4)) / 4;
  return from + reach * (area / total);
}

/** How far the wheel may overshoot its stop without leaving the slice. */
export function wheelOvershoot(segments: WheelSegment[], index: number, offset = 0): number {
  const slice = wheelSlices(segments)[index];
  if (!slice) return 0;
  const half = (slice.end - slice.start) / 2;
  const room = half * (1 - Math.max(-0.7, Math.min(0.7, offset)));
  return Math.min(6, room * 0.6);
}

/** "12%": a segment's share of the weights. */
export function segmentOdds(segments: WheelSegment[], index: number): string {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.weight), 0);
  const weight = Math.max(0, segments[index]?.weight ?? 0);
  if (total <= 0) return `${Math.round(100 / Math.max(1, segments.length))}%`;
  const share = (weight * 100) / total;
  return share < 1 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`;
}

// --- Spin outcome text ------------------------------------------------------

export function spinRefusalMessage(reason: Exclude<QualitySpinOutcome, { ok: true }>["reason"]): string {
  switch (reason) {
    case "wheel_resting":
      return "The wheel is resting, back tomorrow.";
    case "no_spins":
      return "No spins yet: good sessions earn spins.";
    case "quality_rewards_off":
      return "Quality rewards are switched off right now.";
    case "signed_out":
      return "Sign in to omnirush.ai to spin.";
    case "unreachable":
      return "omnirush.ai could not be reached. Try again in a moment.";
    default:
      return "The spin did not go through. Try again.";
  }
}

/** The line under the prize: what the spin paid. */
export function spinPayoutText(spin: QualitySpin): string {
  if (spin.preview) return "Preview: no tokens paid";
  if (spin.capped) return "Pot cap reached: this spin pays 0";
  return `+${compactTokenCount(spin.tokens)} tokens added to your pot`;
}

/** The near-miss tease, only when the server flags it. */
export function nearMissText(spin: QualitySpin): string | null {
  if (!spin.nearMiss) return null;
  const jackpot = spin.jackpotTokens || Math.max(...spin.segments.map((segment) => segment.tokens));
  return `So close to ${compactTokenCount(jackpot)}!`;
}

export function newSpinIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

// --- Shared account status (sidebar footer + notice popup) -----------------

type AccountStatusStore = {
  status: OmniRushAccountStatus | null;
  set: (status: OmniRushAccountStatus | null) => void;
};

export const useAccountStatusStore = create<AccountStatusStore>((set) => ({
  status: null,
  set: (status) => set({ status }),
}));

let inFlight: Promise<OmniRushAccountStatus | null> | null = null;

/**
 * Reads the account status (/device/me) once for every caller in flight:
 * the sidebar footer and the quality popup share one request.
 */
export function refreshAccountStatus(
  read: () => Promise<OmniRushAccountStatus>,
): Promise<OmniRushAccountStatus | null> {
  inFlight ??= read()
    .then((status) => {
      useAccountStatusStore.getState().set(status);
      return status;
    })
    .catch(() => {
      const fallback = { connected: false, gatewayConfigured: false } satisfies OmniRushAccountStatus;
      useAccountStatusStore.getState().set(fallback);
      return fallback;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useAccountQuality(): AccountQuality | null {
  return useAccountStatusStore((store) => (store.status?.connected ? store.status.quality ?? null : null));
}

type QualityUiStore = {
  /** The panel (notice, tips, streak, coaching) opened from the sidebar. */
  panelOpen: boolean;
  spinOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  openSpin: () => void;
  closeSpin: () => void;
};

export const useQualityUiStore = create<QualityUiStore>((set) => ({
  panelOpen: false,
  spinOpen: false,
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  openSpin: () => set({ spinOpen: true, panelOpen: false }),
  closeSpin: () => set({ spinOpen: false }),
}));
