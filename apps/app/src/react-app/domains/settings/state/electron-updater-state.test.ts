declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
};

import {
  ELECTRON_UPDATER_UNSUPPORTED_REASON,
  describeError,
  keepsReadyUpdate,
  resolveCheckedUpdateState,
  shouldScheduleElectronUpdateAutoCheck,
  stripRemoteMethodErrorPrefix,
  unsupportedElectronUpdaterEnvState,
} from "./electron-updater-state";

describe("electron updater web unsupported state", () => {
  test("marks the updater environment unsupported in web", () => {
    expect(unsupportedElectronUpdaterEnvState()).toEqual({
      appVersion: null,
      updateEnv: {
        supported: false,
        reason: ELECTRON_UPDATER_UNSUPPORTED_REASON,
      },
      installMode: null,
      alphaChannelSupported: null,
    });
  });

  test("does not schedule automatic checks when unsupported", () => {
    expect(shouldScheduleElectronUpdateAutoCheck({
      updateAutoCheck: true,
      updateEnv: unsupportedElectronUpdaterEnvState().updateEnv,
      autoCheckKey: null,
      nextAutoCheckKey: "stable:unknown",
    })).toBe(false);
  });
});

describe("electron updater error text", () => {
  test("strips the Electron remote-method prefix from bridge failures", () => {
    expect(describeError(new Error(
      "Error invoking remote method 'omnirush:desktop': Error: net::ERR_NAME_NOT_RESOLVED",
    ))).toBe("net::ERR_NAME_NOT_RESOLVED");
    expect(stripRemoteMethodErrorPrefix(
      "Error invoking remote method 'omnirush:updater:check': Error: Error invoking remote method 'omnirush:desktop': Error: HTTP 404",
    )).toBe("HTTP 404");
    expect(stripRemoteMethodErrorPrefix("Error invoking remote method 'omnirush:desktop': Request timed out.")).toBe(
      "Request timed out.",
    );
  });

  test("leaves ordinary messages and non-errors alone", () => {
    expect(describeError(new Error("network flake"))).toBe("network flake");
    expect(describeError("plain text")).toBe("\"plain text\"");
    expect(describeError({ reason: "boom" })).toContain("\"reason\": \"boom\"");
    expect(stripRemoteMethodErrorPrefix("Error invoking remote method 'omnirush:desktop': ")).toBe(
      "Error invoking remote method 'omnirush:desktop':",
    );
  });
});

describe("electron updater availability state", () => {
  test("does not report a policy-blocked available update as current", () => {
    expect(resolveCheckedUpdateState({ available: true, allowed: false })).toBe("blocked");
  });

  test("reports current only when the feed has no available update", () => {
    expect(resolveCheckedUpdateState({ available: false, allowed: false })).toBe("idle");
  });
});

describe("electron updater staged update", () => {
  test("a newer published release replaces the staged one", () => {
    expect(keepsReadyUpdate({ readyVersion: "2.2.1", checkFailed: false, available: true, latestVersion: "2.2.3" })).toBe(false);
  });

  test("the same release keeps the staged update ready", () => {
    expect(keepsReadyUpdate({ readyVersion: "2.2.3", checkFailed: false, available: true, latestVersion: "2.2.3" })).toBe(true);
  });

  test("a failed re-check keeps the staged update ready", () => {
    expect(keepsReadyUpdate({ readyVersion: "2.2.1", checkFailed: true, available: false, latestVersion: null })).toBe(true);
  });

  test("a pulled release clears the staged update", () => {
    expect(keepsReadyUpdate({ readyVersion: "2.2.1", checkFailed: false, available: false, latestVersion: "2.2.0" })).toBe(false);
    expect(keepsReadyUpdate({ readyVersion: undefined, checkFailed: true, available: false, latestVersion: null })).toBe(false);
  });
});
