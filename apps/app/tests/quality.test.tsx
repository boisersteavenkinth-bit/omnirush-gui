import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_WHEEL_SEGMENTS,
  NOTICE_SEEN_STORAGE_KEY,
  canSpinNow,
  nearMissText,
  noticeToShow,
  nudgeToShow,
  qualityBadgeText,
  readPref,
  sliceAtPointer,
  spinPayoutText,
  spinRefusalMessage,
  useAccountStatusStore,
  wheelAngleAt,
  wheelOvershoot,
  wheelSlices,
  wheelTargetRotation,
  writePref,
  type AccountQuality,
  type QualitySpin,
  type QualityTier,
} from "../src/app/lib/quality";
import { QualityTierBadge, streakText } from "../src/react-app/domains/quality/quality-parts";
import { QualityNoticeCard, QualityRewards } from "../src/react-app/domains/quality/quality-notice";
import { QualitySpinDialog } from "../src/react-app/domains/quality/quality-spin-dialog";

const quality: AccountQuality = {
  tier: "gold",
  score: 0.52,
  tokensMultiplier: 1,
  spinsAvailable: 2,
  reproSpinsAvailable: 1,
  spinsExpireAt: "2026-10-06T10:00:00Z",
  nextTierHint: "Score 0.52. Stay above 0.45 to keep Gold.",
  tips: ["Start omnirush inside the project folder, not ~, and keep edits there.", "Add tests: tested work earns spins."],
  notice: { id: "spins-1", kind: "spins", title: "You earned 2 spins", body: "Two sessions in my-app were reproducible." },
  notices: [{ id: "spins-1", kind: "spins", title: "You earned 2 spins", body: "Two sessions in my-app were reproducible." }],
  mode: "enforce",
  resting: false,
  preview: false,
  streakDays: 4,
  streakMultiplier: 1,
  streakNext: { days: 7, bonusSpins: 2 },
  nextSpinHint: { progress: 0.6, text: "Add tests to earn a spin.", sessionId: "ses_1" },
  biggestWinToday: { tokens: 10_000_000, at: "2026-10-04T09:00:00Z" },
  nudge: null,
};

const spin: QualitySpin = {
  tokens: 1_000_000,
  prizeTokens: 1_000_000,
  segmentIndex: 2,
  segments: DEFAULT_WHEEL_SEGMENTS,
  preview: false,
  capped: false,
  reproducible: true,
  alreadySpun: false,
  spunAt: "2026-10-04T12:00:00Z",
  spinsAvailable: 1,
  potBalance: 12_500_000,
  celebrate: "none",
  nearMiss: false,
  jackpotTokens: 10_000_000,
  streakDays: 4,
};

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

describe("tier badge", () => {
  const labels: Record<QualityTier, string> = { new: "New", standard: "Standard", gold: "Gold", coaching: "Coaching", limited: "Limited" };
  for (const [tier, label] of Object.entries(labels) as [QualityTier, string][]) {
    test(`shows ${label} for ${tier}`, () => {
      const html = renderToStaticMarkup(<QualityTierBadge quality={{ ...quality, tier, preview: false }} />);
      expect(html).toContain(`data-tier="${tier}"`);
      expect(html).toContain(`>${label}</span>`);
      expect(html).not.toContain("data-preview");
    });
  }

  test("preview: dashed, and says Preview", () => {
    const html = renderToStaticMarkup(<QualityTierBadge quality={{ ...quality, preview: true }} />);
    expect(qualityBadgeText({ ...quality, preview: true })).toBe("Gold · Preview");
    expect(html).toContain("Gold · Preview");
    expect(html).toContain("data-preview");
    expect(html).toContain("border-dashed");
  });

  test("renders nothing while quality is null (feature off)", () => {
    expect(renderToStaticMarkup(<QualityTierBadge quality={null} />)).toBe("");
  });

  test("the quality overlay renders nothing while quality is null, or signed out", () => {
    useAccountStatusStore.getState().set({ connected: true, gatewayConfigured: true, quality: null });
    expect(renderToStaticMarkup(<QualityRewards />)).toBe("");
    useAccountStatusStore.getState().set({ connected: false, gatewayConfigured: true, quality });
    expect(renderToStaticMarkup(<QualityRewards />)).toBe("");
    useAccountStatusStore.getState().set(null);
  });
});

