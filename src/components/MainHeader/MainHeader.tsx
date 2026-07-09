/**
 * MainHeader — 主区域顶部标题栏（44px）。
 * 左侧：活动会话标题 + 状态点；右侧：分屏操作图标按钮组。
 */
import { useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { IconButton } from "../ui/IconButton";
import { Lock, LockOpen, Columns2, Rows2, X, ICON_DEFAULTS } from "../ui/icons";
import type { PaneNode, LeafNode } from "../../api/types";

function findLeafById(node: PaneNode, id: string): LeafNode | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id);
}

export function MainHeader(): React.JSX.Element {
  const tree = useLayoutStore((s) => s.tree);
  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const toggleLock = useLayoutStore((s) => s.toggleLock);
  const splitPane = useLayoutStore((s) => s.splitPane);
  const closePane = useLayoutStore((s) => s.closePane);

  const leaf = tree && activePaneId ? findLeafById(tree, activePaneId) : null;
  const isSolo = tree?.type === "leaf";

  const session = useSessionStore((s) =>
    leaf?.activeSessionId ? s.sessions[leaf.activeSessionId] : undefined,
  );
  const wsName = useWorkspaceStore((s) => {
    if (!session?.workspaceId) return "";
    return s.workspaces.find((w) => w.id === session.workspaceId)?.name ?? "";
  });

  const title = session?.title ?? "tht-panel";
  const state = session?.state;

  return (
    <header className="main-header">
      <div className="main-header-left">
        {wsName && <span className="main-header-ws">{wsName}</span>}
        {wsName && <span className="main-header-sep">/</span>}
        {state && <span className="pane-status-dot" data-state={state} />}
        <span className="main-header-title">{title}</span>
      </div>
      <div className="main-header-right">
        {leaf && (
          <>
            <IconButton
              title={leaf.locked ? "解锁分屏" : "锁定分屏"}
              onClick={() => toggleLock(leaf.id)}
            >
              {leaf.locked ? <Lock {...ICON_DEFAULTS} /> : <LockOpen {...ICON_DEFAULTS} />}
            </IconButton>
            <IconButton
              title="左右分割"
              onClick={() => splitPane(leaf.id, "horizontal")}
            >
              <Columns2 {...ICON_DEFAULTS} />
            </IconButton>
            <IconButton
              title="上下分割"
              onClick={() => splitPane(leaf.id, "vertical")}
            >
              <Rows2 {...ICON_DEFAULTS} />
            </IconButton>
            <IconButton
              title="关闭分屏"
              danger
              disabled={isSolo}
              onClick={() => closePane(leaf.id)}
            >
              <X {...ICON_DEFAULTS} />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}
