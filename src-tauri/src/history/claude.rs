//! claude 历史会话扫描。
//!
//! 数据来源（依据计划 8.5 与"已验证本机事实"）：
//! - claude 把每个项目的会话存于 `~/.claude/projects/<slug>/`，其中
//!   `slug` = 项目绝对路径中的 `:` 与路径分隔符（`\` / `/`）替换为 `-`
//!   （如 `D:\AI\register` → `D--AI-register`，盘符大小写原样保留）。
//! - 每个项目目录下有 `sessions-index.json`（历史菜单主数据源），形如
//!   `{version, entries:[{sessionId, firstPrompt, summary, messageCount,
//!    created, modified, gitBranch, projectPath, isSidechain, ...}]}`。
//!
//! 扫描策略（逐级兜底）：
//! 1. 主路径：读 `sessions-index.json`，过滤 `isSidechain`，title 取 firstPrompt；
//! 2. 兜底 A：目录里"不在索引中的" `*.jsonl` 文件（只取文件、跳过 subagent 子目录），
//!    轻解析首条真实用户消息作为标题；
//! 3. 兜底 B：slug 目录不存在时，遍历所有项目的 `sessions-index.json`，用
//!    `entries[].projectPath == 工作空间路径` 反查（应对 slug 规则漂移）。
//!
//! 任何"目录不存在 / 文件损坏"均退化为跳过或返回空列表，绝不 panic、绝不中断。

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::Value;

use super::{clean_title, extract_text_content, ms_to_iso, mtime_iso, paths_equal, sanitize_line};
use crate::config::model::{SessionHistoryEntry, Workspace};
use crate::error::AppError;

/// 轻解析上限：单个 jsonl 兜底解析最多读取的行数。
const MAX_SCAN_LINES: usize = 50;
/// 轻解析上限：单个 jsonl 兜底解析最多读取的字节数（64KB）。
const MAX_SCAN_BYTES: usize = 64 * 1024;
/// 从 sessions-index.json 取用的标题最大字符数（折叠换行后按字符截断）。
const INDEX_TITLE_MAX: usize = 120;

/// 列出指定工作空间的 claude 历史会话。
///
/// 参数：
///   - `_app`：Tauri 应用句柄（保留以统一调用签名，claude 定位仅依赖用户主目录，故未使用）；
///   - `workspace`：目标工作空间，其 `path` 用于定位 slug 目录与 projectPath 反查。
/// 返回：历史会话条目（未排序，排序由上层 `history::list` 统一按 modifiedAt 倒序处理）；
///       `~/.claude/projects` 不存在时返回空 vec。
pub fn list(
    _app: &tauri::AppHandle,
    workspace: &Workspace,
) -> Result<Vec<SessionHistoryEntry>, AppError> {
    // 定位 ~；取不到主目录（异常环境）直接返回空列表。
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Ok(Vec::new()),
    };
    let projects_root = home.join(".claude").join("projects");
    // projects 根目录不存在：本机从未用过 claude，返回空。
    if !projects_root.is_dir() {
        return Ok(Vec::new());
    }

    let slug = slugify(&workspace.path);
    let slug_dir = projects_root.join(&slug);
    let mut out: Vec<SessionHistoryEntry> = Vec::new();

    if slug_dir.is_dir() {
        // ---- 主路径：sessions-index.json ----
        // indexed 收集索引里出现过的所有 sessionId（含被过滤的 sidechain），
        // 供兜底 A 判断哪些 jsonl 文件"不在索引中"。
        let mut indexed: HashSet<String> = HashSet::new();
        let index_path = slug_dir.join("sessions-index.json");
        if index_path.is_file() {
            out.extend(entries_from_index(&index_path, None, &mut indexed));
        }

        // ---- 兜底 A：目录下不在索引中的 *.jsonl（只取文件、跳过子目录）----
        if let Ok(rd) = std::fs::read_dir(&slug_dir) {
            for entry in rd.flatten() {
                let path = entry.path();
                // 只处理普通文件；<uuid>/ 子目录是 subagents 数据，跳过。
                if !path.is_file() {
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                // 文件名主干即会话 uuid（= sessions-index 的 sessionId）。
                let sid = match path.file_stem().and_then(|s| s.to_str()) {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                if indexed.contains(&sid) {
                    continue; // 已在索引中，主路径已收录。
                }
                let title =
                    scan_jsonl_title(&path).unwrap_or_else(|| "(无标题会话)".to_string());
                out.push(SessionHistoryEntry {
                    session_id: sid,
                    source: "claude".to_string(),
                    title,
                    summary: None,
                    message_count: None,
                    modified_at: mtime_iso(&path),
                    git_branch: None,
                });
            }
        }
    } else {
        // ---- 兜底 B：slug 目录不存在，遍历所有项目索引按 projectPath 反查 ----
        if let Ok(rd) = std::fs::read_dir(&projects_root) {
            for entry in rd.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let index_path = dir.join("sessions-index.json");
                if !index_path.is_file() {
                    continue;
                }
                // 兜底 B 无需去重 jsonl，传入临时 set 丢弃即可。
                let mut discard: HashSet<String> = HashSet::new();
                out.extend(entries_from_index(
                    &index_path,
                    Some(workspace.path.as_str()),
                    &mut discard,
                ));
            }
        }
    }

    Ok(out)
}

