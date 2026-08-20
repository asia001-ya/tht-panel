import type {
  AgentKind,
  ManagedSession,
  ProviderProfile,
  PtySessionInfo,
  Workspace,
} from "../api/types";
import { parseNativeConversationTabId } from "./nativeConversation";
import { resolveConversationProvider, resolveProjectProvider } from "./providers";

export interface ActiveTabContext {
  tabId: string | null;
  title: string;
  workspace?: Workspace;
  kind?: AgentKind;
  state?: PtySessionInfo["state"];
  provider?: ProviderProfile;
}

function findManagedSession(
  conversationId: string,
  conversationsByProject: Record<string, ManagedSession[]>,
): ManagedSession | undefined {
  for (const conversations of Object.values(conversationsByProject)) {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (conversation) return conversation;
  }
  return undefined;
}

/**
 * 统一解析终端与原生对话 Tab 的显示上下文，供标题栏、状态栏等全局 UI 复用。
 */
export function resolveActiveTabContext(
  tabId: string | null,
  terminalSessions: Record<string, PtySessionInfo>,
  conversationsByProject: Record<string, ManagedSession[]>,
  workspaces: Workspace[],
  providers: ProviderProfile[],
): ActiveTabContext {
  if (!tabId) return { tabId: null, title: "未选择会话" };

  const nativeConversationId = parseNativeConversationTabId(tabId);
  if (nativeConversationId) {
    const conversation = findManagedSession(nativeConversationId, conversationsByProject);
    if (!conversation) return { tabId, title: "会话不存在" };
    const workspace = workspaces.find((item) => item.id === conversation.workspaceId);
    return {
      tabId,
      title: conversation.name,
      workspace,
      kind: conversation.kind,
      provider: workspace
        ? resolveConversationProvider(conversation, workspace, providers) ?? undefined
        : undefined,
    };
  }

  const session = terminalSessions[tabId];
  if (!session) return { tabId, title: "会话不存在" };
  const workspace = session.workspaceId
    ? workspaces.find((item) => item.id === session.workspaceId)
    : undefined;
  const managedSession = Object.values(conversationsByProject)
    .flat()
    .find((item) => item.ptySessionId === session.sessionId);
  const provider = workspace
    ? session.kind === "shell"
      ? null
      : managedSession
      ? resolveConversationProvider(managedSession, workspace, providers)
      : resolveProjectProvider(workspace, providers)
    : null;
  return {
    tabId,
    title: session.title,
    workspace,
    kind: session.kind,
    state: session.state,
    provider: provider ?? undefined,
  };
}

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
  return findManagedSession(nativeConversationId, conversationsByProject)?.workspaceId ?? null;
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
