import type { OmniRushAccountUsage } from "@omnirush/types/desktop-ipc";

/** The user's clock; tests pin it, the app uses the system's. */
export type UsageClock = { now?: number; timeZone?: string; hourCycle?: Intl.DateTimeFormatOptions["hourCycle"] };

export type UsageSummary = {
  /** The sidebar footer's line: "3.2M tokens left today". */
  short: string;
  /** The Settings account line, with when the binding limit resets. */
  line: string;
  /** How full the meter is, 0–100. */
  percent: number;
};

export function compactTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Math.max(0, value));
}

function percentUsed(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, Math.max(0, (used * 100) / limit)) : 0;
}

/** "5:30 AM (in 3 h)", or "Monday 5:30 AM (in 4 days)" for the week, on the user's clock; null without a time. */
export function localReset(iso: string | null | undefined, scope: "day" | "week", clock: UsageClock = {}): string | null {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return null;
  const { timeZone } = clock;
  const hourCycle = clock.hourCycle ?? new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hourCycle, timeZone }).format(at);
  const local = scope === "week" ? `${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(at)} ${time}` : time;
  const left = at - (clock.now ?? Date.now());
  if (left <= 0) return local;
  const minutes = Math.max(1, Math.round(left / 60_000));
  const hours = Math.round(minutes / 60);
  const relative = minutes < 60 ? `${minutes} min` : hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
  return `${local} (in ${relative})`;
}

/**
 * The account's tokens in words. With daily grants: today's allowance under
 * the weekly cap, then the one-time bonus pot, and when the limit that binds
 * resets. Only the weekly cap (an account's own cap): the week. Otherwise
 * (the weekly model, an older backend) the grant as before.
 */
export function omnirushUsageSummary(usage: OmniRushAccountUsage, clock: UsageClock = {}): UsageSummary {
  const pot = Math.max(0, usage.pot ?? 0);
  const potNote = pot > 0 ? ` · ${compactTokenCount(pot)} bonus pot` : "";
  const potCover = pot > 0 ? ` Your ${compactTokenCount(pot)} bonus pot covers you until then.` : "";
  const week = usage.week ?? null;
  const day = usage.grantModel === "daily" && usage.limitScope !== "week" ? usage.day : null;
  if (day) {
    if (day.allowance <= 0) {
      const tokens = pot > 0 ? `${compactTokenCount(pot)} one-time tokens left` : "No tokens left";
      return { short: tokens, line: `${tokens}. Link Discord or GitHub to get tokens every day.`, percent: pot > 0 ? 0 : 100 };
    }
    const dayLeft = Math.max(0, day.allowance - day.used - day.reserved);
    const weekLeft = week ? Math.max(0, week.limit - week.used - day.reserved) : null;
    const left = weekLeft === null ? dayLeft : Math.min(dayLeft, weekLeft);
    const capped = weekLeft !== null && weekLeft < dayLeft;
    if (left <= 0) {
      const line = capped
        ? `This week's cap is reached. It resets ${localReset(week?.resetsAt, "week", clock) ?? "Monday 00:00 UTC"}.`
        : `Today's tokens are used up. They refill at ${localReset(day.resetsAt, "day", clock) ?? "00:00 UTC"}.`;
      return { short: `${capped ? "Weekly cap reached" : "Today's tokens used up"}${potNote}`, line: `${line}${potCover}`, percent: 100 };
    }
    const reset = capped ? localReset(week?.resetsAt, "week", clock) : localReset(day.resetsAt, "day", clock);
    const when = reset ? ` · ${capped ? "cap resets" : "refills at"} ${reset}` : "";
    return {
      short: `${compactTokenCount(left)} tokens left today`,
      line: `${capped ? `${compactTokenCount(left)} tokens left today (weekly cap)` : `${compactTokenCount(left)} of ${compactTokenCount(day.allowance)} tokens left today`}${when}${potNote}`,
      percent: percentUsed(day.allowance - left, day.allowance),
    };
  }
  if (usage.grantModel === "daily" && week) {
    const left = Math.max(0, week.limit - week.used);
    const reset = localReset(week.resetsAt, "week", clock);
    if (left <= 0) {
      return { short: `Weekly cap reached${potNote}`, line: `This week's cap is reached. It resets ${reset ?? "Monday 00:00 UTC"}.${potCover}`, percent: 100 };
    }
    return {
      short: `${compactTokenCount(left)} tokens left this week`,
      line: `${compactTokenCount(left)} of ${compactTokenCount(week.limit)} tokens left this week${reset ? ` · resets ${reset}` : ""}${potNote}`,
      percent: percentUsed(week.used, week.limit),
    };
  }
  const period = usage.period === "week" ? "this week" : "today";
  return {
    short: `${compactTokenCount(usage.remainingTokens)} tokens left ${period}`,
    line: `${compactTokenCount(usage.remainingTokens)} of ${compactTokenCount(usage.tokenLimit)} tokens left ${period}`,
    percent: percentUsed(usage.usedTokens, usage.tokenLimit),
  };
}
