//! 命令层聚合模块：声明各命令子模块并重导出命令函数，
//! 供 `lib.rs` 的 `tauri::generate_handler!` 统一注册。
//!
//! 命令层职责单一：参数搬运 + 转发到 PtyManager / ConfigStore / history，
//! 返回 `Result<T, AppError>`（错误序列化为 `{code,message}`）。

pub mod config_cmds;
pub mod history_cmds;
pub mod pty_cmds;
pub mod session_cmds;
pub mod task_cmds;

use tauri::{Manager, State};

use crate::error::AppError;
use crate::state::AppState;

// 重导出全部命令函数，lib.rs 可 `use crate::commands::*;` 后直接 generate_handler。
pub use config_cmds::{
    config_get, config_set, layout_get, layout_save, workspace_delete, workspace_list,
    workspace_save,
};
pub use history_cmds::history_list;
pub use pty_cmds::{pty_attach, pty_detach, pty_kill, pty_list, pty_resize, pty_spawn, pty_write};
pub use task_cmds::{
    task_cancel, task_close, task_create, task_dispatch, task_forward, task_list, task_report,
};

/// 退出应用：杀死全部 PTY 会话（防残留 powershell/node，风险 10）后退出进程。
///
/// 参数：app——AppHandle（用于 exit）；state——全局状态（用于 kill_all）；
///       force——是否强制退出（当前实现无论如何都会 kill_all 并退出，保留形参供前端语义/未来扩展）。
/// 返回：() 或 AppError（正常路径不返回，exit 会终止进程）。
#[tauri::command]
pub fn app_quit(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    force: bool,
) -> Result<(), AppError> {
    let _ = force; // 确认流程在前端 / 托盘侧完成，此处统一执行清理与退出。
    state.pty.kill_all();
    app.exit(0);
    Ok(())
}

/// 判断当前是否存在"活跃"（未 dead）的 PTY 会话——托盘退出时据此决定直接退出还是弹确认。
/// 参数：app——AppHandle（用于取 AppState）；返回：存在未 dead 会话则 true。
pub fn has_active_sessions(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    state
        .pty
        .list()
        .iter()
        .any(|s| s.state != crate::config::model::SessionState::Dead)
}
