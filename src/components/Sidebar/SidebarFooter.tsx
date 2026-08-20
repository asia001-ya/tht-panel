/**
 * SidebarFooter — 侧边栏底部：渐变圆头像 + 设置入口 + 主题切换。
 */
import { useSettingsStore } from "../../store/settingsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { IconButton } from "../ui/IconButton";
import { Sun, Moon, ICON_DEFAULTS } from "../ui/icons";

export function SidebarFooter(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.config?.theme ?? "light");
  const setTheme = useSettingsStore((s) => s.setTheme);
  const mainView = useUiStore((s) => s.mainView);
  const setMainView = useUiStore((s) => s.setMainView);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const initial = workspaces[0]?.name?.[0]?.toUpperCase() ?? "T";

  return (
    <div className="sidebar-footer-v2">
      <div
        className={`sidebar-footer-profile${mainView === "settings" ? " active" : ""}`}
        onClick={() => setMainView("settings")}
      >
        <div className="sidebar-avatar">{initial}</div>
        <div className="sidebar-footer-info">
          <span className="sidebar-footer-label">设置</span>
          <span className="sidebar-footer-version">v0.1.0</span>
        </div>
      </div>
      <IconButton
        title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <Sun {...ICON_DEFAULTS} /> : <Moon {...ICON_DEFAULTS} />}
      </IconButton>
    </div>
  );
}
