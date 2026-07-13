//! 配置存储 ConfigStore：管理三个 JSON 配置文件的原子读写与内存缓存。
//!
//! 文件位置：`appConfigDir`（Windows: `C:\Users\<user>\AppData\Roaming\com.tht.panel\`）。
//! - `settings.json`：GlobalConfig 全字段；
//! - `workspaces.json`：`{version, workspaces:[Workspace...]}`；
//! - `layout.json`：PersistedLayout。
//!
//! 健壮性策略（对照计划第十节、风险 13）：
//! - 读取：文件缺失 → 用默认值；解析失败 → 备份为 `<name>.bak` 后用默认值启动；
//! - 写入：原子写（先写 `<name>.tmp` 再 rename 覆盖，Windows 上 std::fs::rename 会替换已存在目标）；
//! - 内存缓存：三份数据各用 `parking_lot::Mutex` 包裹，读多写少。

use std::fs;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::config::model::{
    GlobalConfig, ManagedSession, PersistedLayout, SpawnRequest, Workspace,
};
use crate::error::AppError;

/// workspaces.json 的顶层结构：版本号 + 工作空间列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspacesFile {
    /// 版本号
    pub version: u32,
    /// 工作空间列表
    pub workspaces: Vec<Workspace>,
}

impl Default for WorkspacesFile {
    /// 默认值：版本 1，空列表。
    /// 参数：无；返回：空 WorkspacesFile。
    fn default() -> Self {
        Self {
            version: 1,
            workspaces: Vec::new(),
        }
    }
}

/// sessions.json 的顶层结构：tht-panel 自管的会话记录列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionsFile {
    pub version: u32,
    pub sessions: Vec<ManagedSession>,
}

impl Default for SessionsFile {
    fn default() -> Self {
        Self {
            version: 1,
            sessions: Vec::new(),
        }
    }
}

/// 配置存储。持有配置目录与三份内存缓存。
pub struct ConfigStore {
    /// 配置目录（appConfigDir）
    config_dir: PathBuf,
    /// 全局配置缓存
    global: Mutex<GlobalConfig>,
    /// 工作空间文件缓存
    workspaces: Mutex<WorkspacesFile>,
    /// 布局缓存
    layout: Mutex<PersistedLayout>,
    /// 自管会话记录缓存
    sessions: Mutex<SessionsFile>,
}

impl ConfigStore {
    /// 创建配置存储：定位 appConfigDir、确保目录存在、加载三份配置（缺失/损坏用默认并备份）。
    /// 参数：app——Tauri AppHandle（用于解析 app_config_dir）；
    /// 返回：ConfigStore 或 AppError。
    pub fn new(app: &tauri::AppHandle) -> Result<Self, AppError> {
        // 定位配置目录；tauri::Error 无法直接 From，用字符串转 AppError。
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| AppError::Config(format!("无法定位配置目录: {e}")))?;
        // 确保目录存在
        fs::create_dir_all(&config_dir)?;

        // 分别加载三份配置：缺失或解析失败均回退默认（解析失败会先备份 .bak）。
        let global: GlobalConfig = load_or_default(&config_dir.join("settings.json"));
        let workspaces: WorkspacesFile = load_or_default(&config_dir.join("workspaces.json"));
        let layout: PersistedLayout = load_or_default(&config_dir.join("layout.json"));
        let sessions: SessionsFile = load_or_default(&config_dir.join("sessions.json"));

