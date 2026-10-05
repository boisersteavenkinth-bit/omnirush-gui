import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { NOTICE_SEEN_STORAGE_KEY, type AccountQuality, type QualityNotice } from "../src/app/lib/quality";
import {
  COACHING_DAY_STORAGE_KEY,
  SEEN_NOTICES_STORAGE_KEY,
  isQuietMoment,
  isSpinsNotice,
  noticeToPopUp,
  nudgeToPopUp,
  readSeenNotices,
  recordNoticeShown,
  rememberSeenId,
} from "../src/app/lib/quality-popups";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

const NOON = Date.parse("2026-10-05T12:00:00Z");
const notice = (id: string, kind: string | null): QualityNotice => ({ id, kind, title: id, body: "" });

function qualityWith(notices: QualityNotice[], over: Partial<AccountQuality> = {}): AccountQuality {
  return {
    tier: "standard",
    score: 0.3,
    tokensMultiplier: 1,
    spinsAvailable: 3,
    reproSpinsAvailable: 0,
    clientSpinsAvailable: 0,
    spinsExpireAt: null,
    nextTierHint: "",
    tips: [],
    notice: notices[0] ?? null,
    notices,
    mode: "enforce",
    resting: false,
    preview: false,
    streakDays: 0,
    streakMultiplier: 1,
    streakNext: null,
    nextSpinHint: null,
    biggestWinToday: null,
    nudge: null,
    ...over,
  } as AccountQuality;
}

/** One hourly /device/me read: what pops up, and record it as the hook does. */
function pass(quality: AccountQuality, storage: ReturnType<typeof memoryStorage>, now = NOON): string | null {
  const shown = noticeToPopUp({
    quality,
    seenIds: readSeenNotices(storage),
    coachingDay: storage.getItem(COACHING_DAY_STORAGE_KEY),
    now,
  });
  if (shown) recordNoticeShown(shown, quality, now, storage);
  return shown?.id ?? null;
}

describe("quality notices pop up at most once", () => {
  test("'you earned N spins' never pops up, every hour or otherwise", () => {
    const storage = memoryStorage();
    for (let hour = 0; hour < 6; hour += 1) {
      const spins = notice(`spins-20261005${String(hour).padStart(2, "0")}00-abc`, "spins");
      expect(pass(qualityWith([spins]), storage, NOON + hour * 3_600_000)).toBeNull();
    }
    expect(isSpinsNotice(notice("spins-20261005-abc", null))).toBe(true);
    expect(isSpinsNotice(notice("tier-gold-20261005-abc", "tier-gold"))).toBe(false);
  });

  test("a tier notice pops up once, and stays seen after a restart", () => {
    const storage = memoryStorage();
    const gold = notice("tier-gold-20261005-abc", "tier-gold");
    expect(pass(qualityWith([gold]), storage)).toBe(gold.id);
    expect(pass(qualityWith([gold]), storage)).toBeNull();
    // A restart reads the list back from storage.
    const restarted = memoryStorage(Object.fromEntries(storage.data));
    expect(pass(qualityWith([gold]), restarted)).toBeNull();
  });

  test("a server alternating between two ids cannot bring one back", () => {
    const storage = memoryStorage();
    const a = notice("tier-gold-a", "tier-gold");
    const b = notice("tier-standard-b", "tier-standard");
    expect(pass(qualityWith([a]), storage)).toBe(a.id);
    expect(pass(qualityWith([b, a]), storage)).toBe(b.id);
    expect(pass(qualityWith([a, b]), storage)).toBeNull();
  });

  test("the id the previous version stored counts as seen", () => {
    const storage = memoryStorage({ [NOTICE_SEEN_STORAGE_KEY]: "tier-gold-old" });
    expect(pass(qualityWith([notice("tier-gold-old", "tier-gold")]), storage)).toBeNull();
    expect(JSON.parse(storage.getItem(SEEN_NOTICES_STORAGE_KEY) ?? "[]")).toEqual([]);
  });

  test("coaching pops up at most once a UTC day", () => {
    const storage = memoryStorage();
    const coaching = qualityWith([notice("tier-coaching-1", "tier-coaching")], { tier: "coaching" });
    expect(pass(coaching, storage)).toBe("tier-coaching-1");
    const reminder = qualityWith([notice("reminder-coaching-2", "reminder-coaching"), notice("tier-coaching-1", "tier-coaching")], { tier: "coaching" });
    expect(pass(reminder, storage, NOON + 3_600_000)).toBeNull();
    // Tomorrow's tip shows.
    expect(pass(reminder, storage, NOON + 24 * 3_600_000)).toBe("reminder-coaching-2");
    expect(pass(reminder, storage, NOON + 25 * 3_600_000)).toBeNull();
  });

  test("the seen list is bounded", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 150; index += 1) rememberSeenId(SEEN_NOTICES_STORAGE_KEY, `n-${index}`, storage);
    const ids = JSON.parse(storage.getItem(SEEN_NOTICES_STORAGE_KEY) ?? "[]");
    expect(ids).toHaveLength(100);
    expect(ids.at(-1)).toBe("n-149");
  });
});

describe("the nudge", () => {
  test("pops up once per id", () => {
    const quality = qualityWith([], { nudge: { id: "nudge-1", text: "Keep going and add tests." } });
    expect(nudgeToPopUp({ quality, seenIds: [] })?.id).toBe("nudge-1");
    expect(nudgeToPopUp({ quality, seenIds: ["nudge-1"] })).toBeNull();
  });
});

describe("quiet moments", () => {
  test("nothing pops up while a turn runs or the user types", () => {
    expect(isQuietMoment({ turnRunning: false, typing: false })).toBe(true);
    expect(isQuietMoment({ turnRunning: true, typing: false })).toBe(false);
    expect(isQuietMoment({ turnRunning: false, typing: true })).toBe(false);
  });

  test("the popup host waits for a quiet moment and marks a popup seen as it appears", () => {
    const hook = read("../src/react-app/domains/quality/use-quality-popups.ts");
    expect(hook).toContain("hasLiveSessionActivity");
    expect(hook).toContain('addEventListener("keydown"');
    expect(hook).toMatch(/if \(!quiet \|\| notice\) return;/);
    expect(hook).toContain("recordNoticeShown(next, quality, now)");
    expect(hook).toContain('addEventListener("storage"');
    expect(read("../src/react-app/domains/quality/quality-notice.tsx")).toContain("useQualityPopups(quality)");
  });
});
