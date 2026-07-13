import type { ManagedSession, PtySessionInfo } from "../api/types";
import { parseNativeConversationTabId } from "./nativeConversation";

export type WorkspaceActivationTarget =
  | { kind: "managed"; session: ManagedSession }
  | { kind: "terminal"; sessionId: string }
  | { kind: "new-native" };

export function workspaceIdForTab(
  tabId: string,
  terminalSessions: Record<string, PtySessionInfo>,
  conversationsByProject: Record<string, ManagedSession[]>,
): string | null {
  const nativeConversationId = parseNativeConversationTabId(tabId);
  if (!nativeConversationId) {
    return terminalSessions[tabId]?.workspaceId ?? null;
  }
  for (const conversations of Object.values(conversationsByProject)) {
    const conversation = conversations.find(
      (item) => item.id === nativeConversationId,
    );
    if (conversation) return conversation.workspaceId;
  }
  return null;
}

export function workspaceActivationTarget(
  managedSessions: ManagedSession[] | undefined,
  latestTerminal: PtySessionInfo | null,
): WorkspaceActivationTarget {
  const recentManaged = managedSessions?.[0];
  if (recentManaged) return { kind: "managed", session: recentManaged };
  if (latestTerminal) {
    return { kind: "terminal", sessionId: latestTerminal.sessionId };
  }
  return { kind: "new-native" };
}
