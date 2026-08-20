/**
 * PaneLeaf：单个分屏叶子的渲染单元。
 * 标题栏：拖动句柄 + Tab 条（每 Tab 状态点+会话名+关闭） + 窗格操作区。
 * 主体渲染当前激活 Tab 的 TerminalPane（或空占位提示）。
 */
import { useState } from "react";
import type { LeafNode, SessionState } from "../../api/types";
import { useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import {
  pendingTaskCount,
  tasksForSavedWorkspace,
  useTaskStore,
} from "../../store/taskStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { TerminalPane } from "../../terminal/TerminalPane";
import { parseNativeConversationTabId } from "../../lib/nativeConversation";
import { ComposerBar } from "../Composer/ComposerBar";
import { NativeChatPaneHost } from "../Conversation/NativeChatPane";
import { IconButton } from "../ui/IconButton";
import {
  Columns2,
  GripVertical,
  Lock,
  LockOpen,
  ListTodo,
  Rows2,
  X,
  ICON_DEFAULTS,
} from "../ui/icons";

/* ---------- PaneTab 子组件 ---------- */

interface PaneTabProps {
  leafId: string;
  sessionId: string;
  active: boolean;
  closing: boolean;
  onCloseTab: (leafId: string, sessionId: string) => Promise<void>;
}

/**
 * 渲染单个会话 Tab，并把关闭意图交给应用层生命周期回调。
 * @param props 窗格 ID、会话 ID、激活状态与关闭回调。
 * @returns 单个会话 Tab 元素。
 */
function PaneTab({
  leafId,
  sessionId,
  active,
  closing,
  onCloseTab,
}: PaneTabProps): React.ReactElement {
  const activateTab = useLayoutStore((s) => s.activateTab);
  const setActive = useLayoutStore((s) => s.setActive);

  const nativeConversationId = parseNativeConversationTabId(sessionId);
  const managedName = useWorkspaceStore((s) => {
    for (const list of Object.values(s.historyCache))
      for (const m of list) {
        if (nativeConversationId ? m.id === nativeConversationId : m.ptySessionId === sessionId) {
          return m.name;
        }
      }
    return undefined;
  });
  const title = useSessionStore((s) => s.sessions[sessionId]?.title);
  const terminalState: SessionState = useSessionStore(
    (s) => s.sessions[sessionId]?.state ?? "dead",
  );
  const state: SessionState = nativeConversationId ? "idle" : terminalState;

  const label = managedName ?? title ?? "会话";

  return (
    <div
      className={`pane-tab${active ? " active" : ""}`}
      title={label}
      data-pane-drag-ignore
      onClick={(e) => {
        e.stopPropagation();
        setActive(leafId);
        activateTab(leafId, sessionId);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && !closing) {
          e.stopPropagation();
          void onCloseTab(leafId, sessionId);
        }
      }}
    >
      <span className="pane-status-dot" data-state={state} />
      <span className="pane-tab-label">{label}</span>
      <span
        className="pane-tab-close"
        aria-disabled={closing}
        onClick={(e) => {
          e.stopPropagation();
          if (!closing) void onCloseTab(leafId, sessionId);
        }}
      >
        ×
      </span>
    </div>
  );
}

/* ---------- PaneLeaf 主组件 ---------- */

