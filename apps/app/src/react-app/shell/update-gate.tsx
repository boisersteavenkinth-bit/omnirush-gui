/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpCircle, Download, Loader2 } from "lucide-react";

import {
  connectUpdateGate,
  refreshUpdateGate,
  requiredUpdateAction,
  shouldStartBackgroundDownload,
  updateBannerText,
  useUpdateGateState,
  type UpdateGateState,
} from "../../app/lib/update-gate";
import { useBrandAppName } from "../domains/cloud/brand-theme";
import { useDesktopUpdater } from "../domains/settings/state/desktop-updater-provider";

/** Height of the required-update banner; the app below it is shifted by this much. */
const BANNER_HEIGHT_PX = 36;

function useNow(active: boolean, intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function openDownload(url: string) {
  void window.__OMNIRUSH_ELECTRON__?.shell?.openExternal?.(url);
}

/**
 * Starts the update download in the background as soon as an update is
 * required, and runs "Update now": install the staged update (electron-updater
 * quitAndInstall on Linux, Windows and Developer ID macOS), or open
 * `download_url` where the app cannot replace itself (ad-hoc signed macOS
 * builds, no updater, a failed download).
 */
function useRequiredUpdate(gate: UpdateGateState) {
  const updater = useDesktopUpdater();
  const supported = updater.updateEnv?.supported !== false && Boolean(updater.appVersion);
  const installMode = updater.installMode;
  const updaterState = updater.updateStatus?.state ?? null;
  const [installRequested, setInstallRequested] = useState(false);
  const backgroundStarted = useRef(false);
  const downloadRequested = useRef(false);

  useEffect(() => {
    if (gate.status === "none") {
      backgroundStarted.current = false;
      downloadRequested.current = false;
      return;
    }
    if (backgroundStarted.current) return;
    if (!shouldStartBackgroundDownload({ gate, supported, installMode, updaterState })) return;
    backgroundStarted.current = true;
    // A check downloads by itself when automatic downloads are on; the
    // effect below starts the download when they are off.
    void updater.checkForUpdates();
  }, [gate, installMode, supported, updater, updaterState]);

  useEffect(() => {
    if (gate.status === "none" || installMode === "manual-dmg") return;
    if (updaterState === "available" && !downloadRequested.current) {
      downloadRequested.current = true;
      void updater.downloadUpdate();
    }
  }, [gate.status, installMode, updater, updaterState]);

  // After "Update now": install once the download is ready; where it cannot
  // be (the check found nothing, the download failed, policy holds it back),
  // open download_url instead.
  const previousState = useRef(updaterState);
  const installDownloadStarted = useRef(false);
  useEffect(() => {
    const previous = previousState.current;
    previousState.current = updaterState;
    if (!installRequested) return;
    const finish = (next: () => void) => {
      setInstallRequested(false);
      installDownloadStarted.current = false;
      next();
    };
    if (!supported || installMode === "manual-dmg") return finish(() => openDownload(gate.downloadUrl));
    if (updaterState === "ready") return finish(() => void updater.installUpdateAndRestart());
    if (updaterState === "available" && !installDownloadStarted.current) {
      installDownloadStarted.current = true;
      void updater.downloadUpdate();
      return;
    }
    const failed = previous !== updaterState
      && (updaterState === "error" || updaterState === "blocked" || updaterState === "installer-opened");
    const nothingFound = previous === "checking" && (updaterState === "idle" || updaterState === null);
    if (failed || nothingFound) finish(() => openDownload(gate.downloadUrl));
  }, [gate.downloadUrl, installMode, installRequested, supported, updater, updaterState]);

  const updateNow = useCallback(() => {
    const action = requiredUpdateAction({ supported, installMode, updaterState });
    if (action === "open-download") {
      openDownload(gate.downloadUrl);
      return;
    }
    if (action === "install") {
      void updater.installUpdateAndRestart();
      return;
    }
    installDownloadStarted.current = false;
    setInstallRequested(true);
    if (action === "download-then-install") {
      if (updaterState === "available") {
        installDownloadStarted.current = true;
        void updater.downloadUpdate();
      } else {
        void updater.checkForUpdates();
      }
    }
  }, [gate.downloadUrl, installMode, supported, updater, updaterState]);

  const progress = updater.updateStatus?.state === "downloading" && updater.updateStatus.totalBytes
    ? Math.min(100, Math.round(((updater.updateStatus.downloadedBytes ?? 0) / updater.updateStatus.totalBytes) * 100))
    : null;
  const working = installRequested && (updaterState === "checking" || updaterState === "downloading" || updaterState === "available" || updaterState === "idle");
  const detail = updaterState === "downloading"
    ? progress === null ? "Downloading the update…" : `Downloading the update… ${progress}%`
    : updaterState === "ready"
      ? "The update is downloaded and ready to install."
      : updaterState === "installer-opened"
        ? "The installer is open. Replace the app from it, then open it again."
        : null;
  return { updateNow, working, detail };
}

function UpdateNowButton(props: { onClick: () => void; working: boolean; large?: boolean; testId: string }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={props.onClick}
      disabled={props.working}
      className={props.large
        ? "inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-emerald-100 disabled:cursor-wait disabled:opacity-80 mac:titlebar-no-drag"
        : "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-black/85 px-2.5 text-[11px] font-semibold text-amber-50 transition hover:bg-black disabled:cursor-wait disabled:opacity-80 mac:titlebar-no-drag"}
    >
      {props.working ? <Loader2 className={props.large ? "size-4 animate-spin" : "size-3 animate-spin"} aria-hidden="true" /> : <Download className={props.large ? "size-4" : "size-3"} aria-hidden="true" />}
      Update now
    </button>
  );
}

