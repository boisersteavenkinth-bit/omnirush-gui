/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Gift, Lightbulb, Sparkles, X } from "lucide-react";

import { cn } from "@/lib/utils";

import { omnirushAccountStatus, omnirushQualityDetails } from "../../../app/lib/desktop";
import {
  CLIENT_GRADE_NOTE,
  REPLAY_READY_LABEL,
  NOTICE_SEEN_STORAGE_KEY,
  NUDGE_SEEN_STORAGE_KEY,
  canSpinNow,
  isCoachingNotice,
  noticeToShow,
  nudgeToShow,
  qualityTierLabel,
  readPref,
  refreshAccountStatus,
  useAccountQuality,
  useQualityUiStore,
  writePref,
  type AccountQuality,
  type QualityNotice,
} from "../../../app/lib/quality";
import type { OmniRushQualitySession } from "@omnirush/types/desktop-ipc";
import { BiggestWinTicker, NextSpinHint, QualityTierBadge, StreakLine } from "./quality-parts";
import { QualitySpinDialog } from "./quality-spin-dialog";

/** Used only when the server sends no `fail_labels` entry for a code. */
const FALLBACK_FAIL_LABELS: Record<string, string> = {
  outside_path: "edits outside the project folder",
  home_folder: "started in the home folder",
  wrong_folder: "started in another folder",
  windows_host: "recorded on Windows",
  small_fix: "a small fix",
  one_shot: "a one-shot answer",
  non_coding: "not coding work",
  old_client: "old app version",
};

export function failLabel(fail: string, labels: Record<string, string> = {}): string {
  const label = labels[fail] ?? FALLBACK_FAIL_LABELS[fail] ?? fail.replace(/[_-]+/g, " ");
  // Users never read "client" here, not even in a server label: it names the app instead.
  return label.replace(/\bold client\b/gi, "old app version").replace(/\bclient\b/gi, "app");
}

export type QualitySessionReasons = { sessions: OmniRushQualitySession[]; failLabels: Record<string, string> };

function workSummary(work: OmniRushQualitySession["work"]): string | null {
  if (!work) return null;
  const parts = [`${work.codeFiles} code file${work.codeFiles === 1 ? "" : "s"}`, `${work.linesChanged} lines`];
  parts.push(work.testRuns > 0 ? `${work.testRuns} test run${work.testRuns === 1 ? "" : "s"}` : "no tests");
  return parts.join(" · ");
}

