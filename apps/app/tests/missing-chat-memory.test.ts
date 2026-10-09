import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.window === "undefined") GlobalRegistrator.register({ url: "http://localhost/" });

const { useWorkbenchStore } = await import("../src/react-app/domains/session/chat/workbench-store");
const { forgetMissingChatMemory } = await import("../src/react-app/shell/missing-chat");
const {
  readCachedWorkspaceSessions,
  readLastSessionFor,
  writeCachedWorkspaceSessions,
  writeLastSessionFor,
} = await import("../src/react-app/shell/session-memory");

function savedSession(id: string, directory: string) {
  return { id, slug: id, projectID: "p", directory, title: id, version: "1.18.32", time: { created: 1, updated: 2 } };
}

describe("a chat the engine no longer has", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkbenchStore.setState({ revision: 0, primary: null, tabs: [], secondary: null, focusedPane: "primary", sideChats: {} });
  });

  test("leaves its workspace's saved list, remembered chat, tab and side-chat pair", () => {
    // What an app that ran the earlier engine saved: the chat is in the
    // sidebar cache, remembered as the last chat, open as a tab and paired.
    writeCachedWorkspaceSessions("ws-a", [savedSession("ses_gone", "/p/a"), savedSession("ses_kept", "/p/a")]);
    writeCachedWorkspaceSessions("ws-b", [savedSession("ses_gone", "/p/b")]);
    writeLastSessionFor("ws-a", "ses_gone");
    writeLastSessionFor("ws-b", "ses_gone");
    const store = useWorkbenchStore.getState();
    store.sync({ workspaceId: "ws-a", primarySessionId: "ses_kept", sessions: [], sessionsKnown: false });
    store.openTab({ workspaceId: "ws-a", sessionId: "ses_gone" });
    store.openTab({ workspaceId: "ws-b", sessionId: "ses_gone" });
    store.setSideChat({ workspaceId: "ws-a", sessionId: "ses_kept" }, { workspaceId: "ws-a", sessionId: "ses_gone" });
    expect(Object.keys(useWorkbenchStore.getState().sideChats)).toHaveLength(1);

    expect(forgetMissingChatMemory({ workspaceId: "ws-a", sessionId: "ses_gone" })).toBe(true);

    expect(readCachedWorkspaceSessions("ws-a")?.map((session) => session.id)).toEqual(["ses_kept"]);
    expect(readLastSessionFor("ws-a")).toBeNull();
    const state = useWorkbenchStore.getState();
    expect(state.tabs.map((tab) => [tab.workspaceId, tab.sessionId])).toEqual([
      ["ws-a", "ses_kept"],
      ["ws-b", "ses_gone"],
    ]);
    expect(state.sideChats).toEqual({});

    // Scoped to the pair: the same id under another workspace is untouched.
    expect(readCachedWorkspaceSessions("ws-b")?.map((session) => session.id)).toEqual(["ses_gone"]);
    expect(readLastSessionFor("ws-b")).toBe("ses_gone");
  });

  test("keeps a remembered chat that has since moved on", () => {
    writeLastSessionFor("ws-a", "ses_newer");
    forgetMissingChatMemory({ workspaceId: "ws-a", sessionId: "ses_gone" });
    expect(readLastSessionFor("ws-a")).toBe("ses_newer");
    expect(forgetMissingChatMemory({ workspaceId: " ", sessionId: "ses_gone" })).toBe(false);
  });
});
