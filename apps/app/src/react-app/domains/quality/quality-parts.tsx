/** @jsxImportSource react */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { compactTokenCount } from "../../../app/lib/omnirush-usage";
import { goodSessionWording } from "../../../app/lib/good-session";
import { qualityBadgeText, qualityBadgeTitle, type AccountQuality } from "../../../app/lib/quality";

/** The tier, as a small neutral badge. Dashed in preview (spins pay nothing). */
export function QualityTierBadge({ quality, className }: { quality: AccountQuality | null; className?: string }) {
  // Null: quality rewards are switched off, and nothing shows.
  if (!quality) return null;
  return (
    <Badge
      variant="outline"
      data-testid="quality-tier-badge"
      data-tier={quality.tier}
      data-preview={quality.preview ? "" : undefined}
      title={qualityBadgeTitle(quality)}
      className={cn(
        "h-4 px-1.5 text-[10px] font-normal text-muted-foreground",
        quality.preview && "border-dashed",
        className,
      )}
    >
      {qualityBadgeText(quality)}
    </Badge>
  );
}

/** A thin ring that fills as the latest session gets closer to earning a spin. Takes the text colour. */
export function ProgressRing({ progress, size = 14, stroke = 2, className }: { progress: number; size?: number; stroke?: number; className?: string }) {
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
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - value)}
      />
    </svg>
  );
}

function shortCount(value: number): string {
  return value > 99 ? "99+" : String(value);
}

/** The sidebar row's tooltip: what is ready to spin. */
export function spinRowTitle(quality: AccountQuality): string {
  const ready = quality.spinsAvailable;
  const stars = Math.min(ready, quality.clientSpinsAvailable ?? 0);
  return ready > 0
    ? `${ready} spin${ready === 1 ? "" : "s"} ready${stars > 0 ? `, ${stars} Good session ★ on the richer wheel` : ""}`
    : "No spins yet: good sessions earn spins.";
}

/** "9 ready" and "★2" as small neutral badges, for the sidebar's Spin row. */
export function SpinCounts({ quality }: { quality: AccountQuality }) {
  const ready = quality.spinsAvailable;
  const stars = Math.min(ready, quality.clientSpinsAvailable ?? 0);
  if (ready <= 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="quality-spin-counts">
      <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground tabular-nums">
        {shortCount(ready)} ready
      </Badge>
      {stars > 0 ? (
        <Badge
          variant="secondary"
          data-testid="quality-client-spins"
          title={`${stars} Good session${stars === 1 ? "" : "s"} ★`}
          className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground tabular-nums"
        >
          ★{shortCount(stars)}
        </Badge>
      ) : null}
    </span>
  );
}

/** "4-day streak · +1 spin per Good session ★ · 7 days: +2". */
export function streakText(quality: Pick<AccountQuality, "streakDays" | "streakMultiplier" | "streakNext">): string | null {
  if (quality.streakDays <= 0 && !quality.streakNext) return null;
  const parts: string[] = [];
  parts.push(quality.streakDays > 0 ? `${quality.streakDays}-day streak` : "No streak yet");
  if (quality.streakMultiplier > 0) parts.push(`+${quality.streakMultiplier} spin${quality.streakMultiplier === 1 ? "" : "s"} per Good session ★`);
  if (quality.streakNext) parts.push(`${quality.streakNext.days} days: +${quality.streakNext.bonusSpins}`);
  return parts.join(" · ");
}

export function StreakLine({ quality, className }: { quality: AccountQuality; className?: string }) {
  const text = streakText(quality);
  if (!text) return null;
  return (
    <p className={cn("text-xs text-muted-foreground", className)} data-testid="quality-streak">
      {text}
    </p>
  );
}

export function BiggestWinTicker({ quality, className }: { quality: AccountQuality; className?: string }) {
  if (!quality.biggestWinToday) return null;
  return (
    <p className={cn("text-xs text-muted-foreground", className)} data-testid="quality-biggest-win">
      Today&apos;s biggest win: {compactTokenCount(quality.biggestWinToday.tokens)} tokens
    </p>
  );
}

/** The ring with the server's text: what the latest session still needs to earn a spin. */
export function NextSpinHint({ quality, className }: { quality: AccountQuality; className?: string }) {
  const hint = quality.nextSpinHint;
  if (!hint) return null;
  return (
    <div className={cn("flex items-start gap-2 text-xs", className)} data-testid="quality-next-spin">
      <ProgressRing progress={hint.progress} className="mt-px text-muted-foreground" />
      <div className="min-w-0">
        <div className="font-medium text-foreground">Next spin · {Math.round(hint.progress * 100)}%</div>
        <div className="mt-0.5 leading-5 text-muted-foreground">{goodSessionWording(hint.text)}</div>
      </div>
    </div>
  );
}
