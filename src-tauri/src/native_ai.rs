use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use tauri::State;

use crate::config::model::ProviderProfile;
use crate::error::AppError;
use crate::pty::spawn::{prepare_claude_settings, prepare_codex_home};
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeCommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePromptRequest {
    pub workspace_id: String,
    pub provider_id: String,
    pub prompt: String,
}

/// 根据供应商配置构建原生 AI CLI 命令，不经过 PowerShell。
/// 参数：provider——命名供应商；prompt——完整提示词；config_dir——应用配置目录。
/// 返回：可直接执行的命令描述，配置生成失败时返回 AppError。
pub fn build_native_command(
    provider: &ProviderProfile,
    prompt: &str,
    config_dir: &Path,
) -> Result<NativeCommandSpec, AppError> {
    let mut args = Vec::new();
    let mut env = Vec::new();

    match provider.driver.as_str() {
        "claude" => {
            let settings_path =
                prepare_claude_settings(config_dir, &provider.id, &provider.config)?;
            args.extend([
                "--settings".to_string(),
                settings_path,
                "--print".to_string(),
            ]);
            if let Some(model) = non_empty(&provider.config.model) {
                args.extend(["--model".to_string(), model]);
            }
            args.extend(provider.config.extra_args.iter().cloned());
            args.push(prompt.to_string());
            if let Some(base_url) = non_empty(&provider.config.base_url) {
                env.push(("ANTHROPIC_BASE_URL".to_string(), base_url));
            }
            if let Some(api_key) = non_empty(&provider.config.api_key) {
                env.push(("ANTHROPIC_API_KEY".to_string(), api_key.clone()));
                env.push(("ANTHROPIC_AUTH_TOKEN".to_string(), api_key));
            }
            Ok(NativeCommandSpec {
                program: "claude".to_string(),
                args,
                env,
            })
        }
        "codex" => {
            args.extend([
                "exec".to_string(),
                "--color".to_string(),
                "never".to_string(),
                "--skip-git-repo-check".to_string(),
            ]);
            if let Some(model) = non_empty(&provider.config.model) {
                args.extend(["--model".to_string(), model]);
            }
            args.extend(provider.config.extra_args.iter().cloned());
            args.push(prompt.to_string());
            if let Some(api_key) = non_empty(&provider.config.api_key) {
                env.push(("OPENAI_API_KEY".to_string(), api_key));
            }
            if provider
                .config
                .base_url
                .as_ref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                let codex_home = prepare_codex_home(config_dir, &provider.id, &provider.config)?;
                env.push(("CODEX_HOME".to_string(), codex_home));
            }
            Ok(NativeCommandSpec {
                program: "codex".to_string(),
                args,
                env,
            })
        }
        _ => Err(AppError::Config("不支持的供应商驱动".to_string())),
    }
}

#[tauri::command]
pub async fn ai_prompt(
    state: State<'_, AppState>,
    req: NativePromptRequest,
) -> Result<String, AppError> {
    let workspace = state
        .config
        .workspaces()
        .into_iter()
        .find(|workspace| workspace.id == req.workspace_id)
        .ok_or_else(|| AppError::NotFound("项目不存在".to_string()))?;
    let provider = state
        .config
        .global()
        .providers
        .into_iter()
        .find(|provider| provider.id == req.provider_id)
        .ok_or_else(|| AppError::NotFound("供应商不存在".to_string()))?;
    let spec = build_native_command(&provider, &req.prompt, state.config.config_dir())?;
    let cwd = PathBuf::from(workspace.path);

    tauri::async_runtime::spawn_blocking(move || run_native_command(spec, cwd))
        .await
        .map_err(|error| AppError::Other(format!("AI 任务执行失败: {error}")))?
}

fn run_native_command(spec: NativeCommandSpec, cwd: PathBuf) -> Result<String, AppError> {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args).current_dir(cwd);
    for (key, value) in spec.env {
        command.env(key, value);
    }
    let output = command
        .output()
        .map_err(|error| AppError::Other(format!("无法启动 {}: {error}", spec.program)))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Other(if message.is_empty() {
            format!("{} 执行失败", spec.program)
        } else {
            message
        }));
    }
    let content = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if content.is_empty() {
        return Err(AppError::Other("AI 未返回内容".to_string()));
    }
    Ok(content)
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}
