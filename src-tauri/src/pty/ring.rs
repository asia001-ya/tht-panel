//! 字节环形缓冲（scrollback）。
//!
//! 用分块 `VecDeque<Vec<u8>>` 承载 PTY 原始输出字节，并对总字节数设上限：
//! 超出上限时从最旧的块开始淘汰（必要时对首块做部分截断），保证内存有界。
//! attach 时整块拼出快照回放给前端（配合 `String::from_utf8_lossy` 容忍环形起点半字符）。

use std::collections::VecDeque;

/// 分块环形字节缓冲，带总量上限。
pub struct RingBuffer {
    /// 已缓存的数据块（按写入先后排列，front 最旧）
    chunks: VecDeque<Vec<u8>>,
    /// 当前总字节数
    total: usize,
    /// 总字节上限
    cap: usize,
}

impl RingBuffer {
    /// 新建环形缓冲。
    /// 参数：cap——总字节上限（<=0 时按 1 处理避免死循环）；返回：RingBuffer。
    pub fn new(cap: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total: 0,
            cap: cap.max(1),
        }
    }

    /// 追加一段字节；若超出上限则从最旧数据开始淘汰（含首块部分截断）。
    /// 参数：data——新写入的字节切片；返回：无。
    pub fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        // 单次写入就超过整个容量：只保留其尾部 cap 字节。
        if data.len() >= self.cap {
            self.chunks.clear();
            let start = data.len() - self.cap;
            self.chunks.push_back(data[start..].to_vec());
            self.total = self.cap;
            return;
        }
        self.chunks.push_back(data.to_vec());
        self.total += data.len();
        // 逐块淘汰直至回落到上限内。
        while self.total > self.cap {
            let overflow = self.total - self.cap;
            let front_len = self.chunks.front().map(|c| c.len()).unwrap_or(0);
            if front_len == 0 {
                break;
            }
            if front_len <= overflow {
                // 整块淘汰
                self.chunks.pop_front();
                self.total -= front_len;
            } else {
                // 首块部分截断：丢弃前 overflow 字节
                if let Some(front) = self.chunks.front_mut() {
                    front.drain(0..overflow);
                }
                self.total -= overflow;
            }
        }
    }

    /// 拼出当前缓冲的全部字节快照（用于 attach 回放）。
    /// 参数：无；返回：按写入顺序拼接的字节向量。
    pub fn snapshot(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.total);
        for c in &self.chunks {
            out.extend_from_slice(c);
        }
        out
    }
}
