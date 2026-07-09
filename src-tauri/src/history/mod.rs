//! 历史会话扫描模块。
//!
//! 负责扫描 claude / codex 在本机磁盘上留存的历史会话，供前端左侧
//! 工作空间子菜单懒加载展示，并支持 `--resume` / `resume` 恢复。
//!
//! 约定：任何"目录不存在 / 文件损坏"的情况都退化为返回空列表或跳过，
//! 绝不 panic、绝不报错中断整个列表，以免个别脏数据拖垮历史菜单。

pub mod claude;
pub mod codex;

use std::path::Path;

use serde_json::Value;

use crate::config::model::{SessionHistoryEntry, Workspace};
use crate::error::AppError;

/// 列出指定工作空间的历史 AI 会话。
///
/// 参数：
///   - `_app`：Tauri 应用句柄（保留形参以统一命令层调用签名；claude/codex
///     的历史定位仅依赖用户主目录与环境变量，故当前实现未直接使用它）。
///   - `workspace`：目标工作空间，其 `agent` 字段决定分派到 claude 还是 codex，
///     `path` 字段作为项目路径用于定位 / 过滤。
///
/// 返回：按 `modifiedAt` 倒序（新→旧）排列的历史会话条目；对应目录不存在时返回空 vec。
pub fn list(
    _app: &tauri::AppHandle,
    workspace: &Workspace,
) -> Result<Vec<SessionHistoryEntry>, AppError> {
    // 按工作空间 AI 类型分派；claude 与未知类型均走 claude 扫描器。
    let mut entries = match workspace.agent.as_str() {
        "codex" => codex::list(_app, workspace)?,
        _ => claude::list(_app, workspace)?,
    };
    // 倒序：modifiedAt 为 ISO-8601 / RFC3339 字符串，字典序即时间序，b 与 a 反向比较得倒序。
    entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(entries)
}

// ==================== 以下为 claude / codex 子模块共用的工具函数 ====================

/// 从消息 content 字段中提取纯文本。
///
/// 兼容两种形态：
///   - 字符串：直接返回；
///   - 数组：取首个含 `text` 字段的元素（claude 的 `{type:"text",text}`、
///     codex 的 `{type:"input_text",text}` 均命中）。
/// 参数 `content`：消息的 content JSON 值。
/// 返回：提取到的原始文本；无法提取时返回 None。
pub(crate) fn extract_text_content(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(arr) => {
            for item in arr {
                if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                    return Some(t.to_string());
                }
            }
            None
        }
        _ => None,
    }
}

/// 将原始文本清洗为可用作会话标题的候选。
///
/// 规则：去首尾空白；空串或以 `<` 开头（视为 `<local-command-caveat>` /
/// `<command-name>` 等注入内容）一律丢弃；否则折叠换行并截断到 80 个字符。
/// 参数 `raw`：原始文本。
/// 返回：合格的标题；被判定为注入或空则返回 None（调用方应继续找下一条）。
pub(crate) fn clean_title(raw: &str) -> Option<String> {
    let collapsed = raw.replace(['\n', '\r'], " ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') {
        return None;
    }
    Some(truncate_chars(trimmed, 80))
}

/// 折叠换行并按"字符数"（非字节）截断，避免把多字节中文从中间劈开。
/// 参数 `s`：源字符串；`max`：最大字符数。
/// 返回：清洗并截断后的字符串。
pub(crate) fn sanitize_line(s: &str, max: usize) -> String {
    let collapsed = s.replace(['\n', '\r'], " ");
    truncate_chars(collapsed.trim(), max)
}

/// 按字符数截断字符串（内部工具）。
/// 参数 `s`：源字符串；`max`：最大字符数。
/// 返回：至多 `max` 个字符的新字符串。
fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 读取文件修改时间并格式化为 RFC3339（UTC）字符串。
/// 参数 `path`：目标文件路径。
/// 返回：RFC3339 时间字符串；无法读取时返回空串。
pub(crate) fn mtime_iso(path: &Path) -> String {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_default()
}

/// 将 epoch 毫秒时间戳格式化为 RFC3339（UTC）字符串。
/// 参数 `ms`：自 1970-01-01 起的毫秒数。
/// 返回：RFC3339 时间字符串；越界时返回空串。
pub(crate) fn ms_to_iso(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339())
        .unwrap_or_default()
}

/// 判断两个 Windows 路径是否指向同一目录。
///
/// 规则：去除尾部 `\` / `/`，把 `/` 统一为 `\`，再做 ASCII 大小写不敏感比较
/// （Windows 文件系统大小写不敏感，盘符大小写差异需容忍）。
/// 参数 `a`、`b`：两个路径字符串。
/// 返回：视为同一路径则 true。
pub(crate) fn paths_equal(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim_end_matches(['\\', '/']).replace('/', "\\");
    norm(a).eq_ignore_ascii_case(&norm(b))
}
