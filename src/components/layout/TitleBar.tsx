import { getCurrentWindow } from "@tauri-apps/api/window";
import { preorderLeaves, useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { selectProviders, useSettingsStore } from "../../store/settingsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { resolveActiveTabContext } from "../../lib/workItems";
import { Command, Maximize2, Minus, PanelTop, X, ICON_DEFAULTS } from "../ui/icons";

function runWindowAction(action: "minimize" | "maximize" | "close"): void {
  const appWindow = getCurrentWindow();
  const pending = action === "minimize"
    ? appWindow.minimize()
    : action === "maximize"
      ? appWindow.toggleMaximize()
      : appWindow.close();
  void pending.catch(() => {
    // 浏览器预览没有 Tauri 窗口对象，控件保持无副作用。
  });
}

function startWindowDrag(event: React.PointerEvent<HTMLElement>): void {
  if (!event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  void getCurrentWindow().startDragging().catch(() => {
    // 浏览器预览不提供原生窗口拖动。
  });
}

/** 顶部应用栏：提供稳定的产品标识与当前工作区上下文。 */
export function TitleBar(): React.JSX.Element {
  const tree = useLayoutStore((state) => state.tree);
  const activePaneId = useLayoutStore((state) => state.activePaneId);
  const sessionMap = useSessionStore((state) => state.sessions);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const historyCache = useWorkspaceStore((state) => state.historyCache);
  const providers = useSettingsStore(selectProviders);
  const activeTabId = activePaneId
    ? preorderLeaves(tree).find((leaf) => leaf.id === activePaneId)?.activeSessionId ?? null
    : null;
  const context = resolveActiveTabContext(
    activeTabId,
    sessionMap,
    historyCache,
    workspaces,
    providers,
  );

  return (
    <header className="app-titlebar" onPointerDown={startWindowDrag}>
      <div className="app-titlebar-brand">
        <span className="app-titlebar-mark" aria-hidden="true">
          <Command {...ICON_DEFAULTS} />
        </span>
        <span className="app-titlebar-name">tht-panel</span>
        <span className="app-titlebar-divider" aria-hidden="true" />
        <span className="app-titlebar-context">
          {context.workspace?.name ?? "工作台"}
        </span>
      </div>
      <div className="app-titlebar-session">
        <PanelTop {...ICON_DEFAULTS} />
        <span>{context.title}</span>
        {context.state && <span className="pane-status-dot" data-state={context.state} />}
      </div>
      <div className="app-titlebar-spacer" />
      <div
        className="app-window-controls"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" aria-label="最小化" title="最小化" onClick={() => runWindowAction("minimize")}>
          <Minus {...ICON_DEFAULTS} />
        </button>
        <button type="button" aria-label="最大化或还原" title="最大化或还原" onClick={() => runWindowAction("maximize")}>
          <Maximize2 {...ICON_DEFAULTS} />
        </button>
        <button type="button" className="app-window-close" aria-label="关闭" title="关闭" onClick={() => runWindowAction("close")}>
          <X {...ICON_DEFAULTS} />
        </button>
      </div>
    </header>
  );
}
