import type { GlobalConfig } from "../../api/types";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { ICON_DEFAULTS, Server, Settings } from "../ui/icons";
import { ProviderManager } from "../settings/ProviderManager";

interface GeneralSettingsProps {
  config: GlobalConfig;
  update: (partial: Partial<GlobalConfig>) => void;
  setTheme: (theme: "light" | "dark") => void;
}

/**
 * 把可解析的整数交给设置更新函数。
 * @param raw 输入框中的原始文本。
 * @param apply 接收有效整数的更新函数。
 * @returns 无返回值。
 */
function applyInteger(raw: string, apply: (value: number) => void): void {
  const value = Number.parseInt(raw, 10);
  if (!Number.isNaN(value)) apply(value);
}

/**
 * 渲染外观和终端常规设置。
 * @param props 当前配置及更新函数。
 * @returns 常规设置表单。
 */
function GeneralSettings({
  config,
  update,
  setTheme,
}: GeneralSettingsProps): React.JSX.Element {
  return (
    <>
      <fieldset className="dialog-group">
        <legend className="dialog-group-title">外观</legend>
        <div className="dialog-field">
          <span className="dialog-label">主题</span>
          <div className="dialog-radio-group">
            <label className="dialog-radio">
              <input
                type="radio"
                name="theme"
                checked={config.theme === "light"}
                onChange={() => setTheme("light")}
              />
              浅色
            </label>
            <label className="dialog-radio">
              <input
                type="radio"
                name="theme"
                checked={config.theme === "dark"}
                onChange={() => setTheme("dark")}
              />
              深色
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset className="dialog-group">
        <legend className="dialog-group-title">终端</legend>
        <div className="dialog-field">
          <label className="dialog-label" htmlFor="settings-shell-path">
            Shell 路径
          </label>
          <input
            id="settings-shell-path"
            className="dialog-input"
            value={config.shellPath}
            placeholder="powershell.exe"
            onChange={(event) => update({ shellPath: event.target.value })}
          />
        </div>
        <div className="dialog-field">
          <label className="dialog-label" htmlFor="settings-font-size">
            字号
          </label>
          <input
            id="settings-font-size"
            className="dialog-input"
            type="number"
            value={config.fontSize}
            onChange={(event) =>
              applyInteger(event.target.value, (fontSize) => update({ fontSize }))
            }
          />
        </div>
        <div className="dialog-field">
          <label className="dialog-label" htmlFor="settings-scrollback-lines">
            终端回滚行数
          </label>
          <input
            id="settings-scrollback-lines"
            className="dialog-input"
            type="number"
            value={config.scrollbackLines}
            onChange={(event) =>
              applyInteger(event.target.value, (scrollbackLines) =>
                update({ scrollbackLines }),
              )
            }
          />
        </div>
        <div className="dialog-field dialog-field-inline">
          <label className="dialog-label">
            <input
              type="checkbox"
              checked={config.notifyOnWaiting}
              onChange={(event) =>
                update({ notifyOnWaiting: event.target.checked })
              }
            />
            等待输入时发送系统通知
          </label>
        </div>
      </fieldset>
    </>
  );
}

/**
 * 渲染带左侧分类菜单的设置表单。
 * @param props 已加载的全局配置。
 * @returns 完整设置对话框内容。
 */
function SettingsForm({ config }: { config: GlobalConfig }): React.JSX.Element {
  const closeSettings = useUiStore((state) => state.closeSettings);
  const settingsSection = useUiStore((state) => state.settingsSection);
  const setSettingsSection = useUiStore((state) => state.setSettingsSection);
  const update = useSettingsStore((state) => state.update);
  const setTheme = useSettingsStore((state) => state.setTheme);

  return (
    <div className="dialog-overlay" onClick={closeSettings}>
      <div
        className="dialog dialog-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 id="settings-dialog-title" className="dialog-title">
            设置
          </h2>
        </div>

        <div className="settings-shell">
          <nav className="settings-nav" aria-label="设置分类">
            <button
              type="button"
              className={`settings-nav-item${settingsSection === "general" ? " active" : ""}`}
              aria-pressed={settingsSection === "general"}
              onClick={() => setSettingsSection("general")}
            >
              <Settings {...ICON_DEFAULTS} />
              <span>常规</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${settingsSection === "providers" ? " active" : ""}`}
              aria-pressed={settingsSection === "providers"}
              onClick={() => setSettingsSection("providers")}
            >
              <Server {...ICON_DEFAULTS} />
              <span>供应商管理</span>
            </button>
          </nav>

          <div className="settings-content">
            {settingsSection === "general" ? (
              <GeneralSettings config={config} update={update} setTheme={setTheme} />
            ) : (
              <ProviderManager
                providers={config.providers}
                onChange={(providers) => update({ providers })}
              />
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            className="dialog-btn dialog-btn-primary"
            onClick={closeSettings}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 按 UI store 状态挂载全局设置对话框。
 * @returns 设置未打开或配置未加载时返回 null，否则返回设置表单。
 */
export default function SettingsDialog(): React.JSX.Element | null {
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const config = useSettingsStore((state) => state.config);
  if (!settingsOpen || !config) return null;
  return <SettingsForm config={config} />;
}
