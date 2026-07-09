//! BEL 感知扫描器（activity.rs）：在 PTY 输出流里识别"真正的响铃"。
//!
//! 背景（计划 8.4 / 风险 8）：claude 等 TUI 频繁用 OSC 序列设置窗口标题
//! （`ESC ] 0 ; title BEL`），这类以 BEL(0x07) 结尾的 OSC 不算响铃。真正的
//! 等待输入提示是"处于 Ground 状态时收到裸 BEL"。
//!
//! 为此用一个 5 态 VT 扫描器，且**跨 chunk 保持状态**（转义序列可能被 16ms
//! 聚合帧从中间劈开）：只有 Ground 态遇到 0x07 才判定为真响铃。

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
                    b']' => self.state = VtState::Osc, // OSC
                    b'P' | b'X' | b'^' | b'_' => self.state = VtState::Dcs, // DCS/SOS/PM/APC
                    _ => self.state = VtState::Ground, // 其它转义视为短序列，回到 Ground
                },
                VtState::Osc => match b {
                    0x07 => self.state = VtState::Ground, // BEL 终止 OSC（非响铃）
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
