//! 窗格协作任务命令与受控 PTY 注入。

use serde::Serialize;
use tauri::State;

use crate::collaboration::model::{CreatePaneTaskRequest, PaneTask, TaskOutcome, TaskStatus};
use crate::collaboration::store::TaskStore;
use crate::config::model::{PtySessionInfo, SessionState};
use crate::error::AppError;
use crate::pty::manager::PtyManager;
use crate::state::AppState;

/// 任务注入所需的最小 PTY 接口，生产环境由 PtyManager 实现。
trait TaskPty {
    /// 查询会话快照。
    /// 参数：session_id——会话标识；返回：会话信息或 AppError。
    fn info(&self, session_id: &str) -> Result<PtySessionInfo, AppError>;

    /// 向会话写入文本。
    /// 参数：session_id——会话标识；data——输入文本；返回：成功或 AppError。
    fn write(&self, session_id: &str, data: &str) -> Result<(), AppError>;
}

impl TaskPty for PtyManager {
    /// 查询真实 PTY 会话快照。
    /// 参数：session_id——会话标识；返回：会话信息或 AppError。
    fn info(&self, session_id: &str) -> Result<PtySessionInfo, AppError> {
        PtyManager::info(self, session_id)
    }

    /// 向真实 PTY 会话写入文本。
    /// 参数：session_id——会话标识；data——输入文本；返回：成功或 AppError。
    fn write(&self, session_id: &str, data: &str) -> Result<(), AppError> {
        PtyManager::write(self, session_id, data)
    }
}

/// 注入终端的结构化单行提示。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskPrompt<'a> {
    /// 当前动作的固定指令
    instruction: &'static str,
    /// 状态机中的任务快照
    task: &'a PaneTask,
}

/// 创建任务并拒绝来源与目标相同的无效路由。
/// 参数：tasks——任务存储；request——创建输入；返回：新任务或 AppError。
fn create_task(tasks: &TaskStore, request: CreatePaneTaskRequest) -> Result<PaneTask, AppError> {
    if request.source_pane_id == request.target_pane_id {
        return Err(AppError::Other("来源窗格与目标窗格不能相同".to_string()));
    }
    tasks.create(request)
}

/// 校验并把 queued 任务注入目标会话，随后持久化 dispatched 状态。
/// 参数：tasks——任务存储；pty——PTY 接口；task_id——任务标识；target_pane_id——目标窗格；session_id——目标会话；返回：更新任务。
fn dispatch_task<P: TaskPty>(
    tasks: &TaskStore,
    pty: &P,
    task_id: &str,
    target_pane_id: &str,
    session_id: &str,
) -> Result<PaneTask, AppError> {
    let task = tasks.get(task_id)?;
    validate_task_route(
        &task,
        TaskStatus::Queued,
        &task.target_pane_id,
        target_pane_id,
    )?;
    let info = pty.info(session_id)?;
    validate_session(&info, session_id)?;
    let prompt = build_prompt("执行任务并在完成后通过任务面板上报结果", &task)?;
    pty.write(session_id, &prompt)?;
    tasks.mark_dispatched(task_id, session_id).map_err(|error| {
        AppError::Other(format!(
            "目标可能已收到任务，但状态保存失败；请人工核对，禁止自动重试: {error}"
        ))
    })
}

/// 校验并把 reported 任务结果注入来源会话，随后持久化 forwarded 状态。
/// 参数：tasks——任务存储；pty——PTY 接口；task_id——任务标识；source_pane_id——来源窗格；session_id——来源会话；返回：更新任务。
fn forward_task<P: TaskPty>(
    tasks: &TaskStore,
    pty: &P,
    task_id: &str,
    source_pane_id: &str,
    session_id: &str,
) -> Result<PaneTask, AppError> {
    let task = tasks.get(task_id)?;
    validate_task_route(
        &task,
        TaskStatus::Reported,
        &task.source_pane_id,
        source_pane_id,
    )?;
    let info = pty.info(session_id)?;
    validate_session(&info, session_id)?;
    let prompt = build_prompt("根据目标窗格上报结果继续同步来源实现", &task)?;
    pty.write(session_id, &prompt)?;
    tasks.mark_forwarded(task_id, session_id).map_err(|error| {
        AppError::Other(format!(
            "来源可能已收到任务结果，但状态保存失败；请人工核对，禁止自动重试: {error}"
        ))
    })
}

