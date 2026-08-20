//! Token 用量统计命令。
//!
//! 两个命令共用「id → 绝对路径」的解析：前端传工作空间 id，
//! 但用量数据的归属键是磁盘路径（Claude 的 slug 由路径推导，Codex 直接存 cwd），
//! 故需先查配置拿到 path 再交给扫描器过滤。

use crate::error::AppError;
use crate::state::AppState;
use crate::usage::model::UsageQueryResult;

/// 查询用量统计（只读缓存并按条件聚合，不触发磁盘扫描）。
///
/// 参数：
///   - `state`：全局状态，含 UsageScanner；
///   - `workspace_id`：限定工作空间 id；`None` 表示统计全部项目；
///   - `range_days`：统计最近多少天（含今天）；`None` 用默认 30 天。
/// 返回：按日期升序的序列与各维度汇总。
#[tauri::command]
pub async fn usage_query(
    state: tauri::State<'_, AppState>,
    workspace_id: Option<String>,
    range_days: Option<u32>,
) -> Result<UsageQueryResult, AppError> {
    let workspace_path = resolve_workspace_path(&state, workspace_id);
    Ok(state
        .usage
        .query(workspace_path.as_deref(), range_days))
}

/// 强制扫描全部会话文件，更新缓存后返回最新统计。
///
/// 参数：
///   - `state`：全局状态，含 UsageScanner；
///   - `workspace_id`：限定工作空间 id；`None` 表示统计全部项目；
///   - `range_days`：统计最近多少天；`None` 用默认 30 天。
/// 返回：扫描后的最新统计。
#[tauri::command]
pub async fn usage_refresh(
    state: tauri::State<'_, AppState>,
    workspace_id: Option<String>,
    range_days: Option<u32>,
) -> Result<UsageQueryResult, AppError> {
    state.usage.scan()?;
    let workspace_path = resolve_workspace_path(&state, workspace_id);
    Ok(state
        .usage
        .query(workspace_path.as_deref(), range_days))
}

/// 把工作空间 id 解析为磁盘绝对路径。
///
/// 参数：`state`——全局状态；`workspace_id`——工作空间 id，None 表示不限定。
/// 返回：对应路径；id 为 None 或查不到该 id 时返回 None（退化为统计全部）。
fn resolve_workspace_path(
    state: &tauri::State<'_, AppState>,
    workspace_id: Option<String>,
) -> Option<String> {
    let id = workspace_id?;
    state
        .config
        .workspaces()
        .into_iter()
        .find(|ws| ws.id == id)
        .map(|ws| ws.path)
}
