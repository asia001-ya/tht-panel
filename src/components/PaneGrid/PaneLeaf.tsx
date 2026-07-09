/**
 * PaneLeaf：单个分屏叶子的渲染单元。
 * 标题栏：项目名 + Tab 条（每 Tab 状态点+会话名+关闭） + 操作按钮组。
 * 主体渲染当前激活 Tab 的 TerminalPane（或空占位提示）。
 */
import type { LeafNode, SessionState } from "../../api/types";
import { useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { TerminalPane } from "../../terminal/TerminalPane";
import { IconButton } from "../ui/IconButton";
import { Lock, LockOpen, Columns2, Rows2, X, ICON_DEFAULTS } from "../ui/icons";

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

  const managedName = useWorkspaceStore((s) => {
    for (const list of Object.values(s.historyCache))
      for (const m of list) if (m.ptySessionId === sessionId) return m.name;
    return undefined;
  });
  const title = useSessionStore((s) => s.sessions[sessionId]?.title);
  const state: SessionState = useSessionStore((s) => s.sessions[sessionId]?.state ?? "dead");

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

  const wsId = useSessionStore((s) =>
    leaf.activeSessionId ? s.sessions[leaf.activeSessionId]?.workspaceId : null,
  );
  const wsName = useWorkspaceStore((s) =>
    wsId ? (s.workspaces.find((w) => w.id === wsId)?.name ?? "") : "",
  );

  const isActive = activePaneId === leaf.id;

  return (
    <div
      className={`pane-leaf${isActive ? " pane-active" : ""}`}
      onClick={() => setActive(leaf.id)}
    >
      <div className="pane-titlebar">
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
        {leaf.activeSessionId ? (
          <TerminalPane sessionId={leaf.activeSessionId} />
        ) : (
          <div className="pane-empty">
            点击工作空间/历史会话，或新开 PowerShell
          </div>
        )}
      </div>
    </div>
  );
}
