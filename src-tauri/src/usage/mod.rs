//! Token 用量扫描与聚合。
//!
//! 数据来源（均为本机实测确认的结构，勿凭直觉改）：
//! - Claude：`~/.claude/projects/<slug>/*.jsonl`（含 `subagents/` 子目录，子 agent 同样烧 token）。
//!   用量在 `message.usage`，字段 `input_tokens` / `output_tokens` /
//!   `cache_read_input_tokens` / `cache_creation_input_tokens`。
//!   **同一次 API 调用会写多行**，共享同一 `message.id`，必须按该 id 去重，否则统计翻数倍。
//! - Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。
//!   用量在 `type=event_msg` 且 `payload.type=token_count` 的 `payload.info` 里，含两个对象：
//!   `total_token_usage`（会话累计快照，**累加它会得出天文数字**）与
//!   `last_token_usage`（本次调用增量，可累加）。只取后者，因其本身是增量故无需去重。
//!   模型名不在该事件内，在 `type=turn_context` 的 `payload.model`，需扫描时维护当前 turn 模型。
//!
//! 缓存策略：**按文件缓存聚合结果**，而非按字节偏移做增量续读。
//! 原因是 message.id 去重要求「同一文件的用量事件在同一次扫描内可见」，
//! 若按偏移续读，跨扫描边界的同 id 行会被重复计入。
//! 因此改为：文件 (mtime, size) 未变则复用其缓存桶，变了则整文件重扫并替换该文件的桶。
//! 单个会话文件量级为 MB，全量重扫开销可接受，且换来去重的正确性。
//!
//! 健壮性：沿用 history 模块风格 —— 目录缺失、文件损坏、单行非法 JSON 一律跳过，
//! 绝不 panic、绝不因个别脏数据中断整体统计。

pub mod model;

mod claude;
mod codex;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::AppError;
use crate::history::paths_equal;
use model::{ModelUsage, UsageDayPoint, UsageQueryResult, UsageTotals};

/// 缓存文件名（位于 appConfigDir，与 settings.json 同级）。
const CACHE_FILE: &str = "usage-cache.json";
/// 缓存格式版本。
const CACHE_VERSION: u32 = 1;
/// 解析算法版本。解析逻辑变更后递增此值，可强制丢弃旧缓存全量重扫。
const ALGO_VERSION: u32 = 1;
/// 默认查询天数。
const DEFAULT_RANGE_DAYS: u32 = 30;

/// 单个 (日期, 模型) 维度的用量桶。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageBucket {
    /// 日期 YYYY-MM-DD（本地时区）。
    pub date: String,
    /// 模型名；无法识别时为空串。
    pub model: String,
    /// 该桶累计用量。
    pub totals: UsageTotals,
}

/// 单个 JSONL 文件的解析产物（扫描器返回，尚未附加文件元信息）。
pub(crate) struct ParsedFile {
    /// 归属键：Claude 为 slug 目录名，Codex 为会话 cwd。
    pub owner_key: String,
    /// 解析出的用量桶。
    pub buckets: Vec<UsageBucket>,
}

/// 单个 JSONL 文件的缓存条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileUsage {
    /// 文件修改时间（epoch 毫秒），与 size 共同判断文件是否变化。
    mtime_ms: i64,
    /// 文件字节数。
    size: u64,
    /// 驱动来源：claude 或 codex。
    driver: String,
    /// 归属键：Claude 存 slug 目录名，Codex 存会话 cwd。用于按工作空间过滤。
    owner_key: String,
    /// 该文件解析出的用量桶。
    buckets: Vec<UsageBucket>,
}

/// usage-cache.json 顶层结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct UsageCache {
    version: u32,
    algo_version: u32,
    /// 上次扫描完成时间（RFC3339）。
    last_scanned_at: String,
    /// 文件绝对路径 → 该文件的解析结果。
    files: HashMap<String, FileUsage>,
}

impl Default for UsageCache {
    /// 默认空缓存。
    /// 参数：无；返回：当前版本号的空缓存。
    fn default() -> Self {
        Self {
            version: CACHE_VERSION,
            algo_version: ALGO_VERSION,
            last_scanned_at: String::new(),
            files: HashMap::new(),
        }
    }
}

/// 用量扫描器。持有缓存文件路径与内存缓存，作为全局状态长期存活。
pub struct UsageScanner {
    cache_path: PathBuf,
    cache: Mutex<UsageCache>,
}

