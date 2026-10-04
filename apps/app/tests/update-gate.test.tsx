import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  NO_UPDATE_GATE,
  chatBlockedByUpdate,
  formatUpdateCountdown,
  normalizeUpdateGateState,
  requiredUpdateAction,
  shouldStartBackgroundDownload,
  updateBannerText,
  useUpdateGateStore,
  type UpdateGateState,
} from "../src/app/lib/update-gate";
import { RequiredUpdateBanner, UpdateRequiredView } from "../src/react-app/shell/update-gate";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const NOW = Date.parse("2026-10-04T12:00:00Z");
const required: UpdateGateState = {
  status: "required",
  current: "3.0.2",
  minimum: "3.1.0",
  deadline: "2026-10-04T17:12:00.000Z",
  message: null,
  downloadUrl: "https://omnirush.ai/download",
  source: "header",
};
const blocked: UpdateGateState = { ...required, status: "blocked", message: "Update OmniRush.ai to 3.1.0 to keep using models.", source: "rejection" };

describe("update gate state from the desktop bridge", () => {
  test("normalizes the main-process state and rejects anything malformed", () => {
    expect(normalizeUpdateGateState(required)).toEqual(required);
    expect(normalizeUpdateGateState(null)).toEqual(NO_UPDATE_GATE);
    expect(normalizeUpdateGateState({ status: "panic", deadline: "soon", downloadUrl: "" })).toEqual({
      ...NO_UPDATE_GATE,
      status: "none",
    });
  });

  test("only the blocked state disables the chat input", () => {
    expect(chatBlockedByUpdate(blocked)).toBe(true);
    expect(chatBlockedByUpdate(required)).toBe(false);
    expect(chatBlockedByUpdate(NO_UPDATE_GATE)).toBe(false);
  });
});

describe("required-update banner", () => {
  test("counts down to the deadline", () => {
    expect(formatUpdateCountdown(required.deadline, NOW)).toBe("5h 12m");
    expect(formatUpdateCountdown(required.deadline, NOW + 5 * 3_600_000)).toBe("12m");
    expect(formatUpdateCountdown("2026-10-06T16:00:00Z", NOW)).toBe("2d 4h");
    expect(formatUpdateCountdown(required.deadline, Date.parse(required.deadline!) - 10_000)).toBe("less than a minute");
    expect(formatUpdateCountdown(null, NOW)).toBeNull();
  });

  test("names the required version", () => {
    expect(updateBannerText(required, "OmniRush.ai", NOW)).toBe("OmniRush.ai 3.1.0 is required in 5h 12m");
    expect(updateBannerText({ ...required, minimum: null, deadline: null }, "OmniRush.ai", NOW)).toBe("A newer OmniRush.ai is required");
  });

  test("renders the countdown and an Update now button, with no way to dismiss it", () => {
    const html = renderToStaticMarkup(
      <RequiredUpdateBanner gate={required} appName="OmniRush.ai" onUpdateNow={() => undefined} working={false} detail={null} />,
    );
    expect(html).toContain("data-testid=\"update-required-banner\"");
    expect(html).toMatch(/OmniRush\.ai 3\.1\.0 is required in \d+(d \d+h|h \d+m|m)|less than a minute/);
    expect(html).toContain("Update now");
    expect(html.toLowerCase()).not.toContain("dismiss");
    expect(html).not.toContain("aria-label=\"Close\"");
  });
});

describe("blocked view", () => {
  test("is full-screen, shows the server message and both versions, and offers Update now", () => {
    const html = renderToStaticMarkup(
      <UpdateRequiredView gate={blocked} appName="OmniRush.ai" onUpdateNow={() => undefined} working={false} detail="Downloading the update… 40%" />,
    );
    expect(html).toContain("data-testid=\"update-required-view\"");
    expect(html).toContain("fixed inset-0");
    expect(html).toContain("Update required");
    expect(html).toContain(blocked.message!);
    expect(html).toContain(">3.0.2<");
    expect(html).toContain(">3.1.0<");
    expect(html).toContain("Update now");
    expect(html).toContain("keep uploading in the background");
    expect(html).toContain("Downloading the update… 40%");
  });
});

describe("Update now", () => {
  test("installs a staged update in place (Linux AppImage, Windows, Developer ID macOS)", () => {
    expect(requiredUpdateAction({ supported: true, installMode: "in-place", updaterState: "ready" })).toBe("install");
    expect(requiredUpdateAction({ supported: true, installMode: "in-place", updaterState: "available" })).toBe("download-then-install");
    expect(requiredUpdateAction({ supported: true, installMode: "in-place", updaterState: null })).toBe("download-then-install");
    expect(requiredUpdateAction({ supported: true, installMode: "in-place", updaterState: "downloading" })).toBe("wait");
  });

  test("opens download_url where the app cannot replace itself", () => {
    // Ad-hoc signed macOS builds: Squirrel cannot swap them.
    expect(requiredUpdateAction({ supported: true, installMode: "manual-dmg", updaterState: "ready" })).toBe("open-download");
    expect(requiredUpdateAction({ supported: false, installMode: null, updaterState: null })).toBe("open-download");
    expect(requiredUpdateAction({ supported: true, installMode: "in-place", updaterState: "blocked" })).toBe("open-download");
  });

  test("tries the download again after a failed check or download", () => {
    expect(requiredUpdateAction({ supported: true, installMode: "in-place", updaterState: "error" })).toBe("download-then-install");
  });

  test("the download starts in the background as soon as an update is required", () => {
    const base = { supported: true, installMode: "in-place" as const };
    expect(shouldStartBackgroundDownload({ ...base, gate: required, updaterState: null })).toBe(true);
    expect(shouldStartBackgroundDownload({ ...base, gate: blocked, updaterState: "idle" })).toBe(true);
    expect(shouldStartBackgroundDownload({ ...base, gate: required, updaterState: "downloading" })).toBe(false);
    expect(shouldStartBackgroundDownload({ ...base, gate: required, updaterState: "ready" })).toBe(false);
    expect(shouldStartBackgroundDownload({ ...base, gate: NO_UPDATE_GATE, updaterState: null })).toBe(false);
    expect(shouldStartBackgroundDownload({ supported: true, installMode: "manual-dmg", gate: required, updaterState: null })).toBe(false);
  });
});

describe("wiring", () => {
  test("both composers are disabled while the gate blocks", () => {
    expect(read("../src/react-app/domains/session/surface/session-surface.tsx")).toMatch(/disabled=\{[^}]*\|\| updateBlocked\}/);
    expect(read("../src/react-app/domains/session/chat/new-task-composer.tsx")).toMatch(/disabled=\{[^}]*\|\| updateBlocked\}/);
    useUpdateGateStore.getState().set(blocked);
    expect(chatBlockedByUpdate(useUpdateGateStore.getState().state)).toBe(true);
    useUpdateGateStore.getState().set(NO_UPDATE_GATE);
  });

  test("the gate only covers the UI: it never stops the session uploader or signs out", () => {
    const gate = read("../src/react-app/shell/update-gate.tsx") + read("../src/app/lib/update-gate.ts");
    for (const forbidden of ["signOut", "omnirushAccountSignOut", "omnirushServerRestart", "capture", "uploader", "nuke"]) {
      expect(gate).not.toContain(forbidden);
    }
    // The blocked view overlays the app instead of unmounting it.
    expect(read("../src/react-app/shell/update-gate.tsx")).toContain("{children}");
  });
});
