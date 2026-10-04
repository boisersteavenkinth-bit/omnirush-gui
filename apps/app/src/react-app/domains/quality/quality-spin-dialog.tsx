/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, Volume2, VolumeX, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { OmniRushQualitySpinRecord, OmniRushQualitySpinTotals } from "@omnirush/types/desktop-ipc";

import { omnirushAccountStatus, omnirushQualityDetails, omnirushQualitySpin, omnirushQualitySpins } from "../../../app/lib/desktop";
import { compactTokenCount } from "../../../app/lib/omnirush-usage";
import {
  CLIENT_GRADE_NOTE,
  REPLAY_READY_LABEL,
  countUpValue,
  DEFAULT_WHEEL_SEGMENTS,
  SOUND_STORAGE_KEY,
  canSpinNow,
  nearMissText,
  newSpinIdempotencyKey,
  readPref,
  refreshAccountStatus,
  segmentOdds,
  spinPayoutText,
  spinRefusalMessage,
  writePref,
  type AccountQuality,
  type QualitySpin,
  type QualitySpinOutcome,
  type WheelSegment,
} from "../../../app/lib/quality";
import { BiggestWinTicker, QualityTierBadge, StreakLine } from "./quality-parts";
import { QualityWheel } from "./quality-wheel";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = () => setReduced(media.matches);
    media.addEventListener?.("change", listener);
    return () => media.removeEventListener?.("change", listener);
  }, []);
  return reduced;
}

/**
 * Counts up to `value` once `active`; jumps straight there with reduced
 * motion. `done` only once the shown number is exactly `value`.
 */
function useCountUp(value: number, active: boolean, reducedMotion: boolean, durationMs = 1_400): { shown: number; done: boolean } {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!active) {
      setShown(0);
      return;
    }
    if (reducedMotion) {
      setShown(value);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / durationMs);
      setShown(countUpValue(value, progress));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, durationMs, reducedMotion, value]);
  return { shown, done: active && shown === value };
}

type Phase = "idle" | "requesting" | "spinning" | "result" | "error";

/** The last spins (newest first), ★ on the replay-ready ones. */
export function RecentSpins({ spins }: { spins: OmniRushQualitySpinRecord[] }) {
  const shown = spins.slice(0, 10);
  if (!shown.length) return null;
  return (
    <div className="mt-1 w-full" data-testid="quality-recent-spins">
      <div className="mb-1 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-white/35">Recent spins</div>
      <ul className="flex flex-wrap justify-center gap-1">
        {shown.map((spin) => (
          <li
            key={spin.id}
            data-replay-ready={spin.clientGrade ? "" : undefined}
            title={spin.clientGrade ? REPLAY_READY_LABEL : spin.status}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10.5px] tabular-nums",
              spin.clientGrade ? "border-amber-300/40 bg-amber-300/10 text-amber-200" : "border-white/10 text-white/55",
            )}
          >
            {spin.clientGrade ? "★ " : ""}
            {spin.status === "spun"
              ? spin.prizeTokens !== null ? compactTokenCount(spin.prizeTokens) : "spun"
              : spin.status === "ready" ? "ready" : spin.status}
          </li>
        ))}
      </ul>
    </div>
  );
}

export type QualitySpinDialogProps = {
  quality: AccountQuality;
  onClose: () => void;
  /** Injected in tests; the desktop bridge otherwise. */
  spin?: (input: { idempotencyKey: string }) => Promise<QualitySpinOutcome>;
};

/**
 * The spin dialog: the wheel, the prizes with their odds, and the result.
 * The server picks the segment; the wheel animates to it, then the prize
 * counts up and the profile is read again.
 */