impl UsageScanner {
    /// 创建扫描器：定位 appConfigDir 下的缓存文件并载入。
    ///
    /// 缓存缺失 / 损坏 / 版本不匹配时退化为空缓存（下次扫描即全量重建），不报错。
    /// 参数：`app`——Tauri 应用句柄，用于解析配置目录；
    /// 返回：扫描器实例；仅在配置目录无法定位时返回 Err。
    pub fn new(app: &tauri::AppHandle) -> Result<Self, AppError> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| AppError::Config(format!("无法定位配置目录: {e}")))?;
        fs::create_dir_all(&config_dir)?;
        let cache_path = config_dir.join(CACHE_FILE);

        // 版本不符即丢弃：算法变更后旧桶的语义可能已不同，重扫比兼容更安全。
        let cache = fs::read_to_string(&cache_path)
            .ok()
            .and_then(|text| serde_json::from_str::<UsageCache>(&text).ok())
            .filter(|c| c.version == CACHE_VERSION && c.algo_version == ALGO_VERSION)
            .unwrap_or_default();

        Ok(Self {
            cache_path,
            cache: Mutex::new(cache),
        })
    }

    /// 扫描全部 claude / codex 会话文件，更新缓存并落盘。
    ///
    /// 文件的 (mtime, size) 与缓存一致时跳过解析直接复用旧桶；
    /// 缓存中已不存在于磁盘的文件条目会被清理。
    /// 参数：无；返回：扫描完成时间（RFC3339）；仅落盘失败时返回 Err。
    pub fn scan(&self) -> Result<String, AppError> {
        let mut discovered: HashMap<String, FileUsage> = HashMap::new();
        let previous = self.cache.lock().files.clone();

        for (path, driver) in discover_session_files() {
            let key = path.to_string_lossy().to_string();
            let (mtime_ms, size) = match file_stamp(&path) {
                Some(stamp) => stamp,
                None => continue, // 读不到元数据（权限/竞态删除），跳过该文件。
            };

            // 未变化：直接搬运旧桶，省去整文件解析。
            if let Some(old) = previous.get(&key) {
                if old.mtime_ms == mtime_ms && old.size == size && old.driver == driver {
                    discovered.insert(key, old.clone());
                    continue;
                }
            }

            let parsed = match driver.as_str() {
                "codex" => codex::parse_file(&path),
                _ => claude::parse_file(&path),
            };
            if let Some(parsed) = parsed {
                discovered.insert(
                    key,
                    FileUsage {
                        mtime_ms,
                        size,
                        driver,
                        owner_key: parsed.owner_key,
                        buckets: parsed.buckets,
                    },
                );
            }
        }

        let scanned_at = chrono::Utc::now().to_rfc3339();
        {
            let mut cache = self.cache.lock();
            cache.version = CACHE_VERSION;
            cache.algo_version = ALGO_VERSION;
            cache.last_scanned_at = scanned_at.clone();
            cache.files = discovered;
        }
        self.persist()?;
        Ok(scanned_at)
    }

    /// 按条件聚合缓存中的用量并返回查询结果。
    ///
    /// 参数：
    ///   - `workspace_path`：限定工作空间绝对路径；`None` 表示统计全部项目；
    ///   - `range_days`：统计最近多少天（含今天）；`None` 用默认 30 天。
    /// 返回：按日期升序的序列与各维度汇总。
    pub fn query(&self, workspace_path: Option<&str>, range_days: Option<u32>) -> UsageQueryResult {
        let days = range_days.unwrap_or(DEFAULT_RANGE_DAYS).max(1);
        let cache = self.cache.lock();

        // 起始日期（含），早于此的桶一律丢弃。
        let today = chrono::Local::now().date_naive();
        let start = today - chrono::Duration::days(days as i64 - 1);

        // 目标 slug 只在限定工作空间时计算一次，避免逐文件重复 slugify。
        let want_slug = workspace_path.map(crate::history::claude::slugify);

        let mut by_date: HashMap<String, UsageDayPoint> = HashMap::new();
        let mut by_model: HashMap<(String, String), UsageTotals> = HashMap::new();
        let mut claude_totals = UsageTotals::default();
        let mut codex_totals = UsageTotals::default();

        for file in cache.files.values() {
            // 工作空间过滤：Claude 比 slug 目录名，Codex 比会话 cwd。
            if let Some(want_path) = workspace_path {
                let matched = if file.driver == "codex" {
                    paths_equal(&file.owner_key, want_path)
                } else {
                    want_slug
                        .as_deref()
                        .is_some_and(|slug| slug.eq_ignore_ascii_case(&file.owner_key))
                };
                if !matched {
                    continue;
                }
            }

            for bucket in &file.buckets {
                // 日期早于窗口起点则跳过；日期非法（解析失败写入的空串）一并排除。
                match chrono::NaiveDate::parse_from_str(&bucket.date, "%Y-%m-%d") {
                    Ok(date) if date >= start => {}
                    _ => continue,
                }

                let point = by_date.entry(bucket.date.clone()).or_insert_with(|| UsageDayPoint {
                    date: bucket.date.clone(),
                    ..Default::default()
                });
                if file.driver == "codex" {
                    point.codex.add(&bucket.totals);
                    codex_totals.add(&bucket.totals);
                } else {
                    point.claude.add(&bucket.totals);
                    claude_totals.add(&bucket.totals);
                }

                if !bucket.model.is_empty() {
                    by_model
                        .entry((bucket.model.clone(), file.driver.clone()))
                        .or_default()
                        .add(&bucket.totals);
                }
            }
        }

        let mut series: Vec<UsageDayPoint> = by_date.into_values().collect();
        series.sort_by(|a, b| a.date.cmp(&b.date));

        let mut models: Vec<ModelUsage> = by_model
            .into_iter()
            .map(|((model, driver), totals)| ModelUsage {
                model,
                driver,
                totals,
            })
            .collect();
        // 按总量降序，前端直接取前几名展示。
        models.sort_by(|a, b| grand_total(&b.totals).cmp(&grand_total(&a.totals)));

        UsageQueryResult {
            series,
            claude_totals,
            codex_totals,
            by_model: models,
            last_scanned_at: cache.last_scanned_at.clone(),
        }
    }

    /// 把内存缓存原子写入磁盘（先写 .tmp 再 rename，与 ConfigStore 同策略）。
    /// 参数：无；返回：写入结果。
    fn persist(&self) -> Result<(), AppError> {
        let text = {
            let cache = self.cache.lock();
            serde_json::to_string(&*cache)?
        };
        let tmp = self.cache_path.with_extension("json.tmp");
        fs::write(&tmp, text.as_bytes())?;
        fs::rename(&tmp, &self.cache_path)?;
        Ok(())
    }
}

