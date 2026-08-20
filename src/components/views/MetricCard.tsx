/**
 * MetricCard — 仪表盘 KPI 卡片。
 * 左侧竖条与图标底色由 accentVar 指定的 CSS 变量派生，明暗主题自动跟随。
 */
import type { ReactNode } from "react";

interface MetricCardProps {
  /** 图标节点 */
  icon: ReactNode;
  /** 指标名 */
  label: string;
  /** 展示值（已格式化，如 1.2M） */
  value: string;
  /** 悬停显示的完整值；省略则不显示 title */
  rawValue?: string;
  /** 强调色的 CSS 变量名，如 "--chart-1" */
  accentVar: string;
  /** 0~1 的进度条占比；省略则不渲染进度条 */
  ratio?: number;
}

/**
 * 渲染单个 KPI 卡片。
 * @param props 图标、指标名、数值与强调色配置。
 * @returns KPI 卡片。
 */
export function MetricCard({
  icon,
  label,
  value,
  rawValue,
  accentVar,
  ratio,
}: MetricCardProps): React.JSX.Element {
  const accent = `var(${accentVar})`;
  return (
    <div className="metric-card">
      <div className="metric-card-stripe" style={{ background: accent }} />
      <div
        className="metric-card-icon"
        style={{
          background: `color-mix(in srgb, ${accent} 14%, transparent)`,
          color: accent,
        }}
      >
        {icon}
      </div>
      <div className="metric-card-label">{label}</div>
      <div className="metric-card-value" title={rawValue}>
        {value}
      </div>
      {ratio !== undefined && (
        <div className="metric-card-track">
          <div
            className="metric-card-fill"
            style={{ width: `${Math.min(1, Math.max(0, ratio)) * 100}%`, background: accent }}
          />
        </div>
      )}
    </div>
  );
}
