/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { AlertTriangle, CircleCheck, CircleX, Star, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

import { omnirushQualityDetails, openDesktopUrl } from "../../../app/lib/desktop";
import {
  GOOD_SESSION_GUIDE,
  GOOD_SESSION_GUIDE_LINK,
  GOOD_SESSION_WSL_TIP,
  TURN_GUARD_DETAIL,
  TURN_GUARD_QUIT,
  TURN_GUARD_TITLE,
  TURN_GUARD_WAIT,
  WSL_BANNER_DISMISSED_KEY,
  WSL_BANNER_TEXT,
  WSL_GUIDE_URL,
  checklistHeading,
  checklistText,
  goodSessionChecklist,
  goodSessionNudge,
  messageFacts,
  localDay,
  shouldNudge,
  showWslBanner,
  type GoodSessionCheck,
} from "../../../app/lib/good-session";
import { readPref, useAccountQuality, writePref } from "../../../app/lib/quality";
import { isDesktopRuntime, isWindowsPlatform } from "../../../app/utils";
import { hasLiveSessionActivity, useSessionActivityStore } from "../session/status/session-activity-store";

/** Native Windows (the app itself; there is no WSL desktop build). The e2e hook forces it on Linux. */
export function isNativeWindowsHost(): boolean {
  if (typeof window !== "undefined" && window.__OMNIRUSH_ELECTRON__?.meta?.forceNativeWindows === true) return true;
  return isWindowsPlatform();
}

/** The four steps, plus the WSL tip. */
export function GoodSessionGuide({ className }: { className?: string }) {
  return (
    <div className={cn("text-xs", className)} data-testid="good-session-guide">
      <p className="font-medium text-foreground">{GOOD_SESSION_GUIDE_LINK}</p>
      <ol className="mt-1 list-decimal space-y-0.5 ps-4 leading-5 text-muted-foreground marker:text-muted-foreground/60">
        {GOOD_SESSION_GUIDE.map((step) => <li key={step}>{step}</li>)}
      </ol>
      <p className="mt-1 leading-5 text-muted-foreground" data-testid="good-session-wsl-tip">{GOOD_SESSION_WSL_TIP}</p>
    </div>
  );
}

function CheckMark({ check }: { check: GoodSessionCheck }) {
  return (
    <span
      title={check.hint}
      data-check={check.id}
      data-state={check.state}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
        check.state === "pass" && "text-foreground",
        check.state === "fail" && "text-amber-11",
      )}
    >
      {check.label}
      {check.state === "pending" ? null : check.state === "pass" ? (
        <CircleCheck className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
      ) : (
        <CircleX className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
      )}
    </span>
  );
}

const NUDGED_STORAGE_KEY = "omnirush.goodSession.nudged.v1";
const NUDGED_KEEP = 200;

