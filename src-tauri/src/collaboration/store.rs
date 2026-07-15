//! 窗格协作任务的持久化存储与状态机。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::collaboration::model::{CreatePaneTaskRequest, PaneTask, TaskOutcome, TaskStatus};
use crate::error::AppError;

const TASKS_FILENAME: &str = "collaboration-tasks.json";
const TASKS_VERSION: u32 = 1;

/// 任务持久化文件结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TasksFile {
    /// 文件格式版本
    version: u32,
    /// 全部协作任务
    tasks: Vec<PaneTask>,
}

impl Default for TasksFile {
    /// 创建空任务文件默认值。
    /// 参数：无；返回：版本为 1 的空任务集合。
    fn default() -> Self {
        Self {
            version: TASKS_VERSION,
            tasks: Vec::new(),
        }
    }
}

/// 协作任务持久化仓库，串行化状态迁移和磁盘写入。
pub struct TaskStore {
    /// 任务文件路径
    path: PathBuf,
    /// 内存任务缓存
    tasks: Mutex<TasksFile>,
}

impl TaskStore {
    /// 创建任务存储，加载已有文件并备份损坏 JSON。
    /// 参数：config_dir——应用配置目录；返回：TaskStore 或 AppError。
    pub fn new(config_dir: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(config_dir)?;
        let path = config_dir.join(TASKS_FILENAME);
        let tasks = load_tasks(&path)?;
        Ok(Self {
            path,
            tasks: Mutex::new(tasks),
        })
    }

    /// 按保存工作区精确列出任务，None 只返回未保存布局任务。
    /// 参数：saved_workspace_id——保存工作区标识；返回：匹配任务副本。
    pub fn list(&self, saved_workspace_id: Option<&str>) -> Vec<PaneTask> {
        self.tasks
            .lock()
            .tasks
            .iter()
            .filter(|task| task.saved_workspace_id.as_deref() == saved_workspace_id)
            .cloned()
            .collect()
    }

    /// 创建 queued 任务并持久化。
    /// 参数：request——受控创建输入；返回：新任务或 AppError。
    pub fn create(&self, request: CreatePaneTaskRequest) -> Result<PaneTask, AppError> {
        let now = now_rfc3339();
        let task = PaneTask {
            id: Uuid::new_v4().to_string(),
            saved_workspace_id: request.saved_workspace_id,
            source_pane_id: request.source_pane_id,
            target_pane_id: request.target_pane_id,
            source_pane_name: request.source_pane_name,
            target_pane_name: request.target_pane_name,
            title: request.title,
            request: request.request,
            status: TaskStatus::Queued,
            report: None,
            outcome: None,
            dispatched_to_session_id: None,
            forwarded_to_session_id: None,
            created_at: now.clone(),
            updated_at: now,
        };

        let mut current = self.tasks.lock();
        let mut next = current.clone();
        next.tasks.push(task.clone());
        atomic_write_tasks(&self.path, &next)?;
        *current = next;
        Ok(task)
    }

    /// 按标识读取任务。
    /// 参数：id——任务标识；返回：任务副本或 NotFound。
    pub fn get(&self, id: &str) -> Result<PaneTask, AppError> {
        self.tasks
            .lock()
            .tasks
            .iter()
            .find(|task| task.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("协作任务不存在: {id}")))
    }

    /// 把 queued 任务标记为已派发并冻结目标会话标识。
    /// 参数：id——任务标识；session_id——目标 PTY 标识；返回：更新任务或 AppError。
    pub fn mark_dispatched(&self, id: &str, session_id: &str) -> Result<PaneTask, AppError> {
        self.transition(id, TaskStatus::Queued, TaskStatus::Dispatched, |task| {
            task.dispatched_to_session_id = Some(session_id.to_string())
        })
    }

    /// 上报 dispatched 任务的完成或受阻结果。
    /// 参数：id——任务标识；outcome——上报结果；report——上报正文；返回：更新任务或 AppError。
    pub fn report(
        &self,
        id: &str,
        outcome: TaskOutcome,
        report: String,
    ) -> Result<PaneTask, AppError> {
        self.transition(id, TaskStatus::Dispatched, TaskStatus::Reported, |task| {
            task.outcome = Some(outcome);
            task.report = Some(report);
        })
    }

    /// 把 reported 任务标记为已转交并冻结来源会话标识。
    /// 参数：id——任务标识；session_id——来源 PTY 标识；返回：更新任务或 AppError。
    pub fn mark_forwarded(&self, id: &str, session_id: &str) -> Result<PaneTask, AppError> {
        self.transition(id, TaskStatus::Reported, TaskStatus::Forwarded, |task| {
            task.forwarded_to_session_id = Some(session_id.to_string())
        })
    }

    /// 关闭已转交任务。
    /// 参数：id——任务标识；返回：closed 任务或 AppError。
    pub fn close(&self, id: &str) -> Result<PaneTask, AppError> {
        self.transition(id, TaskStatus::Forwarded, TaskStatus::Closed, |_| {})
    }

    /// 取消尚未派发的 queued 任务。
    /// 参数：id——任务标识；返回：cancelled 任务或 AppError。
    pub fn cancel(&self, id: &str) -> Result<PaneTask, AppError> {
        self.transition(id, TaskStatus::Queued, TaskStatus::Cancelled, |_| {})
    }

    /// 校验并执行一次固定状态迁移，写盘成功后才替换内存缓存。
    /// 参数：id——任务标识；expected——当前状态；next_status——目标状态；update——附加字段更新；返回：更新任务。
    fn transition<F>(
        &self,
        id: &str,
        expected: TaskStatus,
        next_status: TaskStatus,
        update: F,
    ) -> Result<PaneTask, AppError>
    where
        F: FnOnce(&mut PaneTask),
    {
        let mut current = self.tasks.lock();
        let mut next = current.clone();
        let task = next
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| AppError::NotFound(format!("协作任务不存在: {id}")))?;
        if task.status != expected {
            return Err(AppError::Other(format!(
                "任务状态不允许迁移: 当前 {:?}，要求 {:?}",
                task.status, expected
            )));
        }

        update(task);
        task.status = next_status;
        task.updated_at = now_rfc3339();
        let updated = task.clone();
        atomic_write_tasks(&self.path, &next)?;
        *current = next;
        Ok(updated)
    }
}

