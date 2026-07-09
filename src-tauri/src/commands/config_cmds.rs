//! 配置 / 工作空间 / 布局命令：转发到 ConfigStore。
//!
//! 约定：命令层只做转发与错误透传；config_set 额外把「等待输入通知」开关同步给 PtyManager。

use tauri::State;

use crate::config::model::{GlobalConfig, PersistedLayout, Workspace};
use crate::error::AppError;
use crate::state::AppState;

/// 读取全局配置。
/// 参数：state——全局状态。
/// 返回：GlobalConfig 或 AppError。
#[tauri::command]
pub fn config_get(state: State<'_, AppState>) -> Result<GlobalConfig, AppError> {
    Ok(state.config.global())
}

/// 保存全局配置，并把通知开关同步到 PtyManager。
/// 参数：state——全局状态；cfg——新的全局配置。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn config_set(state: State<'_, AppState>, cfg: GlobalConfig) -> Result<(), AppError> {
    // 先同步运行时开关（pump 线程据此决定是否发系统通知），再持久化。
    state.pty.set_notify_on_waiting(cfg.notify_on_waiting);
    state.config.set_global(cfg)
}

/// 列出全部工作空间。
/// 参数：state——全局状态。
/// 返回：Vec<Workspace> 或 AppError。
#[tauri::command]
pub fn workspace_list(state: State<'_, AppState>) -> Result<Vec<Workspace>, AppError> {
    Ok(state.config.workspaces())
}

/// 保存单个工作空间（按 id 覆盖或追加）。
/// 参数：state——全局状态；ws——工作空间。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn workspace_save(state: State<'_, AppState>, ws: Workspace) -> Result<(), AppError> {
    state.config.save_workspace(ws)
}

/// 按 id 删除工作空间。
/// 参数：state——全局状态；id——工作空间 id。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn workspace_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.config.delete_workspace(&id)
}

/// 读取持久化布局。
/// 参数：state——全局状态。
/// 返回：PersistedLayout 或 AppError。
#[tauri::command]
pub fn layout_get(state: State<'_, AppState>) -> Result<PersistedLayout, AppError> {
    Ok(state.config.layout())
}

/// 保存持久化布局。
/// 参数：state——全局状态；layout——新的布局。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn layout_save(state: State<'_, AppState>, layout: PersistedLayout) -> Result<(), AppError> {
    state.config.save_layout(layout)
}
