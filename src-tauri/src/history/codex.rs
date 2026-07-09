//! codex 历史会话扫描。
//!
//! 数据来源（依据计划 8.5 与"已验证本机事实"）：
//! - codex 会话按日期存于 `{CODEX_HOME 或 ~/.codex}/sessions/YYYY/MM/DD/`，
//!   文件名形如 `rollout-<ts>-<uuid>.jsonl`（`<ts>` 为时间戳、`<uuid>` 为会话 id）。
//! - 每个 rollout 文件首行为 `session_meta` 记录，`payload.cwd` 是会话工作目录。
//!
//! 扫描策略：
//! 1. 定位 sessions 目录（优先环境变量 `CODEX_HOME`，否则 `~/.codex`）；不存在返回空 vec；
//! 2. 日期倒序遍历 YYYY/MM/DD，最多取 200 个 rollout 文件（控制扫描量）；
//! 3. 文件名提取 uuid（resume 用）与时间戳；读首行 session_meta 取 cwd；
//!    - 使用默认 `~/.codex` 时按 `payload.cwd == 工作空间路径` 过滤；
//!    - 使用独立 `CODEX_HOME`（环境变量已设）时视为已隔离，全部收下不再按 cwd 过滤；
//! 4. 标题取首条用户输入，取不到则用时间戳。
//!
//! 任何"目录不存在 / 文件损坏"均退化为跳过或返回空列表，绝不 panic、绝不中断。

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{clean_title, extract_text_content, mtime_iso, paths_equal};
use crate::config::model::{SessionHistoryEntry, Workspace};
use crate::error::AppError;

/// 最多扫描的 rollout 文件数（日期倒序取前 N 个）。
const MAX_FILES: usize = 200;
/// 单文件轻解析上限：最多读取的行数（用于取 meta + 首条用户输入）。
const MAX_SCAN_LINES: usize = 50;
/// 单文件轻解析上限：最多读取的字节数（64KB）。
const MAX_SCAN_BYTES: usize = 64 * 1024;

/// 列出指定工作空间的 codex 历史会话。
///
/// 参数：
///   - `_app`：Tauri 应用句柄（保留以统一调用签名，codex 定位仅依赖环境变量与主目录，故未使用）；
///   - `workspace`：目标工作空间，其 `path` 用于按 `payload.cwd` 过滤。
/// 返回：历史会话条目（未排序，排序由上层 `history::list` 统一按 modifiedAt 倒序处理）；
///       sessions 目录不存在时返回空 vec，不报错。
pub fn list(
    _app: &tauri::AppHandle,
    workspace: &Workspace,
) -> Result<Vec<SessionHistoryEntry>, AppError> {
    // 定位 codex home：优先环境变量 CODEX_HOME（视为独立隔离目录），否则 ~/.codex。
    let (codex_home, isolated) = match std::env::var("CODEX_HOME") {
        Ok(v) if !v.trim().is_empty() => (PathBuf::from(v), true),
        _ => match dirs::home_dir() {
            Some(h) => (h.join(".codex"), false),
            None => return Ok(Vec::new()),
        },
    };
    let sessions_dir = codex_home.join("sessions");
    // 目录不存在（如本机从未用过 codex）：返回空列表，不报错。
    if !sessions_dir.is_dir() {
        return Ok(Vec::new());
    }

    // 日期倒序收集至多 MAX_FILES 个 rollout 文件。
    let files = collect_rollout_files(&sessions_dir, MAX_FILES);
    let mut out: Vec<SessionHistoryEntry> = Vec::with_capacity(files.len());
    for path in files {
        // isolated=true（独立 CODEX_HOME）时全收；否则按 cwd 过滤。
        if let Some(entry) = parse_rollout(&path, workspace, isolated) {
            out.push(entry);
        }
    }
    Ok(out)
}

