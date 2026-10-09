/**
 * A chat the engine confirmed it does not have (deleted elsewhere, never
 * carried over from an earlier engine, or saved by an older app) must leave
 * every place the app remembers it, or it keeps coming back as a dead end:
 * the saved sidebar list, the remembered chat for its workspace, and the
 * workbench tabs and side-chat pairs that outlive restarts.
 */
import { useWorkbenchStore } from "@/react-app/domains/session/chat/workbench-store";
import { forgetLastSessionFor, removeCachedWorkspaceSession } from "./session-memory";

export type MissingChatRef = { workspaceId: string; sessionId: string };

/**
 * Drops one workspace's saved references to a missing chat. Scoped to the
 * pair: the same id listed under another workspace is left alone, so a route
 * that briefly pairs a chat with the wrong workspace cannot erase it.
 */
export function forgetMissingChatMemory(ref: MissingChatRef): boolean {
  const workspaceId = ref.workspaceId.trim();
  const sessionId = ref.sessionId.trim();
  if (!workspaceId || !sessionId) return false;
  removeCachedWorkspaceSession(workspaceId, sessionId);
  forgetLastSessionFor(workspaceId, sessionId);
  useWorkbenchStore.getState().closeTab({ workspaceId, sessionId });
  return true;
}
