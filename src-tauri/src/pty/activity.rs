//! BEL 感知扫描器（activity.rs）：在 PTY 输出流里识别"真正的响铃"。
//!
//! 背景（计划 8.4 / 风险 8）：claude 等 TUI 频繁用 OSC 序列设置窗口标题
//! （`ESC ] 0 ; title BEL`），这类以 BEL(0x07) 结尾的 OSC 不算响铃。真正的
//! 等待输入提示是"处于 Ground 状态时收到裸 BEL"。
//!
//! 为此用一个 5 态 VT 扫描器，且**跨 chunk 保持状态**（转义序列可能被 16ms
//! 聚合帧从中间劈开）：只有 Ground 态遇到 0x07 才判定为真响铃。

/// PowerShell 中的 AI 子进程返回后输出的私有标记文本。
pub const AGENT_EXIT_MARKER_TEXT: &str = "tht-panel-agent-exit";
/// AI 子进程返回后写入 PTY 的完整未知 OSC 序列。
pub const AGENT_EXIT_SEQUENCE: &[u8] = b"\x1b]777;tht-panel-agent-exit\x07";

/// 跨块识别 AI 前台退出标记的单次扫描器。
pub struct AgentExitScanner {
    /// 当前已匹配的标记字节数
    matched: usize,
    /// 是否已经识别过退出标记
    exited: bool,
}

impl AgentExitScanner {
    /// 创建尚未识别退出标记的扫描器。
    /// 参数：无；返回：AgentExitScanner。
    pub fn new() -> Self {
        Self {
            matched: 0,
            exited: false,
        }
    }

    /// 扫描一段 PTY 输出并跨块累计匹配，仅首次完整标记返回 true。
    /// 参数：data——待扫描字节；返回：本次是否首次识别到 AI 退出标记。
    pub fn scan(&mut self, data: &[u8]) -> bool {
        if self.exited {
            return false;
        }

        for &byte in data {
            if byte == AGENT_EXIT_SEQUENCE[self.matched] {
                self.matched += 1;
            } else {
                self.matched = usize::from(byte == AGENT_EXIT_SEQUENCE[0]);
            }

            if self.matched == AGENT_EXIT_SEQUENCE.len() {
                self.matched = 0;
                self.exited = true;
                return true;
            }
        }
        false
    }
}

/// 会话内真实的 AI 前台运行状态，仅允许由退出标记单向关闭。
pub struct AgentForeground {
    /// AI 命令当前是否仍在 PowerShell 前台运行
    active: bool,
    /// AI 命令退出标记扫描器
    exit_scanner: AgentExitScanner,
}

impl AgentForeground {
    /// 根据启动会话类型创建前台状态。
    /// 参数：kind——会话启动类型；返回：Claude/Codex 初始活动、Shell 初始关闭的状态。
    pub fn new(kind: &str) -> Self {
        Self {
            active: matches!(kind, "claude" | "codex"),
            exit_scanner: AgentExitScanner::new(),
        }
    }

    /// 读取 AI 命令当前是否仍在前台运行。
    /// 参数：无；返回：仍可作为 AI 会话注入则 true。
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// 主动关闭 AI 前台状态，供会话 kill/退出路径先使任务注入失效。
    /// 参数：无；返回：无。
    pub fn deactivate(&mut self) {
        self.active = false;
    }

    /// 扫描 PTY 输出，识别退出标记后永久关闭前台状态。
    /// 参数：data——本次 PTY 输出；返回：无。
    pub fn observe_output(&mut self, data: &[u8]) {
        if self.active && self.exit_scanner.scan(data) {
            self.active = false;
        }
    }
}