/// 日期倒序遍历 `sessions/YYYY/MM/DD/`，收集 rollout jsonl 文件路径。
///
/// 参数：
///   - `sessions_dir`：`{codex_home}/sessions` 目录；
///   - `limit`：最多收集的文件数。
/// 返回：按 年→月→日→文件名 均倒序排列的 rollout 文件路径（新→旧），至多 `limit` 个。
fn collect_rollout_files(sessions_dir: &Path, limit: usize) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    // 三级目录（YYYY / MM / DD）均按名称倒序，年份/月/日字符串定长，字典序即时间序。
    for year_dir in sorted_subdirs_desc(sessions_dir) {
        for month_dir in sorted_subdirs_desc(&year_dir) {
            for day_dir in sorted_subdirs_desc(&month_dir) {
                let mut day_files: Vec<PathBuf> = match std::fs::read_dir(&day_dir) {
                    Ok(rd) => rd
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| p.is_file())
                        .filter(|p| is_rollout_file(p))
                        .collect(),
                    Err(_) => Vec::new(),
                };
                // 同一天内按文件名倒序（文件名含时间戳，新会话在前）。
                day_files.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for f in day_files {
                    files.push(f);
                    if files.len() >= limit {
                        return files;
                    }
                }
            }
        }
    }
    files
}

/// 读取某目录下的子目录并按名称倒序返回。
/// 参数 `dir`：父目录。
/// 返回：按目录名倒序排列的子目录路径；读取失败返回空 vec。
fn sorted_subdirs_desc(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect(),
        Err(_) => Vec::new(),
    };
    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    dirs
}

/// 判断文件名是否为 codex rollout 文件（`rollout-*.jsonl`）。
/// 参数 `path`：文件路径。
/// 返回：命中命名规则则 true。
fn is_rollout_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        .unwrap_or(false)
}

/// 解析单个 rollout 文件为一条历史会话条目。
///
/// 参数：
///   - `path`：rollout jsonl 文件路径；
///   - `workspace`：目标工作空间（用于 cwd 过滤）；
///   - `isolated`：是否处于独立 CODEX_HOME（true 则跳过 cwd 过滤全部收下）。
/// 返回：解析成功且通过过滤的会话条目；文件名不合法 / 被 cwd 过滤掉时返回 None。
fn parse_rollout(
    path: &Path,
    workspace: &Workspace,
    isolated: bool,
) -> Option<SessionHistoryEntry> {
    let file_name = path.file_name()?.to_str()?;
    // 从文件名提取时间戳与会话 uuid。
    let (ts_str, uuid) = parse_rollout_name(file_name)?;

    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut lines_read = 0usize;
    let mut bytes_read = 0usize;

    let mut cwd: Option<String> = None; // session_meta.payload.cwd
    let mut meta_ts: Option<String> = None; // session_meta 的 RFC3339 时间戳（排序键优先用）
    let mut title: Option<String> = None; // 首条用户输入清洗后的标题
    let mut meta_done = false; // 是否已解析到 session_meta

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        lines_read += 1;
        bytes_read += line.len() + 1;
        if lines_read > MAX_SCAN_LINES || bytes_read > MAX_SCAN_BYTES {
            break;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // 先取 session_meta（通常在首行）：拿 cwd 与时间戳。
        if !meta_done {
            if let Some(meta) = extract_session_meta(&v) {
                cwd = meta
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());
                meta_ts = v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .or_else(|| meta.get("timestamp").and_then(|t| t.as_str()))
                    .map(|s| s.to_string());
                meta_done = true;
                continue;
            }
        }

        // 再找首条用户输入作为标题。
        if title.is_none() {
            if let Some(text) = extract_user_text(&v) {
                title = clean_title(&text);
            }
        }

        // meta 与标题都拿到即可提前结束扫描。
        if meta_done && title.is_some() {
            break;
        }
    }

    // cwd 过滤：非独立 home 时要求 cwd 与工作空间路径一致；取不到 cwd 视为不匹配。
    if !isolated {
        match cwd.as_deref() {
            Some(c) if paths_equal(c, &workspace.path) => {}
            _ => return None,
        }
    }

    // 排序键：优先 meta 时间戳（RFC3339，与 claude 一致），否则退化到文件 mtime。
    let modified_at = meta_ts
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| mtime_iso(path));
    // 标题：首条用户输入 > 时间戳 > 文件 mtime。
    let title = title.unwrap_or_else(|| {
        if !ts_str.is_empty() {
            ts_str.clone()
        } else {
            mtime_iso(path)
        }
    });

    Some(SessionHistoryEntry {
        session_id: uuid,
        source: "codex".to_string(),
        title,
        summary: None,
        message_count: None,
        modified_at,
        git_branch: None,
    })
}

