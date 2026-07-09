//! 输出泵（pump.rs，全应用性能命脉，对照计划 8.2 / 风险 1）。
//!
//! reader 线程把 PTY 原始字节经 mpsc 送来，本模块的 pump 线程按
//! 「距上次发送 ≥16ms 或 pending ≥64KB」聚合刷帧，避免逐字节直发 event 拥塞 webview：
//!   1. 原始字节进环形缓冲 ring；
//!   2. activity 扫描（BEL / 活动检测），驱动状态机；
//!   3. 按 UTF-8 `valid_up_to()` 切出完整前缀，残尾留 carry 下帧拼接（解决中文被读边界劈断）；
//!   4. 若 sink 有 Channel 则 send Data。
//! `ch.send()` 失败（webview 刷新）→ sink 置 None 防御清理。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::config::model::{PtyOutputMsg, SessionState, SessionStatePayload, EVT_SESSION_STATE};
use crate::pty::session::PtySession;

/// 刷帧最小间隔（毫秒）。
const FLUSH_INTERVAL_MS: u64 = 16;
/// 刷帧字节阈值（累积到此立即刷帧）。
const FLUSH_BYTES: usize = 64 * 1024;
/// recv 轮询超时（毫秒）。
const RECV_TIMEOUT_MS: u64 = 4;
/// 系统通知防抖间隔。
const NOTIFY_DEBOUNCE: Duration = Duration::from_secs(30);

/// pump 线程主循环：从 reader 收字节、聚合、刷帧，直至 reader 端断开。
///
/// 参数：
///   - `rx`：来自 reader 线程的字节流；
///   - `session`：目标会话（与命令层 / tick 线程共享）；
///   - `app`：AppHandle（emit 状态事件、发系统通知）；
///   - `session_id`：会话 id；
///   - `notify_on_waiting`：是否在等待输入时发系统通知（跟随全局配置）。
/// 返回：无（线程结束即退出）。
pub fn run_pump(
    rx: Receiver<Vec<u8>>,
    session: Arc<Mutex<PtySession>>,
    app: AppHandle,
    session_id: String,
    notify_on_waiting: Arc<AtomicBool>,
) {
    let mut pending: Vec<u8> = Vec::new();
    // carry：上一帧末尾不完整的 UTF-8 残字节，尚未写入 ring，下一帧拼接。
    let mut carry: Vec<u8> = Vec::new();
    let mut last_flush = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(RECV_TIMEOUT_MS)) {
            Ok(chunk) => pending.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                // reader 结束：把残余（含 carry）以 lossy 方式最后刷一帧。
                flush(
                    &session,
                    &app,
                    &session_id,
                    &notify_on_waiting,
                    &mut pending,
                    &mut carry,
                    true,
                );
                break;
            }
        }

        let should_flush = !pending.is_empty()
            && (last_flush.elapsed() >= Duration::from_millis(FLUSH_INTERVAL_MS)
                || pending.len() >= FLUSH_BYTES);
        if should_flush {
            flush(
                &session,
                &app,
                &session_id,
                &notify_on_waiting,
                &mut pending,
                &mut carry,
                false,
            );
            last_flush = Instant::now();
        }
    }
}

/// 刷一帧：拼 carry+pending → 切 UTF-8 完整前缀 → 写 ring / 扫 BEL / 发 Data → 更新状态。
///
/// 参数：
///   - `session`/`app`/`session_id`/`notify_on_waiting`：同 run_pump；
///   - `pending`/`carry`：输入/残尾缓冲（会被本函数消费与更新）；
///   - `final_flush`：true 表示 reader 已断开，残尾也一并 lossy 输出（不再留 carry）。
/// 返回：无。
#[allow(clippy::too_many_arguments)]
fn flush(
    session: &Arc<Mutex<PtySession>>,
    app: &AppHandle,
    session_id: &str,
    notify_on_waiting: &Arc<AtomicBool>,
    pending: &mut Vec<u8>,
    carry: &mut Vec<u8>,
    final_flush: bool,
) {
    if pending.is_empty() && carry.is_empty() {
        return;
    }
    // 拼接 carry（上帧残尾，最旧）与 pending（本帧新数据）。
    let mut combined: Vec<u8> = Vec::with_capacity(carry.len() + pending.len());
    combined.append(carry); // carry 被清空
    combined.append(pending); // pending 被清空

    // 按 UTF-8 完整性切分：final_flush 时全部消费（lossy），否则只消费完整前缀。
    let valid = if final_flush {
        combined.len()
    } else {
        match std::str::from_utf8(&combined) {
            Ok(_) => combined.len(),
            Err(e) => e.valid_up_to(),
        }
    };
    let consumed = &combined[..valid];
    // 残尾留待下帧（final_flush 时为空）。
    *carry = combined[valid..].to_vec();

    if consumed.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(consumed).into_owned();

    // ---- 锁内：写 ring、扫 BEL、发 Data、更新状态、算通知防抖 ----
    let mut state_payload: Option<SessionStatePayload> = None;
    let mut do_notify = false;
    let mut notify_title = String::new();
    {
        let mut s = session.lock();
        s.ring.push(consumed);
        let bel = s.scanner.scan(consumed);
        s.last_output = Instant::now();

        // 发送实时增量；send 失败说明 webview 已断开，清理 sink。
        let mut drop_sink = false;
        if let Some(sink) = &s.sink {
            if sink.send(PtyOutputMsg::Data { data: text }).is_err() {
                drop_sink = true;
            }
        }
        if drop_sink {
            s.sink = None;
        }

        // 状态机：dead 不再变；bel → waiting（优先，需用户输入清除）；否则 idle→running。
        let mut changed = false;
        if s.info.state != SessionState::Dead {
            if bel {
                if s.info.state != SessionState::Waiting {
                    s.info.state = SessionState::Waiting;
                    changed = true;
                }
            } else if s.info.state == SessionState::Idle {
                s.info.state = SessionState::Running;
                changed = true;
            }
        }

        if changed {
            state_payload = Some(SessionStatePayload {
                session_id: s.info.session_id.clone(),
                workspace_id: s.info.workspace_id.clone(),
                state: s.info.state,
            });
            // 变为 waiting 且开启通知：30s 防抖后决定是否发通知。
            if s.info.state == SessionState::Waiting && notify_on_waiting.load(Ordering::Relaxed) {
                let now = Instant::now();
                let ok = s
                    .last_notify
                    .map_or(true, |t| now.duration_since(t) >= NOTIFY_DEBOUNCE);
                if ok {
                    s.last_notify = Some(now);
                    do_notify = true;
                    notify_title = s.info.title.clone();
                }
            }
        }
    }

    // ---- 锁外：emit 状态事件 + 视窗口聚焦情况发系统通知 ----
    if let Some(p) = state_payload {
        let _ = app.emit(EVT_SESSION_STATE, p);
    }
    if do_notify && !window_focused(app) {
        let body = format!("{notify_title} 正在等待输入");
        let _ = app
            .notification()
            .builder()
            .title("tht-panel")
            .body(body)
            .show();
    }
    let _ = session_id; // 保留形参语义（会话定位由 session 句柄完成）
}

/// 判断主窗口当前是否聚焦（聚焦时不打扰用户，不发通知）。
/// 参数：app——AppHandle；返回：主窗口存在且聚焦则 true；取不到状态时保守返回 false（允许通知）。
fn window_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}
