import type {
  AgentKind,
  LeafNode,
  ManagedSession,
  PaneNode,
  ProviderProfile,
  PtySessionInfo,
  SavedSessionRef,
  SavedWorkspaceLayout,
  Workspace,
} from "../api/types";
import {
  nativeConversationTabId,
  parseNativeConversationTabId,
} from "./nativeConversation";

interface PendingSessionMeta {
  workspaceId: string;
  kind: string;
  providerId?: string;
}

interface RestorePlanInput {
  snapshot: SavedWorkspaceLayout;
  runtimeSessions: Record<string, PtySessionInfo>;
  managedSessions: ManagedSession[];
  workspaces: Workspace[];
  providers: ProviderProfile[];
  failedWorkspaceIds?: ReadonlySet<string>;
}

interface RestoreContext extends Omit<RestorePlanInput, "snapshot"> {
  sessionRefs: Record<string, SavedSessionRef> | undefined;
}

export type RestoreAction =
  | {
      kind: "keep";
      leafId: string;
      oldTabId: string;
      sessionId: string;
      managedSessionId?: string;
    }
  | {
      kind: "native";
      leafId: string;
      oldTabId: string;
      sessionId: string;
      managedSessionId: string;
    }
  | {
      kind: "spawn";
      leafId: string;
      oldTabId: string;
      ref: SavedSessionRef;
      managed?: ManagedSession;
    }
  | {
      kind: "error";
      leafId: string;
      oldTabId: string;
      message: string;
    };

/**
 * 判断字符串是否为受支持的会话类型。
 * @param value 待检查的字符串。
 * @returns 属于 AgentKind 时返回 true。
 */
function isAgentKind(value: string): value is AgentKind {
  return value === "claude" || value === "codex" || value === "shell";
}

/**
 * 从自管会话复制稳定引用字段。
 * @param managed 自管会话。
 * @param mode 保存的会话展示模式。
 * @returns 与自管会话对象引用独立的稳定引用。
 */
function refFromManaged(
  managed: ManagedSession,
  mode: SavedSessionRef["mode"],
): SavedSessionRef {
  return {
    managedSessionId: managed.id,
    workspaceId: managed.workspaceId,
    kind: managed.kind,
    ...(managed.providerId ? { providerId: managed.providerId } : {}),
    mode,
  };
}

/**
 * 按布局先序收集全部叶子窗格。
 * @param tree 待遍历的布局树。
 * @returns Leaf 先序排列的窗格列表。
 */
function preorderLeaves(tree: PaneNode): LeafNode[] {
  if (tree.type === "leaf") return [tree];
  return [
    ...preorderLeaves(tree.children[0]),
    ...preorderLeaves(tree.children[1]),
  ];
}

/**
 * 创建带完整 Tab 定位信息的恢复错误动作。
 * @param leafId 错误所属窗格 ID。
 * @param oldTabId 快照中的旧 Tab ID。
 * @param message 错误说明。
 * @returns 恢复错误动作。
 */
function restoreError(
  leafId: string,
  oldTabId: string,
  message: string,
): RestoreAction {
  return { kind: "error", leafId, oldTabId, message };
}

/**
 * 校验保存引用中的命名供应商约束。
 * @param ref 待恢复的稳定会话引用。
 * @param providers 当前供应商配置列表。
 * @returns 校验失败文案；通过时返回 null。
 */
function providerValidationError(
  ref: SavedSessionRef,
  providers: ProviderProfile[],
): string | null {
  if (ref.kind === "shell" || !ref.providerId) return null;
  const matches = providers.filter((provider) => provider.id === ref.providerId);
  if (matches.length === 0) return `供应商不存在：${ref.providerId}`;
  if (matches.length > 1) return `供应商 ID 不唯一：${ref.providerId}`;
  if (matches[0].driver !== ref.kind) {
    return `供应商类型与会话类型不一致：${ref.providerId}`;
  }
  return null;
}

/**
 * 为旧快照中没有稳定引用的 Tab 推导引用或原生会话。
 * @param oldTabId 快照中的旧 Tab ID。
 * @param managedSessions 已加载的自管会话。
 * @returns 推导出的自管会话、稳定引用和是否为原生 Tab。
 */
function resolveLegacyTab(
  oldTabId: string,
  managedSessions: ManagedSession[],
): {
  managed: ManagedSession;
  ref: SavedSessionRef;
} | null {
  const nativeId = parseNativeConversationTabId(oldTabId);
  if (nativeId !== null) {
    const managed = managedSessions.find((session) => session.id === nativeId);
    return managed
      ? { managed, ref: refFromManaged(managed, "native") }
      : null;
  }

  const managed = managedSessions.find(
    (session) => session.ptySessionId === oldTabId,
  );
  return managed
    ? { managed, ref: refFromManaged(managed, "terminal") }
    : null;
}

/**
 * 为布局中全部可识别 Tab 构建稳定会话引用。
 * @param tree 当前运行时布局树。
 * @param runtimeSessions 当前 PTY 会话镜像。
 * @param historyCache 按工作空间缓存的自管会话。
 * @param pendingSessions 尚未命名的 PTY 元数据。
 * @returns 以当前 Tab ID 为键、与输入对象引用独立的稳定引用表。
 */
