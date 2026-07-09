//! 全 crate 共用的数据模型。
//!
//! 约定（务必遵守）：
//! - 所有 serde 结构加 `#[serde(rename_all = "camelCase")]`，字段名与前端
//!   `src/api/types.ts` 完全一致；
//! - 配置类结构（会落盘、需容忍字段演进）再加 `#[serde(default)]`；
//! - 时间戳统一用字符串（ISO-8601 / RFC3339），由调用方生成。

use serde::{Deserialize, Serialize};

/// 一套 AI 连接配置。
/// - claude：baseUrl→ANTHROPIC_BASE_URL，apiKey→ANTHROPIC_AUTH_TOKEN，model→--model；
/// - codex：baseUrl→config.toml 的 model_providers.base_url，apiKey→OPENAI_API_KEY，model→--model。
/// 字段全部可选，空表示走官方默认。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    /// API 端点，空 = 官方默认
    pub base_url: Option<String>,
    /// 密钥（v1 明文存储，已确认可接受）
    pub api_key: Option<String>,
    /// 模型名
    pub model: Option<String>,
    /// 附加命令行参数，逐项追加到启动命令
    pub extra_args: Vec<String>,
}

/// 工作空间：名称 + 项目目录 + AI 类型 + 配置模式。
/// 落盘于 workspaces.json，加 `#[serde(default)]` 容忍字段演进。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    /// uuid
    pub id: String,
    /// 显示名（默认 = 目录名）
    pub name: String,
    /// 项目绝对路径，如 D:\AI\register
    pub path: String,
    /// 工作空间级 AI 类型："claude" | "codex"
    pub agent: String,
    /// true = 统一配置（用 GlobalConfig 对应默认）；false = 用下面的 config
    pub use_global_config: bool,
    /// 独立配置（use_global_config = false 时生效）
    pub config: Option<AgentConfig>,
    /// 侧边栏排序，Ctrl+1..9 依此序
    pub sort_order: i64,
    /// 创建时间戳
    pub created_at: String,
}

/// 全局配置，落盘于 settings.json。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GlobalConfig {
    /// 主题："light" | "dark"
    pub theme: String,
    /// shell 宿主路径，默认 "powershell.exe"，可改 pwsh.exe
    pub shell_path: String,
    /// 终端字号
    pub font_size: u32,
    /// 每会话环形缓冲上限（后端字节数）
    pub scrollback_bytes: usize,
    /// xterm 前端 scrollback 行数
    pub scrollback_lines: u32,
    /// 等待输入时是否发系统通知
    pub notify_on_waiting: bool,
    /// 「统一配置」时 claude 用这套
    pub claude_defaults: AgentConfig,
    /// 「统一配置」时 codex 用这套
    pub codex_defaults: AgentConfig,
}

impl Default for GlobalConfig {
    /// 全局配置默认值（首次启动 / 配置缺失时使用）。
    /// 参数：无；返回：带默认值的 GlobalConfig。
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            shell_path: "pwsh.exe".to_string(),
            font_size: 13,
            scrollback_bytes: 5 * 1024 * 1024,
            scrollback_lines: 10000,
            notify_on_waiting: true,
            claude_defaults: AgentConfig::default(),
            codex_defaults: AgentConfig::default(),
        }
    }
}

/// 会话运行状态。徽标与状态机使用；序列化为小写驼峰（running/waiting/idle/dead）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// 运行中（最近有输出）
    Running,
    /// 等待输入（收到裸 BEL）
    Waiting,
    /// 空闲（静默超时）
    Idle,
    /// 已退出
    Dead,
}

/// 运行时 PTY 会话信息（Rust 为真相，前端镜像）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInfo {
    /// 本应用生成的 PTY 会话 uuid（≠ claude/codex 的会话 uuid）
    pub session_id: String,
    /// 所属工作空间；纯 shell 也可挂在工作空间下
    pub workspace_id: Option<String>,
    /// 会话类型："claude" | "codex" | "shell"
    pub kind: String,
    /// 工作目录
    pub cwd: String,
    /// 显示名："claude"/"codex"/"PowerShell"/"续: <历史标题>"
    pub title: String,
    /// 若恢复历史会话，记录原 AI sessionId
    pub resumed_from: Option<String>,
    /// 当前状态
    pub state: SessionState,
    /// 创建时间戳
    pub created_at: String,
}

