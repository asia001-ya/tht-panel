use std::path::PathBuf;

use tht_panel_lib::config::model::{AgentConfig, ProviderProfile};
use tht_panel_lib::native_ai::build_native_command;
use uuid::Uuid;

/// 生成原生命令测试使用的唯一临时配置目录。
/// 参数：无；返回：位于系统临时目录下的唯一路径。
fn unique_temp_dir() -> PathBuf {
    std::env::temp_dir().join(format!("tht-panel-native-ai-{}", Uuid::new_v4()))
}

/// 验证 Claude 原生会话直启 CLI，并通过 flag settings 隔离用户级供应商配置。
#[test]
fn claude_native_command_uses_direct_exec_and_flag_settings() {
    let config_dir = unique_temp_dir();
    let provider = ProviderProfile {
        id: "claude-a".to_string(),
        name: "Claude A".to_string(),
        driver: "claude".to_string(),
        config: AgentConfig {
            base_url: Some("https://claude.example.com".to_string()),
            api_key: Some("secret".to_string()),
            model: Some("claude-model".to_string()),
            extra_args: Vec::new(),
        },
    };

    let command =
        build_native_command(&provider, "hello", &config_dir).expect("Claude 原生命令应可构建");

    assert_eq!(command.program, "claude");
    assert!(!command.args.iter().any(|arg| arg.contains("powershell")));
    assert!(command.args.iter().any(|arg| arg == "--print"));
    let settings_index = command
        .args
        .iter()
        .position(|arg| arg == "--settings")
        .expect("Claude 原生命令应传入 flag settings");
    let settings_path = PathBuf::from(
        command
            .args
            .get(settings_index + 1)
            .expect("--settings 后应存在文件路径"),
    );
    assert!(settings_path.starts_with(&config_dir));
    let settings_text =
        std::fs::read_to_string(settings_path).expect("Claude 原生命令应生成独立 settings.json");
    let settings: serde_json::Value =
        serde_json::from_str(&settings_text).expect("Claude settings 应为有效 JSON");
    assert_eq!(
        settings["env"]["ANTHROPIC_BASE_URL"],
        "https://claude.example.com"
    );
    assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
    assert!(command.env.iter().any(|(key, value)| {
        key == "ANTHROPIC_BASE_URL" && value == "https://claude.example.com"
    }));
    assert!(command
        .env
        .iter()
        .any(|(key, value)| key == "ANTHROPIC_API_KEY" && value == "secret"));
}

/// 验证 Codex 原生会话直接执行 `codex exec`，不经过 PowerShell。
#[test]
fn codex_native_command_uses_exec_directly() {
    let provider = ProviderProfile {
        id: "codex-a".to_string(),
        name: "Codex A".to_string(),
        driver: "codex".to_string(),
        config: AgentConfig {
            base_url: None,
            api_key: Some("secret".to_string()),
            model: Some("gpt-5".to_string()),
            extra_args: Vec::new(),
        },
    };

    let command = build_native_command(&provider, "hello", &unique_temp_dir())
        .expect("Codex 原生命令应可构建");

    assert_eq!(command.program, "codex");
    assert_eq!(command.args.first().map(String::as_str), Some("exec"));
    assert!(!command.args.iter().any(|arg| arg.contains("powershell")));
}
