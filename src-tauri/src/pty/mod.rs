//! PTY 子系统：一切 PTY 会话真相的持有者。
//!
//! 子模块：
//! - `ring`：字节环形缓冲（scrollback）；
//! - `activity`：BEL 感知扫描器（区分真响铃与 OSC 标题设置）；
//! - `spawn`：三模式启动命令组装（ResolvedLaunch / build_resolved_launch）；
//! - `session`：单会话运行时状态 PtySession；
//! - `pump`：输出泵（聚合刷帧，性能命脉）；
//! - `manager`：会话表管理器 PtyManager（spawn/write/resize/kill/list/attach/detach/kill_all）。

pub mod activity;
pub mod manager;
pub mod pump;
pub mod ring;
pub mod session;
pub mod spawn;

// 常用项上提，便于其它模块引用。
pub use manager::PtyManager;
pub use spawn::{build_resolved_launch, ResolvedLaunch};
