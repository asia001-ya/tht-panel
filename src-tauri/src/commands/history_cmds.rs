//! 历史会话命令：按 workspace_id 查工作空间，再委托 history 模块扫描。

use tauri::State;

use crate::config::model::SessionHistoryEntry;
use crate::error::AppError;
use crate::state::AppState;

/// 列出指定工作空间的历史 AI 会话（claude / codex，按 modifiedAt 倒序）。
/// 参数：state——全局状态；app——AppHandle（透传给扫描器统一签名）；workspace_id——工作空间 id。
/// 返回：历史会话条目列表或 AppError（工作空间不存在时报 NotFound）。
#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<Vec<SessionHistoryEntry>, AppError> {
    // 按 id 定位工作空间；不存在则报错（前端不应对未知 id 请求历史）。
    let ws = state
        .config
        .workspaces()
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| AppError::NotFound(format!("工作空间不存在: {workspace_id}")))?;
    crate::history::list(&app, &ws)
}
