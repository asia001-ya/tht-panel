//! 单个 PTY 会话的运行时状态（session.rs）。
//!
//! 每个会话由 `Arc<Mutex<PtySession>>` 持有，供命令层（write/resize/kill/attach）
//! 与内部线程（pump 输出泵 / tick 状态降级 / waiter 退出捕获）共享访问。
//! 锁一律用 `parking_lot::Mutex`（无 poisoning）。

use std::io::Write;
use std::time::Instant;

use portable_pty::{ChildKiller, MasterPty};
use tauri::ipc::Channel;

use crate::config::model::{PtyOutputMsg, PtySessionInfo};
use crate::pty::activity::{AgentForeground, BelScanner};
use crate::pty::ring::RingBuffer;

/// 一个存活（或已退出待回看）的 PTY 会话。
pub struct PtySession {
    /// 会话元信息（含 state，前端镜像的真相源）
    pub info: PtySessionInfo,
    /// 写入端（take_writer 仅一次，故用 Option 持有）
    pub writer: Option<Box<dyn Write + Send>>,
    /// 主控端（用于 resize）
    pub master: Box<dyn MasterPty + Send>,
    /// 跨线程杀进程句柄（clone_killer 得到）
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    /// 环形输出缓冲（scrollback，attach 时回放）
    pub ring: RingBuffer,
    /// 当前 attach 的输出通道；None 表示无前端显示，仅写 ring
    pub sink: Option<Channel<PtyOutputMsg>>,
    /// BEL 感知扫描器（跨帧保持状态）
    pub scanner: BelScanner,
    /// AI 命令是否仍处于 PowerShell 前台
    pub agent_foreground: AgentForeground,
    /// 最近一次收到输出的时刻（tick 线程据此做 running→idle 降级）
    pub last_output: Instant,
    /// 最近一次因 waiting 发系统通知的时刻（30s 防抖）
    pub last_notify: Option<Instant>,
}
