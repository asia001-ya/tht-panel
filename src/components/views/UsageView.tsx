/**
 * UsageView — Token 用量仪表盘。
 * 顶部工具栏（项目过滤 / 时间窗口 / 刷新）+ KPI 卡片行 + 每日趋势折线图 + 分模型列表。
 *
 * 数字全部来自 lib/usage.ts 的派生函数，本组件不自行做 token 算术
 * （Claude 与 Codex 的 inputTokens 语义不同，混算会出错）。
 */
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useUsageStore, RANGE_OPTIONS } from "../../store/usageStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import {
  claudeTotal,
  codexTotal,
  formatPercent,
  formatTokens,
  summarize,
  totalFor,
} from "../../lib/usage";
import { MetricCard } from "./MetricCard";
import { ICON_DEFAULTS, ChartLine, Database, RotateCw, Send, Sparkles } from "../ui/icons";

/** 图表中两条曲线的 dataKey。 */
const SERIES = [
  { key: "claude", name: "Claude", color: "var(--chart-1)" },
  { key: "codex", name: "Codex", color: "var(--chart-2)" },
] as const;

/**
 * 渲染 Token 用量仪表盘。
 * @returns 仪表盘页面。
 */
export function UsageView(): React.JSX.Element {
  const data = useUsageStore((s) => s.data);
  const loading = useUsageStore((s) => s.loading);
  const refreshing = useUsageStore((s) => s.refreshing);
  const error = useUsageStore((s) => s.error);
  const rangeDays = useUsageStore((s) => s.rangeDays);
  const workspaceId = useUsageStore((s) => s.workspaceId);
  const load = useUsageStore((s) => s.load);
  const refresh = useUsageStore((s) => s.refresh);
  const setRange = useUsageStore((s) => s.setRange);
  const setWorkspace = useUsageStore((s) => s.setWorkspace);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  // 图例点击隐藏的曲线。
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  // 首次进入若无数据则先读缓存；缓存为空（从未扫描）时自动触发一次扫描。
  useEffect(() => {
    if (data === null && !loading) {
      void load().then(() => {
        const current = useUsageStore.getState().data;
        if (current && current.lastScannedAt === "") void refresh();
      });
    }
  }, [data, loading, load, refresh]);

  const summary = useMemo(() => summarize(data), [data]);

  // 折线图数据：每天一个点，两条曲线各按自身语义算总量。
  const chartData = useMemo(
    () =>
      (data?.series ?? []).map((point) => ({
        date: point.date.slice(5), // 只显示 MM-DD，避免 X 轴拥挤
        claude: claudeTotal(point.claude),
        codex: codexTotal(point.codex),
      })),
    [data],
  );

  const hasData = summary.totalTokens > 0;

  return (
    <div className="view-page">
      <header className="view-header">
        <div className="view-title-group">
          <h1 className="view-title">Token 用量</h1>
          <span className="view-subtitle">
            {data?.lastScannedAt
              ? `上次扫描 ${new Date(data.lastScannedAt).toLocaleString()}`
              : "尚未扫描"}
          </span>
        </div>

        <div className="view-toolbar">
          <select
            className="view-select"
            value={workspaceId ?? ""}
            aria-label="按项目过滤"
            onChange={(event) => void setWorkspace(event.target.value || undefined)}
          >
            <option value="">全部项目</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>

          <div className="view-segmented">
            {RANGE_OPTIONS.map((days) => (
              <button
                key={days}
                type="button"
                className={`view-segmented-item${days === rangeDays ? " active" : ""}`}
                aria-pressed={days === rangeDays}
                onClick={() => void setRange(days)}
              >
                {days}天
              </button>
            ))}
          </div>

          <button
            type="button"
            className="view-icon-btn"
            title="重新扫描会话文件"
            aria-label="重新扫描"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RotateCw
              size={16}
              strokeWidth={1.5}
              className={refreshing ? "spinning" : undefined}
            />
          </button>
        </div>
      </header>

      {error && <div className="view-error">读取用量失败：{error}</div>}

      <div className="metric-grid">
        <MetricCard
          icon={<Sparkles {...ICON_DEFAULTS} />}
          label="总 Token"
          value={formatTokens(summary.totalTokens)}
          rawValue={summary.totalTokens.toLocaleString()}
          accentVar="--chart-1"
        />
        <MetricCard
          icon={<Send {...ICON_DEFAULTS} />}
          label="输出 Token"
          value={formatTokens(summary.outputTokens)}
          rawValue={summary.outputTokens.toLocaleString()}
          accentVar="--chart-2"
        />
        <MetricCard
          icon={<Database {...ICON_DEFAULTS} />}
          label="缓存命中率"
          value={formatPercent(summary.cacheHitRate)}
          rawValue={`缓存读取 ${summary.cacheReadTokens.toLocaleString()}`}
          accentVar="--chart-3"
          ratio={summary.cacheHitRate}
        />
      </div>

      <section className="view-panel">
        <div className="view-panel-title">每日趋势</div>
        {hasData ? (
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "var(--fg-faint)", fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                />
                <YAxis
                  tick={{ fill: "var(--fg-faint)", fontSize: 11 }}
                  tickFormatter={formatTokens}
                  width={56}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(value, name) => [formatTokens(Number(value) || 0), String(name)]}
                  contentStyle={{
                    background: "var(--panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--fg)",
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
                  onClick={(payload) => {
                    const key = String(payload.dataKey ?? "");
                    setHidden((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  }}
                />
                {SERIES.map((series) => (
                  <Line
                    key={series.key}
                    type="monotone"
                    dataKey={series.key}
                    name={series.name}
                    stroke={series.color}
                    strokeWidth={2}
                    dot={false}
                    hide={hidden.has(series.key)}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="view-empty">
            {loading || refreshing
              ? "正在读取会话记录…"
              : "暂无用量数据。点击右上角刷新以扫描 Claude / Codex 会话记录。"}
          </div>
        )}
      </section>

      <section className="view-panel">
        <div className="view-panel-title">分模型用量</div>
        {data && data.byModel.length > 0 ? (
          <div className="model-list">
            {data.byModel.map((item) => {
              const total = totalFor(item.totals, item.driver);
              const share = summary.totalTokens > 0 ? total / summary.totalTokens : 0;
              return (
                <div className="model-row" key={`${item.driver}:${item.model}`}>
                  <span className={`model-driver model-driver-${item.driver}`}>
                    {item.driver === "codex" ? "Codex" : "Claude"}
                  </span>
                  <span className="model-name" title={item.model}>
                    {item.model}
                  </span>
                  <span className="model-share">
                    <span
                      className="model-share-fill"
                      style={{
                        width: `${share * 100}%`,
                        background:
                          item.driver === "codex" ? "var(--chart-2)" : "var(--chart-1)",
                      }}
                    />
                  </span>
                  <span className="model-total" title={total.toLocaleString()}>
                    {formatTokens(total)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="view-empty view-empty-compact">
            <ChartLine size={14} strokeWidth={1.5} />
            暂无分模型数据
          </div>
        )}
      </section>
    </div>
  );
}
