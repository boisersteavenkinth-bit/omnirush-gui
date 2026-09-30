import { describe, expect, test } from "bun:test";

import type { OmniRushAccountUsage } from "@omnirush/types/desktop-ipc";

import { omnirushUsageSummary, type UsageClock } from "../src/app/lib/omnirush-usage";
import {
  accountServerLine,
  accountSignOutMessage,
} from "../src/react-app/domains/settings/pages/general-view";

describe("account usage in words", () => {
  // Wednesday 21:00 UTC; the day resets at 00:00 UTC, the week on Monday.
  const clock: UsageClock = { now: Date.parse("2026-09-30T21:00:00Z"), timeZone: "Asia/Kolkata", hourCycle: "h12" };
  const daily = (day: Partial<NonNullable<OmniRushAccountUsage["day"]>>, extra: Partial<OmniRushAccountUsage> = {}): OmniRushAccountUsage => ({
    tokenLimit: 0,
    usedTokens: 0,
    remainingTokens: 0,
    period: "day",
    grantModel: "daily",
    limitScope: "day",
    day: { allowance: 10_000_000, used: 0, reserved: 0, resetsAt: "2026-10-01T00:00:00Z", ...day },
    week: { limit: 50_000_000, used: 0, resetsAt: "2026-10-05T00:00:00Z" },
    pot: 0,
    ...extra,
  });

  test("today's allowance, when it refills, and the bonus pot", () => {
    expect(omnirushUsageSummary(daily({ used: 6_800_000 }, { pot: 500_000 }), clock)).toEqual({
      short: "3.2M tokens left today",
      line: "3.2M of 10M tokens left today · refills at 5:30 AM (in 3 h) · 500K bonus pot",
      percent: 68,
    });
  });

  test("says which limit ran out and when it resets", () => {
    expect(omnirushUsageSummary(daily({ used: 10_000_000 }), clock)).toEqual({
      short: "Today's tokens used up",
      line: "Today's tokens are used up. They refill at 5:30 AM (in 3 h).",
      percent: 100,
    });
    expect(omnirushUsageSummary(daily({ used: 1_000_000 }, { week: { limit: 50_000_000, used: 50_000_000, resetsAt: "2026-10-05T00:00:00Z" }, pot: 400_000 }), clock)).toEqual({
      short: "Weekly cap reached · 400K bonus pot",
      line: "This week's cap is reached. It resets Monday 5:30 AM (in 4 days). Your 400K bonus pot covers you until then.",
      percent: 100,
    });
    // The cap leaves less than today's allowance: it is what binds.
    expect(omnirushUsageSummary(daily({ used: 1_000_000 }, { week: { limit: 50_000_000, used: 48_000_000, resetsAt: "2026-10-05T00:00:00Z" } }), clock).line)
      .toBe("2M tokens left today (weekly cap) · cap resets Monday 5:30 AM (in 4 days)");
  });

  test("an account without daily tokens: the one-time pot, and how to earn every day", () => {
    expect(omnirushUsageSummary(daily({ allowance: 0 }, { pot: 500_000 }), clock)).toEqual({
      short: "500K one-time tokens left",
      line: "500K one-time tokens left. Link Discord or GitHub to get tokens every day.",
      percent: 0,
    });
    expect(omnirushUsageSummary(daily({ allowance: 0 }), clock).line).toBe("No tokens left. Link Discord or GitHub to get tokens every day.");
  });

  test("an account with only its own weekly cap meters the week", () => {
    const usage = daily({}, { limitScope: "week", week: { limit: 200_000_000, used: 50_000_000, resetsAt: "2026-10-05T00:00:00Z" } });
    expect(omnirushUsageSummary(usage, clock)).toEqual({
      short: "150M tokens left this week",
      line: "150M of 200M tokens left this week · resets Monday 5:30 AM (in 4 days)",
      percent: 25,
    });
  });

  test("the weekly model and an older backend read as before", () => {
    const legacy: OmniRushAccountUsage = { tokenLimit: 100_000, usedTokens: 1_234, remainingTokens: 98_766 };
    expect(omnirushUsageSummary(legacy, clock)).toEqual({
      short: "98.8K tokens left today",
      line: "98.8K of 100K tokens left today",
      percent: 1.234,
    });
    expect(omnirushUsageSummary({ ...legacy, period: "week", grantModel: "weekly" }, clock).short).toBe("98.8K tokens left this week");
  });
});

describe("settings sign-out message", () => {
  test("says exactly what happened to the remote device session", () => {
    expect(accountSignOutMessage({ remoteRevoked: true, reason: "revoked" }, "omnirush.ai")).toBe(
      "Signed out on this device and revoked its device session on omnirush.ai.",
    );
    expect(accountSignOutMessage({ remoteRevoked: true, reason: "already_revoked" }, "omnirush.ai")).toBe(
      "Signed out on this device. omnirush.ai had already revoked this device session.",
    );
    expect(accountSignOutMessage({ remoteRevoked: false, reason: "unreachable" }, "omnirush.ai")).toBe(
      "Signed out on this device. omnirush.ai could not be reached, so the device session was not revoked there.",
    );
    expect(
      accountSignOutMessage({ remoteRevoked: false, reason: "endpoint_missing" }, "localhost:8090 (local API)"),
    ).toBe(
      "Signed out on this device. localhost:8090 (local API) has no remote sign-out endpoint, so the device session was not revoked there.",
    );
  });

  test("falls back to the boolean outcome for a desktop bridge without reasons", () => {
    expect(accountSignOutMessage({ remoteRevoked: true }, null)).toBe(
      "Signed out on this device and revoked its device session on the account server.",
    );
    expect(accountSignOutMessage({ remoteRevoked: false }, "")).toBe(
      "Signed out on this device. The device session on the account server could not be revoked.",
    );
  });
});

describe("settings account server line", () => {
  test("names the connected server and the default server while signed out", () => {
    expect(accountServerLine({ connected: true, gatewayHost: "omnirush.ai" })).toBe("Connected to omnirush.ai");
    expect(accountServerLine({ connected: false, gatewayHost: "localhost:8090 (local API)" })).toBe(
      "Account server: localhost:8090 (local API)",
    );
  });

  test("renders nothing when the bridge reports no server", () => {
    expect(accountServerLine({ connected: true, gatewayHost: null })).toBe(null);
    expect(accountServerLine({ connected: false })).toBe(null);
    expect(accountServerLine({ connected: false, gatewayHost: "  " })).toBe(null);
  });
});