        Ok(Self {
            config_dir,
            global: Mutex::new(global),
            workspaces: Mutex::new(workspaces),
            layout: Mutex::new(layout),
            sessions: Mutex::new(sessions),
        })
    }

    /// 返回配置目录路径（供 pty::spawn 生成 CODEX_HOME 等使用）。
    /// 参数：无；返回：配置目录引用。
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    // ---------- 全局配置 ----------

    /// 读取全局配置（克隆一份返回）。
    /// 参数：无；返回：GlobalConfig。
    pub fn global(&self) -> GlobalConfig {
        self.global.lock().clone()
    }

    /// 设置并持久化全局配置。
    /// 参数：cfg——新的全局配置；返回：() 或 AppError。
    pub fn set_global(&self, cfg: GlobalConfig) -> Result<(), AppError> {
        atomic_write_json(&self.config_dir.join("settings.json"), &cfg)?;
        *self.global.lock() = cfg;
        Ok(())
    }

    // ---------- 工作空间 ----------

    /// 读取全部工作空间（克隆列表返回）。
    /// 参数：无；返回：Vec<Workspace>。
    pub fn workspaces(&self) -> Vec<Workspace> {
        self.workspaces.lock().workspaces.clone()
    }

    /// 保存单个工作空间：按 id 存在则覆盖，否则追加；随后持久化。
    /// 参数：ws——要保存的工作空间；返回：() 或 AppError。
    pub fn save_workspace(&self, ws: Workspace) -> Result<(), AppError> {
        let snapshot = {
            let mut guard = self.workspaces.lock();
            match guard.workspaces.iter_mut().find(|w| w.id == ws.id) {
                Some(existing) => *existing = ws,
                None => guard.workspaces.push(ws),
            }
            guard.clone()
        };
        atomic_write_json(&self.config_dir.join("workspaces.json"), &snapshot)?;
        Ok(())
    }

    /// 按 id 删除工作空间；随后持久化。
    /// 参数：id——工作空间 id；返回：() 或 AppError。
    pub fn delete_workspace(&self, id: &str) -> Result<(), AppError> {
        let snapshot = {
            let mut guard = self.workspaces.lock();
            guard.workspaces.retain(|w| w.id != id);
            guard.clone()
        };
        atomic_write_json(&self.config_dir.join("workspaces.json"), &snapshot)?;
        Ok(())
    }

    // ---------- 布局 ----------

    /// 读取持久化布局（克隆一份返回）。
    /// 参数：无；返回：PersistedLayout。
    pub fn layout(&self) -> PersistedLayout {
        self.layout.lock().clone()
    }

    /// 保存并持久化布局。
    /// 参数：l——新的布局；返回：() 或 AppError。
    pub fn save_layout(&self, l: PersistedLayout) -> Result<(), AppError> {
        atomic_write_json(&self.config_dir.join("layout.json"), &l)?;
        *self.layout.lock() = l;
        Ok(())
    }

    // ---------- 自管会话 ----------

    /// 列出指定工作空间的自管会话（按 updatedAt 倒序）。
    /// 参数：workspace_id——工作空间 id；返回：该工作空间的 ManagedSession 列表。
    pub fn managed_sessions(&self, workspace_id: &str) -> Vec<ManagedSession> {
        let mut list: Vec<ManagedSession> = self
            .sessions
            .lock()
            .sessions
            .iter()
            .filter(|s| s.workspace_id == workspace_id)
            .cloned()
            .collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        list
    }

    /// 创建一条自管会话记录并持久化。
    /// 参数：session——新的 ManagedSession；返回：() 或 AppError。
    pub fn create_managed_session(&self, session: ManagedSession) -> Result<(), AppError> {
        let snapshot = {
            let mut guard = self.sessions.lock();
            guard.sessions.push(session);
            guard.clone()
        };
        atomic_write_json(&self.config_dir.join("sessions.json"), &snapshot)
    }

    /// 更新自管会话记录（按 id 查找并覆盖）并持久化。
    /// 参数：session——更新后的 ManagedSession；返回：() 或 AppError。
    pub fn update_managed_session(&self, session: ManagedSession) -> Result<(), AppError> {
        let snapshot = {
            let mut guard = self.sessions.lock();
            if let Some(existing) = guard.sessions.iter_mut().find(|s| s.id == session.id) {
                *existing = session;
            }
            guard.clone()
        };
        atomic_write_json(&self.config_dir.join("sessions.json"), &snapshot)
    }

    /// 删除一条自管会话记录并持久化。
    /// 参数：id——会话 id；返回：() 或 AppError。
    pub fn delete_managed_session(&self, id: &str) -> Result<(), AppError> {
        let snapshot = {
            let mut guard = self.sessions.lock();
            guard.sessions.retain(|s| s.id != id);
            guard.clone()
        };
        atomic_write_json(&self.config_dir.join("sessions.json"), &snapshot)
    }

    // ---------- 启动参数准备 ----------

    /// 为一次 spawn 准备启动数据。
    ///
    /// 约定（与 pty::spawn 一致）：本方法读取 global 配置与请求指向的 workspace，
    /// 将「组装」职责交给 `pty::spawn::build_resolved_launch`，store 只负责数据准备，
    /// 不在此处拼命令 / 注入 env（避免配置逻辑分散两处）。
    ///
    /// 参数：req——启动请求；返回：ResolvedLaunch（已解析的启动描述）或 AppError。
    pub fn resolve_launch(
        &self,
        req: &SpawnRequest,
    ) -> Result<crate::pty::spawn::ResolvedLaunch, AppError> {
        let global = self.global();
        // 按 workspace_id 查找工作空间（可能为 None，纯 shell 或未绑定）
        let ws: Option<Workspace> = match &req.workspace_id {
            Some(id) => {
                let found = self
                    .workspaces
                    .lock()
                    .workspaces
                    .iter()
                    .find(|w| &w.id == id)
                    .cloned();
                // 指定了 workspace_id 却查不到，视为错误
                match found {
                    Some(w) => Some(w),
                    None => {
                        return Err(AppError::NotFound(format!("工作空间不存在: {id}")));
                    }
                }
            }
            None => None,
        };
        // 交给 spawn 模块组装（env 注入、命令拼装、CODEX_HOME 生成等）。
        crate::pty::spawn::build_resolved_launch(&global, ws.as_ref(), req, &self.config_dir)
    }
}

/// 从磁盘读取并反序列化，缺失或解析失败均回退默认；解析失败时先备份为 `<name>.bak`。
/// 参数：path——目标文件路径；返回：反序列化结果或默认值（T: DeserializeOwned + Default）。
fn load_or_default<T>(path: &Path) -> T
where
    T: DeserializeOwned + Default,
{
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<T>(&text) {
            Ok(value) => value,
            Err(_) => {
                // 解析失败：备份损坏文件，返回默认值，保证应用可正常启动。
                let bak = backup_path(path);
                let _ = fs::rename(path, &bak);
                T::default()
            }
        },
        // 文件不存在 / 读取失败：用默认值（首次启动的正常路径）。
        Err(_) => T::default(),
    }
}

/// 构造备份文件路径：`settings.json` → `settings.json.bak`。
/// 参数：path——原文件路径；返回：备份路径。
fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    path.with_file_name(format!("{name}.bak"))
}

/// 原子写 JSON：序列化为美化 JSON → 写 `<name>.tmp` → rename 覆盖目标。
/// 参数：path——目标文件路径；value——可序列化数据；返回：() 或 AppError。
fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let text = serde_json::to_string_pretty(value)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    let tmp = path.with_file_name(format!("{name}.tmp"));
    fs::write(&tmp, text.as_bytes())?;
    // std::fs::rename 在 Windows 上会替换已存在目标（MoveFileEx REPLACE_EXISTING）。
    fs::rename(&tmp, path)?;
    Ok(())
}
