import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushFilesUsed } from "../src/app/lib/omnirush-server";
import { filesUsedCardShown, filesUsedChecked, filesUsedHelp, filesUsedStatusLine } from "../src/react-app/domains/settings/files-used";
import { FilesUsedCard } from "../src/react-app/domains/settings/pages/general-view";

const LINE = "OmniRush also saves the files the agent reads, runs or creates during a session (including temporary files and a few allowlisted config files, with secrets removed), so the session can be replayed.";
const setting = (patch: Partial<OmniRushFilesUsed> = {}): OmniRushFilesUsed => ({ enabled: true, active: false, accepted: false, available: true, consentText: LINE, ...patch });

function switchMarkup(markup: string): string {
  const match = markup.match(/<[a-z]+[^>]*role="switch"[^>]*>/);
  if (!match) throw new Error(`no switch in ${markup}`);
  return match[0];
}

describe("session files settings card", () => {
  test("shows omnirush.ai's consent line and the account's answer", () => {
    const off = renderToStaticMarkup(<FilesUsedCard setting={setting()} busy={false} status="" onToggle={() => {}} />);
    expect(off).toContain("Session files");
    expect(off).toContain(LINE);
    expect(switchMarkup(off)).toContain('aria-checked="false"');
    expect(off).toContain("Off for this account.");

    const on = renderToStaticMarkup(<FilesUsedCard setting={setting({ active: true, accepted: true })} busy={false} status="" onToggle={() => {}} />);
    expect(switchMarkup(on)).toContain('aria-checked="true"');
    expect(on).toContain("On for this account.");
  });

  test("the switch is off when this computer turned it off, whatever the account says", () => {
    const local = setting({ enabled: false, accepted: true, active: false });
    expect(filesUsedChecked(local)).toBe(false);
    expect(filesUsedStatusLine(local)).toBe("Off on this computer. No session files are saved.");
    expect(filesUsedChecked(setting({ accepted: null, active: null }))).toBe(true);
    expect(filesUsedStatusLine(setting({ accepted: null, active: null }))).toContain("could not be reached");
  });

  test("shown only while omnirush.ai offers it, with its own wording (no copy kept in the app)", () => {
    expect(filesUsedCardShown(setting())).toBe(true);
    expect(filesUsedCardShown(setting({ available: false }))).toBe(false);
    expect(filesUsedCardShown(setting({ consentText: null }))).toBe(false);
    expect(filesUsedCardShown(null)).toBe(false);
    expect(filesUsedHelp(setting({ consentText: "Server wording." }))).toStartWith("Server wording.");
  });
});
