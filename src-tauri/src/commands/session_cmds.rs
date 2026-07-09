//! 自管会话命令：CRUD + 重命名。
//! 侧边栏的"会话列表"读这里，不再依赖 claude/codex 的 sessions-index.json。

use tauri::State;

use crate::config::model::ManagedSession;
use crate::error::AppError;
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
pub fn managed_session_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    state.config.delete_managed_session(&id)
}
