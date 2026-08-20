import { describe, expect, it } from "vitest";
import type { UsageQueryResult, UsageTotals } from "../api/types";
import {
  cacheHitRate,
  claudeTotal,
  codexTotal,
  formatPercent,
  formatTokens,
  summarize,
  totalFor,
} from "./usage";

/**
 * 构造一组用量。
 * @param partial 需要覆盖的字段。
 * @returns 补齐零值的完整用量。
 */
function totals(partial: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...partial,
  };
}

describe("用量总量计算", () => {
  it("Claude 的 inputTokens 不含缓存，四项全部相加", () => {
    const t = totals({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 500,
      cacheCreationTokens: 80,
    });
    expect(claudeTotal(t)).toBe(700);
  });

  it("Codex 的 inputTokens 已含 cacheRead，不得重复相加", () => {
    const t = totals({
      inputTokens: 600, // 其中 500 是 cacheRead
      outputTokens: 20,
      cacheReadTokens: 500,
      cacheCreationTokens: 80,
    });
    // 若误用 Claude 公式会得 1200，多算了一次 cacheRead。
    expect(codexTotal(t)).toBe(700);
  });

  it("totalFor 按 driver 分派到对应公式", () => {
    const t = totals({ inputTokens: 100, cacheReadTokens: 50 });
    expect(totalFor(t, "claude")).toBe(150);
    expect(totalFor(t, "codex")).toBe(100);
  });
});

describe("缓存命中率", () => {
  it("Claude 的分母需把缓存加回去才是完整输入规模", () => {
    const t = totals({
      inputTokens: 100,
      cacheReadTokens: 300,
      cacheCreationTokens: 100,
    });
    // 300 / (100 + 300 + 100) = 0.6
    expect(cacheHitRate(t, "claude")).toBeCloseTo(0.6);
  });

  it("Codex 的 inputTokens 本身即完整输入规模", () => {
    const t = totals({ inputTokens: 500, cacheReadTokens: 300 });
    // 300 / 500 = 0.6
    expect(cacheHitRate(t, "codex")).toBeCloseTo(0.6);
  });

  it("无输入时返回 0 而非 NaN", () => {
    expect(cacheHitRate(totals({}), "claude")).toBe(0);
    expect(cacheHitRate(totals({}), "codex")).toBe(0);
  });
});

describe("KPI 汇总", () => {
  it("两侧各按自身语义算完再相加", () => {
    const result: UsageQueryResult = {
      series: [],
      claudeTotals: totals({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 300,
        cacheCreationTokens: 90,
      }), // Claude 总量 500
      codexTotals: totals({
        inputTokens: 400, // 含 200 cacheRead
        outputTokens: 20,
        cacheReadTokens: 200,
        cacheCreationTokens: 80,
      }), // Codex 总量 500
      byModel: [],
      lastScannedAt: "",
    };

    const summary = summarize(result);
    expect(summary.claudeTokens).toBe(500);
    expect(summary.codexTokens).toBe(500);
    expect(summary.totalTokens).toBe(1000);
    expect(summary.outputTokens).toBe(30);
    expect(summary.cacheReadTokens).toBe(500);
    // 分母 = (100+300+90) + 400 = 890，分子 500
    expect(summary.cacheHitRate).toBeCloseTo(500 / 890);
  });

  it("无数据时返回全零汇总而非抛错", () => {
    const summary = summarize(null);
    expect(summary.totalTokens).toBe(0);
    expect(summary.cacheHitRate).toBe(0);
  });
});

describe("数字格式化", () => {
  it("按量级切换单位", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2_400_000)).toBe("2.4M");
    expect(formatTokens(3_100_000_000)).toBe("3.10B");
  });

  it("比率转百分比文本", () => {
    expect(formatPercent(0.734)).toBe("73.4%");
    expect(formatPercent(0)).toBe("0.0%");
  });
});