interface PaneLeafProps {
  leaf: LeafNode;
  onCloseTab: (leafId: string, sessionId: string) => Promise<void>;
  onClosePane: (leaf: LeafNode) => Promise<void>;
  closingSessionIds: ReadonlySet<string>;
  closingPaneIds: ReadonlySet<string>;
  draggedLeafId: string | null;
  dropTargetLeafId: string | null;
  onPanePointerDown: (
    leafId: string,
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  onPaneDragStart: (
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDragOver: (
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDragLeave: (
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDrop: (
    leafId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDragEnd: (event: React.DragEvent<HTMLElement>) => void;
  onCreateTerminal?: (workspaceId?: string) => void;
}

/**
 * 渲染单个分屏叶子，并把拖放事件交给 PaneGrid 的共享处理器。
 * @param props 叶子数据、共享目标 ID 与拖放生命周期处理器。
 * @returns 单个窗格对应的 React 元素。
 */
export function PaneLeaf({
  leaf,
  onCloseTab,
  onClosePane,
  closingSessionIds,
  closingPaneIds,
  draggedLeafId,
  dropTargetLeafId,
  onPanePointerDown,
  onPaneDragStart,
  onPaneDragOver,
  onPaneDragLeave,
  onPaneDrop,
  onPaneDragEnd,
  onCreateTerminal,
}: PaneLeafProps): React.ReactElement {
  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const activeSavedWorkspaceId = useLayoutStore((s) => s.activeSavedWorkspaceId);
  const setActive = useLayoutStore((s) => s.setActive);
  const toggleLock = useLayoutStore((s) => s.toggleLock);
  const splitPane = useLayoutStore((s) => s.splitPane);
  const renamePane = useLayoutStore((s) => s.renamePane);
  const restoreError = useLayoutStore((s) => s.restoreErrors[leaf.id]);
  const openTaskDrawer = useTaskStore((state) => state.openDrawer);
  const taskCount = useTaskStore((state) => pendingTaskCount(
    tasksForSavedWorkspace(state.tasks, activeSavedWorkspaceId),
    leaf.id,
  ));
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  const nativeConversationId = leaf.activeSessionId
    ? parseNativeConversationTabId(leaf.activeSessionId)
    : null;
  const terminalWorkspaceId = useSessionStore((s) =>
    leaf.activeSessionId ? s.sessions[leaf.activeSessionId]?.workspaceId : null,
  );
  const nativeWorkspaceId = useWorkspaceStore((state) => {
    if (!nativeConversationId) return null;
    for (const list of Object.values(state.historyCache)) {
      const conversation = list.find((item) => item.id === nativeConversationId);
      if (conversation) return conversation.workspaceId;
    }
    return null;
  });
  const wsId = nativeWorkspaceId ?? terminalWorkspaceId;
  const wsName = useWorkspaceStore((s) =>
    wsId ? s.workspaces.find((w) => w.id === wsId)?.name : undefined,
  );

  const isActive = activePaneId === leaf.id;
  const isDragSource = draggedLeafId === leaf.id;
  const isDropTarget = dropTargetLeafId === leaf.id;
  const displayName = leaf.name ?? wsName ?? "未命名";
  const nameErrorId = `pane-name-error-${leaf.id}`;

  /**
   * 进入窗格名称编辑态，并以当前显式名称或项目名初始化草稿。
   * @returns 无返回值。
   */
  const beginNameEditing = (): void => {
    setDraftName(leaf.name ?? wsName ?? "");
    setNameError(null);
    setEditing(true);
  };

  /**
   * 保存当前名称草稿；名称重复时保留编辑态并展示 store 返回的错误。
   * @returns 无返回值。
   */
  const saveName = (): void => {
    const error = renamePane(leaf.id, draftName);
    if (error) {
      setNameError(error);
      return;
    }
    setNameError(null);
    setEditing(false);
  };

  return (
    <div
      className={`pane-leaf${isActive ? " pane-active" : ""}${isDragSource ? " pane-drag-source" : ""}${isDropTarget ? " pane-drop-target" : ""}`}
      data-pane-leaf-id={leaf.id}
      onClick={() => setActive(leaf.id)}
      onDragOver={(event) => onPaneDragOver(leaf.id, event)}
      onDragLeave={(event) => onPaneDragLeave(leaf.id, event)}
      onDrop={(event) => onPaneDrop(leaf.id, event)}
    >
      <div
        className="pane-titlebar"
        title="拖动标题栏空白处到其他窗格交换位置"
        onPointerDown={(event) => onPanePointerDown(leaf.id, event)}
      >
        <span
          className="pane-drag-handle"
          draggable
          title="拖动到其他窗口交换位置"
          onDragStart={(event) => onPaneDragStart(leaf.id, event)}
          onDragEnd={onPaneDragEnd}
        >
          <GripVertical size={14} strokeWidth={1.5} />
        </span>
        <div className="pane-tabs">
          {leaf.sessionIds.map((sid) => (
            <PaneTab
              key={sid}
              leafId={leaf.id}
              sessionId={sid}
              active={sid === leaf.activeSessionId}
              closing={closingSessionIds.has(sid) || closingPaneIds.has(leaf.id)}
              onCloseTab={onCloseTab}
            />
          ))}
        </div>

        <div className="pane-actions">
          <IconButton
            className="pane-task-button"
            title="任务"
            onClick={(event) => {
              event.stopPropagation();
              openTaskDrawer(leaf.id);
            }}
          >
            <ListTodo {...ICON_DEFAULTS} />
            {taskCount > 0 && <span className="pane-task-badge">{taskCount}</span>}
          </IconButton>
          <div className="pane-name-slot">
            {editing ? (
              <>
                <input
                  autoFocus
                  aria-describedby={nameError ? nameErrorId : undefined}
                  aria-invalid={nameError ? true : undefined}
                  aria-label="窗格名称"
                  className={`pane-name-input${nameError ? " pane-name-input-error" : ""}`}
                  value={draftName}
                  onChange={(event) => {
                    setDraftName(event.target.value);
                    setNameError(null);
                  }}
                  onBlur={saveName}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      saveName();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setNameError(null);
                      setEditing(false);
                    }
                  }}
                />
                {nameError && (
                  <span
                    className="pane-name-error"
                    id={nameErrorId}
                    role="alert"
                  >
                    {nameError}
                  </span>
                )}
              </>
            ) : (
              <button
                className="pane-name"
                title={displayName}
                type="button"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  beginNameEditing();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== "F2") return;
                  event.preventDefault();
                  event.stopPropagation();
                  beginNameEditing();
                }}
              >
                {displayName}
              </button>
            )}
          </div>
          <IconButton
            title={leaf.locked ? "已锁定：点击解锁" : "未锁定：点击锁定"}
            onClick={(e) => { e.stopPropagation(); toggleLock(leaf.id); }}
          >
            {leaf.locked ? <Lock {...ICON_DEFAULTS} /> : <LockOpen {...ICON_DEFAULTS} />}
          </IconButton>
          <IconButton
            title="左右分割"
            onClick={(e) => { e.stopPropagation(); splitPane(leaf.id, "horizontal"); }}
          >
            <Columns2 {...ICON_DEFAULTS} />
          </IconButton>
          <IconButton
            title="上下分割"
            onClick={(e) => { e.stopPropagation(); splitPane(leaf.id, "vertical"); }}
          >
            <Rows2 {...ICON_DEFAULTS} />
          </IconButton>
          <IconButton
            title="关闭此分屏"
            danger
            disabled={closingPaneIds.has(leaf.id)}
            onClick={(e) => {
              e.stopPropagation();
              void onClosePane(leaf);
            }}
          >
            <X {...ICON_DEFAULTS} />
          </IconButton>
        </div>
      </div>

      <div className="pane-body">
        {restoreError && (
          <div className="pane-restore-error" role="alert">
            工作区恢复：{restoreError}
          </div>
        )}
        {nativeConversationId ? (
          <NativeChatPaneHost conversationId={nativeConversationId} />
        ) : leaf.activeSessionId ? (
          <TerminalPane sessionId={leaf.activeSessionId} />
        ) : (
          <div className="pane-empty">
            <span>从菜单打开项目会话，或新建终端会话</span>
            {onCreateTerminal && (
              <button
                type="button"
                className="pane-empty-create"
                onClick={(event) => {
                  event.stopPropagation();
                  onCreateTerminal(wsId ?? undefined);
                }}
              >
                创建终端
              </button>
            )}
          </div>
        )}
      </div>
      {!nativeConversationId && (
        <ComposerBar leafId={leaf.id} sessionId={leaf.activeSessionId} />
      )}
    </div>
  );
}
