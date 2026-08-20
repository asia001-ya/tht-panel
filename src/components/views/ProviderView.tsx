/**
 * ProviderView — 供应商管理独立页面。
 * 仅提供页面外壳，表单逻辑复用 settings/ProviderManager（纯 props 组件，与弹框无耦合）。
 */
import { useSettingsStore } from "../../store/settingsStore";
import { ProviderManager } from "../settings/ProviderManager";

/**
 * 渲染供应商管理页。
 * @returns 供应商页面；配置尚未加载时显示占位。
 */
export function ProviderView(): React.JSX.Element {
  const config = useSettingsStore((s) => s.config);
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="view-page">
      <header className="view-header">
        <div className="view-title-group">
          <h1 className="view-title">供应商</h1>
          <span className="view-subtitle">
            管理 Claude / Codex 的连接配置，可在项目与会话级分别指定
          </span>
        </div>
      </header>

      <section className="view-panel">
        {config ? (
          <ProviderManager
            providers={config.providers}
            onChange={(providers) => update({ providers })}
          />
        ) : (
          <div className="view-empty">正在加载配置…</div>
        )}
      </section>
    </div>
  );
}