/// 校验任务状态、跨窗格约束和本次提交的 Pane 标识。
/// 参数：task——任务；expected_status——要求状态；expected_pane_id——冻结 Pane；actual_pane_id——提交 Pane；返回：成功或 AppError。
fn validate_task_route(
    task: &PaneTask,
    expected_status: TaskStatus,
    expected_pane_id: &str,
    actual_pane_id: &str,
) -> Result<(), AppError> {
    if task.source_pane_id == task.target_pane_id {
        return Err(AppError::Other("任务来源与目标窗格不能相同".to_string()));
    }
    if task.status != expected_status {
        return Err(AppError::Other(format!(
            "任务状态不允许注入: 当前 {:?}，要求 {:?}",
            task.status, expected_status
        )));
    }
    if expected_pane_id != actual_pane_id {
        return Err(AppError::Other("提交的窗格与任务路由不匹配".to_string()));
    }
    Ok(())
}

/// 校验会话标识、AI 类型和可注入状态。
/// 参数：info——PTY 会话快照；session_id——提交的会话标识；返回：成功或 AppError。
fn validate_session(info: &PtySessionInfo, session_id: &str) -> Result<(), AppError> {
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

/// 使用 serde 生成结构化提示，清理全部 C0 控制字符并追加唯一回车。
/// 参数：instruction——固定指令；task——任务快照；返回：单行提示或 AppError。
fn build_prompt(instruction: &'static str, task: &PaneTask) -> Result<String, AppError> {
    let json = serde_json::to_string(&TaskPrompt { instruction, task })?;
    let mut prompt = json
        .chars()
        .map(|character| {
            if character <= '\u{001f}' {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    prompt.push('\r');
    Ok(prompt)
}

/// 列出指定保存工作区或当前未保存布局的任务。
/// 参数：state——应用状态；saved_workspace_id——保存工作区标识；返回：任务列表。
#[tauri::command]
pub fn task_list(
    state: State<'_, AppState>,
    saved_workspace_id: Option<String>,
) -> Result<Vec<PaneTask>, AppError> {
    Ok(state.tasks.list(saved_workspace_id.as_deref()))
}

/// 创建 queued 协作任务。
/// 参数：state——应用状态；req——创建输入；返回：新任务或 AppError。
#[tauri::command]
pub fn task_create(
    state: State<'_, AppState>,
    req: CreatePaneTaskRequest,
) -> Result<PaneTask, AppError> {
    create_task(&state.tasks, req)
}

/// 确认并把任务注入目标活动会话。
/// 参数：state——应用状态；task_id——任务标识；target_pane_id——目标 Pane；session_id——目标会话；返回：dispatched 任务。
#[tauri::command]
pub fn task_dispatch(
    state: State<'_, AppState>,
    task_id: String,
    target_pane_id: String,
    session_id: String,
) -> Result<PaneTask, AppError> {
    dispatch_task(
        &state.tasks,
        &state.pty,
        &task_id,
        &target_pane_id,
        &session_id,
    )
}

/// 上报已派发任务的完成或受阻结果。
/// 参数：state——应用状态；task_id——任务标识；outcome——结果；report——报告；返回：reported 任务。
#[tauri::command]
pub fn task_report(
    state: State<'_, AppState>,
    task_id: String,
    outcome: TaskOutcome,
    report: String,
) -> Result<PaneTask, AppError> {
    state.tasks.report(&task_id, outcome, report)
}

/// 把目标上报结果注入来源活动会话。
/// 参数：state——应用状态；task_id——任务标识；source_pane_id——来源 Pane；session_id——来源会话；返回：forwarded 任务。
#[tauri::command]
pub fn task_forward(
    state: State<'_, AppState>,
    task_id: String,
    source_pane_id: String,
    session_id: String,
) -> Result<PaneTask, AppError> {
    forward_task(
        &state.tasks,
        &state.pty,
        &task_id,
        &source_pane_id,
        &session_id,
    )
}

/// 关闭已转交任务。
/// 参数：state——应用状态；task_id——任务标识；返回：closed 任务。
#[tauri::command]
pub fn task_close(state: State<'_, AppState>, task_id: String) -> Result<PaneTask, AppError> {
    state.tasks.close(&task_id)
}

/// 取消尚未派发的任务。
/// 参数：state——应用状态；task_id——任务标识；返回：cancelled 任务。
#[tauri::command]
pub fn task_cancel(state: State<'_, AppState>, task_id: String) -> Result<PaneTask, AppError> {
    state.tasks.cancel(&task_id)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use parking_lot::Mutex;
    use uuid::Uuid;

    use super::{create_task, dispatch_task, forward_task, TaskPty};
    use crate::collaboration::model::{CreatePaneTaskRequest, TaskOutcome, TaskStatus};
    use crate::collaboration::store::TaskStore;
    use crate::config::model::{PtySessionInfo, SessionState};
    use crate::error::AppError;

    /// 测试专用临时目录守卫。
    struct TestDir(PathBuf);

    impl TestDir {
        /// 创建带随机标识的测试目录。
        /// 参数：无；返回：测试目录守卫。
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("tht-panel-task-commands-{}", Uuid::new_v4())))
        }

        /// 返回测试目录路径。
        /// 参数：无；返回：路径引用。
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        /// 删除当前测试创建的唯一目录。
        /// 参数：无；返回：无。
        fn drop(&mut self) {
            if self.0.exists() {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    /// 可控制会话信息、写入结果并记录输入的 PTY 测试替身。
    struct FakePty {
        sessions: HashMap<String, PtySessionInfo>,
        writes: Mutex<Vec<(String, String)>>,
        fail_write: bool,
    }

    impl FakePty {
        /// 创建只包含一个会话的 PTY 替身。
        /// 参数：info——会话信息；返回：PTY 替身。
        fn new(info: PtySessionInfo) -> Self {
            Self {
                sessions: HashMap::from([(info.session_id.clone(), info)]),
                writes: Mutex::new(Vec::new()),
                fail_write: false,
            }
        }

        /// 返回已记录写入的副本。
        /// 参数：无；返回：会话标识与文本列表。
        fn writes(&self) -> Vec<(String, String)> {
            self.writes.lock().clone()
        }
    }

    impl TaskPty for FakePty {
        /// 按标识返回测试会话。
        /// 参数：session_id——会话标识；返回：会话信息或 NotFound。
        fn info(&self, session_id: &str) -> Result<PtySessionInfo, AppError> {
            self.sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("会话不存在: {session_id}")))
        }

        /// 记录写入，或按测试配置返回 PTY 错误。
        /// 参数：session_id——会话标识；data——输入文本；返回：成功或 AppError。
        fn write(&self, session_id: &str, data: &str) -> Result<(), AppError> {
            if self.fail_write {
                return Err(AppError::Pty("测试写入失败".to_string()));
            }
            self.writes
                .lock()
                .push((session_id.to_string(), data.to_string()));
            Ok(())
        }
    }

    /// 构造任务请求。
    /// 参数：无；返回：web 到 server 的任务请求。
    fn request() -> CreatePaneTaskRequest {
        CreatePaneTaskRequest {
            saved_workspace_id: Some("saved-1".to_string()),
            source_pane_id: "pane-web".to_string(),
            target_pane_id: "pane-server".to_string(),
            source_pane_name: "web".to_string(),
            target_pane_name: "server".to_string(),
            title: "同步接口".to_string(),
            request: "增加 /users 接口".to_string(),
        }
    }

    /// 构造 PTY 会话信息。
    /// 参数：id——会话标识；kind——会话类型；state——运行状态；返回：会话信息。
    fn session(id: &str, kind: &str, state: SessionState) -> PtySessionInfo {
        PtySessionInfo {
            session_id: id.to_string(),
            workspace_id: Some("project-1".to_string()),
            kind: kind.to_string(),
            cwd: ".".to_string(),
            title: kind.to_string(),
            resumed_from: None,
            state,
            created_at: "2026-07-15T00:00:00Z".to_string(),
        }
    }

    /// 验证来源与目标相同的任务无法创建。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn create_rejects_same_pane() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let mut input = request();
        input.target_pane_id = input.source_pane_id.clone();

        assert!(create_task(&store, input).is_err());
        assert!(store.list(Some("saved-1")).is_empty());
    }

    /// 验证派发时必须提交任务冻结的目标 Pane。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn dispatch_rejects_target_pane_mismatch() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let task = store.create(request()).expect("应创建任务");
        let pty = FakePty::new(session("pty-server", "codex", SessionState::Idle));

        assert!(dispatch_task(&store, &pty, &task.id, "pane-other", "pty-server",).is_err());
        assert!(pty.writes().is_empty());
        assert_eq!(
            store.get(&task.id).expect("任务应存在").status,
            TaskStatus::Queued
        );
    }

    /// 验证 Shell、waiting 与 dead 会话均不能接收任务。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn dispatch_rejects_unsupported_or_unavailable_sessions() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let task = store.create(request()).expect("应创建任务");

        for (kind, state) in [
            ("shell", SessionState::Idle),
            ("claude", SessionState::Waiting),
            ("codex", SessionState::Dead),
        ] {
            let pty = FakePty::new(session("pty-server", kind, state));
            assert!(dispatch_task(&store, &pty, &task.id, "pane-server", "pty-server",).is_err());
            assert!(pty.writes().is_empty());
        }
        assert_eq!(
            store.get(&task.id).expect("任务应存在").status,
            TaskStatus::Queued
        );
    }

    /// 验证合法派发清理控制字符、只追加一个回车并拒绝重复注入。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn dispatch_writes_one_sanitized_prompt_and_rejects_repeat() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let mut input = request();
        input.title = "接口\r\n标题\u{1b}".to_string();
        input.request = "实现接口\u{0007}\n并上报".to_string();
        let task = store.create(input).expect("应创建任务");
        let pty = FakePty::new(session("pty-server", "codex", SessionState::Idle));

        let dispatched = dispatch_task(&store, &pty, &task.id, "pane-server", "pty-server")
            .expect("合法任务应派发");

        assert_eq!(dispatched.status, TaskStatus::Dispatched);
        let writes = pty.writes();
        assert_eq!(writes.len(), 1);
        let prompt = &writes[0].1;
        assert!(prompt.ends_with('\r'));
        assert_eq!(prompt.matches('\r').count(), 1);
        assert!(!prompt.contains('\n'));
        assert!(!prompt.contains('\u{1b}'));
        assert!(!prompt.contains('\u{0007}'));

        assert!(dispatch_task(&store, &pty, &task.id, "pane-server", "pty-server",).is_err());
        assert_eq!(pty.writes().len(), 1);
    }

    /// 验证上报后只能转交冻结的来源 Pane，且重复转交不会再次写入。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn forward_validates_source_and_rejects_repeat() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let task = store.create(request()).expect("应创建任务");
        store
            .mark_dispatched(&task.id, "pty-server")
            .expect("应标记已派发");
        store
            .report(
                &task.id,
                TaskOutcome::Completed,
                "接口已完成\n字段已同步".to_string(),
            )
            .expect("应上报结果");
        let pty = FakePty::new(session("pty-web", "claude", SessionState::Running));

        assert!(forward_task(&store, &pty, &task.id, "pane-other", "pty-web").is_err());
        assert!(pty.writes().is_empty());

        let forwarded =
            forward_task(&store, &pty, &task.id, "pane-web", "pty-web").expect("合法结果应转交");
        assert_eq!(forwarded.status, TaskStatus::Forwarded);
        let prompt = &pty.writes()[0].1;
        assert_eq!(prompt.matches('\r').count(), 1);
        assert!(!prompt.contains('\n'));
        assert!(forward_task(&store, &pty, &task.id, "pane-web", "pty-web").is_err());
        assert_eq!(pty.writes().len(), 1);
    }

    /// 验证 PTY 写入失败时任务仍保持 queued。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn write_failure_preserves_task_state() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let task = store.create(request()).expect("应创建任务");
        let mut pty = FakePty::new(session("pty-server", "codex", SessionState::Idle));
        pty.fail_write = true;

        assert!(dispatch_task(&store, &pty, &task.id, "pane-server", "pty-server",).is_err());
        assert_eq!(
            store.get(&task.id).expect("任务应存在").status,
            TaskStatus::Queued
        );
    }

    /// 验证写入成功但状态落盘失败时返回禁止自动重试的明确错误。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn persistence_failure_warns_that_target_may_have_received_task() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let task = store.create(request()).expect("应创建任务");
        fs::create_dir(dir.path().join("collaboration-tasks.json.tmp"))
            .expect("应创建阻断原子写的目录");
        let pty = FakePty::new(session("pty-server", "codex", SessionState::Idle));

        let error = dispatch_task(&store, &pty, &task.id, "pane-server", "pty-server")
            .expect_err("状态落盘失败应返回错误");

        assert!(error.to_string().contains("目标可能已收到"));
        assert!(error.to_string().contains("禁止自动重试"));
        assert_eq!(pty.writes().len(), 1);
        assert_eq!(
            store.get(&task.id).expect("任务应存在").status,
            TaskStatus::Queued
        );
    }
}
