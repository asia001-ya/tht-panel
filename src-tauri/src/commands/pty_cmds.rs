//! PTY 相关命令：转发到 PtyManager，spawn 前先经 ConfigStore 解析启动描述。
//!
//! 约定：命令层只做参数搬运与错误透传，不含业务逻辑；返回 `Result<T, AppError>`，
//! 错误会被 Tauri 序列化为 `{code,message}` 交给前端。

use tauri::ipc::Channel;
use tauri::State;

use crate::config::model::{PtyOutputMsg, PtySessionInfo, SpawnRequest};
use crate::error::AppError;
use crate::state::AppState;

/// 启动一个 PTY 会话。
///
/// 流程：ConfigStore::resolve_launch 组装 ResolvedLaunch（读全局/工作空间配置、
/// 注入 env、生成 CODEX_HOME）→ PtyManager::spawn 起进程与三线程。**spawn 后不 attach**，
/// 由前端随后调用 pty_attach。
/// 参数：state——全局状态；_app——AppHandle（保留形参，会话事件由 manager 内部 emit）；req——启动请求。
/// 返回：新会话 PtySessionInfo 或 AppError。
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, AppState>,
    _app: tauri::AppHandle,
    req: SpawnRequest,
) -> Result<PtySessionInfo, AppError> {
    // 临时诊断：确认前端是否调用到后端，以及失败在哪一步。
    eprintln!("[DIAG] pty_spawn 进入: kind={} ws={:?}", req.kind, req.workspace_id);
    let launch = state.config.resolve_launch(&req).inspect_err(|e| {
        eprintln!("[DIAG] resolve_launch 失败: {e}");
    })?;
    eprintln!("[DIAG] resolve_launch 成功，准备 spawn");
    let scrollback = state.config.global().scrollback_bytes;
    state.pty.spawn(
        launch,
        req.cols,
        req.rows,
        req.workspace_id.clone(),
        scrollback,
    )
}

/// 向会话写入输入数据（顺带清除 waiting 状态）。
/// 参数：state——全局状态；session_id——会话 id；data——待写入文本。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn pty_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    state.pty.write(&session_id, &data)
}

/// 调整会话终端尺寸。
/// 参数：state——全局状态；session_id——会话 id；cols/rows——目标列/行。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    state.pty.resize(&session_id, cols, rows)
}

/// 杀死会话进程并从会话表移除。
/// 参数：state——全局状态；session_id——会话 id。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, session_id: String) -> Result<(), AppError> {
    state.pty.kill(&session_id)
}

/// 列出全部 PTY 会话信息。
/// 参数：state——全局状态。
/// 返回：Vec<PtySessionInfo>。
#[tauri::command]
pub fn pty_list(state: State<'_, AppState>) -> Result<Vec<PtySessionInfo>, AppError> {
    Ok(state.pty.list())
}

/// attach 会话到输出通道：发送快照并接管后续实时输出。
/// 参数：state——全局状态；session_id——会话 id；channel——前端提供的输出通道。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn pty_attach(
    state: State<'_, AppState>,
    session_id: String,
    channel: Channel<PtyOutputMsg>,
) -> Result<(), AppError> {
    state.pty.attach(&session_id, channel)
}

/// detach 会话：停止向前端推送（仅继续写环形缓冲）。
/// 参数：state——全局状态；session_id——会话 id。
/// 返回：() 或 AppError。
#[tauri::command]
pub fn pty_detach(state: State<'_, AppState>, session_id: String) -> Result<(), AppError> {
    state.pty.detach(&session_id)
}