export function buildSessionRefs(
  tree: PaneNode,
  runtimeSessions: Record<string, PtySessionInfo>,
  historyCache: Record<string, ManagedSession[]>,
  pendingSessions: ReadonlyMap<string, PendingSessionMeta>,
): Record<string, SavedSessionRef> {
  const refs: Record<string, SavedSessionRef> = {};
  const managedSessions = Object.values(historyCache).flat();

  for (const leaf of preorderLeaves(tree)) {
    for (const tabId of leaf.sessionIds) {
      const nativeId = parseNativeConversationTabId(tabId);
      if (nativeId !== null) {
        const managed = managedSessions.find((session) => session.id === nativeId);
        if (managed?.workspaceId) {
          refs[tabId] = refFromManaged(managed, "native");
        }
        continue;
      }

      const managed = managedSessions.find(
        (session) => session.ptySessionId === tabId,
      );
      if (managed?.workspaceId) {
        refs[tabId] = refFromManaged(managed, "terminal");
        continue;
      }

      const pending = pendingSessions.get(tabId);
      if (pending?.workspaceId && isAgentKind(pending.kind)) {
        refs[tabId] = {
          workspaceId: pending.workspaceId,
          kind: pending.kind,
          ...(pending.providerId ? { providerId: pending.providerId } : {}),
          mode: "terminal",
        };
        continue;
      }

      const runtime = runtimeSessions[tabId];
      if (runtime?.workspaceId) {
        refs[tabId] = {
          workspaceId: runtime.workspaceId,
          kind: runtime.kind,
          mode: "terminal",
        };
      }
    }
  }

  return refs;
}

/**
 * 规划单个快照 Tab 的无副作用恢复动作。
 * @param leafId Tab 所属窗格 ID。
 * @param oldTabId 快照中的旧 Tab ID。
 * @param context 当前运行时数据和配置。
 * @returns 该 Tab 唯一的恢复动作。
 */
function planTabRestore(
  leafId: string,
  oldTabId: string,
  context: RestoreContext,
): RestoreAction {
  const {
    runtimeSessions,
    managedSessions,
    workspaces,
    providers,
    failedWorkspaceIds,
    sessionRefs,
  } = context;
  const savedRef = sessionRefs?.[oldTabId];
  const managedByRef = savedRef?.managedSessionId
    ? managedSessions.find((session) => session.id === savedRef.managedSessionId)
    : undefined;
  const managedByOldPty = managedSessions.find(
    (session) => session.ptySessionId === oldTabId,
  );
  const oldRuntime = runtimeSessions[oldTabId];

  if (oldRuntime && oldRuntime.state !== "dead") {
    const managedSessionId = savedRef?.managedSessionId ?? managedByOldPty?.id;
    return {
      kind: "keep",
      leafId,
      oldTabId,
      sessionId: oldTabId,
      ...(managedSessionId ? { managedSessionId } : {}),
    };
  }

  const legacy = savedRef ? null : resolveLegacyTab(oldTabId, managedSessions);
  if (!savedRef && !legacy) {
    return restoreError(leafId, oldTabId, "旧会话无法恢复");
  }

  const ref = { ...(savedRef ?? legacy?.ref) } as SavedSessionRef;
  const managed = savedRef?.managedSessionId
    ? managedByRef
    : legacy?.managed ?? managedByOldPty;

  if (managed && managed.kind !== ref.kind) {
    return restoreError(leafId, oldTabId, "自管会话类型与保存引用不一致");
  }

  if (ref.mode === "terminal" && managed?.ptySessionId) {
    const currentRuntime = runtimeSessions[managed.ptySessionId];
    if (currentRuntime && currentRuntime.state !== "dead") {
      return {
        kind: "keep",
        leafId,
        oldTabId,
        sessionId: managed.ptySessionId,
        managedSessionId: managed.id,
      };
    }
  }

  if (!workspaces.some((workspace) => workspace.id === ref.workspaceId)) {
    return restoreError(leafId, oldTabId, `工作空间不存在：${ref.workspaceId}`);
  }

  if (ref.managedSessionId && failedWorkspaceIds?.has(ref.workspaceId)) {
    return restoreError(leafId, oldTabId, "自管会话历史加载失败");
  }

  const providerError = providerValidationError(ref, providers);
  if (providerError) return restoreError(leafId, oldTabId, providerError);

  if (ref.mode === "native") {
    if (!managed) return restoreError(leafId, oldTabId, "原生会话不存在");
    return {
      kind: "native",
      leafId,
      oldTabId,
      sessionId: nativeConversationTabId(managed.id),
      managedSessionId: managed.id,
    };
  }

  return {
    kind: "spawn",
    leafId,
    oldTabId,
    ref,
    ...(managed ? { managed } : {}),
  };
}

/**
 * 按 Leaf 先序和 Tab 顺序生成保存工作区恢复计划。
 * @param input 保存快照、运行态、自管会话和当前配置。
 * @returns 不执行任何副作用的有序恢复动作列表。
 */
export function planWorkspaceRestore(input: RestorePlanInput): RestoreAction[] {
  const { snapshot, ...context } = input;
  const restoreContext: RestoreContext = {
    ...context,
    sessionRefs: snapshot.sessionRefs,
  };

  return preorderLeaves(snapshot.tree).flatMap((leaf) =>
    leaf.sessionIds.map((oldTabId) =>
      planTabRestore(leaf.id, oldTabId, restoreContext),
    ),
  );
}
