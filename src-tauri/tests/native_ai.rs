use std::path::Path;

use tht_panel_lib::config::model::{AgentConfig, ProviderProfile};
use tht_panel_lib::native_ai::build_native_command;

#[test]
fn claude_native_command_does_not_use_powershell() {
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
        build_native_command(&provider, "hello", Path::new(".")).expect("Claude 原生命令应可构建");

    assert_eq!(command.program, "claude");
    assert!(!command.args.iter().any(|arg| arg.contains("powershell")));
    assert!(command.args.iter().any(|arg| arg == "--print"));
    assert!(command.env.iter().any(|(key, value)| {
        key == "ANTHROPIC_BASE_URL" && value == "https://claude.example.com"
    }));
    assert!(command
        .env
        .iter()
        .any(|(key, value)| key == "ANTHROPIC_API_KEY" && value == "secret"));
}

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

    let command =
        build_native_command(&provider, "hello", Path::new(".")).expect("Codex 原生命令应可构建");

    assert_eq!(command.program, "codex");
    assert_eq!(command.args.first().map(String::as_str), Some("exec"));
    assert!(!command.args.iter().any(|arg| arg.contains("powershell")));
}
