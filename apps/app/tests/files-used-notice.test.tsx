import { describe, expect, test } from "bun:test";

import type { OmniRushFilesUsed } from "../src/app/lib/omnirush-server";
import { filesUsedNoticeDue, filesUsedNoticeText, showFilesUsedNoticeOnce } from "../src/react-app/shell/files-used-notice";

const LINE = "OmniRush also saves the files the agent reads, runs or creates during a session (including temporary files and a few allowlisted config files, with secrets removed), so the session can be replayed.";
const status = (patch: Partial<OmniRushFilesUsed> = {}): OmniRushFilesUsed => ({ active: true, available: true, consentText: LINE, ...patch });

function withStorage(run: (store: Map<string, string>) => Promise<void>): Promise<void> {
  const store = new Map<string, string>();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) },
  };
  return run(store).finally(() => {
    (globalThis as { window?: unknown }).window = previous;
  });
}

describe("session files notice", () => {
  test("shows omnirush.ai's own line as what's new, with nothing about turning it off", () => {
    expect(filesUsedNoticeText(status())).toBe(`What's new: ${LINE}`);
    expect(filesUsedNoticeText(status({ consentText: "Server wording." }))).toBe("What's new: Server wording.");
    expect(filesUsedNoticeText(status()).toLowerCase()).not.toContain("turn off");
  });

  test("due only while omnirush.ai offers it with its line, and until dismissed", () => {
    expect(filesUsedNoticeDue(status(), false)).toBe(true);
    expect(filesUsedNoticeDue(status(), true)).toBe(false);
    expect(filesUsedNoticeDue(status({ available: false, active: false }), false)).toBe(false);
    expect(filesUsedNoticeDue(status({ consentText: null }), false)).toBe(false);
    expect(filesUsedNoticeDue(null, false)).toBe(false);
  });

  test("once per computer: dismissing it keeps it away", async () => {
    await withStorage(async (store) => {
      const shown: string[] = [];
      const client = { getFilesUsed: async () => status() };
      let dismiss: () => void = () => undefined;
      expect(await showFilesUsedNoticeOnce(client, (text, onDismiss) => {
        shown.push(text);
        dismiss = onDismiss;
      })).toBe(true);
      expect(shown).toEqual([`What's new: ${LINE}`]);
      dismiss();
      expect(store.get("omnirush:files-used-notice:v1")).toBe("1");
      expect(await showFilesUsedNoticeOnce(client, () => shown.push("again"))).toBe(false);
      expect(shown.length).toBe(1);
      // An unreachable server shows nothing and never throws.
      store.clear();
      expect(await showFilesUsedNoticeOnce({ getFilesUsed: async () => { throw new Error("down"); } }, () => shown.push("x"))).toBe(false);
    });
  });
});
