import { useCallback, useEffect, useState } from "react";

import type { AccountQuality, QualityNotice } from "../../../app/lib/quality";
import {
  COACHING_DAY_STORAGE_KEY,
  SEEN_NOTICES_STORAGE_KEY,
  SEEN_NUDGES_STORAGE_KEY,
  isQuietMoment,
  noticeToPopUp,
  nudgeToPopUp,
  readSeenNotices,
  readSeenNudges,
  recordNoticeShown,
  rememberSeenId,
} from "../../../app/lib/quality-popups";
import { readPref } from "../../../app/lib/quality";
import { hasLiveSessionActivity, useSessionActivityStore } from "../session/status/session-activity-store";

/** How long after the last keystroke the user counts as no longer typing. */
const QUIET_AFTER_TYPING_MS = 30_000;
/** A nudge is a hint, not a question: it hides by itself. */
const NUDGE_VISIBLE_MS = 12_000;

/** True while no turn is running and the user has not typed for QUIET_AFTER_TYPING_MS. */
export function useQuietMoment(quietAfterMs = QUIET_AFTER_TYPING_MS): boolean {
  const turnRunning = useSessionActivityStore((store) => hasLiveSessionActivity(store.statusesByWorkspaceId));
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onKey = () => {
      setTyping(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTyping(false), quietAfterMs);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(timer);
    };
  }, [quietAfterMs]);
  return isQuietMoment({ turnRunning, typing });
}

/**
 * The notice and nudge to show over the app (quality-popups.ts has the
 * rules). A popup is chosen only at a quiet moment and is marked seen as it
 * appears, so it shows once even if the app quits before it is dismissed;
 * it then stays until dismissed (a nudge hides by itself).
 */
export function useQualityPopups(quality: AccountQuality | null) {
  const quiet = useQuietMoment();
  const [seenNotices, setSeenNotices] = useState(() => readSeenNotices());
  const [seenNudges, setSeenNudges] = useState(() => readSeenNudges());
  const [notice, setNotice] = useState<QualityNotice | null>(null);
  const [nudge, setNudge] = useState<{ id: string; text: string } | null>(null);

  // Another window (or a second copy of the renderer) marking an id seen.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === SEEN_NOTICES_STORAGE_KEY || event.key === COACHING_DAY_STORAGE_KEY) setSeenNotices(readSeenNotices());
      if (event.key === SEEN_NUDGES_STORAGE_KEY) setSeenNudges(readSeenNudges());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!quiet || notice) return;
    const now = Date.now();
    const next = noticeToPopUp({ quality, seenIds: seenNotices, coachingDay: readPref(COACHING_DAY_STORAGE_KEY), now });
    if (!next) return;
    recordNoticeShown(next, quality, now);
    setSeenNotices(readSeenNotices());
    setNotice(next);
  }, [notice, quality, quiet, seenNotices]);

  useEffect(() => {
    if (!quiet || nudge || notice) return;
    const next = nudgeToPopUp({ quality, seenIds: seenNudges });
    if (!next) return;
    setSeenNudges(rememberSeenId(SEEN_NUDGES_STORAGE_KEY, next.id));
    setNudge(next);
  }, [notice, nudge, quality, quiet, seenNudges]);

  useEffect(() => {
    if (!nudge) return;
    const timer = window.setTimeout(() => setNudge(null), NUDGE_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [nudge]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  const dismissNudge = useCallback(() => setNudge(null), []);
  return { notice, nudge, dismissNotice, dismissNudge };
}