/// 启动请求（前端 pty_spawn 传入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    /// 有则从工作空间取 cwd 和配置
    pub workspace_id: Option<String>,
    /// 会话类型："claude" | "codex" | "shell"
    pub kind: String,
    /// 恢复历史会话时传 AI sessionId
    pub resume_session_id: Option<String>,
    /// 目标 leaf 列数
    pub cols: u16,
    /// 目标 leaf 行数（避免启动后立刻 resize 重绘）
    pub rows: u16,
}

/// 历史会话条目（claude 与 codex 统一）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryEntry {
    /// AI 侧会话 uuid（resume 用）
    pub session_id: String,
    /// 来源："claude" | "codex"
    pub source: String,
    /// 标题（claude: firstPrompt；codex: 首条用户输入或时间戳）
    pub title: String,
    /// 摘要（claude sessions-index 的 summary）
    pub summary: Option<String>,
    /// 消息数
    pub message_count: Option<u32>,
    /// 修改时间（排序键，倒序）
    pub modified_at: String,
    /// Git 分支
    pub git_branch: Option<String>,
}

/// 持久化布局（layout.json）。后端只整体存取，布局树用 `serde_json::Value` 透传，不解析。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedLayout {
    /// 版本号
    pub version: u32,
    /// 分屏二叉树骨架（leaf 只存 {id,locked,workspaceId?}），透传不解析
    pub tree: Option<serde_json::Value>,
    /// 活动 pane id
    pub active_pane_id: Option<String>,
    /// 窗口状态 {width,height,maximized}，透传不解析
    pub window: Option<serde_json::Value>,
}

impl Default for PersistedLayout {
    /// 布局默认值（首次启动 / 配置缺失时使用）：空树。
    /// 参数：无；返回：空布局。
    fn default() -> Self {
        Self {
            version: 1,
            tree: None,
            active_pane_id: None,
            window: None,
        }
    }
}

/// Channel 推送的 PTY 输出消息（tagged enum，与前端 `PtyOutputMsg` 对应）。
/// 用 `tag = "kind"` + snake_case，产出 `{kind:"snapshot"|"data"|"exit", ...}`。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PtyOutputMsg {
    /// attach 后第一条：环形缓冲全量回放
    Snapshot { data: String },
    /// 实时输出（~16ms 聚合）
    Data { data: String },
    /// 进程退出
    Exit { code: Option<i32> },
}

/// 事件 `session://state` 的载荷：会话状态变化广播。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatePayload {
    /// PTY 会话 id
    pub session_id: String,
    /// 所属工作空间
    pub workspace_id: Option<String>,
    /// 新状态
    pub state: SessionState,
}

/// 事件 `session://exit` 的载荷：会话进程退出广播。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExitPayload {
    /// PTY 会话 id
    pub session_id: String,
    /// 退出码
    pub exit_code: Option<i32>,
}

/// 事件名：会话状态变化（低频广播）
pub const EVT_SESSION_STATE: &str = "session://state";
/// 事件名：会话进程退出
pub const EVT_SESSION_EXIT: &str = "session://exit";
/// 事件名：托盘请求退出（前端弹确认，空 payload）
pub const EVT_QUIT_REQUEST: &str = "app://quit-request";

/// tht-panel 自管的会话记录（侧边栏左侧列表的数据源）。
/// 首次发送指令时创建；会话名称可编辑；与运行时 PtySessionInfo 通过 pty_session_id 关联。
/// 落盘于 sessions.json。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ManagedSession {
    /// 自管会话 uuid（稳定标识，区别于 PTY session_id 每次新建都不同）
    pub id: String,
    /// 所属工作空间 id
    pub workspace_id: String,
    /// 显示名称（可编辑）
    pub name: String,
    /// 会话类型："claude" | "codex" | "shell"
    pub kind: String,
    /// 关联的运行时 PTY session_id（会话活跃时有值，退出后清空）
    pub pty_session_id: Option<String>,
    /// 关联的 AI 侧 session_id（claude/codex 的原始 uuid，可用于 resume）
    pub ai_session_id: Option<String>,
    /// 创建时间
    pub created_at: String,
    /// 最后活跃时间（更新时机：创建、发送指令、退出）
    pub updated_at: String,
}

impl Default for ManagedSession {
    fn default() -> Self {
        Self {
            id: String::new(),
            workspace_id: String::new(),
            name: String::new(),
            kind: String::new(),
            pty_session_id: None,
            ai_session_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}
