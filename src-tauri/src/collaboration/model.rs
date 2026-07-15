//! 窗格协作任务的数据模型。

use serde::{Deserialize, Serialize};

/// 协作任务状态，只允许由 TaskStore 按固定状态机迁移。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    /// 已创建，等待目标窗格确认接收
    Queued,
    /// 已注入目标会话，等待目标上报
    Dispatched,
    /// 目标已上报，等待转交来源会话
    Reported,
    /// 已转交来源会话，等待用户关闭
    Forwarded,
    /// 任务闭环完成
    Closed,
    /// queued 阶段由用户取消
    Cancelled,
}

/// 目标窗格的任务上报结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskOutcome {
    /// 任务已完成
    Completed,
    /// 任务受阻
    Blocked,
}

/// 持久化的窗格协作任务。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneTask {
    /// 任务唯一标识
    pub id: String,
    /// 所属保存工作区；None 表示当前未保存布局
    pub saved_workspace_id: Option<String>,
    /// 来源窗格标识
    pub source_pane_id: String,
    /// 目标窗格标识
    pub target_pane_id: String,
    /// 创建时冻结的来源窗格名称
    pub source_pane_name: String,
    /// 创建时冻结的目标窗格名称
    pub target_pane_name: String,
    /// 任务标题
    pub title: String,
    /// 任务请求正文
    pub request: String,
    /// 当前状态
    pub status: TaskStatus,
    /// 目标上报正文
    pub report: Option<String>,
    /// 目标上报结果
    pub outcome: Option<TaskOutcome>,
    /// 实际接收任务的目标 PTY 会话标识
    pub dispatched_to_session_id: Option<String>,
    /// 实际接收转交结果的来源 PTY 会话标识
    pub forwarded_to_session_id: Option<String>,
    /// 创建时间（RFC3339）
    pub created_at: String,
    /// 最近更新时间（RFC3339）
    pub updated_at: String,
}

/// 创建协作任务的受控输入，不允许调用方指定状态、标识或时间。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePaneTaskRequest {
    /// 所属保存工作区；None 表示当前未保存布局
    pub saved_workspace_id: Option<String>,
    /// 来源窗格标识
    pub source_pane_id: String,
    /// 目标窗格标识
    pub target_pane_id: String,
    /// 来源窗格展示名称
    pub source_pane_name: String,
    /// 目标窗格展示名称
    pub target_pane_name: String,
    /// 任务标题
    pub title: String,
    /// 任务请求正文
    pub request: String,
}
