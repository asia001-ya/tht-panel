/**
 * 用量数字的派生计算。
 *
 * 存在的理由：Claude 与 Codex 对 inputTokens 的定义不同，直接相加会算错。
 * 这里是该差异的唯一处理点，UI 组件只消费本模块的结果，不自行做算术。
 *
 * - Claude：inputTokens 不含缓存，总量 = input + output + cacheRead + cacheCreation
 * - Codex ：inputTokens 已含 cacheRead，总量 = input + output + cacheCreation
 *           （cacheRead 已计在 input 里，再加一次会重复）
 */
import type { UsageQueryResult, UsageTotals } from "../api/types";

/** 全零用量，用于缺省与空态。 */
export const ZERO_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * 计算 Claude 侧的总 token 数。
 * @param t Claude 用量。
 * @returns 四项之和（input 不含缓存，故全部相加）。
 */
export function claudeTotal(t: UsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;
}

/**
 * 计算 Codex 侧的总 token 数。
 * @param t Codex 用量。
 * @returns input + output + cacheCreation；cacheRead 已含在 input 中故不重复计。
 */
export function codexTotal(t: UsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheCreationTokens;
}

/**
 * 按驱动计算总 token 数。
 * @param t 用量。
 * @param driver 驱动名，codex 与其它（claude）走不同公式。
 * @returns 该驱动语义下的总量。
 */
export function totalFor(t: UsageTotals, driver: string): number {
  return driver === "codex" ? codexTotal(t) : claudeTotal(t);
}

/**
 * 计算缓存命中率。
 *
 * 分母同样受 inputTokens 语义影响：Claude 需把缓存加回去才是完整输入规模，
 * Codex 的 input 本身即完整输入规模。
 * @param t 用量。
 * @param driver 驱动名。
 * @returns 0~1 的命中率；无输入时返回 0。
 */
export function cacheHitRate(t: UsageTotals, driver: string): number {
  const denominator =
    driver === "codex"
      ? t.inputTokens
      : t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
  if (denominator <= 0) return 0;
  return t.cacheReadTokens / denominator;
}

/** 仪表盘 KPI 汇总（已消化两侧语义差异，可直接展示）。 */
export interface UsageSummary {
  /** 总 token（Claude 与 Codex 各按自身公式后相加） */
  totalTokens: number;
  /** 输出 token 合计 */
  outputTokens: number;
  /** 缓存读取合计 */
  cacheReadTokens: number;
  /** 合并命中率 0~1 */
  cacheHitRate: number;
  /** Claude 侧总量 */
  claudeTokens: number;
  /** Codex 侧总量 */
  codexTokens: number;
}

/**
 * 由查询结果计算 KPI 汇总。
 * @param result 后端返回的查询结果；为空时返回全零汇总。
 * @returns 可直接渲染的汇总数字。
 */
export function summarize(result: UsageQueryResult | null): UsageSummary {
  if (!result) {
    return {
      totalTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      claudeTokens: 0,
      codexTokens: 0,
    };
  }

  const { claudeTotals: c, codexTotals: x } = result;
  const claudeTokens = claudeTotal(c);
  const codexTokens = codexTotal(x);

  // 合并命中率：分子分母各自按语义算好后再相加，避免语义混算。
  const hitNumerator = c.cacheReadTokens + x.cacheReadTokens;
  const hitDenominator =
    c.inputTokens + c.cacheReadTokens + c.cacheCreationTokens + x.inputTokens;

  return {
    totalTokens: claudeTokens + codexTokens,
    outputTokens: c.outputTokens + x.outputTokens,
    cacheReadTokens: hitNumerator,
    cacheHitRate: hitDenominator > 0 ? hitNumerator / hitDenominator : 0,
    claudeTokens,
    codexTokens,
  };
}

/**
 * 把 token 数格式化为紧凑可读形式。
 * @param value token 数。
 * @returns 如 1.2K / 34.5M；小于 1000 时原样返回。
 */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

/**
 * 把 0~1 的比率格式化为百分比文本。
 * @param rate 比率。
 * @returns 如 73.4%。
 */
export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
