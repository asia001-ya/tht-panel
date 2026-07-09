//! PTY 会话管理器（manager.rs，真相持有者，对照计划 8.1/8.3/风险 2、10）。
//!
//! 持有全部会话表 `HashMap<session_id, Arc<Mutex<PtySession>>>`，负责：
//!   - spawn：openpty → spawn_command → drop(slave) → 起 reader/pump/waiter 三线程；
//!   - write/resize/kill/list/attach/detach 转发；
//!   - 全局 1s tick 线程做 running→idle 降级；
//!   - kill_all：应用退出时遍历 killer.kill() 防残留（风险 10）。
//! 锁一律 parking_lot::Mutex（无 poisoning）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::config::model::{
    PtyOutputMsg, PtySessionInfo, SessionExitPayload, SessionState, SessionStatePayload,
    EVT_SESSION_EXIT, EVT_SESSION_STATE,
};
use crate::error::AppError;
use crate::pty::activity::BelScanner;
use crate::pty::pump::run_pump;
use crate::pty::ring::RingBuffer;
use crate::pty::session::PtySession;
use crate::pty::spawn::ResolvedLaunch;

/// running→idle 的静默阈值：最近一次输出距今超过此时长则降级为 idle。
const IDLE_AFTER: Duration = Duration::from_secs(2);
/// reader 单次读取缓冲大小。
const READ_BUF: usize = 8192;

/// 会话表类型别名。
type SessionMap = Arc<Mutex<HashMap<String, Arc<Mutex<PtySession>>>>>;

/// PTY 会话管理器。
pub struct PtyManager {
    /// Tauri 句柄（供内部线程 emit 全局事件、发通知）
    app: AppHandle,
    /// 会话表
    sessions: SessionMap,
    /// 是否在等待输入时发系统通知（跟随全局配置，由 config_set 更新）
    notify_on_waiting: Arc<AtomicBool>,
}

impl PtyManager {
    /// 创建管理器并启动全局 tick 线程（running→idle 降级）。
    /// 参数：app——Tauri AppHandle；返回：PtyManager。
    pub fn new(app: AppHandle) -> Self {
        let sessions: SessionMap = Arc::new(Mutex::new(HashMap::new()));
        let mgr = Self {
            app: app.clone(),
            sessions: sessions.clone(),
            notify_on_waiting: Arc::new(AtomicBool::new(true)),
        };
        mgr.spawn_tick_thread(sessions, app);
        mgr
    }