/** "See why": each recent session, with what earned spins and what held it back. */
export function SessionReasons({ reasons }: { reasons: QualitySessionReasons | null }) {
  if (reasons === null) return <div className="text-xs text-white/50">Loading your sessions…</div>;
  const { sessions, failLabels } = reasons;
  if (sessions === null) return <div className="text-xs text-white/50">Loading your sessions…</div>;
  if (!sessions.length) return <div className="text-xs text-white/50">No sessions checked yet. They are checked about once an hour.</div>;
  return (
    <>
    <p className="mb-2 text-[11px] text-amber-200/80" data-testid="quality-client-grade-note">{CLIENT_GRADE_NOTE}</p>
    <ul className="space-y-2" data-testid="quality-session-reasons">
      {sessions.slice(0, 6).map((session) => (
        <li key={session.sessionId} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-[11px] text-white/50">
            <span className="truncate">{session.workspace ?? "session"}</span>
            {session.spins > 0 ? (
              <span className="shrink-0 font-semibold text-[#bef264]">+{session.spins} spin{session.spins === 1 ? "" : "s"}</span>
            ) : null}
          </div>
          {session.why ? <div className="mt-0.5 text-xs leading-5 text-white/80">{session.why}</div> : null}
          {workSummary(session.work) ? <div className="mt-0.5 text-[10.5px] text-white/45">{workSummary(session.work)}</div> : null}
          {session.fails.length || session.reproducible === "pass" || session.clientGrade ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {session.clientGrade ? (
                <span data-testid="quality-client-grade" className="rounded-full bg-amber-300/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">{REPLAY_READY_LABEL}</span>
              ) : session.reproducible === "pass" ? (
                <span data-testid="quality-reproducible" className="rounded-full bg-[#a3e635]/15 px-1.5 py-0.5 text-[10px] text-[#d9f99d]">reproducible ✓</span>
              ) : null}
              {session.fails.map((fail) => (
                <span key={fail} data-fail={fail} className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/60">
                  {failLabel(fail, failLabels)}
                </span>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
    </>
  );
}

export type QualityNoticeCardProps = {
  quality: AccountQuality;
  /** The notice to announce; null when the user opened the panel from the sidebar. */
  notice: QualityNotice | null;
  onSpin: () => void;
  onDismiss: () => void;
  /** GET /me/quality sessions (and fail labels) for "see why"; fetched when first opened. */
  loadSessions?: () => Promise<QualitySessionReasons | null>;
};

/**
 * The quality popup, modelled on the update banner: fixed over the app,
 * with the notice, the tips and, when spins are ready, a Spin button.
 * Coaching reads as "here is how to get spins", never as a penalty.
 */
export function QualityNoticeCard(props: QualityNoticeCardProps) {
  const { quality, notice } = props;
  const coaching = isCoachingNotice(notice, quality);
  const [whyOpen, setWhyOpen] = useState(false);
  const [sessions, setSessions] = useState<QualitySessionReasons | null>(null);
  const title = notice?.title ?? `Quality: ${qualityTierLabel(quality.tier)}`;
  const body = notice?.body || (notice ? "" : quality.nextTierHint ?? "");
  const spinnable = canSpinNow(quality);

  const toggleWhy = () => {
    setWhyOpen((open) => !open);
    if (sessions === null && props.loadSessions) {
      const none = { sessions: [], failLabels: {} };
      void props.loadSessions().then((next) => setSessions(next ?? none)).catch(() => setSessions(none));
    }
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      data-testid="quality-notice"
      data-notice-id={notice?.id ?? undefined}
      data-coaching={coaching ? "" : undefined}
      className="fixed bottom-4 right-4 z-[65] w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border border-white/10 bg-[#0b1120]/95 text-white shadow-2xl shadow-black/50 backdrop-blur"
    >
      <div className={cn("h-1 w-full", coaching ? "bg-violet-300/70" : "bg-[#a3e635]")} />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
            {coaching ? <Lightbulb className="size-3.5 text-violet-300" /> : <Sparkles className="size-3.5 text-[#a3e635]" />}
            {coaching ? "How to earn spins" : "Quality rewards"}
            <QualityTierBadge quality={quality} />
          </div>
          <button
            type="button"
            onClick={props.onDismiss}
            aria-label="Dismiss"
            data-testid="quality-notice-dismiss"
            className="-me-1 -mt-1 flex size-7 items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
        <h3 className="mt-3 text-lg font-semibold leading-6 tracking-[-0.01em]" data-testid="quality-notice-title">{title}</h3>
        {body ? <p className="mt-1.5 text-sm leading-6 text-white/70" data-testid="quality-notice-body">{body}</p> : null}

        <div className="mt-3 space-y-2.5">
          <StreakLine quality={quality} />
          <NextSpinHint quality={quality} />
        </div>

        {quality.tips.length ? (
          <ul className="mt-3 space-y-1.5 rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-testid="quality-notice-tips">
            {quality.tips.map((tip) => (
              <li key={tip} className="flex gap-2 text-xs leading-5 text-white/75">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[#a3e635]" aria-hidden="true" />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {coaching ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={toggleWhy}
              aria-expanded={whyOpen}
              data-testid="quality-see-why"
              className="inline-flex items-center gap-1 text-xs font-medium text-violet-200 hover:text-violet-100"
            >
              See why
              <ChevronDown className={cn("size-3.5 transition", whyOpen && "rotate-180")} />
            </button>
            {whyOpen ? <div className="mt-2 max-h-56 overflow-y-auto pe-1"><SessionReasons reasons={sessions} /></div> : null}
          </div>
        ) : null}

        <BiggestWinTicker quality={quality} className="mt-3 w-fit" />

        <div className="mt-4 flex items-center gap-2">
          {quality.spinsAvailable > 0 ? (
            <button
              type="button"
              onClick={props.onSpin}
              disabled={!spinnable}
              data-testid="quality-notice-spin"
              className="inline-flex items-center gap-2 rounded-full bg-[#a3e635] px-4 py-2 text-sm font-bold text-[#1a2e05] shadow-[0_0_20px_rgba(163,230,53,0.4)] transition hover:bg-[#bef264] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Gift className="size-4" aria-hidden="true" />
              Spin{quality.spinsAvailable > 1 ? ` (${quality.spinsAvailable})` : ""}
            </button>
          ) : null}
          <button
            type="button"
            onClick={props.onDismiss}
            className="rounded-full px-3 py-2 text-sm font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            Got it
          </button>
          {quality.spinsAvailable > 0 && !spinnable ? (
            <span className="text-xs text-amber-200">The wheel is resting, back tomorrow.</span>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/** The server's nudge, once per id. */
export function QualityNudge(props: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      data-testid="quality-nudge"
      className="fixed bottom-4 right-4 z-[64] flex max-w-[360px] items-start gap-2 rounded-2xl border border-[#a3e635]/30 bg-[#0b1120]/95 px-4 py-3 text-sm text-white shadow-xl shadow-black/40"
    >
      <Sparkles className="mt-0.5 size-4 shrink-0 text-[#a3e635]" aria-hidden="true" />
      <span className="leading-5 text-white/85">{props.text}</span>
      <button type="button" onClick={props.onDismiss} aria-label="Dismiss" className="-me-1 text-white/50 hover:text-white">
        <X className="size-4" />
      </button>
    </div>
  );
}

const PROFILE_REFRESH_MS = 15 * 60_000;

/**
 * Quality rewards over the app: the notice popup (once per notice id), the
 * panel the sidebar opens, the server's nudge (once per id) and the spin
 * dialog. Renders nothing while `quality` is null (the feature is off).
 */
export function QualityRewards() {
  const quality = useAccountQuality();
  const panelOpen = useQualityUiStore((store) => store.panelOpen);
  const spinOpen = useQualityUiStore((store) => store.spinOpen);
  const [seenNotice, setSeenNotice] = useState(() => readPref(NOTICE_SEEN_STORAGE_KEY));
  const [seenNudge, setSeenNudge] = useState(() => readPref(NUDGE_SEEN_STORAGE_KEY));

  useEffect(() => {
    const read = () => void refreshAccountStatus(omnirushAccountStatus);
    read();
    const timer = window.setInterval(read, PROFILE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const notice = noticeToShow(quality, seenNotice);
  const nudge = nudgeToShow(quality, seenNudge);

  const markNoticeSeen = useCallback(() => {
    if (!notice) return;
    writePref(NOTICE_SEEN_STORAGE_KEY, notice.id);
    setSeenNotice(notice.id);
  }, [notice]);

  const dismiss = useCallback(() => {
    markNoticeSeen();
    useQualityUiStore.getState().closePanel();
  }, [markNoticeSeen]);

  const spin = useCallback(() => {
    markNoticeSeen();
    useQualityUiStore.getState().openSpin();
  }, [markNoticeSeen]);

  const loadSessions = useCallback(async (): Promise<QualitySessionReasons | null> => {
    const details = await omnirushQualityDetails();
    return details ? { sessions: details.sessions, failLabels: details.failLabels ?? {} } : null;
  }, []);

  if (!quality) return null;
  const showCard = !spinOpen && (panelOpen || notice !== null);
  return (
    <>
      {showCard ? (
        <QualityNoticeCard quality={quality} notice={notice} onSpin={spin} onDismiss={dismiss} loadSessions={loadSessions} />
      ) : nudge && !spinOpen ? (
        <QualityNudge
          text={nudge.text}
          onDismiss={() => {
            writePref(NUDGE_SEEN_STORAGE_KEY, nudge.id);
            setSeenNudge(nudge.id);
          }}
        />
      ) : null}
      {spinOpen ? <QualitySpinDialog quality={quality} onClose={() => useQualityUiStore.getState().closeSpin()} /> : null}
    </>
  );
}
