//! 配置模块：数据模型（model）与磁盘存储（store）。
//!
//! - `model`：全 crate 共用的 serde 数据结构、会话状态枚举、PTY 输出消息、
//!   事件 payload 与事件名常量；字段名与前端 `src/api/types.ts` 严格 camelCase 对应。
//! - `store`：三个 JSON 配置文件（settings/workspaces/layout）的原子读写与内存缓存。

pub mod model;
pub mod store;

// 常用项上提到 crate::config::* 便于其它模块引用。
pub use model::{
    AgentConfig, GlobalConfig, ManagedSession, PersistedLayout, PtyOutputMsg, PtySessionInfo,
    SessionExitPayload, SessionHistoryEntry, SessionState, SessionStatePayload, SpawnRequest,
    Workspace, EVT_QUIT_REQUEST, EVT_SESSION_EXIT, EVT_SESSION_STATE,
};
pub use store::ConfigStore;