describe("notice: once per id", () => {
  test("a notice shows until its id is seen; a new id shows again", () => {
    const storage = memoryStorage();
    expect(noticeToShow(quality, readPref(NOTICE_SEEN_STORAGE_KEY, storage))?.id).toBe("spins-1");
    writePref(NOTICE_SEEN_STORAGE_KEY, "spins-1", storage);
    expect(noticeToShow(quality, readPref(NOTICE_SEEN_STORAGE_KEY, storage))).toBeNull();
    const next = { id: "tier-gold-2", kind: "tier-gold", title: "You reached Gold", body: "" };
    expect(noticeToShow({ ...quality, notice: next, notices: [next, quality.notices[0]] }, "spins-1")?.id).toBe("tier-gold-2");
    expect(noticeToShow({ ...quality, notice: null, notices: [] }, null)).toBeNull();
    expect(noticeToShow(null, null)).toBeNull();
  });

  test("the nudge shows only when the server sends one, once per id", () => {
    expect(nudgeToShow(quality, null)).toBeNull();
    const nudged = { ...quality, nudge: { id: "nudge-1", text: "This session can earn spins: add tests." } };
    expect(nudgeToShow(nudged, null)?.text).toContain("add tests");
    expect(nudgeToShow(nudged, "nudge-1")).toBeNull();
  });

  test("the popup shows the notice, the tips and a Spin button while spins are ready", () => {
    const html = renderToStaticMarkup(
      <QualityNoticeCard quality={quality} notice={quality.notice} onSpin={() => undefined} onDismiss={() => undefined} />,
    );
    expect(html).toContain("data-notice-id=\"spins-1\"");
    expect(html).toContain("You earned 2 spins");
    expect(html).toContain("Two sessions in my-app were reproducible.");
    expect(html).toContain("keep edits there.");
    expect(html).toContain("data-testid=\"quality-notice-spin\"");
    expect(html).toContain("Spin (2)");
    expect(html).toContain("4-day streak");
    expect(html).toContain("Next spin · 60%");
  });

  test("no Spin button without spins; a resting wheel says so", () => {
    const none = renderToStaticMarkup(
      <QualityNoticeCard quality={{ ...quality, spinsAvailable: 0, reproSpinsAvailable: 0 }} notice={quality.notice} onSpin={() => undefined} onDismiss={() => undefined} />,
    );
    expect(none).not.toContain("quality-notice-spin");
    const resting = { ...quality, resting: true, reproSpinsAvailable: 0 };
    expect(canSpinNow(resting)).toBe(false);
    expect(canSpinNow({ ...resting, reproSpinsAvailable: 1 })).toBe(true);
    const html = renderToStaticMarkup(<QualityNoticeCard quality={resting} notice={null} onSpin={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain("The wheel is resting, back tomorrow.");
  });

  test("coaching reads as how to earn spins, with a see-why list", () => {
    const coaching = { ...quality, tier: "coaching" as const, spinsAvailable: 0 };
    const notice = { id: "c-1", kind: "tier-coaching", title: "Here is how to get spins", body: "A few habits make sessions count." };
    const html = renderToStaticMarkup(<QualityNoticeCard quality={coaching} notice={notice} onSpin={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain("How to earn spins");
    expect(html).toContain("See why");
    expect(html).toContain("data-coaching");
  });

  test("streak text", () => {
    expect(streakText(quality)).toBe("4-day streak · +1 spin per reproducible session · 7 days: +2");
    expect(streakText({ streakDays: 0, streakMultiplier: 0, streakNext: null })).toBeNull();
  });
});

describe("wheel geometry", () => {
  const slices = wheelSlices(DEFAULT_WHEEL_SEGMENTS);

  test("slices follow the weights and fill the circle", () => {
    expect(slices[0].start).toBe(0);
    expect(slices.at(-1)!.end).toBe(360);
    expect(slices[0].end - slices[0].start).toBeCloseTo(126, 5);
    expect(slices[5].end - slices[5].start).toBeCloseTo(3.6, 5);
  });

  test("the target rotation stops every index under the pointer, after full turns", () => {
    for (let index = 0; index < DEFAULT_WHEEL_SEGMENTS.length; index += 1) {
      for (const from of [0, 137.5, 2_000]) {
        for (const offset of [-0.9, 0, 0.45]) {
          const target = wheelTargetRotation(DEFAULT_WHEEL_SEGMENTS, index, from, 6, offset);
          expect(sliceAtPointer(slices, target)).toBe(index);
          expect(target - from).toBeGreaterThanOrEqual(6 * 360);
          expect(target - from).toBeLessThan(7 * 360);
        }
      }
    }
  });

  test("index 2 (1M) stops at the middle of its slice with no offset", () => {
    const target = wheelTargetRotation(DEFAULT_WHEEL_SEGMENTS, 2, 0, 5);
    // Slice 2 spans 234°..306°: its middle (270°) is turned to the top.
    expect(((-target % 360) + 360) % 360).toBeCloseTo(270, 6);
  });

  test("the spin starts and ends where it should, and the overshoot stays in the slice", () => {
    const to = wheelTargetRotation(DEFAULT_WHEEL_SEGMENTS, 5, 0, 6);
    const overshoot = wheelOvershoot(DEFAULT_WHEEL_SEGMENTS, 5);
    expect(wheelAngleAt(0, 0, to, overshoot)).toBe(0);
    expect(wheelAngleAt(1, 0, to, overshoot)).toBeCloseTo(to, 6);
    let previous = 0;
    let peak = 0;
    let arrived = false;
    for (let step = 1; step <= 1_000; step += 1) {
      const angle = wheelAngleAt(step / 1_000, 0, to, overshoot);
      if (step / 1_000 <= 0.88) expect(angle).toBeGreaterThanOrEqual(previous);
      previous = angle;
      peak = Math.max(peak, angle);
      // Once the wheel reaches the stop it overshoots and settles without leaving the 10M slice.
      arrived ||= angle >= to;
      if (arrived) expect(sliceAtPointer(slices, angle)).toBe(5);
    }
    expect(arrived).toBe(true);
    expect(peak).toBeCloseTo(to + overshoot, 3);
  });
});

describe("spin results", () => {
  test("refusals read as the API asks", () => {
    expect(spinRefusalMessage("wheel_resting")).toBe("The wheel is resting, back tomorrow.");
    expect(spinRefusalMessage("no_spins")).toBe("No spins yet: good sessions earn spins.");
    expect(spinRefusalMessage("quality_rewards_off")).toContain("switched off");
  });

  test("paid, preview and capped", () => {
    expect(spinPayoutText(spin)).toBe("+1M tokens added to your pot");
    expect(spinPayoutText({ ...spin, preview: true, tokens: 0 })).toBe("Preview: no tokens paid");
    expect(spinPayoutText({ ...spin, capped: true, tokens: 0 })).toBe("Pot cap reached: this spin pays 0");
  });

  test("the near-miss tease only when the server flags it", () => {
    expect(nearMissText(spin)).toBeNull();
    expect(nearMissText({ ...spin, nearMiss: true, segmentIndex: 4 })).toBe("So close to 10M!");
  });

  test("the dialog shows the wheel, the odds and the Spin button", () => {
    const html = renderToStaticMarkup(<QualitySpinDialog quality={quality} onClose={() => undefined} />);
    expect(html).toContain("data-testid=\"quality-wheel\"");
    expect(html).toContain("10M · 1%");
    expect(html).toContain("250K · 35%");
    expect(html).toContain("Spin (2 ready)");
    expect(html).toContain("Today&#x27;s biggest win");
  });
});
