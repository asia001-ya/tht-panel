/**
 * PaneLeaf：单个分屏叶子的渲染单元。
 * 顶部迷你标题栏（会话标题 + 状态点 + 锁定/左右分割/上下分割/关闭按钮），
 * 主体渲染 TerminalPane（或空占位提示）。
 * 整块点击置为活动 leaf；活动时加 pane-active 高亮边框（用 --accent）。
 * 参考实施计划 9.1（分屏渲染）/ 9.2（xterm 生命周期）。
 */
import type { LeafNode, SessionState } from "../../api/types";
import { useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { TerminalPane } from "../../terminal/TerminalPane";

/** PaneLeaf 组件属性 */
interface PaneLeafProps {
  leaf: LeafNode; // 当前叶子节点（含 id / sessionId / locked）
}

/**
 * 单个分屏叶子。
 * @param props.leaf 叶子节点数据
 * @returns 叶子分屏的 React 元素
 */
export function PaneLeaf({ leaf }: PaneLeafProps): React.ReactElement {
  // 分屏动作与活动态：逐字段订阅，避免整表变更导致的无谓重渲染
  const activePaneId = useLayoutStore((s) => s.activePaneId);
  const setActive = useLayoutStore((s) => s.setActive);
  const toggleLock = useLayoutStore((s) => s.toggleLock);
  const splitPane = useLayoutStore((s) => s.splitPane);
  const closePane = useLayoutStore((s) => s.closePane);

  // 会话标题与状态：仅在本 leaf 绑定了会话时读取
  const title = useSessionStore((s) =>
    leaf.sessionId ? s.sessions[leaf.sessionId]?.title : undefined,
  );
  const state: SessionState | undefined = useSessionStore((s) =>
    leaf.sessionId ? s.sessions[leaf.sessionId]?.state : undefined,
  );

  const isActive = activePaneId === leaf.id;

  return (
    <div
      className={`pane-leaf${isActive ? " pane-active" : ""}`}
      // 点击叶子任意处即置为活动 leaf（落点判定用）
      onClick={() => setActive(leaf.id)}
    >
      <div className="pane-titlebar">
        {/* 状态点：无会话不显示；有会话按 state 上色（data-state 驱动 CSS） */}
        {leaf.sessionId && (
          <span className="pane-status-dot" data-state={state ?? "idle"} />
        )}
        {/* 会话标题：无会话显示“空” */}
        <span className="pane-title" title={title ?? "空"}>
          {title ?? "空"}
        </span>

        <div className="pane-actions">
          <button
            type="button"
            className="pane-btn"
            title={leaf.locked ? "已锁定：点击解锁" : "未锁定：点击锁定"}
            onClick={(e) => {
              e.stopPropagation();
              toggleLock(leaf.id);
            }}
          >
            {leaf.locked ? "🔒" : "🔓"}
          </button>
          <button
            type="button"
            className="pane-btn"
            title="左右分割"
            onClick={(e) => {
              e.stopPropagation();
              splitPane(leaf.id, "horizontal");
            }}
          >
            ▥
          </button>
          <button
            type="button"
            className="pane-btn"
            title="上下分割"
            onClick={(e) => {
              e.stopPropagation();
              splitPane(leaf.id, "vertical");
            }}
          >
            ▤
          </button>
          <button
            type="button"
            className="pane-btn pane-btn-close"
            title="关闭此分屏"
            onClick={(e) => {
              e.stopPropagation();
              closePane(leaf.id);
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="pane-body">
        {leaf.sessionId ? (
          // 已绑定会话：常驻复用的 xterm 显示器（换会话 = detach+attach，不销毁实例）
          <TerminalPane sessionId={leaf.sessionId} />
        ) : (
          // 空占位：引导用户从侧边栏/历史发起会话或开纯 PowerShell
          <div className="pane-empty">
            点击工作空间/历史会话，或新开 PowerShell
          </div>
        )}
      </div>
    </div>
  );
}