/// 计算一组用量的总 token 数（四项相加，仅用于模型排序）。
///
/// 注意：此处刻意不区分 Claude / Codex 的 input_tokens 语义差异
/// （Codex 的 input 已含 cache_read，相加会重复计一次），
/// 因为它只用于「哪个模型用得多」的相对排序，不作为对外展示数字。
/// 对外展示的总量在前端按 driver 分支计算。
/// 参数：`t`——用量；返回：四项之和。
fn grand_total(t: &UsageTotals) -> u64 {
    t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens
}

/// 读取文件的 (修改时间毫秒, 字节数)。
/// 参数：`path`——目标文件；返回：元数据；读取失败时 None。
fn file_stamp(path: &Path) -> Option<(i64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis())?;
    Some((mtime, meta.len()))
}

/// 枚举本机全部 claude / codex 会话 JSONL 文件。
///
/// 参数：无；返回：(文件路径, 驱动名) 列表；对应根目录不存在时该来源贡献空列表。
fn discover_session_files() -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return out,
    };

    // Claude：projects/<slug>/*.jsonl，另含 <slug>/<uuid>/subagents/*.jsonl。
    let claude_root = home.join(".claude").join("projects");
    if claude_root.is_dir() {
        collect_jsonl(&claude_root, 4, &mut |p| {
            out.push((p, "claude".to_string()))
        });
    }

    // Codex：sessions/YYYY/MM/DD/rollout-*.jsonl，固定三层日期目录。
    let codex_root = home.join(".codex").join("sessions");
    if codex_root.is_dir() {
        collect_jsonl(&codex_root, 4, &mut |p| out.push((p, "codex".to_string())));
    }

    out
}

/// 递归收集目录下的 .jsonl 文件。
///
/// 限制递归深度以防目录环（符号链接）导致无限下潜。
/// 参数：`dir`——起始目录；`depth`——剩余可下潜层数；`sink`——命中文件的回调。
/// 返回：无。
fn collect_jsonl(dir: &Path, depth: usize, sink: &mut impl FnMut(PathBuf)) {
    if depth == 0 {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return, // 权限不足等，跳过整个目录。
    };
    for entry in rd.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => collect_jsonl(&path, depth - 1, sink),
            Ok(ft) if ft.is_file() => {
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    sink(path);
                }
            }
            _ => {}
        }
    }
}
