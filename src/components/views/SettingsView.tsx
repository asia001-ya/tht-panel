/**
 * SettingsView — 常规设置独立页面。
 * 由原 SettingsDialog 的 GeneralSettings 段落迁移而来（供应商管理已拆到 ProviderView）。
 * 所有改动经 settingsStore.update 走防抖持久化，无需保存按钮。
 */
import { useRef } from "react";
import type { GlobalConfig, WallpaperFit, WallpaperSettings } from "../../api/types";
import { DEFAULT_WALLPAPER, useSettingsStore } from "../../store/settingsStore";

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

interface SettingsFormProps {
  config: GlobalConfig;
  update: (partial: Partial<GlobalConfig>) => void;
  setTheme: (theme: "light" | "dark") => void;
}

/**
 * 渲染外观与终端设置表单。
 * @param props 当前配置及更新函数。
 * @returns 设置表单。
 */
function SettingsForm({ config, update, setTheme }: SettingsFormProps): React.JSX.Element {
  const wallpaper = { ...DEFAULT_WALLPAPER, ...(config.wallpaper ?? {}) };
  const setWallpaper = useSettingsStore((state) => state.setWallpaper);
  const clearWallpaper = useSettingsStore((state) => state.clearWallpaper);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateWallpaper = (partial: Partial<WallpaperSettings>): void => {
    setWallpaper(partial);
  };

  const readWallpaper = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) return;
      updateWallpaper({ enabled: true, kind: "image", file: file.name, dataUrl });
    };
    reader.readAsDataURL(file);
  };

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

      <fieldset className="dialog-group settings-wallpaper-group">
        <legend className="dialog-group-title">主区壁纸</legend>
        <div className="dialog-field dialog-field-inline">
          <label className="dialog-label">
            <input
              type="checkbox"
              checked={wallpaper.enabled}
              onChange={(event) =>
                updateWallpaper({
                  enabled: event.target.checked,
                  kind: event.target.checked ? "image" : "none",
                })
              }
            />
            启用壁纸与面板透明化
          </label>
        </div>
        <input
          ref={fileInputRef}
          className="settings-wallpaper-file"
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) readWallpaper(file);
            event.target.value = "";
          }}
        />
        <div className="settings-wallpaper-preview-row">
          {wallpaper.dataUrl ? (
            <img className="settings-wallpaper-preview" src={wallpaper.dataUrl} alt="当前壁纸预览" />
          ) : (
            <div className="settings-wallpaper-preview settings-wallpaper-empty">未选择图片</div>
          )}
          <div className="settings-wallpaper-actions">
            <button
              type="button"
              className="dialog-btn dialog-btn-ghost"
              onClick={() => fileInputRef.current?.click()}
            >
              选择图片
            </button>
            {(wallpaper.dataUrl || wallpaper.file) && (
              <button type="button" className="dialog-btn dialog-btn-ghost" onClick={clearWallpaper}>
                清除
              </button>
            )}
          </div>
        </div>
        <div className="dialog-field">
          <label className="dialog-label" htmlFor="wallpaper-fit">填充方式</label>
          <select
            id="wallpaper-fit"
            className="dialog-input"
            value={wallpaper.fit}
            onChange={(event) => updateWallpaper({ fit: event.target.value as WallpaperFit })}
          >
            <option value="cover">覆盖</option>
            <option value="contain">适应</option>
            <option value="center">居中</option>
            <option value="tile">平铺</option>
          </select>
        </div>
        <div className="settings-slider-grid">
          <WallpaperSlider label="图片不透明度" value={wallpaper.opacity} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(value) => updateWallpaper({ opacity: value })} />
          <WallpaperSlider label="模糊" value={wallpaper.blur} min={0} max={36} step={1} format={(v) => `${v}px`} onChange={(value) => updateWallpaper({ blur: value })} />
          <WallpaperSlider label="压暗" value={wallpaper.dim} min={0} max={0.8} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(value) => updateWallpaper({ dim: value })} />
          <WallpaperSlider label="终端透明度" value={wallpaper.terminalOpacity} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(value) => updateWallpaper({ terminalOpacity: value })} />
          <WallpaperSlider label="面板玻璃模糊" value={wallpaper.glassBlur} min={0} max={24} step={1} format={(v) => `${v}px`} onChange={(value) => updateWallpaper({ glassBlur: value })} />
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
              onChange={(event) => update({ notifyOnWaiting: event.target.checked })}
            />
            等待输入时发送系统通知
          </label>
        </div>
      </fieldset>
    </>
  );
}

interface WallpaperSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function WallpaperSlider({ label, value, min, max, step, format, onChange }: WallpaperSliderProps): React.JSX.Element {
  return (
    <label className="settings-slider-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{format(value)}</output>
    </label>
  );
}

/**
 * 渲染设置页。
 * @returns 设置页面；配置尚未加载时显示占位。
 */
export function SettingsView(): React.JSX.Element {
  const config = useSettingsStore((s) => s.config);
  const update = useSettingsStore((s) => s.update);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="view-page">
      <header className="view-header">
        <div className="view-title-group">
          <h1 className="view-title">设置</h1>
          <span className="view-subtitle">改动即时生效并自动保存</span>
        </div>
      </header>

      <section className="view-panel">
        {config ? (
          <SettingsForm config={config} update={update} setTheme={setTheme} />
        ) : (
          <div className="view-empty">正在加载配置…</div>
        )}
      </section>
    </div>
  );
}