/// 由工作空间绝对路径计算 claude 的 slug 目录名。
///
/// 规则：把 `:` 与路径分隔符（`\` 与 `/` 都归一）替换为 `-`，盘符大小写原样保留。
/// 例：`D:\AI\register` → `D--AI-register`。（对 `/` 也归一以兼容前端传入正斜杠路径。）
/// 参数 `path`：工作空间绝对路径。
/// 返回：slug 字符串。
pub(crate) fn slugify(path: &str) -> String {
    path.trim_end_matches(['\\', '/'])
        .replace(':', "-")
        .replace(['\\', '/'], "-")
}

/// 读取并解析单个 `sessions-index.json`，产出历史会话条目。
///
/// 参数：
///   - `index_path`：sessions-index.json 路径；
///   - `path_filter`：`Some(ws_path)` 时只保留 `projectPath == ws_path` 的条目（兜底 B 反查用）；
///     `None` 时全收（主路径 slug 已精确定位）；
///   - `collected_ids`：输出参数，收集本索引中出现的全部 sessionId（含被过滤者），
///     供兜底 A 去重。
/// 返回：过滤后的历史会话条目（未排序）；文件缺失 / 解析失败时返回空 vec。
fn entries_from_index(
    index_path: &Path,
    path_filter: Option<&str>,
    collected_ids: &mut HashSet<String>,
) -> Vec<SessionHistoryEntry> {
    let mut result: Vec<SessionHistoryEntry> = Vec::new();
    let data = match std::fs::read_to_string(index_path) {
        Ok(d) => d,
        Err(_) => return result,
    };
    let json: Value = match serde_json::from_str(&data) {
        Ok(j) => j,
        Err(_) => return result,
    };
    let entries = match json.get("entries").and_then(|e| e.as_array()) {
        Some(a) => a,
        None => return result,
    };

    for entry in entries {
        // 无 sessionId 无法 resume，直接跳过（也不计入去重集）。
        let sid = match entry.get("sessionId").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // 无论是否被后续过滤，都登记 sessionId，防止兜底 A 复活 sidechain。
        collected_ids.insert(sid.clone());

        // 过滤 subagent 侧链会话（与 claude --resume 交互列表保持一致）。
        if entry
            .get("isSidechain")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        // 兜底 B：按 projectPath 反查过滤。
        if let Some(want) = path_filter {
            let pp = entry
                .get("projectPath")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !paths_equal(pp, want) {
                continue;
            }
        }

        // 标题取 firstPrompt，折叠换行并按字符截断；为空则占位。
        let raw_title = entry
            .get("firstPrompt")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut title = sanitize_line(raw_title, INDEX_TITLE_MAX);
        if title.is_empty() {
            title = "(无标题会话)".to_string();
        }
        let summary = entry
            .get("summary")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let message_count = entry
            .get("messageCount")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let git_branch = entry
            .get("gitBranch")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        // 排序键 modified 优先；退化到 created，再退化到 fileMtime（epoch 毫秒）。
        let modified_at = entry
            .get("modified")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                entry
                    .get("created")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .or_else(|| entry.get("fileMtime").and_then(|v| v.as_i64()).map(ms_to_iso))
            .unwrap_or_default();

        result.push(SessionHistoryEntry {
            session_id: sid,
            source: "claude".to_string(),
            title,
            summary,
            message_count,
            modified_at,
            git_branch,
        });
    }

    result
}

/// 轻解析一个 jsonl 会话文件，提取首条真实用户消息作为标题（兜底 A）。
///
/// 规则：最多读 50 行 / 64KB；找首条 `type == "user"` 且 `isMeta != true` 的记录，
/// 取其 `message.content`（字符串直接用 / 数组取首个含 text 者），跳过以 `<` 开头的
/// 注入内容（`<local-command-caveat>` 等），折叠换行并截断到 80 字符。
/// 参数 `path`：jsonl 文件路径。
/// 返回：合格标题；未找到时返回 None。
fn scan_jsonl_title(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut lines_read = 0usize;
    let mut bytes_read = 0usize;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // 非法 UTF-8 等，停止扫描。
        };
        lines_read += 1;
        bytes_read += line.len() + 1;
        if lines_read > MAX_SCAN_LINES || bytes_read > MAX_SCAN_BYTES {
            break;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue, // 跳过损坏行。
        };
        // 只看用户消息，跳过 mode / file-history-snapshot 等元数据行。
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        if v.get("isMeta").and_then(|b| b.as_bool()) == Some(true) {
            continue;
        }
        if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
            if let Some(text) = extract_text_content(content) {
                // clean_title 会丢弃空串与 `<` 开头的注入内容并截断到 80 字符。
                if let Some(title) = clean_title(&text) {
                    return Some(title);
                }
            }
        }
    }
    None
}
