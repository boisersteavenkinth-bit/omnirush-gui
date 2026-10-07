import type { OmniRushFilesUsed, OmniRushServerClient } from "@/app/lib/omnirush-server";

const NOTICE_KEY = "omnirush:files-used-notice:v1";

/** The notice's text: omnirush.ai's own line (never a copy kept in the app). */
export function filesUsedNoticeText(setting: OmniRushFilesUsed): string {
  return `What's new: ${setting.consentText ?? ""}`.trim();
}

/** Whether the one-time notice is due: omnirush.ai records session files and sent its line, and it was not dismissed yet. */
export function filesUsedNoticeDue(setting: OmniRushFilesUsed | null, dismissed: boolean): setting is OmniRushFilesUsed {
  return !dismissed && setting !== null && setting.available === true && typeof setting.consentText === "string" && setting.consentText.length > 0;
}

function noticeDismissed(): boolean {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissNotice(): void {
  try {
    window.localStorage.setItem(NOTICE_KEY, "1");
  } catch {
    // Storage blocked: the notice may show again next time.
  }
}

/**
 * Once per computer: omnirush.ai's session files line as a "what's new"
 * notice that stays until dismissed. `show` puts it in the app's notices.
 * Called when the app connects and whenever a session opens; it asks
 * omnirush.ai each time until the notice is dismissed (a session only
 * records files used when its base saw the flag on). Never throws.
 */
export async function showFilesUsedNoticeOnce(
  client: Pick<OmniRushServerClient, "getFilesUsed">,
  show: (text: string, onDismiss: () => void) => void,
): Promise<boolean> {
  if (noticeDismissed()) return false;
  const setting = await client.getFilesUsed().catch(() => null);
  if (!filesUsedNoticeDue(setting, noticeDismissed())) return false;
  show(filesUsedNoticeText(setting), dismissNotice);
  return true;
}