    /// 启动 1s tick 线程：把「running 且静默超时」的会话降级为 idle 并广播。
    /// 参数：sessions——会话表克隆；app——AppHandle 克隆；返回：无。
    fn spawn_tick_thread(&self, sessions: SessionMap, app: AppHandle) {
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(1));
            // 收集当前会话句柄快照，避免持锁做 emit。
            let arcs: Vec<Arc<Mutex<PtySession>>> =
                sessions.lock().values().cloned().collect();
            for arc in arcs {
                let mut payload: Option<SessionStatePayload> = None;
                {
                    let mut s = arc.lock();
                    if s.info.state == SessionState::Running
                        && s.last_output.elapsed() >= IDLE_AFTER
                    {
                        s.info.state = SessionState::Idle;
                        payload = Some(SessionStatePayload {
                            session_id: s.info.session_id.clone(),
                            workspace_id: s.info.workspace_id.clone(),
                            state: s.info.state,
                        });
                    }
                }
                if let Some(p) = payload {
                    let _ = app.emit(EVT_SESSION_STATE, p);
                }
            }
        });
    }

    /// 更新「等待输入时发系统通知」开关（由 config_set 同步全局配置）。
    /// 参数：v——是否开启；返回：无。
    pub fn set_notify_on_waiting(&self, v: bool) {
        self.notify_on_waiting.store(v, Ordering::Relaxed);
    }

    /// 启动一个新 PTY 会话。
    ///
    /// 流程（计划 8.1）：openpty(按 cols/rows) → spawn_command → **立即 drop(slave)** →
    /// try_clone_reader / take_writer / clone_killer → 起 reader/pump/waiter 三线程。
    /// spawn 后**不 attach**（由前端随后调用 pty_attach）。
    ///
    /// 参数：launch——已解析启动描述；req 的 cols/rows/workspace_id 等经 launch 与本函数使用；
    ///       cols/rows——初始终端尺寸；scrollback_bytes——环形缓冲上限。
    /// 返回：新会话的 PtySessionInfo 或 AppError。
    pub fn spawn(
        &self,
        launch: ResolvedLaunch,
        cols: u16,
        rows: u16,
        workspace_id: Option<String>,
        scrollback_bytes: usize,
    ) -> Result<PtySessionInfo, AppError> {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system
            .openpty(size)
            .map_err(|e| AppError::Pty(format!("openpty 失败: {e}")))?;

        // 组装命令：宿主 + 参数 + cwd + env 注入。
        let mut cmd = CommandBuilder::new(&launch.program);
        for a in &launch.args {
            cmd.arg(a);
        }
        cmd.cwd(&launch.cwd);
        for (k, v) in &launch.env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Pty(format!("spawn 子进程失败: {e}")))?;
        // 关键：立即 drop slave，否则子进程退出后 reader 永不返回 EOF。
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Pty(format!("clone reader 失败: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Pty(format!("take writer 失败: {e}")))?;
        let killer = child.clone_killer();

        let session_id = Uuid::new_v4().to_string();
        let info = PtySessionInfo {
            session_id: session_id.clone(),
            workspace_id,
            kind: launch.kind.clone(),
            cwd: launch.cwd.clone(),
            title: launch.title.clone(),
            resumed_from: launch.resumed_from.clone(),
            state: SessionState::Running,
            created_at: now_iso(),
        };

        let session = PtySession {
            info: info.clone(),
            writer: Some(writer),
            master: pair.master,
            killer,
            ring: RingBuffer::new(scrollback_bytes),
            sink: None,
            scanner: BelScanner::new(),
            last_output: Instant::now(),
            last_notify: None,
        };
        let arc = Arc::new(Mutex::new(session));
        self.sessions.lock().insert(session_id.clone(), arc.clone());

        // reader 线程：阻塞读 → mpsc → pump。
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        {
            let mut reader = reader;
            thread::spawn(move || {
                let mut buf = [0u8; READ_BUF];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break, // EOF：子进程退出且 slave 已释放
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break; // pump 端已退出
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // pump 线程：聚合刷帧（ring + BEL + Channel）。
        {
            let arc_pump = arc.clone();
            let app = self.app.clone();
            let sid = session_id.clone();
            let notify = self.notify_on_waiting.clone();
            thread::spawn(move || run_pump(rx, arc_pump, app, sid, notify));
        }

        // waiter 线程：child.wait() 阻塞 → 退出后置 dead + 发 exit + 广播。
        {
            let sessions = self.sessions.clone();
            let app = self.app.clone();
            let sid = session_id.clone();
            let mut child = child;
            thread::spawn(move || {
                let code = child.wait().ok().map(|st| st.exit_code() as i32);
                // 进程死后会话保留在表中（缓冲可回看），仅更新状态并广播。
                if let Some(arc) = sessions.lock().get(&sid).cloned() {
                    let (state_payload, exit_payload) = {
                        let mut s = arc.lock();
                        s.info.state = SessionState::Dead;
                        if let Some(sink) = &s.sink {
                            let _ = sink.send(PtyOutputMsg::Exit { code });
                        }
                        (
                            SessionStatePayload {
                                session_id: s.info.session_id.clone(),
                                workspace_id: s.info.workspace_id.clone(),
                                state: s.info.state,
                            },
                            SessionExitPayload {
                                session_id: sid.clone(),
                                exit_code: code,
                            },
                        )
                    };
                    let _ = app.emit(EVT_SESSION_STATE, state_payload);
                    let _ = app.emit(EVT_SESSION_EXIT, exit_payload);
                }
            });
        }

        Ok(info)
    }

    /// 向会话写入数据；若会话处于 waiting，写入后清除为 running 并广播。
    /// 参数：session_id——会话 id；data——待写入文本；返回：() 或 AppError。
    pub fn write(&self, session_id: &str, data: &str) -> Result<(), AppError> {
        let arc = self.get(session_id)?;
        let mut cleared: Option<SessionStatePayload> = None;
        {
            let mut s = arc.lock();
            if let Some(w) = s.writer.as_mut() {
                w.write_all(data.as_bytes())
                    .map_err(|e| AppError::Pty(format!("写入失败: {e}")))?;
                let _ = w.flush();
            }
            // 用户输入 → 清除 waiting（计划 8.4）。
            if s.info.state == SessionState::Waiting {
                s.info.state = SessionState::Running;
                s.last_output = Instant::now();
                cleared = Some(SessionStatePayload {
                    session_id: s.info.session_id.clone(),
                    workspace_id: s.info.workspace_id.clone(),
                    state: s.info.state,
                });
            }
        }
        if let Some(p) = cleared {
            let _ = self.app.emit(EVT_SESSION_STATE, p);
        }
        Ok(())
    }

    /// 调整会话终端尺寸（cols/rows 钳制下限 2，风险 6）。
    /// 参数：session_id——会话 id；cols/rows——目标列/行；返回：() 或 AppError。
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        let arc = self.get(session_id)?;
        let s = arc.lock();
        s.master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty(format!("resize 失败: {e}")))?;
        Ok(())
    }

    /// 杀死会话进程并从会话表移除（用户主动关闭 leaf / kill 时调用）。
    /// 参数：session_id——会话 id；返回：() 或 AppError。
    pub fn kill(&self, session_id: &str) -> Result<(), AppError> {
        let arc = self.get(session_id)?;
        {
            let mut s = arc.lock();
            let _ = s.killer.kill();
        }
        self.sessions.lock().remove(session_id);
        Ok(())
    }

    /// 列出全部会话信息（含已 dead 但保留待回看者）。
    /// 参数：无；返回：Vec<PtySessionInfo>。
    pub fn list(&self) -> Vec<PtySessionInfo> {
        self.sessions
            .lock()
            .values()
            .map(|a| a.lock().info.clone())
            .collect()
    }

    /// attach：原子发送环形缓冲快照并设定 sink（抢占替换旧 sink）。
    /// Channel 有序 ⇒ 后续 Data 必排在 Snapshot 之后，无需序号机制（计划 8.3）。
    /// 参数：session_id——会话 id；channel——输出通道；返回：() 或 AppError。
    pub fn attach(
        &self,
        session_id: &str,
        channel: Channel<PtyOutputMsg>,
    ) -> Result<(), AppError> {
        let arc = self.get(session_id)?;
        let mut s = arc.lock();
        // 快照用 lossy 转字符串（环形起点半字符容忍一个替换符）。
        let snapshot = String::from_utf8_lossy(&s.ring.snapshot()).into_owned();
        let _ = channel.send(PtyOutputMsg::Snapshot { data: snapshot });
        // 若进程已退出，补发一条 exit 让前端标注现场。
        if s.info.state == SessionState::Dead {
            let _ = channel.send(PtyOutputMsg::Exit { code: None });
        }
        s.sink = Some(channel);
        Ok(())
    }

    /// detach：清除 sink，之后仅写 ring 不再推前端。
    /// 参数：session_id——会话 id；返回：() 或 AppError（会话不存在也视为成功）。
    pub fn detach(&self, session_id: &str) -> Result<(), AppError> {
        if let Some(arc) = self.sessions.lock().get(session_id).cloned() {
            arc.lock().sink = None;
        }
        Ok(())
    }

    /// 杀死全部会话进程（应用退出路径，风险 10：防残留 powershell/node）。
    /// 参数：无；返回：无。
    pub fn kill_all(&self) {
        let arcs: Vec<Arc<Mutex<PtySession>>> =
            self.sessions.lock().values().cloned().collect();
        for arc in arcs {
            let _ = arc.lock().killer.kill();
        }
        self.sessions.lock().clear();
    }

    /// 内部：按 id 取会话句柄，不存在返回 NotFound。
    /// 参数：session_id——会话 id；返回：Arc<Mutex<PtySession>> 或 AppError。
    fn get(&self, session_id: &str) -> Result<Arc<Mutex<PtySession>>, AppError> {
        self.sessions
            .lock()
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("会话不存在: {session_id}")))
    }
}

/// 当前时刻的 RFC3339（UTC）字符串。
/// 参数：无；返回：时间戳字符串。
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}
