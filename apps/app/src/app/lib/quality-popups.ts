// When the quality rewards may interrupt. The server sends notices (tier
// changes, spins earned, the daily coaching tip) and a nudge, each with an id;
// /device/me is re-read every 15 minutes and on every window focus. These
// rules keep that from turning into popups at random moments:
//
//  - a notice or nudge pops up at most once: seen ids persist (a list, not
//    just the last id, so a server alternating between two ids cannot bring
//    one back) and are marked seen as soon as one shows, not on dismiss;
//  - "you earned N spins" never pops up: the sidebar's spin count says it;
//  - coaching (tier and daily reminder) pops up at most once a UTC day;
//  - nothing pops up while a turn runs or the user is typing (the caller
//    holds a pending popup until a quiet moment).

import type { AccountQuality, QualityNotice } from "./quality";
import { NOTICE_SEEN_STORAGE_KEY, NUDGE_SEEN_STORAGE_KEY, isCoachingNotice, latestNotice, readPref, writePref } from "./quality";

export const SEEN_NOTICES_STORAGE_KEY = "omnirush.quality.seenNoticeIds.v2";
export const SEEN_NUDGES_STORAGE_KEY = "omnirush.quality.seenNudgeIds.v2";
export const COACHING_DAY_STORAGE_KEY = "omnirush.quality.coachingShownDay.v1";
const MAX_SEEN_IDS = 100;

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/** The seen ids under `key`, plus the single id the previous version stored under `legacyKey`. */
export function readSeenIds(key: string, legacyKey: string | null, storage?: KeyValueStore | null): string[] {
  const ids: string[] = [];
  try {
    const parsed = JSON.parse(readPref(key, storage) ?? "[]");
    if (Array.isArray(parsed)) ids.push(...parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    // A corrupt list only means a popup may show once more.
  }
  const legacy = legacyKey ? readPref(legacyKey, storage) : null;
  if (legacy && !ids.includes(legacy)) ids.push(legacy);
  return ids;
}

/** Adds `id` to the seen list (newest last, bounded) and returns the new list. */
export function rememberSeenId(key: string, id: string, storage?: KeyValueStore | null): string[] {
  const ids = readSeenIds(key, null, storage).filter((seen) => seen !== id);
  ids.push(id);
  const next = ids.slice(-MAX_SEEN_IDS);
  writePref(key, JSON.stringify(next), storage);
  return next;
}

export function readSeenNotices(storage?: KeyValueStore | null): string[] {
  return readSeenIds(SEEN_NOTICES_STORAGE_KEY, NOTICE_SEEN_STORAGE_KEY, storage);
}

export function readSeenNudges(storage?: KeyValueStore | null): string[] {
  return readSeenIds(SEEN_NUDGES_STORAGE_KEY, NUDGE_SEEN_STORAGE_KEY, storage);
}

/** "You earned N spins": the sidebar count announces it, never a popup. */
export function isSpinsNotice(notice: QualityNotice | null | undefined): boolean {
  if (!notice) return false;
  return notice.kind === "spins" || (!notice.kind && notice.id.startsWith("spins-"));
}

/** The UTC day, as the server dates its daily notices. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The notice that may pop up now, or null. `coachingDay` is the UTC day a
 * coaching notice last popped up.
 */
export function noticeToPopUp(input: {
  quality: AccountQuality | null | undefined;
  seenIds: readonly string[];
  coachingDay: string | null;
  now: number;
}): QualityNotice | null {
  const notice = latestNotice(input.quality);
  if (!notice?.id || input.seenIds.includes(notice.id)) return null;
  if (isSpinsNotice(notice)) return null;
  if (isCoachingNotice(notice, input.quality) && input.coachingDay === utcDay(input.now)) return null;
  return notice;
}

/** The server's nudge, once per id. */
export function nudgeToPopUp(input: {
  quality: AccountQuality | null | undefined;
  seenIds: readonly string[];
}): { id: string; text: string } | null {
  const nudge = input.quality?.nudge ?? null;
  return nudge?.id && !input.seenIds.includes(nudge.id) ? nudge : null;
}

/**
 * Records that `notice` popped up: it never pops up again, and a coaching
 * notice holds the next one back until tomorrow.
 */
export function recordNoticeShown(
  notice: QualityNotice,
  quality: AccountQuality | null | undefined,
  now: number,
  storage?: KeyValueStore | null,
): void {
  rememberSeenId(SEEN_NOTICES_STORAGE_KEY, notice.id, storage);
  if (isCoachingNotice(notice, quality)) writePref(COACHING_DAY_STORAGE_KEY, utcDay(now), storage);
}

/** A popup may show only when no turn is running and the user is not typing. */
export function isQuietMoment(input: { turnRunning: boolean; typing: boolean }): boolean {
  return !input.turnRunning && !input.typing;
}