function nudgedSessions(): string[] {
  try {
    const parsed = JSON.parse(readPref(NUDGED_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberNudged(sessionId: string) {
  const ids = nudgedSessions().filter((id) => id !== sessionId);
  ids.push(sessionId);
  writePref(NUDGED_STORAGE_KEY, JSON.stringify(ids.slice(-NUDGED_KEEP)));
}

export type GoodSessionChecklistBarProps = {
  sessionId: string;
  messages: readonly UIMessage[];
  workspaceRoot: string;
  isRemoteWorkspace: boolean;
  turnRunning: boolean;
};

const SERVER_VERDICT_REFRESH_MS = 5 * 60_000;

/**
 * The server's verdict on this session (GET /me/quality: `client_grade`),
 * once the local checks pass and no turn runs. Sessions are checked about
 * once an hour after upload, so this is usually false during the session.
 */
function useServerGood(sessionId: string, ask: boolean): boolean {
  const quality = useAccountQuality();
  const [good, setGood] = useState<{ sessionId: string; good: boolean }>({ sessionId, good: false });
  const lastRead = useRef<{ sessionId: string; at: number } | null>(null);
  useEffect(() => {
    if (!ask || !quality) return;
    const last = lastRead.current;
    if (last && last.sessionId === sessionId && Date.now() - last.at < SERVER_VERDICT_REFRESH_MS) return;
    lastRead.current = { sessionId, at: Date.now() };
    let cancelled = false;
    void omnirushQualityDetails()
      .then((details) => {
        if (cancelled) return;
        const session = details?.sessions.find((entry) => entry.sessionId === sessionId);
        setGood({ sessionId, good: session?.clientGrade === true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ask, quality, sessionId]);
  return good.sessionId === sessionId && good.good;
}

/**
 * The live checklist over the composer: "Good session: code changed ✓ ·
 * ran/tested ✗ · in project ✓ · finish your turn". When every local check
 * passes it reads "On track for a Good session ★ (final check after
 * upload)" with an outlined star; the star fills only on the server's
 * verdict. One gentle nudge per session when a turn ends with something
 * missing.
 */
export function GoodSessionChecklistBar(props: GoodSessionChecklistBarProps) {
  const nativeWindows = useMemo(() => isNativeWindowsHost(), []);
  const facts = useMemo(() => messageFacts(props.messages), [props.messages]);
  const local = useMemo(() => goodSessionChecklist({
    ...facts,
    workspaceRoot: props.workspaceRoot,
    isRemoteWorkspace: props.isRemoteWorkspace,
    turnRunning: props.turnRunning,
    nativeWindows,
  }), [facts, nativeWindows, props.isRemoteWorkspace, props.turnRunning, props.workspaceRoot]);
  const serverGood = useServerGood(props.sessionId, local.onTrack);
  const checklist = useMemo(
    () => (serverGood && local.onTrack ? { ...local, verdict: "good" as const, text: checklistText(local.checks, "good") } : local),
    [local, serverGood],
  );
  const hasPrompt = props.messages.some((message) => message.role === "user");

  // The nudge: on the running → done edge of this session's turn.
  const wasRunning = useRef<{ sessionId: string; running: boolean }>({ sessionId: props.sessionId, running: props.turnRunning });
  useEffect(() => {
    const previous = wasRunning.current;
    wasRunning.current = { sessionId: props.sessionId, running: props.turnRunning };
    if (previous.sessionId !== props.sessionId || !hasPrompt) return;
    const alreadyNudged = nudgedSessions().includes(props.sessionId);
    if (!shouldNudge({ wasRunning: previous.running, running: props.turnRunning, checklist, alreadyNudged })) return;
    const nudge = goodSessionNudge(checklist);
    if (!nudge) return;
    rememberNudged(props.sessionId);
    toast(nudge.title, { id: `good-session-nudge:${props.sessionId}`, description: nudge.body, duration: 12_000 });
  }, [checklist, hasPrompt, props.sessionId, props.turnRunning]);

  if (!hasPrompt) return null;
  const verdict = checklist.verdict;
  return (
    <div className="px-4 max-lg:px-3 lg:px-8" data-testid="good-session-checklist" data-verdict={verdict}>
      <div className="mx-auto flex max-w-[800px] items-center gap-2 pb-1.5">
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full border border-border bg-popover/60 px-2.5 py-1 text-[11px] leading-4 text-muted-foreground"
          aria-label={checklist.text}
          role="status"
        >
          <Star
            data-testid="good-session-star"
            data-filled={verdict === "good" ? "" : undefined}
            className={cn("size-3 shrink-0", verdict === "good" ? "fill-current text-foreground" : verdict === "on-track" ? "text-foreground" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className="whitespace-nowrap font-medium text-foreground">{checklistHeading(verdict)}:</span>
          {checklist.checks.map((check, index) => (
            <span key={check.id} className="inline-flex items-center gap-1.5">
              {index > 0 ? <span aria-hidden="true" className="text-muted-foreground/60">·</span> : null}
              <CheckMark check={check} />
            </span>
          ))}
        </div>
        <Popover>
          <PopoverTrigger
            render={(
              <button
                type="button"
                data-testid="good-session-guide-link"
                className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
              />
            )}
          >
            {GOOD_SESSION_GUIDE_LINK}
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="w-72 gap-2 rounded-2xl p-3">
            <GoodSessionGuide />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

/** "Sessions from native Windows don't count as Good sessions. Switch to WSL": dismissible, back the next day. */
export function WslBanner({ className }: { className?: string }) {
  const nativeWindows = useMemo(() => isNativeWindowsHost(), []);
  const [dismissedDay, setDismissedDay] = useState(() => readPref(WSL_BANNER_DISMISSED_KEY));
  // Comes back on the next day even when the app stays open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60 * 60_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!showWslBanner({ nativeWindows, dismissedDay, now })) return null;
  const dismiss = () => {
    const day = localDay();
    writePref(WSL_BANNER_DISMISSED_KEY, day);
    setDismissedDay(day);
  };
  return (
    <div className={cn("px-4 max-lg:px-3 lg:px-8", className)}>
      <div
        role="status"
        data-testid="good-session-wsl-banner"
        className="mx-auto mb-2 flex max-w-[800px] items-center gap-2 rounded-lg border border-amber-7/40 bg-amber-2/30 px-3 py-2 text-xs text-amber-11"
      >
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {WSL_BANNER_TEXT}{" "}
          <button
            type="button"
            data-testid="good-session-wsl-link"
            className="font-medium underline underline-offset-2 hover:text-amber-12"
            onClick={() => void openDesktopUrl(WSL_GUIDE_URL).catch(() => undefined)}
          >
            Open the WSL guide
          </button>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          data-testid="good-session-wsl-dismiss"
          onClick={dismiss}
          className="-me-1 text-amber-11 hover:text-amber-12"
        >
          <X />
        </Button>
      </div>
    </div>
  );
}

/** The confirm before switching or deleting a session whose turn is running. */
export function TurnGuardDialog(props: { open: boolean; onWait: () => void; onQuit: () => void }) {
  return (
    <AlertDialog open={props.open} onOpenChange={(open) => { if (!open) props.onWait(); }}>
      <AlertDialogContent data-testid="turn-guard-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-amber-3/50 text-amber-11">
            <AlertTriangle />
          </AlertDialogMedia>
          <AlertDialogTitle>{TURN_GUARD_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{TURN_GUARD_DETAIL}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction variant="outline" data-testid="turn-guard-quit" onClick={props.onQuit}>
            {TURN_GUARD_QUIT}
          </AlertDialogAction>
          <AlertDialogCancel variant="default" autoFocus data-testid="turn-guard-wait">
            {TURN_GUARD_WAIT}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Tells the desktop shell whether any turn is running, so closing or quitting asks first. */
export function TurnRunningSync() {
  const running = useSessionActivityStore((store) => hasLiveSessionActivity(store.statusesByWorkspaceId));
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void Promise.resolve(window.__OMNIRUSH_ELECTRON__?.invokeDesktop?.("__setTurnRunning", running)).catch(() => undefined);
  }, [running]);
  return null;
}
