//! 应用全局状态 AppState。
//!
//! 由 Tauri 以 `app.manage(AppState)` 托管，命令层通过 `tauri::State<'_, AppState>` 访问。
//! 聚合四大子系统：
//! - `pty`：PtyManager，PTY 会话真相持有者（spawn/kill/attach/detach/list）；
//! - `config`：ConfigStore，应用配置的原子读写与缓存；
//! - `tasks`：TaskStore，窗格协作任务的持久化状态机；
//! - `usage`：UsageScanner，Claude/Codex 会话 JSONL 的 token 用量扫描与缓存。

use crate::collaboration::store::TaskStore;
use crate::config::store::ConfigStore;
use crate::error::AppError;
use crate::pty::manager::PtyManager;
use crate::usage::UsageScanner;

/// 应用全局状态。字段公开供命令层直接取用。
pub struct AppState {
    /// PTY 会话管理器
    pub pty: PtyManager,
    /// 配置存储
    pub config: ConfigStore,
    /// 窗格协作任务存储
    pub tasks: TaskStore,
    /// Token 用量扫描器
    pub usage: UsageScanner,
}

impl AppState {
    /// 构建全局状态：先加载配置与任务，再创建 PtyManager 与用量扫描器。
    ///
    /// 约定：`PtyManager::new(app: tauri::AppHandle)` —— PtyManager 需持有 AppHandle
    /// 以便 pump/activity 线程 emit `session://state`、`session://exit` 全局事件。
    /// （pty 模块须与此签名保持一致。）
    ///
    /// 参数：app——Tauri AppHandle；返回：AppState 或 AppError。
    pub fn new(app: &tauri::AppHandle) -> Result<Self, AppError> {
        let config = ConfigStore::new(app)?;
        let tasks = TaskStore::new(config.config_dir())?;
        let pty = PtyManager::new(app.clone());
        // 仅载入既有缓存，不在启动路径上做磁盘扫描，避免拖慢冷启动。
        let usage = UsageScanner::new(app)?;
        Ok(Self {
            pty,
            config,
            tasks,
            usage,
        })
    }
}
