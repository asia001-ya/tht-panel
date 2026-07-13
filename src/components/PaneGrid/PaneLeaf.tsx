/**
 * PaneLeaf：单个分屏叶子的渲染单元。
 * 标题栏：项目名 + Tab 条（每 Tab 状态点+会话名+关闭） + 操作按钮组。
 * 主体渲染当前激活 Tab 的 TerminalPane（或空占位提示）。
 */
import { useState } from "react";
import type { LeafNode, SessionState } from "../../api/types";
import { useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { TerminalPane } from "../../terminal/TerminalPane";
import { parseNativeConversationTabId } from "../../lib/nativeConversation";
import { NativeChatPaneHost } from "../Conversation/NativeChatPane";
import { IconButton } from "../ui/IconButton";
import {
  Columns2,
  GripVertical,
  Lock,
  LockOpen,
  Rows2,
  X,
  ICON_DEFAULTS,
} from "../ui/icons";

const PANE_DRAG_TYPE = "application/x-tht-pane";

/* ---------- PaneTab 子组件 ---------- */

interface PaneTabProps {
  leafId: string;
  sessionId: string;
  active: boolean;
}

function PaneTab({ leafId, sessionId, active }: PaneTabProps): React.ReactElement {
  const activateTab = useLayoutStore((s) => s.activateTab);
  const setActive = useLayoutStore((s) => s.setActive);
  const closeTab = useLayoutStore((s) => s.closeTab);

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
      onClick={(e) => {
        e.stopPropagation();
        setActive(leafId);
        activateTab(leafId, sessionId);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) { e.stopPropagation(); closeTab(leafId, sessionId); }
      }}
    >
      <span className="pane-status-dot" data-state={state} />
      <span className="pane-tab-label">{label}</span>
      <span
        className="pane-tab-close"
        onClick={(e) => { e.stopPropagation(); closeTab(leafId, sessionId); }}
      >
        ×
      </span>
    </div>
  );
}

/* ---------- PaneLeaf 主组件 ---------- */

interface PaneLeafProps {
  leaf: LeafNode;
}

export function PaneLeaf({ leaf }: PaneLeafProps): React.ReactElement {
  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const setActive = useLayoutStore((s) => s.setActive);
  const toggleLock = useLayoutStore((s) => s.toggleLock);
  const splitPane = useLayoutStore((s) => s.splitPane);
  const closePane = useLayoutStore((s) => s.closePane);
  const swapPaneContents = useLayoutStore((s) => s.swapPaneContents);
  const [dropTarget, setDropTarget] = useState(false);

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
    wsId ? (s.workspaces.find((w) => w.id === wsId)?.name ?? "") : "",
  );

  const isActive = activePaneId === leaf.id;

  return (
    <div
      className={`pane-leaf${isActive ? " pane-active" : ""}${dropTarget ? " pane-drop-target" : ""}`}
      onClick={() => setActive(leaf.id)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
        event.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropTarget(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropTarget(false);
        const sourceLeafId = event.dataTransfer.getData(PANE_DRAG_TYPE);
        if (sourceLeafId) swapPaneContents(sourceLeafId, leaf.id);
      }}
    >
      <div className="pane-titlebar">
        <span
          className="pane-drag-handle"
          draggable
          title="拖动到其他窗口交换位置"
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(PANE_DRAG_TYPE, leaf.id);
          }}
        >
          <GripVertical size={14} strokeWidth={1.5} />
        </span>
        <span className="pane-ws-name" title={wsName || "空"}>
          {wsName || "空"}
        </span>

        <div className="pane-tabs">
          {leaf.sessionIds.map((sid) => (
            <PaneTab
              key={sid}
              leafId={leaf.id}
              sessionId={sid}
              active={sid === leaf.activeSessionId}
            />
          ))}
        </div>

        <div className="pane-actions">
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
            onClick={(e) => { e.stopPropagation(); closePane(leaf.id); }}
          >
            <X {...ICON_DEFAULTS} />
          </IconButton>
        </div>
      </div>

      <div className="pane-body">
        {nativeConversationId ? (
          <NativeChatPaneHost conversationId={nativeConversationId} />
        ) : leaf.activeSessionId ? (
          <TerminalPane sessionId={leaf.activeSessionId} />
        ) : (
          <div className="pane-empty">
            从菜单打开项目会话，或新建终端会话
          </div>
        )}
      </div>
    </div>
  );
}