export function QualitySpinDialog(props: QualitySpinDialogProps) {
  const { quality, onClose } = props;
  const reducedMotion = usePrefersReducedMotion();
  const [segments, setSegments] = useState<WheelSegment[]>(DEFAULT_WHEEL_SEGMENTS);
  const [expectedTokens, setExpectedTokens] = useState<number | null>(null);
  const [jackpotTokens, setJackpotTokens] = useState<number | null>(null);
  const [clientSegments, setClientSegments] = useState<WheelSegment[]>([]);
  const [totals, setTotals] = useState<OmniRushQualitySpinTotals | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<QualitySpin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spinId, setSpinId] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(() => readPref(SOUND_STORAGE_KEY) === "on");
  const spinsLeft = result ? result.spinsAvailable : quality.spinsAvailable;
  const count = useCountUp(result?.prizeTokens ?? 0, phase === "result", reducedMotion);
  const prize = count.shown;
  // The final state (payout, chips, Spin again) waits for the count-up to land on the server's prize.
  const settled = phase === "result" && count.done;
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    void omnirushQualityDetails()
      .then((details) => {
        if (!active || !details) return;
        if (details.segments.length) setSegments(details.segments);
        setExpectedTokens(details.expectedTokens);
        setJackpotTokens(details.jackpotTokens ?? null);
        setClientSegments(details.clientSegments ?? []);
      })
      .catch(() => undefined);
    void omnirushQualitySpins()
      .then((next) => { if (active) setTotals(next); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const runSpin = useCallback(async () => {
    if (phase === "requesting" || phase === "spinning") return;
    setPhase("requesting");
    setError(null);
    // One key per click: a retry of this click gets this click's result back.
    const idempotencyKey = newSpinIdempotencyKey();
    const send = props.spin ?? ((input: { idempotencyKey: string }) => omnirushQualitySpin(input));
    let outcome: QualitySpinOutcome;
    try {
      outcome = await send({ idempotencyKey });
    } catch {
      outcome = { ok: false, reason: "unreachable", status: null };
    }
    if (!outcome.ok) {
      setPhase("error");
      setError(spinRefusalMessage(outcome.reason));
      void refreshAccountStatus(omnirushAccountStatus);
      return;
    }
    if (outcome.spin.segments.length) setSegments(outcome.spin.segments);
    setResult(outcome.spin);
    setSpinId((value) => value + 1);
    setPhase("spinning");
  }, [phase, props.spin]);

  const landed = useCallback(() => {
    setPhase("result");
    void refreshAccountStatus(omnirushAccountStatus);
    void omnirushQualitySpins().then(setTotals).catch(() => undefined);
  }, []);

  const toggleSound = () => {
    setSoundEnabled((value) => {
      writePref(SOUND_STORAGE_KEY, value ? "off" : "on");
      return !value;
    });
  };

  const resting = !canSpinNow(quality) && quality.spinsAvailable > 0;
  const tease = result && settled ? nearMissText(result, jackpotTokens) : null;
  const celebrate = result?.celebrate ?? "none";
  const busy = phase === "requesting" || phase === "spinning" || (phase === "result" && !settled);
  const canSpin = !busy && spinsLeft > 0 && !(phase !== "result" && resting);
  // Before a spin: the wheel the next spin uses (the richer one while replay-ready spins are
  // waiting). From the answer on: the wheel the server actually used.
  const nextIsReplayReady = !result && quality.clientSpinsAvailable > 0 && clientSegments.length > 0;
  const shownSegments = result ? segments : nextIsReplayReady ? clientSegments : segments;
  const goldHeader = result ? (result.clientGrade ? "★ replay-ready wheel" : null) : nextIsReplayReady ? "★ replay-ready wheel (next spin)" : null;

  return (
    <div className="fixed inset-0 z-[76] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" data-testid="quality-spin-overlay">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="quality-spin-title"
        data-testid="quality-spin-dialog"
        data-phase={phase}
        className="relative w-full max-w-[520px] overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(ellipse_at_top,#1a2e05_0%,#0b1120_45%,#05070c_100%)] p-6 text-white shadow-2xl shadow-black/60"
      >
        {goldHeader ? (
          <div
            data-testid="quality-client-grade-header"
            className="-mx-6 -mt-6 mb-4 bg-gradient-to-r from-amber-500/30 via-amber-300/25 to-amber-500/30 px-6 py-2 text-center text-xs font-bold uppercase tracking-[0.24em] text-amber-200"
          >
            {goldHeader}
          </div>
        ) : null}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <QualityTierBadge quality={quality} />
              <span className="text-[11px] text-white/50">
                {spinsLeft} spin{spinsLeft === 1 ? "" : "s"} ready
                {!result && quality.clientSpinsAvailable > 0 ? (
                  <span className="ms-1 font-semibold text-amber-200" data-testid="quality-dialog-client-spins">· ★{quality.clientSpinsAvailable} replay-ready</span>
                ) : null}
              </span>
            </div>
            <h2 id="quality-spin-title" className="mt-2 text-2xl font-semibold tracking-[-0.02em]">
              Spin for tokens
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleSound}
              aria-pressed={soundEnabled}
              aria-label={soundEnabled ? "Turn sound off" : "Turn sound on"}
              data-testid="quality-sound-toggle"
              className="flex size-8 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              {soundEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-8 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <BiggestWinTicker quality={quality} />
          <StreakLine quality={quality} />
        </div>

        <div className="relative mt-4">
          <QualityWheel
            segments={shownSegments}
            targetIndex={result ? result.segmentIndex : null}
            spinId={spinId}
            onDone={landed}
            celebrate={celebrate}
            nearMiss={result?.nearMiss ?? false}
            soundEnabled={soundEnabled}
            reducedMotion={reducedMotion}
            jackpotTokens={result?.jackpotTokens ?? jackpotTokens}
            size={300}
          />
        </div>

        <div className="mt-3 flex flex-wrap justify-center gap-1.5" data-testid="quality-wheel-legend">
          {shownSegments.map((segment, index) => (
            <span
              key={index}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10.5px] tabular-nums",
                result && settled && index === result.segmentIndex
                  ? "border-[#a3e635] bg-[#a3e635]/20 text-[#ecfccb]"
                  : "border-white/10 text-white/55",
              )}
            >
              {compactTokenCount(segment.tokens)} · {segmentOdds(shownSegments, index)}
            </span>
          ))}
        </div>

        <div className="mt-4 min-h-[92px] text-center" aria-live="polite">
          {phase === "result" && result ? (
            <div data-testid="quality-spin-result" data-celebrate={celebrate}>
              <div
                className={cn(
                  "font-semibold tabular-nums tracking-[-0.03em]",
                  celebrate === "jackpot" ? "text-5xl text-amber-200" : celebrate === "big" ? "text-5xl text-[#d9f99d]" : "text-4xl text-white",
                )}
                data-testid="quality-spin-prize"
              >
                {prize.toLocaleString("en-US")}
                <span className="ms-2 text-base font-medium text-white/60">tokens</span>
              </div>
              {celebrate === "jackpot" ? (
                <div className="mt-1 text-sm font-semibold uppercase tracking-[0.3em] text-amber-300">Jackpot</div>
              ) : null}
              {settled ? (
              <>
              <div className={cn("mt-1 text-sm", result.preview || result.capped ? "text-amber-200" : "text-[#bef264]")} data-testid="quality-spin-payout">
                {spinPayoutText(result)}
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2 text-[11px]">
                {result.clientGrade ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/50 bg-amber-300/15 px-2 py-0.5 font-semibold text-amber-200">
                    {REPLAY_READY_LABEL}
                  </span>
                ) : result.reproducible ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-[#a3e635]/40 bg-[#a3e635]/10 px-2 py-0.5 text-[#d9f99d]">
                    <Sparkles className="size-3" aria-hidden="true" /> reproducible ✓
                  </span>
                ) : null}
                {result.alreadySpun ? <span className="text-white/50">This spin was already counted.</span> : null}
                {result.potBalance !== null && !result.preview ? (
                  <span className="text-white/50">Pot: {compactTokenCount(result.potBalance)} tokens</span>
                ) : null}
              </div>
              {tease ? (
                <div className="mt-2 text-sm font-semibold text-amber-300" data-testid="quality-near-miss">{tease}</div>
              ) : null}
              </>
              ) : null}
            </div>
          ) : phase === "error" && error ? (
            <div className="pt-4 text-sm text-amber-200" data-testid="quality-spin-error">{error}</div>
          ) : phase === "spinning" ? (
            <div className="pt-6 text-sm text-white/60">Good luck…</div>
          ) : resting ? (
            <div className="pt-4 text-sm text-amber-200">The wheel is resting, back tomorrow.</div>
          ) : (
            <div className="pt-4 text-sm text-white/60">
              {quality.preview ? "Preview: spins show what you would win, and pay 0 tokens." : "The wheel decides. Every prize goes into your pot."}
              {expectedTokens ? <span className="block text-white/40">Average spin: {compactTokenCount(expectedTokens)} tokens</span> : null}
              <span className="mt-1 block text-[11px] text-amber-200/70" data-testid="quality-client-grade-note">{CLIENT_GRADE_NOTE}</span>
            </div>
          )}
        </div>

        <div className="mt-2 flex flex-col items-center gap-2">
          {spinsLeft > 0 || busy ? (
            <button
              type="button"
              onClick={() => void runSpin()}
              disabled={!canSpin}
              data-testid="quality-spin-go"
              className="inline-flex min-w-[200px] items-center justify-center gap-2 rounded-full bg-[#a3e635] px-6 py-3 text-sm font-bold uppercase tracking-[0.12em] text-[#1a2e05] shadow-[0_0_30px_rgba(163,230,53,0.45)] transition hover:bg-[#bef264] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {busy ? "Spinning" : settled ? `Spin again (${spinsLeft} left)` : spinsLeft > 1 ? `Spin (${spinsLeft} ready)` : "Spin"}
            </button>
          ) : (
            <div className="text-xs text-white/50">No spins left. Good sessions earn more.</div>
          )}
          {totals && totals.spun > 0 ? (
            <div className="text-[11px] text-white/40" data-testid="quality-spin-totals">
              {totals.spun} spin{totals.spun === 1 ? "" : "s"} so far · {compactTokenCount(totals.paidTokens)} tokens won
            </div>
          ) : null}
          {totals ? <RecentSpins spins={totals.recent ?? []} /> : null}
        </div>
      </section>
    </div>
  );
}
