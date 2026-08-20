//! Token 用量统计数据模型。
//!
//! 字段名与前端 `src/api/types.ts` 严格 camelCase 对应，修改任一侧务必同步另一侧。
//!
//! 关键语义（已实测确认，勿凭直觉修改）：
//! - Claude 的 `input_tokens` **不含**缓存部分，缓存另计在 cache_read / cache_creation；
//! - Codex 的 `input_tokens` **已含** cached_input_tokens（cached 是它的子集）。
//!   因此「总量」与「缓存命中率」两处计算必须按 driver 分支，见 `UsageTotals::total`。

use serde::{Deserialize, Serialize};

/// 一组 token 用量累计值。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageTotals {
    /// 输入 token。Claude：不含缓存；Codex：已含 cache_read。
    pub input_tokens: u64,
    /// 输出 token（Codex 侧已并入 reasoning_output_tokens）。
    pub output_tokens: u64,
    /// 缓存读取命中的 token。
    pub cache_read_tokens: u64,
    /// 写入缓存产生的 token。
    pub cache_creation_tokens: u64,
}

impl UsageTotals {
    /// 就地累加另一组用量。
    /// 参数：`other`——待累加的用量；返回：无。
    pub fn add(&mut self, other: &UsageTotals) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
    }

    /// 是否全为零（用于跳过空数据的序列点）。
    /// 参数：无；返回：四项均为 0 则 true。
    pub fn is_zero(&self) -> bool {
        *self == UsageTotals::default()
    }
}

/// 按天聚合的用量点，claude / codex 分列。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageDayPoint {
    /// 日期，格式 YYYY-MM-DD（本地时区）。
    pub date: String,
    /// 该日 Claude 用量。
    pub claude: UsageTotals,
    /// 该日 Codex 用量。
    pub codex: UsageTotals,
}

/// 按模型聚合的用量。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelUsage {
    /// 模型名，如 claude-opus-5 / gpt-5.6-sol。
    pub model: String,
    /// 该模型的驱动来源：claude 或 codex。
    pub driver: String,
    /// 该模型累计用量。
    pub totals: UsageTotals,
}

/// usage_query / usage_refresh 的返回结构。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageQueryResult {
    /// 按日期升序排列的时间序列。
    pub series: Vec<UsageDayPoint>,
    /// Claude 汇总。
    pub claude_totals: UsageTotals,
    /// Codex 汇总。
    pub codex_totals: UsageTotals,
    /// 按模型汇总，用量降序。
    pub by_model: Vec<ModelUsage>,
    /// 上次扫描完成时间（RFC3339）；从未扫描时为空串。
    pub last_scanned_at: String,
}
