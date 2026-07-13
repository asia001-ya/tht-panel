//! 自管会话命令：CRUD + 重命名 + AI 会话 uuid 探测。
//! 侧边栏的"会话列表"读这里，不再依赖 claude/codex 的 sessions-index.json。

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use chrono::Datelike;
use tauri::State;

use crate::config::model::ManagedSession;
use crate::error::AppError;
use crate::history::claude::slugify;
use crate::history::paths_equal;
use crate::state::AppState;

/// 列出指定工作空间的自管会话（按 updatedAt 倒序）。
/// 参数：state——全局状态；workspace_id——工作空间 id。
/// 返回：该工作空间的会话记录列表或 AppError。
#[tauri::command]
pub fn managed_session_list(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<ManagedSession>, AppError> {
    Ok(state.config.managed_sessions(&workspace_id))
}

/// 创建一条自管会话记录（首次发送指令时由前端调用）。
/// 参数：state——全局状态；session——新会话记录。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn managed_session_create(
    state: State<'_, AppState>,
    session: ManagedSession,
) -> Result<(), AppError> {
    state.config.create_managed_session(session)
}

/// 更新一条自管会话记录（重命名、绑定 pty_session_id 等）。
/// 参数：state——全局状态；session——更新后的会话记录。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn managed_session_update(
    state: State<'_, AppState>,
    session: ManagedSession,
) -> Result<(), AppError> {
    state.config.update_managed_session(session)
}

/// 删除一条自管会话记录。
/// 参数：state——全局状态；id——会话记录 id。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn managed_session_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.config.delete_managed_session(&id)
}

/// 探测最近为某工作空间新建的 AI 会话 uuid。
/// 找不到返回 Ok(None)，绝不报错。
#[tauri::command]
pub fn ai_session_detect(
    state: State<'_, AppState>,
    workspace_id: String,
    kind: String,
    spawned_at: String,
    exclude: Vec<String>,
) -> Result<Option<String>, AppError> {
    let ws = state
        .config
        .workspaces()
        .into_iter()
        .find(|w| w.id == workspace_id);
    let ws = match ws {
        Some(w) => w,
        None => return Ok(None),
    };

    let threshold = chrono::DateTime::parse_from_rfc3339(&spawned_at)
        .map(|dt| dt.with_timezone(&chrono::Utc) - chrono::Duration::seconds(2))
        .ok();

    let exclude_set: HashSet<&str> = exclude.iter().map(|s| s.as_str()).collect();

    match kind.as_str() {
        "claude" => Ok(detect_claude(&ws.path, threshold, &exclude_set)),
        "codex" => Ok(detect_codex(&ws.path, &spawned_at, threshold, &exclude_set)),
        _ => Ok(detect_claude(&ws.path, threshold, &exclude_set)),
    }
}

fn detect_claude(
    ws_path: &str,
    threshold: Option<chrono::DateTime<chrono::Utc>>,
    exclude: &HashSet<&str>,
) -> Option<String> {
    let home = dirs::home_dir()?;
    let slug = slugify(ws_path);
    let slug_dir = home.join(".claude").join("projects").join(&slug);
    if !slug_dir.is_dir() {
        return None;
    }

    let rd = std::fs::read_dir(&slug_dir).ok()?;
    let mut best: Option<(std::time::SystemTime, String)> = None;

    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if exclude.contains(stem.as_str()) {
            continue;
        }
        let mtime = match std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
        {
            Some(t) => t,
            None => continue,
        };
        if let Some(th) = threshold {
            let mtime_utc: chrono::DateTime<chrono::Utc> = mtime.into();
            if mtime_utc < th {
                continue;
            }
        }
        match &best {
            Some((prev, _)) if mtime <= *prev => {}
            _ => best = Some((mtime, stem)),
        }
    }

    best.map(|(_, id)| id)
}

fn detect_codex(
    ws_path: &str,
    spawned_at: &str,
    threshold: Option<chrono::DateTime<chrono::Utc>>,
    exclude: &HashSet<&str>,
) -> Option<String> {
    let home = dirs::home_dir()?;
    let codex_home = match std::env::var("CODEX_HOME") {
        Ok(v) if !v.trim().is_empty() => PathBuf::from(v),
        _ => home.join(".codex"),
    };
    let sessions_dir = codex_home.join("sessions");
    if !sessions_dir.is_dir() {
        return None;
    }

    let date_dirs = date_dirs_for_spawn(&sessions_dir, spawned_at);
    let mut best: Option<(std::time::SystemTime, String)> = None;

    for day_dir in date_dirs {
        let rd = match std::fs::read_dir(&day_dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let fname = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !fname.starts_with("rollout-") || !fname.ends_with(".jsonl") {
                continue;
            }
            let mtime = match std::fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
            {
                Some(t) => t,
                None => continue,
            };
            if let Some(th) = threshold {
                let mtime_utc: chrono::DateTime<chrono::Utc> = mtime.into();
                if mtime_utc < th {
                    continue;
                }
            }
            if let Some((cwd, uuid)) = parse_codex_rollout(&path) {
                if exclude.contains(uuid.as_str()) {
                    continue;
                }
                if paths_equal(&cwd, ws_path) {
                    match &best {
                        Some((prev, _)) if mtime <= *prev => {}
                        _ => best = Some((mtime, uuid)),
                    }
                }
            }
        }
    }

    best.map(|(_, id)| id)
}

fn date_dirs_for_spawn(sessions_dir: &std::path::Path, spawned_at: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(spawned_at) {
        let d = dt.date_naive();
        let next = d + chrono::Duration::days(1);
        for date in [d, next] {
            let dir = sessions_dir
                .join(format!("{:04}", date.year()))
                .join(format!("{:02}", date.month()))
                .join(format!("{:02}", date.day()));
            if dir.is_dir() {
                dirs.push(dir);
            }
        }
    }
    dirs
}

fn parse_codex_rollout(path: &std::path::Path) -> Option<(String, String)> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(5) {
        let line = line.ok()?;
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
            let payload = v.get("payload").unwrap_or(&v);
            let cwd = payload.get("cwd").and_then(|c| c.as_str())?.to_string();
            let uuid = payload.get("id").and_then(|i| i.as_str())?.to_string();
            return Some((cwd, uuid));
        }
        if v.get("cwd").is_some() && v.get("id").is_some() {
            let cwd = v.get("cwd").and_then(|c| c.as_str())?.to_string();
            let uuid = v.get("id").and_then(|i| i.as_str())?.to_string();
            return Some((cwd, uuid));
        }
    }
    None
}
