//! 应用统一错误类型 AppError。
//!
//! 设计目标：
//! - 实现 `thiserror::Error`，便于在后端各层用 `?` 传播；
//! - 实现 `serde::Serialize`，序列化为 `{code:String, message:String}`，
//!   命令层返回的 `Err` 会被 Tauri 直接传给前端，前端据此展示错误；
//! - 提供 `From<std::io::Error>`、`From<serde_json::Error>`、`From<String>`、`From<&str>`，
//!   跨线程 / anyhow 风格的错误统一用 `.map_err(|e| AppError::from(e.to_string()))` 转入。

use serde::ser::{Serialize, SerializeStruct, Serializer};

/// 后端统一错误枚举。命令层一律返回 `Result<T, AppError>`。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 文件读写等 IO 错误
    #[error("IO 错误: {0}")]
    Io(String),
    /// JSON 序列化 / 反序列化错误
    #[error("序列化错误: {0}")]
    Serde(String),
    /// 未找到目标资源（会话 / 工作空间 / 文件等）
    #[error("未找到: {0}")]
    NotFound(String),
    /// PTY / 子进程相关错误
    #[error("PTY 错误: {0}")]
    Pty(String),
    /// 配置读写 / 解析相关错误
    #[error("配置错误: {0}")]
    Config(String),
    /// 其它通用错误
    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// 返回该错误对应的稳定错误码，供前端做分支判断。
    /// 参数：无（读取 self）；返回：静态字符串错误码。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Io(_) => "IO_ERROR",
            AppError::Serde(_) => "SERDE_ERROR",
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::Pty(_) => "PTY_ERROR",
            AppError::Config(_) => "CONFIG_ERROR",
            AppError::Other(_) => "ERROR",
        }
    }
}

/// 将 AppError 序列化为 `{code, message}` 结构，前端 invoke 捕获到的即此形状。
impl Serialize for AppError {
    /// 序列化实现：写出 code 与 message 两个字段。
    /// 参数：serializer——序列化器；返回：序列化结果。
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut st = serializer.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

/// 由 std::io::Error 转换（文件读写失败等）。
impl From<std::io::Error> for AppError {
    /// 参数：e——IO 错误；返回：AppError::Io。
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

/// 由 serde_json::Error 转换（JSON 解析 / 生成失败）。
impl From<serde_json::Error> for AppError {
    /// 参数：e——serde_json 错误；返回：AppError::Serde。
    fn from(e: serde_json::Error) -> Self {
        AppError::Serde(e.to_string())
    }
}

/// 由 String 转换（跨线程 / anyhow 风格错误统一用字符串携带）。
impl From<String> for AppError {
    /// 参数：s——错误信息；返回：AppError::Other。
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

/// 由 &str 转换（字面量错误信息）。
impl From<&str> for AppError {
    /// 参数：s——错误信息；返回：AppError::Other。
    fn from(s: &str) -> Self {
        AppError::Other(s.to_string())
    }
}
