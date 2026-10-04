/** @jsxImportSource react */
import { Flame, Gift, Trophy } from "lucide-react";

import { cn } from "@/lib/utils";

import { compactTokenCount } from "../../../app/lib/omnirush-usage";
import { qualityBadgeText, qualityBadgeTitle, type AccountQuality, type QualityTier } from "../../../app/lib/quality";

const TIER_STYLES: Record<QualityTier, string> = {
  new: "border-sky-400/40 bg-sky-400/10 text-sky-200",
  standard: "border-slate-300/30 bg-slate-300/10 text-slate-200",
  gold: "border-amber-300/60 bg-amber-300/15 text-amber-200",
  coaching: "border-violet-300/45 bg-violet-300/10 text-violet-200",
  limited: "border-rose-300/45 bg-rose-400/10 text-rose-200",
};

/** The tier, as a small pill. Dashed and dimmed in preview (spins pay nothing). */
export function QualityTierBadge({ quality, className }: { quality: AccountQuality | null; className?: string }) {
  // Null: quality rewards are switched off, and nothing shows.
  if (!quality) return null;
  return (
    <span
      data-testid="quality-tier-badge"
      data-tier={quality.tier}
      data-preview={quality.preview ? "" : undefined}
      title={qualityBadgeTitle(quality)}
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[9.5px] font-semibold uppercase leading-none tracking-[0.06em]",
        TIER_STYLES[quality.tier],
        quality.preview && "border-dashed opacity-80",
        className,
      )}
    >
      {quality.tier === "gold" ? <Trophy className="size-2.5" aria-hidden="true" /> : null}
      {qualityBadgeText(quality)}
    </span>
  );
}

/** A ring that fills as the latest session gets closer to earning a spin. */
export function ProgressRing({ progress, size = 18, stroke = 2.5, className }: { progress: number; size?: number; stroke?: number; className?: string }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const value = Math.min(1, Math.max(0, progress));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0 -rotate-90", className)}
      data-testid="quality-progress-ring"
      data-progress={value.toFixed(2)}
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#a3e635"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - value)}
      />
    </svg>
  );
}

/** "Spin" with a pulsing count of the spins that are ready. */
export function SpinButton(props: {
  quality: AccountQuality;
  onClick: () => void;
  className?: string;
  label?: string;
  testId?: string;
}) {
  const { quality } = props;
  const ready = quality.spinsAvailable;
  const stars = Math.min(ready, quality.clientSpinsAvailable ?? 0);
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid={props.testId ?? "quality-spin-button"}
      data-spins={ready}
      data-client-spins={stars}
      title={ready > 0
        ? `${ready} spin${ready === 1 ? "" : "s"} ready${stars > 0 ? `, ${stars} client-grade ★ on the richer wheel` : ""}`
        : "No spins yet: good sessions earn spins."}
      className={cn(
        "relative inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold transition",
        ready > 0
          ? "bg-[#a3e635] text-[#1a2e05] shadow-[0_0_14px_rgba(163,230,53,0.45)] hover:bg-[#bef264]"
          : "border border-sidebar-border text-muted-foreground hover:text-foreground",
        props.className,
      )}
    >
      <Gift className="size-3.5" aria-hidden="true" />
      {props.label ?? "Spin"}
      {ready > 0 ? (
        <span className="relative ms-0.5 flex size-4 items-center justify-center">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70 motion-reduce:hidden" />
          <span className="relative inline-flex size-4 items-center justify-center rounded-full bg-[#0b1120] text-[9.5px] font-bold text-[#a3e635]">
            {ready > 9 ? "9+" : ready}
          </span>
        </span>
      ) : null}
      {stars > 0 ? (
        <span
          data-testid="quality-client-spins"
          className="inline-flex h-4 items-center rounded-full bg-amber-300 px-1 text-[9.5px] font-bold text-amber-950"
        >
          ★{stars > 9 ? "9+" : stars}
        </span>
      ) : null}
    </button>
  );
}

/** "4-day streak · +1 spin per reproducible session · 7 days: +2". */
export function streakText(quality: Pick<AccountQuality, "streakDays" | "streakMultiplier" | "streakNext">): string | null {
  if (quality.streakDays <= 0 && !quality.streakNext) return null;
  const parts: string[] = [];
  parts.push(quality.streakDays > 0 ? `${quality.streakDays}-day streak` : "No streak yet");
  if (quality.streakMultiplier > 0) parts.push(`+${quality.streakMultiplier} spin${quality.streakMultiplier === 1 ? "" : "s"} per reproducible session`);
  if (quality.streakNext) parts.push(`${quality.streakNext.days} days: +${quality.streakNext.bonusSpins}`);
  return parts.join(" · ");
}

export function StreakLine({ quality, className }: { quality: AccountQuality; className?: string }) {
  const text = streakText(quality);
  if (!text) return null;
  return (
    <div className={cn("flex items-center gap-1.5 text-xs text-orange-200", className)} data-testid="quality-streak">
      <Flame className="size-3.5 shrink-0 text-orange-400" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

export function BiggestWinTicker({ quality, className }: { quality: AccountQuality; className?: string }) {
  if (!quality.biggestWinToday) return null;
  return (
    <div
      className={cn("flex items-center gap-1.5 overflow-hidden rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[11px] text-amber-100", className)}
      data-testid="quality-biggest-win"
    >
      <Trophy className="size-3 shrink-0 text-amber-300" aria-hidden="true" />
      <span className="truncate">
        Today&apos;s biggest win: <strong className="font-semibold text-amber-200">{compactTokenCount(quality.biggestWinToday.tokens)} tokens</strong>
      </span>
    </div>
  );
}

/** The ring with the server's text: what the latest session still needs to earn a spin. */
export function NextSpinHint({ quality, className }: { quality: AccountQuality; className?: string }) {
  const hint = quality.nextSpinHint;
  if (!hint) return null;
  return (
    <div className={cn("flex items-start gap-2 text-xs text-white/75", className)} data-testid="quality-next-spin">
      <ProgressRing progress={hint.progress} size={22} stroke={3} className="mt-0.5 text-white" />
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a3e635]">
          Next spin · {Math.round(hint.progress * 100)}%
        </div>
        <div className="leading-5">{hint.text}</div>
      </div>
    </div>
  );
}