/// 读取任务文件；缺失时返回空值，损坏时先备份再返回空值。
/// 参数：path——任务文件路径；返回：任务文件内容或 AppError。
fn load_tasks(path: &Path) -> Result<TasksFile, AppError> {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(tasks) => Ok(tasks),
            Err(_) => {
                fs::rename(path, backup_path(path))?;
                Ok(TasksFile::default())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TasksFile::default()),
        Err(error) => Err(error.into()),
    }
}

/// 构造损坏任务文件的备份路径。
/// 参数：path——原文件路径；返回：`.bak` 备份路径。
fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{TASKS_FILENAME}.bak"))
}

/// 原子写入任务 JSON：先写同目录 tmp，再替换目标文件。
/// 参数：path——目标路径；tasks——待写任务文件；返回：成功或 AppError。
fn atomic_write_tasks(path: &Path, tasks: &TasksFile) -> Result<(), AppError> {
    let tmp = path.with_file_name(format!("{TASKS_FILENAME}.tmp"));
    let text = serde_json::to_string_pretty(tasks)?;
    fs::write(&tmp, text.as_bytes())?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// 返回当前 UTC RFC3339 时间。
/// 参数：无；返回：时间字符串。
fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use chrono::DateTime;
    use uuid::Uuid;

    use super::TaskStore;
    use crate::collaboration::model::{CreatePaneTaskRequest, TaskOutcome, TaskStatus};
    use crate::error::AppError;

    /// 测试专用临时目录，离开作用域时删除自身创建的目录。
    struct TestDir(PathBuf);

    impl TestDir {
        /// 创建带随机标识的测试目录。
        /// 参数：无；返回：测试目录守卫。
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("tht-panel-collaboration-{}", Uuid::new_v4())))
        }

        /// 返回测试目录路径。
        /// 参数：无；返回：目录路径引用。
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

    /// 构造任务创建请求。
    /// 参数：saved_workspace_id——保存工作区标识；返回：完整创建请求。
    fn request(saved_workspace_id: Option<&str>) -> CreatePaneTaskRequest {
        CreatePaneTaskRequest {
            saved_workspace_id: saved_workspace_id.map(str::to_string),
            source_pane_id: "pane-web".to_string(),
            target_pane_id: "pane-server".to_string(),
            source_pane_name: "web".to_string(),
            target_pane_name: "server".to_string(),
            title: "同步用户接口".to_string(),
            request: "实现用户查询接口并上报字段".to_string(),
        }
    }

    /// 验证创建任务生成稳定字段、写入磁盘并按工作区精确隔离。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn create_persists_task_and_filters_saved_workspace() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");

        let current = store.create(request(None)).expect("应创建当前布局任务");
        let saved_a = store
            .create(request(Some("workspace-a")))
            .expect("应创建保存工作区 A 的任务");
        store
            .create(request(Some("workspace-b")))
            .expect("应创建保存工作区 B 的任务");

        assert!(!current.id.is_empty());
        assert_eq!(current.status, TaskStatus::Queued);
        assert_eq!(current.created_at, current.updated_at);
        DateTime::parse_from_rfc3339(&current.created_at).expect("创建时间应为 RFC3339");
        assert_eq!(store.list(None), vec![current]);
        assert_eq!(store.list(Some("workspace-a")), vec![saved_a]);

        let text = fs::read_to_string(dir.path().join("collaboration-tasks.json"))
            .expect("任务文件应已写入");
        assert!(text.contains("\"savedWorkspaceId\""));
        assert!(text.contains("\"status\": \"queued\""));
    }

    /// 验证完整合法状态流可持久化并在重载后保留结果。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn legal_flow_persists_and_reloads() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let created = store.create(request(None)).expect("应创建任务");

        let dispatched = store
            .mark_dispatched(&created.id, "pty-server")
            .expect("queued 应可派发");
        assert_eq!(dispatched.status, TaskStatus::Dispatched);
        assert_eq!(
            dispatched.dispatched_to_session_id.as_deref(),
            Some("pty-server")
        );

        let reported = store
            .report(
                &created.id,
                TaskOutcome::Completed,
                "已增加 /users 接口".to_string(),
            )
            .expect("dispatched 应可上报");
        assert_eq!(reported.status, TaskStatus::Reported);
        assert_eq!(reported.outcome, Some(TaskOutcome::Completed));

        let forwarded = store
            .mark_forwarded(&created.id, "pty-web")
            .expect("reported 应可转交");
        assert_eq!(forwarded.status, TaskStatus::Forwarded);
        assert_eq!(
            forwarded.forwarded_to_session_id.as_deref(),
            Some("pty-web")
        );

        let closed = store.close(&created.id).expect("forwarded 应可关闭");
        assert_eq!(closed.status, TaskStatus::Closed);
        drop(store);

        let reloaded = TaskStore::new(dir.path()).expect("应重载任务存储");
        assert_eq!(reloaded.get(&created.id).expect("应找到重载任务"), closed);
    }

    /// 验证非法状态跳转返回错误且不污染当前任务。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn invalid_transitions_preserve_current_state() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let created = store.create(request(None)).expect("应创建任务");

        assert!(store
            .report(&created.id, TaskOutcome::Blocked, "尚未派发".to_string(),)
            .is_err());
        assert_eq!(
            store.get(&created.id).expect("任务应保留").status,
            TaskStatus::Queued,
        );

        store
            .mark_dispatched(&created.id, "pty-server")
            .expect("queued 应可派发");
        assert!(store.cancel(&created.id).is_err());
        assert_eq!(
            store.get(&created.id).expect("任务应保留").status,
            TaskStatus::Dispatched,
        );
    }

    /// 验证只有 queued 任务可以取消且取消后不能再次迁移。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn queued_task_can_be_cancelled_once() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let created = store.create(request(None)).expect("应创建任务");

        let cancelled = store.cancel(&created.id).expect("queued 应可取消");
        assert_eq!(cancelled.status, TaskStatus::Cancelled);
        assert!(store.cancel(&created.id).is_err());
        assert!(store.mark_dispatched(&created.id, "pty-server").is_err());
    }

    /// 验证读取或更新不存在的任务返回 NotFound。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn missing_task_returns_not_found() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");

        assert!(matches!(store.get("missing"), Err(AppError::NotFound(_))));
        assert!(matches!(
            store.mark_dispatched("missing", "pty-server"),
            Err(AppError::NotFound(_)),
        ));
    }

    /// 验证损坏的任务 JSON 会备份并以空存储继续启动。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn corrupt_json_is_backed_up() {
        let dir = TestDir::new();
        fs::create_dir_all(dir.path()).expect("应创建测试目录");
        fs::write(
            dir.path().join("collaboration-tasks.json"),
            b"{ broken json",
        )
        .expect("应写入损坏文件");

        let store = TaskStore::new(dir.path()).expect("损坏文件应回退空存储");

        assert!(store.list(None).is_empty());
        assert!(dir.path().join("collaboration-tasks.json.bak").exists());
    }

    /// 验证连续写入成功且不会遗留临时文件。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn repeated_atomic_writes_leave_no_temp_file() {
        let dir = TestDir::new();
        let store = TaskStore::new(dir.path()).expect("应创建任务存储");
        let task = store.create(request(None)).expect("首次写入应成功");
        store
            .mark_dispatched(&task.id, "pty-server")
            .expect("第二次写入应成功");

        assert!(!dir.path().join("collaboration-tasks.json.tmp").exists());
        assert_eq!(
            store.get(&task.id).expect("任务应存在").status,
            TaskStatus::Dispatched
        );
    }
}
