import { useCallback, useEffect, useRef, useState } from "react";

import type { OmniRushFilesUsed, OmniRushServerClient } from "@/app/lib/omnirush-server";

export type FilesUsedClient = Pick<OmniRushServerClient, "getFilesUsed" | "setFilesUsed">;

/**
 * The card is shown only while omnirush.ai offers it (`available`), with the
 * consent line omnirush.ai sends (never a copy kept here).
 */
export function filesUsedCardShown(setting: OmniRushFilesUsed | null): boolean {
  return setting?.available === true && typeof setting.consentText === "string" && setting.consentText.length > 0;
}

/** The card's help: omnirush.ai's consent line, and what the switch does. */
export function filesUsedHelp(setting: OmniRushFilesUsed | null): string {
  return `${setting?.consentText ?? ""} Turning this on accepts it for your account; turning it off stops it.`.trim();
}

/** Whether the switch shows on: this device's choice and the account's answer (an unknown answer counts as on). */
export function filesUsedChecked(setting: OmniRushFilesUsed | null): boolean {
  return setting !== null && setting.enabled && setting.accepted !== false;
}

/** What the card says under the switch, from the saved setting. */
export function filesUsedStatusLine(setting: OmniRushFilesUsed | null): string {
  if (!setting) return "";
  if (!setting.enabled) return "Off on this computer. No session files are saved.";
  if (setting.active === true) return "On for this account.";
  if (setting.accepted === false) return "Off for this account.";
  if (setting.active === false) return "Not saving yet.";
  return "On here. omnirush.ai could not be reached to confirm.";
}

/** The Settings switch: a GET begun before a PUT never replaces the newly saved choice. */
export function useFilesUsed(client: FilesUsedClient | null) {
  const [setting, setSetting] = useState<OmniRushFilesUsed | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    const startedAt = sequence.current;
    let cancelled = false;
    setSetting(null);
    setBusy(false);
    setStatus("");
    if (client) {
      void client.getFilesUsed()
        .then((value) => {
          if (!cancelled && sequence.current === startedAt) setSetting(value);
        })
        .catch(() => {
          if (!cancelled && sequence.current === startedAt) setStatus("This setting could not be loaded. Try opening Settings again.");
        });
    }
    return () => { cancelled = true; };
  }, [client]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!client || busy) return;
    sequence.current += 1;
    const startedAt = sequence.current;
    setBusy(true);
    setStatus("Saving…");
    try {
      const result = await client.setFilesUsed(enabled);
      if (sequence.current !== startedAt) return;
      setSetting({ enabled: result.enabled, active: result.active, accepted: result.accepted, available: result.available, consentText: result.consentText });
      setStatus("");
    } catch {
      if (sequence.current !== startedAt) return;
      const saved = await client.getFilesUsed().catch(() => null);
      if (sequence.current !== startedAt) return;
      if (saved) setSetting(saved);
      setStatus("This setting could not be saved. Try again.");
    } finally {
      if (sequence.current === startedAt) setBusy(false);
    }
  }, [busy, client]);

  return { setting, busy, status, setEnabled };
}
