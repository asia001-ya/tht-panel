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

/// 任务提示写入失败阶段，用于区分写前拒绝与可能部分交付。
pub(crate) enum TaskPromptWriteError {
    /// 写入开始前的会话校验失败
    Rejected(AppError),
    /// 写入开始后结果不确定，禁止自动重试
    DeliveryUnknown(AppError),
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
            let arcs: Vec<Arc<Mutex<PtySession>>> = sessions.lock().values().cloned().collect();
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
    /// 流程：openpty(按 cols/rows) → spawn_command → **立即 drop(slave)** →
    /// 取得 reader/writer/killer → 写入可选初始命令 → 起 reader/pump/waiter 三线程。
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
        let cmd = build_command(&launch);

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
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Pty(format!("take writer 失败: {e}")))?;
        let mut killer = child.clone_killer();
        write_initial_command_or_terminate(
            writer.as_mut(),
            launch.initial_command.as_deref(),
            || {
                let _ = killer.kill();
            },
        )?;

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
            write_session(&mut s, data)?;
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

    /// 在同一会话锁内校验 AI 会话类型与状态并写入任务提示。
    /// 参数：session_id——会话标识；data——单行任务提示；返回：成功或带交付阶段的错误。
    pub(crate) fn validate_and_write_task(
        &self,
        session_id: &str,
        data: &str,
    ) -> Result<(), TaskPromptWriteError> {
        let session = self
            .get(session_id)
            .map_err(TaskPromptWriteError::Rejected)?;
        let mut session = session.lock();
        validate_task_prompt_session(&session.info, session_id)
            .map_err(TaskPromptWriteError::Rejected)?;
        if session.writer.is_none() {
            return Err(TaskPromptWriteError::Rejected(AppError::Pty(
                "会话写入端不可用".to_string(),
            )));
        }
        write_session(&mut session, data).map_err(TaskPromptWriteError::DeliveryUnknown)
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
            s.info.state = SessionState::Dead;
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

    /// 按标识读取单个会话的当前信息快照。
    /// 参数：session_id——会话标识；返回：PtySessionInfo 或 AppError。
    pub fn info(&self, session_id: &str) -> Result<PtySessionInfo, AppError> {
        let session = self.get(session_id)?;
        let info = session.lock().info.clone();
        Ok(info)
    }

    /// attach：原子发送环形缓冲快照并设定 sink（抢占替换旧 sink）。
    /// Channel 有序 ⇒ 后续 Data 必排在 Snapshot 之后，无需序号机制（计划 8.3）。
    /// 参数：session_id——会话 id；channel——输出通道；返回：() 或 AppError。
    pub fn attach(&self, session_id: &str, channel: Channel<PtyOutputMsg>) -> Result<(), AppError> {
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
        let arcs: Vec<Arc<Mutex<PtySession>>> = self.sessions.lock().values().cloned().collect();
        for arc in arcs {
            let mut session = arc.lock();
            session.info.state = SessionState::Dead;
            let _ = session.killer.kill();
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

/// 校验任务提示的会话标识、AI 类型和可注入状态。
/// 参数：info——会话快照；session_id——提交会话标识；返回：成功或 AppError。
pub(crate) fn validate_task_prompt_session(
    info: &PtySessionInfo,
    session_id: &str,
) -> Result<(), AppError> {
    if info.session_id != session_id {
        return Err(AppError::Other("PTY 会话标识不匹配".to_string()));
    }
    if !matches!(info.kind.as_str(), "claude" | "codex") {
        return Err(AppError::Other(
            "仅 Claude/Codex 会话可接收任务".to_string(),
        ));
    }
    if matches!(info.state, SessionState::Waiting | SessionState::Dead) {
        return Err(AppError::Other(format!(
            "当前会话状态不可注入: {:?}",
            info.state
        )));
    }
    Ok(())
}

/// 向已加锁会话完整写入文本并刷新写入端。
/// 参数：session——已加锁会话；data——输入文本；返回：成功或 AppError。
fn write_session(session: &mut PtySession, data: &str) -> Result<(), AppError> {
    let writer = session
        .writer
        .as_mut()
        .ok_or_else(|| AppError::Pty("会话写入端不可用".to_string()))?;
    write_all_and_flush(writer.as_mut(), data.as_bytes())
}

/// 完整写入全部字节并刷新写入端。
/// 参数：writer——PTY 写入端；data——待写字节；返回：成功或 AppError。
fn write_all_and_flush(writer: &mut dyn Write, data: &[u8]) -> Result<(), AppError> {
    writer
        .write_all(data)
        .map_err(|error| AppError::Pty(format!("写入失败: {error}")))?;
    writer
        .flush()
        .map_err(|error| AppError::Pty(format!("刷新失败: {error}")))?;
    Ok(())
}

/// 写入一次性初始命令；写入或刷新失败时先终止刚创建的子进程。
/// 参数：writer——PTY 写入端；initial_command——不含回车的可选命令；terminate——失败清理回调；返回：成功或 AppError。
fn write_initial_command_or_terminate<F>(
    writer: &mut dyn Write,
    initial_command: Option<&str>,
    terminate: F,
) -> Result<(), AppError>
where
    F: FnOnce(),
{
    let Some(command) = initial_command else {
        return Ok(());
    };
    let mut input = Vec::with_capacity(command.len() + 1);
    input.extend_from_slice(command.as_bytes());
    input.push(b'\r');
    if let Err(error) = write_all_and_flush(writer, &input) {
        terminate();
        return Err(error);
    }
    Ok(())
}

/// 根据解析后的启动描述构建原生 Shell 子进程命令。
/// 参数：launch——程序、参数、目录与供应商环境；返回：可交给 PTY 启动的命令。
fn build_command(launch: &ResolvedLaunch) -> CommandBuilder {
    let mut command = CommandBuilder::new(&launch.program);
    for arg in &launch.args {
        command.arg(arg);
    }
    command.cwd(&launch.cwd);
    for (key, value) in &launch.env {
        command.env(key, value);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::{
        build_command, validate_task_prompt_session, write_all_and_flush,
        write_initial_command_or_terminate,
    };
    use crate::config::model::{PtySessionInfo, SessionState};
    use crate::pty::spawn::ResolvedLaunch;
    use std::ffi::OsStr;
    use std::io::{self, Write};

    /// 完整记录写入、刷新次数与交付字节的测试写入端。
    struct RecordingWriter {
        delivered: Vec<u8>,
        writes: usize,
        flushes: usize,
    }

    impl RecordingWriter {
        /// 创建空的记录写入端。
        /// 参数：无；返回：尚无写入记录的实例。
        fn new() -> Self {
            Self {
                delivered: Vec::new(),
                writes: 0,
                flushes: 0,
            }
        }
    }

    impl Write for RecordingWriter {
        /// 完整记录本次写入。
        /// 参数：buffer——待写字节；返回：全部字节数。
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            self.delivered.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        /// 记录一次刷新。
        /// 参数：无；返回：成功。
        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    /// 首次只写部分字节、后续写入失败的测试写入端。
    struct PartialThenFailWriter {
        delivered: Vec<u8>,
        writes: usize,
    }

    impl PartialThenFailWriter {
        /// 创建尚未写入任何字节的测试写入端。
        /// 参数：无；返回：测试写入端。
        fn new() -> Self {
            Self {
                delivered: Vec::new(),
                writes: 0,
            }
        }
    }

    impl Write for PartialThenFailWriter {
        /// 首次交付三个字节，后续返回模拟错误。
        /// 参数：buffer——待写字节；返回：本次写入数量或 IO 错误。
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            if self.writes > 1 {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "模拟部分写失败"));
            }
            let written = buffer.len().min(3);
            self.delivered.extend_from_slice(&buffer[..written]);
            Ok(written)
        }

        /// 刷新测试写入端。
        /// 参数：无；返回：成功。
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// 写入成功但刷新失败的测试写入端。
    struct FlushFailWriter {
        delivered: Vec<u8>,
    }

    impl Write for FlushFailWriter {
        /// 完整记录本次写入字节。
        /// 参数：buffer——待写字节；返回：全部字节数。
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.delivered.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        /// 模拟刷新失败。
        /// 参数：无；返回：IO 错误。
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "模拟刷新失败"))
        }
    }

    /// 验证完整写入失败前可能已经交付部分字节。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn write_all_reports_error_after_partial_delivery() {
        let mut writer = PartialThenFailWriter::new();

        let error = write_all_and_flush(&mut writer, b"task-prompt")
            .expect_err("部分交付后失败必须返回错误");

        assert_eq!(writer.delivered, b"tas");
        assert!(error.to_string().contains("写入失败"));
    }

    /// 验证字节写入成功后的刷新失败仍向调用方传播。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn write_all_propagates_flush_failure() {
        let mut writer = FlushFailWriter {
            delivered: Vec::new(),
        };

        let error =
            write_all_and_flush(&mut writer, b"task-prompt").expect_err("刷新失败必须向调用方传播");

        assert_eq!(writer.delivered, b"task-prompt");
        assert!(error.to_string().contains("刷新失败"));
    }

    /// 验证 AI 初始命令只写入一次并只追加一个回车。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn initial_command_is_written_once() {
        let mut writer = RecordingWriter::new();
        let mut terminate_count = 0usize;

        write_initial_command_or_terminate(&mut writer, Some("codex 'resume' 'session-1'"), || {
            terminate_count += 1
        })
        .expect("合法初始命令应写入成功");

        assert_eq!(writer.delivered, b"codex 'resume' 'session-1'\r");
        assert_eq!(writer.writes, 1);
        assert_eq!(writer.flushes, 1);
        assert_eq!(terminate_count, 0);
    }

    /// 验证纯 Shell 会话不产生任何初始输入。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn shell_without_initial_command_writes_nothing() {
        let mut writer = RecordingWriter::new();
        let mut terminate_count = 0usize;

        write_initial_command_or_terminate(&mut writer, None, || terminate_count += 1)
            .expect("纯 Shell 不应写入初始命令");

        assert!(writer.delivered.is_empty());
        assert_eq!(writer.writes, 0);
        assert_eq!(writer.flushes, 0);
        assert_eq!(terminate_count, 0);
    }

    /// 验证初始命令写入失败时恰好终止一次刚创建的子进程。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn initial_command_failure_terminates_child_once() {
        let mut writer = PartialThenFailWriter::new();
        let mut terminate_count = 0usize;

        let error = write_initial_command_or_terminate(
            &mut writer,
            Some("claude --resume session-1"),
            || terminate_count += 1,
        )
        .expect_err("部分写入失败必须终止子进程");

        assert_eq!(writer.delivered, b"cla");
        assert_eq!(terminate_count, 1);
        assert!(error.to_string().contains("写入失败"));
    }

    /// 验证协作注入只校验真实会话属性，不依赖无法可靠识别的 AI 前台标记。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn idle_ai_session_is_valid_without_private_foreground_signal() {
        let info = PtySessionInfo {
            session_id: "pty-1".to_string(),
            workspace_id: Some("project-1".to_string()),
            kind: "codex".to_string(),
            cwd: ".".to_string(),
            title: "codex".to_string(),
            resumed_from: None,
            state: SessionState::Idle,
            created_at: "2026-07-15T00:00:00Z".to_string(),
        };

        validate_task_prompt_session(&info, "pty-1").expect("idle AI 会话应允许人工确认后注入");
    }

    /// 验证实际启动命令不强制覆盖 Shell 的终端能力环境。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn command_preserves_shell_terminal_environment() {
        let launch = ResolvedLaunch {
            program: "powershell.exe".to_string(),
            args: Vec::new(),
            cwd: ".".to_string(),
            env: vec![("OPENAI_API_KEY".to_string(), "test-key".to_string())],
            title: "PowerShell".to_string(),
            kind: "shell".to_string(),
            resumed_from: None,
            initial_command: None,
        };
        let command = build_command(&launch);

        assert_eq!(command.get_env("TERM"), None);
        assert_eq!(command.get_env("COLORTERM"), None);
        assert_eq!(
            command.get_env("OPENAI_API_KEY"),
            Some(OsStr::new("test-key"))
        );
    }
}