export function RequiredUpdateBanner(props: { gate: UpdateGateState; appName: string; onUpdateNow: () => void; working: boolean; detail: string | null }) {
  const now = useNow(true);
  const text = updateBannerText(props.gate, props.appName, now);
  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="update-required-banner"
      data-update-deadline={props.gate.deadline ?? undefined}
      className="fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-3 border-b border-amber-700/30 bg-amber-300 px-4 text-[12px] font-medium text-amber-950 mac:titlebar-drag mac:ps-20"
      style={{ height: BANNER_HEIGHT_PX }}
    >
      <ArrowUpCircle className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate" data-testid="update-required-banner-text">{text}</span>
      {props.detail ? <span className="hidden truncate text-amber-900/80 md:inline">· {props.detail}</span> : null}
      <UpdateNowButton onClick={props.onUpdateNow} working={props.working} testId="update-required-banner-button" />
    </div>
  );
}

export function UpdateRequiredView(props: { gate: UpdateGateState; appName: string; onUpdateNow: () => void; working: boolean; detail: string | null }) {
  const { gate, appName } = props;
  return (
    <main
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="update-required-title"
      data-testid="update-required-view"
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-[#05070c] px-6 py-12 text-white mac:titlebar-drag"
    >
      <section className="w-full max-w-xl rounded-[28px] border border-white/10 bg-white/[0.04] p-8 shadow-2xl shadow-black/40 sm:p-10">
        <div className="inline-flex rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-amber-100">
          Update required
        </div>
        <h1 id="update-required-title" className="mt-6 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
          Update {appName} to keep working
        </h1>
        <p className="mt-4 text-base leading-7 text-white/72" data-testid="update-required-message">
          {gate.message ?? `This version of ${appName} is no longer supported. Install ${gate.minimum ? `version ${gate.minimum} or newer` : "the latest version"} to keep using models.`}
        </p>
        <p className="mt-3 text-sm leading-6 text-white/55">
          Your sessions and settings stay on this computer, and sessions you already ran keep uploading in the background. After the update, open the same session and continue where you left off.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-white/40">This version</div>
            <div className="mt-1 font-mono text-lg text-white" data-testid="update-required-current">{gate.current || "unknown"}</div>
          </div>
          <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/70">Required</div>
            <div className="mt-1 font-mono text-lg text-emerald-50" data-testid="update-required-minimum">{gate.minimum ?? "latest"}</div>
          </div>
        </div>
        <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <UpdateNowButton onClick={props.onUpdateNow} working={props.working} large testId="update-required-button" />
          <button
            type="button"
            onClick={() => openDownload(gate.downloadUrl)}
            className="text-sm font-medium text-white/60 underline-offset-4 hover:text-white hover:underline mac:titlebar-no-drag"
          >
            Download from omnirush.ai
          </button>
        </div>
        {props.detail ? <p className="mt-4 text-sm text-white/60" data-testid="update-required-detail">{props.detail}</p> : null}
      </section>
    </main>
  );
}

/**
 * Mandatory client update. Required: a banner that cannot be dismissed, with
 * a countdown to the deadline, above the app (shifted down beneath it).
 * Blocked: a full-screen "Update required" view over the app, which stays
 * mounted underneath; the chat input is disabled (useUpdateGateBlocked).
 * Session uploads run in the Electron main process and are not touched.
 */
export function UpdateGate({ children }: { children: ReactNode }) {
  const gate = useUpdateGateState();
  // The product name as the release names it, unless an organization brands the app.
  const brandName = useBrandAppName();
  const appName = brandName === "omnirush.ai" ? "OmniRush.ai" : brandName;
  const { updateNow, working, detail } = useRequiredUpdate(gate);

  useEffect(() => {
    connectUpdateGate();
  }, []);

  // client_update on /device/me is authoritative: look again when the
  // window comes back, so a gate the server lifted goes away.
  useEffect(() => {
    if (gate.status === "none") return;
    window.addEventListener("focus", refreshUpdateGate);
    return () => window.removeEventListener("focus", refreshUpdateGate);
  }, [gate.status]);

  const banner = gate.status === "required";
  return (
    <>
      {banner ? <RequiredUpdateBanner gate={gate} appName={appName} onUpdateNow={updateNow} working={working} detail={detail} /> : null}
      <div
        data-update-gate-shifted={banner ? "" : undefined}
        style={banner
          ? { position: "fixed", inset: `${BANNER_HEIGHT_PX}px 0 0 0`, transform: "translateZ(0)", overflow: "hidden" }
          : { display: "contents" }}
      >
        {children}
      </div>
      {gate.status === "blocked" ? <UpdateRequiredView gate={gate} appName={appName} onUpdateNow={updateNow} working={working} detail={detail} /> : null}
    </>
  );
}