/// VT 扫描状态机的状态。
#[derive(Clone, Copy, PartialEq, Eq)]
enum VtState {
    /// 普通文本态：此态遇到 0x07 才是真响铃
    Ground,
    /// 刚收到 ESC(0x1b)，等待判定后续序列类型
    Escape,
    /// OSC 字符串态（`ESC ]` 之后），以 BEL 或 ST 结束
    Osc,
    /// DCS/SOS/PM/APC 字符串态（`ESC P/X/^/_` 之后），以 ST 结束
    Dcs,
    /// 字符串态中收到 ESC，疑似 ST 终止符（`ESC \`）的前半
    StMaybe,
}

/// 跨块保持状态的 BEL 扫描器。
pub struct BelScanner {
    /// 当前扫描状态
    state: VtState,
}

impl BelScanner {
    /// 新建扫描器，初始为 Ground 态。
    /// 参数：无；返回：BelScanner。
    pub fn new() -> Self {
        Self {
            state: VtState::Ground,
        }
    }

    /// 扫描一段字节，更新内部状态，返回本段是否出现"真响铃"。
    /// 参数：data——待扫描字节切片；返回：出现 Ground 态裸 BEL 则 true。
    pub fn scan(&mut self, data: &[u8]) -> bool {
        let mut bel = false;
        for &b in data {
            match self.state {
                VtState::Ground => match b {
                    0x1b => self.state = VtState::Escape, // ESC
                    0x07 => bel = true,                   // 真响铃
                    _ => {}
                },
                VtState::Escape => match b {
                    b']' => self.state = VtState::Osc,                      // OSC
                    b'P' | b'X' | b'^' | b'_' => self.state = VtState::Dcs, // DCS/SOS/PM/APC
                    _ => self.state = VtState::Ground, // 其它转义视为短序列，回到 Ground
                },
                VtState::Osc => match b {
                    0x07 => self.state = VtState::Ground,  // BEL 终止 OSC（非响铃）
                    0x1b => self.state = VtState::StMaybe, // 疑似 ST
                    _ => {}
                },
                VtState::Dcs => match b {
                    0x1b => self.state = VtState::StMaybe, // 疑似 ST
                    _ => {}
                },
                VtState::StMaybe => match b {
                    b'\\' => self.state = VtState::Ground, // ST 终止符，字符串结束
                    0x1b => self.state = VtState::StMaybe, // 连续 ESC，保持
                    b']' => self.state = VtState::Osc,     // 新的 OSC
                    b'P' | b'X' | b'^' | b'_' => self.state = VtState::Dcs, // 新的 DCS 类
                    0x07 => self.state = VtState::Ground,  // 字符串内 BEL，视为结束（非响铃）
                    _ => self.state = VtState::Ground,     // ESC+其它，回到 Ground
                },
            }
        }
        bel
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentExitScanner, AgentForeground, BelScanner, AGENT_EXIT_SEQUENCE};

    /// 验证 AI 退出标记被任意分块后仍只识别一次。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn agent_exit_scanner_detects_split_marker_once() {
        let mut scanner = AgentExitScanner::new();
        let split = AGENT_EXIT_SEQUENCE.len() / 2;

        assert!(!scanner.scan(&AGENT_EXIT_SEQUENCE[..split]));
        assert!(scanner.scan(&AGENT_EXIT_SEQUENCE[split..]));
        assert!(!scanner.scan(b"ordinary output\x07"));
        assert!(!scanner.scan(AGENT_EXIT_SEQUENCE));
        assert!(!BelScanner::new().scan(AGENT_EXIT_SEQUENCE));
    }

    /// 验证 AI 前台状态在退出标记后关闭，Shell 从不处于 AI 前台。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn agent_foreground_turns_off_after_exit_marker() {
        let mut foreground = AgentForeground::new("codex");
        let split = AGENT_EXIT_SEQUENCE.len() - 1;

        assert!(foreground.is_active());
        foreground.observe_output(&AGENT_EXIT_SEQUENCE[..split]);
        assert!(foreground.is_active());
        foreground.observe_output(&AGENT_EXIT_SEQUENCE[split..]);
        assert!(!foreground.is_active());
        assert!(!AgentForeground::new("shell").is_active());
    }
}
