import { preorderLeaves, useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { selectProviders, useSettingsStore } from "../../store/settingsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { resolveActiveTabContext } from "../../lib/workItems";
import { Activity, FolderKanban, Image, Server, ICON_DEFAULTS } from "../ui/icons";

/** 底部状态栏：显示运行会话、当前项目、供应商和壁纸状态。 */
export function StatusBar(): React.JSX.Element {
  // 订阅稳定的 sessions 对象；直接在 selector 中 Object.values 会每次生成新数组，
  // React 19 会把它判定为快照变化并触发无限重渲染。
  const sessionMap = useSessionStore((state) => state.sessions);
  const sessions = Object.values(sessionMap);
  const activePaneId = useLayoutStore((state) => state.activePaneId);
  const tree = useLayoutStore((state) => state.tree);
  const config = useSettingsStore((state) => state.config);
  const providers = useSettingsStore(selectProviders);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const historyCache = useWorkspaceStore((state) => state.historyCache);
  const activeSessionId = activePaneId
    ? preorderLeaves(tree).find((leaf) => leaf.id === activePaneId)?.activeSessionId ?? null
    : null;
  const context = resolveActiveTabContext(
    activeSessionId,
    sessionMap,
    historyCache,
    workspaces,
    providers,
  );
  const wallpaperOn = Boolean(config?.wallpaper?.enabled && (config.wallpaper.dataUrl || config.wallpaper.file));
  const running = sessions.filter((item) => item.state !== "dead").length;

  return (
    <footer className="app-statusbar">
      <span className="app-statusbar-item"><Activity {...ICON_DEFAULTS} />{running} 个会话</span>
      <span className="app-statusbar-separator" />
      <span className="app-statusbar-item"><FolderKanban {...ICON_DEFAULTS} />{context.workspace?.name ?? "未绑定工作空间"}</span>
      <span className="app-statusbar-item"><Server {...ICON_DEFAULTS} />{context.provider?.name ?? (context.kind === "shell" ? "本地 Shell" : "系统配置")}</span>
      <span className="app-statusbar-spacer" />
      <span className="app-statusbar-item"><Image {...ICON_DEFAULTS} />{wallpaperOn ? "壁纸已启用" : "纯色背景"}</span>
      <span className="app-statusbar-item app-statusbar-dim">{config?.theme === "dark" ? "深色" : "浅色"}</span>
    </footer>
  );
}