/// 从 rollout 文件名解析出（时间戳, 会话 uuid）。
///
/// 文件名格式：`rollout-<ts>-<uuid>.jsonl`，其中 `<uuid>` 为标准 36 字符 UUID
/// （`8-4-4-4-12`），`<ts>` 本身含 `-`，故不能简单按 `-` 切分——取末尾 36 字符为 uuid，
/// 其余为时间戳（去掉与 uuid 之间的连接 `-`）。
/// 参数 `name`：文件名（含扩展名）。
/// 返回：`Some((ts, uuid))`；不符合命名规则或末尾不是合法 UUID 时返回 None。
fn parse_rollout_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    // 至少要容纳 uuid(36) + 连接符(1)。
    if rest.len() < 37 {
        return None;
    }
    let (ts_part, uuid_part) = rest.split_at(rest.len() - 36);
    if !looks_like_uuid(uuid_part) {
        return None;
    }
    let ts = ts_part.trim_end_matches('-').to_string();
    Some((ts, uuid_part.to_string()))
}

/// 判断字符串是否形如标准 UUID（`8-4-4-4-12` 十六进制，第 8/13/18/23 位为 `-`）。
/// 参数 `s`：待判断字符串。
/// 返回：形如 UUID 则 true。
fn looks_like_uuid(s: &str) -> bool {
    if s.len() != 36 {
        return false;
    }
    s.bytes().enumerate().all(|(i, b)| {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            b == b'-'
        } else {
            b.is_ascii_hexdigit()
        }
    })
}

/// 从一行 JSON 记录中提取 `session_meta` 的 payload（含 cwd）。
///
/// 兼容两种形态：
///   - 新格式：`{type:"session_meta", payload:{cwd,...}}` → 返回 payload（无 payload 时退化为整体）；
///   - 老格式：首行直接是含 `cwd` 与 `id` 的对象 → 返回整体。
/// 参数 `v`：一行解析后的 JSON 值。
/// 返回：meta 对象引用；非 meta 行返回 None。
fn extract_session_meta(v: &Value) -> Option<&Value> {
    if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
        return v.get("payload").or(Some(v));
    }
    if v.get("cwd").is_some() && v.get("id").is_some() {
        return Some(v);
    }
    None
}

/// 从一行 JSON 记录中提取用户输入文本。
///
/// 兼容 codex 的多种记录形态：
///   - `event_msg` → `payload.type=="user_message"`，取 `payload.message`（字符串或含 text 结构）；
///   - `response_item` / 直接消息 → `payload.role=="user"`（或顶层 role），取 `content`
///     （字符串直接用 / 数组取首个含 text，命中 `{type:"input_text",text}`）。
/// 参数 `v`：一行解析后的 JSON 值。
/// 返回：提取到的原始用户文本；非用户输入返回 None。
fn extract_user_text(v: &Value) -> Option<String> {
    // payload 缺失时退化为整体，兼容扁平结构。
    let payload = v.get("payload").unwrap_or(v);

    // event_msg：用户消息。
    if payload.get("type").and_then(|t| t.as_str()) == Some("user_message") {
        if let Some(msg) = payload.get("message") {
            if let Some(s) = msg.as_str() {
                return Some(s.to_string());
            }
            if let Some(t) = extract_text_content(msg) {
                return Some(t);
            }
        }
    }

    // 消息记录：role == user。
    if payload.get("role").and_then(|r| r.as_str()) == Some("user") {
        if let Some(content) = payload.get("content") {
            return extract_text_content(content);
        }
    }

    None
}
