import type { GlobalConfig } from "../../api/types";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { ProviderManager } from "../settings/ProviderManager";

function SettingsForm({ config }: { config: GlobalConfig }): React.JSX.Element {
  const closeSettings = useUiStore((state) => state.closeSettings);
  const update = useSettingsStore((state) => state.update);
  const setTheme = useSettingsStore((state) => state.setTheme);

  const updateNumber = (raw: string, apply: (value: number) => void): void => {
    const value = Number.parseInt(raw, 10);
    if (!Number.isNaN(value)) apply(value);
  };

  return (
    <div className="dialog-overlay" onClick={closeSettings}>
      <div
        className="dialog dialog-settings"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">设置</h2>
        </div>

        <div className="dialog-body">
          <fieldset className="dialog-group">
            <legend className="dialog-group-title">模型供应商</legend>
            <ProviderManager
              providers={config.providers}
              onChange={(providers) => update({ providers })}
            />
          </fieldset>

          <fieldset className="dialog-group">
            <legend className="dialog-group-title">外观</legend>
            <div className="dialog-field">
              <label className="dialog-label">主题</label>
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
              <label className="dialog-label">Shell 路径</label>
              <input
                className="dialog-input"
                value={config.shellPath}
                placeholder="pwsh.exe"
                onChange={(event) => update({ shellPath: event.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">字号</label>
              <input
                className="dialog-input"
                type="number"
                value={config.fontSize}
                onChange={(event) =>
                  updateNumber(event.target.value, (fontSize) => update({ fontSize }))
                }
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">终端回滚行数</label>
              <input
                className="dialog-input"
                type="number"
                value={config.scrollbackLines}
                onChange={(event) =>
                  updateNumber(event.target.value, (scrollbackLines) =>
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

export default function SettingsDialog(): React.JSX.Element | null {
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const config = useSettingsStore((state) => state.config);
  if (!settingsOpen || !config) return null;
  return <SettingsForm config={config} />;
}
