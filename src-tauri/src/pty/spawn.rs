//! 启动命令组装（spawn.rs，坑集中地，对照计划 8.6 / 风险 3、4）。
//!
//! 三种模式（shell / claude / codex）统一以 PowerShell 为宿主，解决 `.cmd` shim、
//! PATH 解析问题，并让 AI 退出后仍留在 shell（"通用终端"定位）：
//!   - shell:  `powershell.exe -NoLogo`（cwd = 工作空间目录）
//!   - agent:  `powershell.exe -NoLogo -NoExit -EncodedCommand <base64(UTF-16LE)>`
//!             脚本 = `chcp 65001 | Out-Null; [Console]::OutputEncoding=...UTF8; & claude --model m --resume id ...`
//!
//! 用 `-EncodedCommand` 规避引号地狱（base64 的是 UTF-16LE 字节）。唯一合法的命名供应商
//! 使用自身配置；没有合法供应商时不注入应用配置，裸启动 AI 并沿用用户系统配置。
//! env 注入仅在命名供应商有值时进行、不进命令行；命名 Claude 通过应用私有 settings
//! 覆盖用户配置，命名 Codex 额外生成隔离的 CODEX_HOME。
//! **绝不修改用户的 ~/.claude 或 ~/.codex 配置文件。**

use std::path::Path;

use base64::Engine;

use crate::config::model::{AgentConfig, GlobalConfig, ProviderProfile, SpawnRequest, Workspace};
use crate::error::AppError;

/// 已解析的启动描述：交给 PtyManager::spawn 直接用来 openpty + spawn_command。
#[derive(Debug, Clone)]
pub struct ResolvedLaunch {
    /// 宿主程序（shell 路径，通常 powershell.exe）
    pub program: String,
    /// 传给宿主的参数（含 -EncodedCommand 及其 base64 载荷）
    pub args: Vec<String>,
    /// 工作目录
    pub cwd: String,
    /// 需要注入的环境变量（键，值），仅在有值时加入
    pub env: Vec<(String, String)>,
    /// 会话显示标题
    pub title: String,
    /// 会话类型："claude" | "codex" | "shell"
    pub kind: String,
    /// 若为恢复历史会话，记录原 AI sessionId
    pub resumed_from: Option<String>,
}

/// 组装一次 spawn 的启动描述。
///
/// 参数：
///   - `global`：全局配置（提供 shell_path 与命名供应商）；
///   - `ws`：目标工作空间（None 表示纯 shell / 未绑定，cwd 退化到用户主目录）；
///   - `req`：启动请求（kind / resume / cols / rows）；
///   - `config_dir`：应用配置目录（用于命名供应商生成隔离配置）。
/// 返回：ResolvedLaunch 或 AppError。
pub fn build_resolved_launch(
    global: &GlobalConfig,
    ws: Option<&Workspace>,
    req: &SpawnRequest,
    config_dir: &Path,
) -> Result<ResolvedLaunch, AppError> {
    // 宿主 shell：全局配置指定，缺省 powershell.exe。
    let program = if global.shell_path.trim().is_empty() {
        "powershell.exe".to_string()
    } else {
        global.shell_path.clone()
    };

    // 工作目录：优先工作空间路径，否则用户主目录，再否则当前目录。
    let cwd = ws
        .map(|w| w.path.clone())
        .filter(|p| !p.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string());

    // 纯 shell 模式：只起 PowerShell，不注入 env、不拼 AI 命令。
    if req.kind == "shell" {
        return Ok(ResolvedLaunch {
            program,
            args: vec![
                "-NoLogo".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
            ],
            cwd,
            env: Vec::new(),
            title: "PowerShell".to_string(),
            kind: "shell".to_string(),
            resumed_from: None,
        });
    }

    let provider = if req.strict_provider {
        req.provider_id
            .as_deref()
            .map(|id| resolve_strict_provider(global, id, &req.kind))
            .transpose()?
    } else {
        req.provider_id
            .as_deref()
            .and_then(|id| unique_valid_provider(global, id))
            .or_else(|| {
                ws.and_then(|workspace| workspace.default_provider_id.as_deref())
                    .and_then(|id| unique_valid_provider(global, id))
            })
    };
    let kind = provider
        .map(|profile| profile.driver.clone())
        .unwrap_or_else(|| req.kind.clone());

    // 无合法命名供应商时不带应用配置，让 AI 使用用户系统配置。
    let resolved_cfg = provider
        .map(|profile| profile.config.clone())
        .unwrap_or_default();

    let mut env: Vec<(String, String)> = Vec::new();
    let mut ai_args: Vec<String> = Vec::new();

    // 可执行名（经 PowerShell 宿主，靠 PATH 解析，兼容 .exe 与 .cmd shim）。
    let exe = match kind.as_str() {
        "codex" => "codex",
        _ => "claude",
    };

    // Claude 的用户 settings 会覆盖父进程环境变量；命名供应商用 flag 层 settings 保证隔离。
    if kind == "claude" {
        if let Some(profile) = provider {
            let settings_path = prepare_claude_settings(config_dir, &profile.id, &resolved_cfg)?;
            ai_args.push("--settings".to_string());
            ai_args.push(settings_path);
        }
    }

    // --model 参数（有值才加）。
    if let Some(model) = non_empty(&resolved_cfg.model) {
        ai_args.push("--model".to_string());
        ai_args.push(model);
    }

    // resume 恢复历史会话：claude 用 `--resume <id>`，codex 用 `resume <id>`。
    if let Some(rid) = non_empty(&req.resume_session_id) {
        match kind.as_str() {
            "codex" => {
                // codex 的 resume 是子命令，需排在最前。
                ai_args.insert(0, rid.clone());
                ai_args.insert(0, "resume".to_string());
            }
            _ => {
                ai_args.push("--resume".to_string());
                ai_args.push(rid.clone());
            }
        }
    }

    // 附加启动参数逐项追加。
    for a in &resolved_cfg.extra_args {
        if !a.trim().is_empty() {
            ai_args.push(a.clone());
        }
    }

    // Codex TUI 覆盖只作用于当前子进程，不修改用户全局配置。
    if kind == "codex" {
        ai_args.extend([
            "-c".to_string(),
            "tui.animations=false".to_string(),
            "-c".to_string(),
            "tui.terminal_title=[]".to_string(),
        ]);
    }

    // env 注入（仅在有值时；不写入命令行避免密钥泄漏到进程列表）。
    match kind.as_str() {
        "codex" => {
            env.push((
                "COLORFGBG".to_string(),
                if global.theme == "dark" {
                    "15;0".to_string()
                } else {
                    "0;15".to_string()
                },
            ));
            if let Some(key) = non_empty(&resolved_cfg.api_key) {
                env.push(("OPENAI_API_KEY".to_string(), key));
            }
            // 仅命名 Codex 生成隔离 CODEX_HOME，系统回退沿用用户自己的配置目录。
            if let Some(profile) = provider {
                let codex_home = prepare_codex_home(config_dir, &profile.id, &resolved_cfg)?;
                env.push(("CODEX_HOME".to_string(), codex_home));
            }
        }
        _ => {
            if let Some(base) = non_empty(&resolved_cfg.base_url) {
                env.push(("ANTHROPIC_BASE_URL".to_string(), base));
            }
            if let Some(key) = non_empty(&resolved_cfg.api_key) {
                env.push(("ANTHROPIC_API_KEY".to_string(), key.clone()));
                env.push(("ANTHROPIC_AUTH_TOKEN".to_string(), key));
            }
        }
    }

    // 组装 PowerShell 脚本：先切 UTF-8 代码页与输出编码，再 & 调用 AI（参数单引号安全包裹）。
    let mut script = String::new();
    script.push_str("chcp 65001 | Out-Null; ");
    script.push_str("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ");
    script.push_str("& ");
    script.push_str(&quote_arg(exe));
    for a in &ai_args {
        script.push(' ');
        script.push_str(&quote_arg(a));
    }

    let encoded = encode_powershell_command(&script);
    let args = vec![
        "-NoLogo".to_string(),
        "-NoExit".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-EncodedCommand".to_string(),
        encoded,
    ];

    // 标题：恢复会话标注"续:"，普通会话直接用 AI 名。
    let base_title = match kind.as_str() {
        "codex" => "codex",
        _ => "claude",
    };
    let title = if req
        .resume_session_id
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        format!("续: {base_title}")
    } else {
        base_title.to_string()
    };

    Ok(ResolvedLaunch {
        program,
        args,
        cwd,
        env,
        title,
        kind,
        resumed_from: non_empty(&req.resume_session_id),
    })
}

/// 按标识解析唯一且合法的命名供应商。
/// 参数：global——全局配置；id——供应商标识。返回：同 ID 恰有一个且驱动为 claude/codex 的供应商。
fn unique_valid_provider<'a>(global: &'a GlobalConfig, id: &str) -> Option<&'a ProviderProfile> {
    let mut candidates = global
        .providers
        .iter()
        .filter(|candidate| candidate.id == id);
    let provider = candidates.next()?;
    if candidates.next().is_some() || !matches!(provider.driver.as_str(), "claude" | "codex") {
        return None;
    }
    Some(provider)
}

/// 严格解析唯一、合法且与请求类型一致的命名供应商。
/// 参数：global——全局配置；id——供应商标识；kind——请求会话类型。
/// 返回：匹配的供应商；缺失、重复、非法或类型不匹配时返回配置错误。
fn resolve_strict_provider<'a>(
    global: &'a GlobalConfig,
    id: &str,
    kind: &str,
) -> Result<&'a ProviderProfile, AppError> {
    let mut candidates = global
        .providers
        .iter()
        .filter(|candidate| candidate.id == id);
    let provider = candidates
        .next()
        .ok_or_else(|| AppError::Config(format!("供应商不存在: {id}")))?;
    if candidates.next().is_some() {
        return Err(AppError::Config(format!("供应商标识不唯一: {id}")));
    }
    if !matches!(provider.driver.as_str(), "claude" | "codex") {
        return Err(AppError::Config(format!(
            "不支持的供应商驱动: {}",
            provider.driver
        )));
    }
    if provider.driver != kind {
        return Err(AppError::Config(format!(
            "供应商驱动与请求类型不匹配: 期望 {kind}，实际 {}",
            provider.driver
        )));
    }
    Ok(provider)
}

/// 生成命名 Claude 供应商专用的 flag 层 settings 文件。
///
/// 目录：`{config_dir}/claude-settings/{安全供应商键}/settings.json`。供应商标识使用
/// URL-safe Base64 编码，避免路径分隔符或 `..` 逃逸应用配置目录。文件显式写入三项
/// `ANTHROPIC_*` 环境变量，使空配置也能覆盖用户 settings 中的旧供应商值。
/// 参数：config_dir——应用配置目录；provider_id——供应商标识；cfg——供应商 AI 配置。
/// 返回：settings.json 绝对或基于 config_dir 的路径字符串，失败时返回 AppError。
pub(crate) fn prepare_claude_settings(
    config_dir: &Path,
    provider_id: &str,
    cfg: &AgentConfig,
) -> Result<String, AppError> {
    let provider_key =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(provider_id.as_bytes());
    let settings_dir = config_dir.join("claude-settings").join(provider_key);
    std::fs::create_dir_all(&settings_dir)?;

    let api_key = non_empty(&cfg.api_key).unwrap_or_default();
    let settings = serde_json::json!({
        "env": {
            "ANTHROPIC_BASE_URL": non_empty(&cfg.base_url).unwrap_or_default(),
            "ANTHROPIC_API_KEY": api_key,
            "ANTHROPIC_AUTH_TOKEN": api_key,
        }
    });
    let settings_path = settings_dir.join("settings.json");
    std::fs::write(&settings_path, serde_json::to_vec_pretty(&settings)?)?;

    Ok(settings_path.to_string_lossy().to_string())
}

/// 生成并写入隔离的 CODEX_HOME 目录及其 config.toml。
///
/// 目录：`{config_dir}/codex-homes/{wsId}`。每次 spawn 都重写 config.toml，
/// 使模型 / base_url 的配置改动即时生效（该目录由本应用独占管理，不涉及用户 ~/.codex）。
/// 参数：config_dir——应用配置目录；ws_id——工作空间 id；cfg——已解析的 AI 配置。
/// 返回：CODEX_HOME 绝对路径字符串或 AppError。
pub(crate) fn prepare_codex_home(
    config_dir: &Path,
    ws_id: &str,
    cfg: &AgentConfig,
) -> Result<String, AppError> {
    let home = config_dir.join("codex-homes").join(ws_id);
    std::fs::create_dir_all(&home)?;

    // 组装最小 config.toml：有 base_url 时定义自定义 provider，否则仅写 model。
    let mut toml = String::new();
    if let Some(model) = non_empty(&cfg.model) {
        toml.push_str(&format!("model = \"{}\"\n", toml_escape(&model)));
    }
    if let Some(base) = non_empty(&cfg.base_url) {
        toml.push_str("model_provider = \"custom\"\n\n");
        toml.push_str("[model_providers.custom]\n");
        toml.push_str("name = \"custom\"\n");
        toml.push_str(&format!("base_url = \"{}\"\n", toml_escape(&base)));
        toml.push_str("env_key = \"OPENAI_API_KEY\"\n");
    }
    // 即便内容为空也写入，保证目录结构存在、隔离生效。
    std::fs::write(home.join("config.toml"), toml.as_bytes())?;

    Ok(home.to_string_lossy().to_string())
}

/// 取 Option<String> 中的非空值（去空白后为空视为无）。
/// 参数：v——可选字符串引用；返回：Some(trim 后原值) 或 None。
fn non_empty(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// PowerShell 单引号安全包裹：内部单引号翻倍（`'` → `''`），整体外包单引号。
/// 参数：s——原始参数；返回：可安全嵌入 PowerShell 脚本的字面量。
fn quote_arg(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 转义 TOML 双引号字符串中的反斜杠与双引号。
/// 参数：s——原始字符串；返回：转义后可安全嵌入 `"..."` 的内容。
fn toml_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 把脚本编码为 PowerShell `-EncodedCommand` 所需的 base64(UTF-16LE)。
/// 参数：script——PowerShell 脚本文本；返回：base64 字符串。
fn encode_powershell_command(script: &str) -> String {
    // UTF-16LE 字节序列
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::model::ProviderProfile;
    use std::path::PathBuf;
    use uuid::Uuid;

    /// 构造测试供应商；参数为标识、驱动和配置，返回完整供应商配置。
    fn provider(id: &str, driver: &str, config: AgentConfig) -> ProviderProfile {
        ProviderProfile {
            id: id.to_string(),
            name: id.to_string(),
            driver: driver.to_string(),
            config,
        }
    }

    /// 构造可识别的旧配置；参数为标记，返回所有字段均非空的配置。
    fn legacy_config(marker: &str) -> AgentConfig {
        AgentConfig {
            base_url: Some(format!("https://{marker}.example.com")),
            api_key: Some(format!("{marker}-key")),
            model: Some(format!("{marker}-model")),
            extra_args: vec![format!("--{marker}-extra")],
        }
    }

    /// 解码启动描述中的 PowerShell 脚本；参数为启动描述，返回 UTF-16LE 解码后的文本。
    fn decode_script(launch: &ResolvedLaunch) -> String {
        let encoded_index = launch
            .args
            .iter()
            .position(|arg| arg == "-EncodedCommand")
            .expect("AI 启动参数应包含 -EncodedCommand");
        let encoded = launch
            .args
            .get(encoded_index + 1)
            .expect("-EncodedCommand 后应存在编码脚本");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("PowerShell 脚本应为有效 base64");
        assert_eq!(bytes.len() % 2, 0, "UTF-16LE 字节数应为偶数");
        let utf16 = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&utf16).expect("PowerShell 脚本应为有效 UTF-16LE")
    }

    /// 生成测试专用临时目录；参数为空，返回带随机 UUID 的唯一目录路径。
    fn unique_temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("tht-panel-{}", Uuid::new_v4()))
    }

    fn workspace() -> Workspace {
        Workspace {
            id: "project-1".to_string(),
            name: "项目".to_string(),
            path: ".".to_string(),
            agent: "claude".to_string(),
            use_global_config: true,
            default_provider_id: Some("claude-b".to_string()),
            ..Workspace::default()
        }
    }

    fn request(provider_id: &str) -> SpawnRequest {
        SpawnRequest {
            workspace_id: Some("project-1".to_string()),
            kind: "claude".to_string(),
            provider_id: Some(provider_id.to_string()),
            strict_provider: false,
            resume_session_id: None,
            cols: 80,
            rows: 24,
        }
    }

    /// 验证严格模式可使用与请求类型一致的唯一合法命名供应商。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn strict_named_provider_succeeds() {
        let config_dir = unique_temp_dir();
        let mut global = GlobalConfig::default();
        global.providers = vec![provider(
            "strict-provider",
            "claude",
            legacy_config("strict-provider"),
        )];
        let mut req = request("strict-provider");
        req.strict_provider = true;

        let launch = build_resolved_launch(&global, Some(&workspace()), &req, &config_dir)
            .expect("严格模式应接受唯一且类型匹配的命名供应商");
        let script = decode_script(&launch);
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }

        assert_eq!(launch.kind, "claude");
        assert!(script.contains("strict-provider-model"));
    }

    /// 验证严格模式拒绝不存在的命名供应商，而不是回退到项目默认供应商。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn strict_named_provider_rejects_missing_id() {
        let config_dir = unique_temp_dir();
        let mut global = GlobalConfig::default();
        global.providers = vec![provider(
            "project-default",
            "claude",
            legacy_config("project-default"),
        )];
        let mut ws = workspace();
        ws.default_provider_id = Some("project-default".to_string());
        let mut req = request("missing");
        req.strict_provider = true;

        let result = build_resolved_launch(&global, Some(&ws), &req, &config_dir);
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }
        let error = result.expect_err("严格模式不应回退不存在的命名供应商");

        assert!(matches!(error, AppError::Config(_)));
    }

    /// 验证严格模式拒绝重复标识的命名供应商。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn strict_named_provider_rejects_duplicate_id() {
        let mut global = GlobalConfig::default();
        global.providers = vec![
            provider("duplicate", "claude", legacy_config("duplicate-a")),
            provider("duplicate", "claude", legacy_config("duplicate-b")),
        ];
        let mut ws = workspace();
        ws.default_provider_id = None;
        let mut req = request("duplicate");
        req.strict_provider = true;

        let error = build_resolved_launch(&global, Some(&ws), &req, Path::new("."))
            .expect_err("严格模式不应接受重复标识的命名供应商");

        assert!(matches!(error, AppError::Config(_)));
    }

    /// 验证严格模式拒绝不受支持的供应商驱动。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn strict_named_provider_rejects_unsupported_driver() {
        let mut global = GlobalConfig::default();
        global.providers = vec![provider(
            "unsupported",
            "gemini",
            legacy_config("unsupported"),
        )];
        let mut ws = workspace();
        ws.default_provider_id = None;
        let mut req = request("unsupported");
        req.strict_provider = true;

        let error = build_resolved_launch(&global, Some(&ws), &req, Path::new("."))
            .expect_err("严格模式不应接受不受支持的供应商驱动");

        assert!(matches!(error, AppError::Config(_)));
    }

    /// 验证严格模式拒绝与请求会话类型不一致的合法供应商驱动。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn strict_named_provider_rejects_driver_mismatch() {
        let config_dir = unique_temp_dir();
        let mut global = GlobalConfig::default();
        global.providers = vec![provider(
            "claude-provider",
            "claude",
            legacy_config("claude-provider"),
        )];
        let mut ws = workspace();
        ws.default_provider_id = None;
        let mut req = request("claude-provider");
        req.kind = "codex".to_string();
        req.strict_provider = true;

        let result = build_resolved_launch(&global, Some(&ws), &req, &config_dir);
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }
        let error = result.expect_err("严格模式不应允许供应商驱动覆盖请求类型");

        assert!(matches!(error, AppError::Config(_)));
    }

    /// 验证严格系统模式忽略项目默认供应商并沿用请求类型的系统配置。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn strict_system_ignores_workspace_default_provider() {
        let config_dir = unique_temp_dir();
        let mut global = GlobalConfig::default();
        global.providers = vec![provider(
            "project-default",
            "claude",
            legacy_config("project-default"),
        )];
        let mut ws = workspace();
        ws.default_provider_id = Some("project-default".to_string());
        let mut req = request("unused");
        req.kind = "codex".to_string();
        req.provider_id = None;
        req.strict_provider = true;

        let launch = build_resolved_launch(&global, Some(&ws), &req, &config_dir)
            .expect("严格系统模式应生成启动描述");
        let script = decode_script(&launch);
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }

        assert_eq!(launch.kind, "codex");
        expect_env(&launch, "COLORFGBG", "0;15");
        assert_eq!(launch.env.len(), 1, "严格系统模式只应注入主题环境");
        assert!(!script.contains("project-default-model"));
    }

    /// 验证 shell 启动在严格模式下仍完全绕过供应商校验。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn strict_shell_ignores_provider_validation() {
        let mut req = request("missing");
        req.kind = "shell".to_string();
        req.strict_provider = true;

        let launch = build_resolved_launch(
            &GlobalConfig::default(),
            Some(&workspace()),
            &req,
            Path::new("."),
        )
        .expect("严格模式不应影响 shell 启动");

        assert_eq!(launch.kind, "shell");
        assert_eq!(launch.title, "PowerShell");
        assert!(launch.env.is_empty());
    }

    /// 验证重复的请求供应商无效，并回退到唯一合法的项目默认供应商。
    #[test]
    fn duplicate_requested_provider_falls_back_to_unique_valid_default() {
        let mut global = GlobalConfig::default();
        global.providers = vec![
            provider("duplicate", "claude", legacy_config("duplicate-valid")),
            provider("duplicate", "gemini", legacy_config("duplicate-illegal")),
            provider(
                "project-default",
                "claude",
                legacy_config("project-default"),
            ),
        ];
        let mut ws = workspace();
        ws.default_provider_id = Some("project-default".to_string());

        let launch = build_resolved_launch(
            &global,
            Some(&ws),
            &request("duplicate"),
            &unique_temp_dir(),
        )
        .expect("重复请求供应商应回退到项目默认供应商");
        let script = decode_script(&launch);

        assert_eq!(launch.kind, "claude");
        assert!(script.contains("project-default-model"));
        assert!(!script.contains("duplicate-valid-model"));
    }

    /// 验证不存在的请求供应商不会报错，而会回退到唯一合法的项目默认供应商。
    #[test]
    fn missing_requested_provider_falls_back_to_unique_valid_default() {
        let mut global = GlobalConfig::default();
        global.providers = vec![provider(
            "project-default",
            "claude",
            legacy_config("project-default"),
        )];
        let mut ws = workspace();
        ws.default_provider_id = Some("project-default".to_string());

        let launch =
            build_resolved_launch(&global, Some(&ws), &request("missing"), &unique_temp_dir())
                .expect("不存在的请求供应商应回退到项目默认供应商");

        assert_eq!(launch.kind, "claude");
        assert!(decode_script(&launch).contains("project-default-model"));
    }

    /// 验证不支持的请求供应商驱动无效，并回退到唯一合法的项目默认供应商。
    #[test]
    fn unsupported_requested_provider_driver_falls_back_to_unique_valid_default() {
        let mut global = GlobalConfig::default();
        global.providers = vec![
            provider("requested", "gemini", legacy_config("illegal-request")),
            provider(
                "project-default",
                "claude",
                legacy_config("project-default"),
            ),
        ];
        let mut ws = workspace();
        ws.default_provider_id = Some("project-default".to_string());

        let launch = build_resolved_launch(
            &global,
            Some(&ws),
            &request("requested"),
            &unique_temp_dir(),
        )
        .expect("非法请求供应商应回退到项目默认供应商");
        let script = decode_script(&launch);

        assert_eq!(launch.kind, "claude");
        assert!(script.contains("project-default-model"));
        assert!(!script.contains("illegal-request-model"));
    }

    /// 验证重复的项目默认供应商无效，即使其中恰有一个条目的驱动合法。
    #[test]
    fn duplicate_default_provider_is_ignored_as_system_fallback() {
        let mut global = GlobalConfig::default();
        global.providers = vec![
            provider("duplicate", "claude", legacy_config("duplicate-valid")),
            provider("duplicate", "gemini", legacy_config("duplicate-illegal")),
        ];
        let mut ws = workspace();
        ws.default_provider_id = Some("duplicate".to_string());
        let mut req = request("unused");
        req.provider_id = None;
        req.kind = "codex".to_string();

        let launch = build_resolved_launch(&global, Some(&ws), &req, Path::new("."))
            .expect("重复项目默认供应商应进入系统回退");

        assert_eq!(launch.kind, "codex");
        assert!(!decode_script(&launch).contains("duplicate-valid-model"));
    }

    /// 验证不支持的项目默认供应商驱动无效，并按请求类型进入系统回退。
    #[test]
    fn unsupported_default_provider_driver_is_ignored_as_system_fallback() {
        let mut global = GlobalConfig::default();
        global.providers = vec![provider(
            "project-default",
            "gemini",
            legacy_config("illegal-driver"),
        )];
        let mut ws = workspace();
        ws.default_provider_id = Some("project-default".to_string());
        let mut req = request("unused");
        req.provider_id = None;
        req.kind = "codex".to_string();

        let launch = build_resolved_launch(&global, Some(&ws), &req, Path::new("."))
            .expect("非法项目默认供应商应进入系统回退");

        assert_eq!(launch.kind, "codex");
        assert!(!decode_script(&launch).contains("illegal-driver-model"));
    }

    /// 验证系统回退忽略全局和工作空间旧配置，仅生成裸 AI 启动命令。
    #[test]
    fn system_fallback_ignores_legacy_agent_configs() {
        let mut global = GlobalConfig::default();
        global.claude_defaults = legacy_config("global-claude");
        global.codex_defaults = legacy_config("global-codex");
        let legacy_markers = ["global-claude", "global-codex", "workspace"];

        for (kind, use_global_config) in [("claude", true), ("claude", false), ("codex", true)] {
            let mut ws = workspace();
            ws.default_provider_id = None;
            ws.use_global_config = use_global_config;
            ws.config = Some(legacy_config("workspace"));
            let mut req = request("unused");
            req.provider_id = None;
            req.kind = kind.to_string();

            let launch = build_resolved_launch(&global, Some(&ws), &req, Path::new("."))
                .expect("系统回退应生成启动描述");
            let script = decode_script(&launch);

            assert!(launch.args.iter().any(|arg| arg == "-NoExit"));
            assert!(launch.args.iter().any(|arg| arg == "-EncodedCommand"));
            if kind == "codex" {
                expect_env(&launch, "COLORFGBG", "0;15");
                assert_eq!(launch.env.len(), 1, "Codex 系统回退只应注入主题环境");
            } else {
                assert!(launch.env.is_empty(), "Claude 系统回退不应注入应用环境变量");
            }
            for marker in legacy_markers {
                assert!(!script.contains(marker), "脚本不应包含旧配置标记 {marker}");
            }
        }
    }

    /// 验证浅色 Codex 系统回退注入可读主题并关闭 TUI 动画。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn codex_terminal_light_uses_theme_and_tui_overrides() {
        let mut ws = workspace();
        ws.default_provider_id = None;
        let mut req = request("unused");
        req.kind = "codex".to_string();
        req.provider_id = None;

        let launch =
            build_resolved_launch(&GlobalConfig::default(), Some(&ws), &req, Path::new("."))
                .expect("浅色 Codex 应生成启动描述");
        let script = decode_script(&launch);

        expect_env(&launch, "COLORFGBG", "0;15");
        assert!(script.contains("'tui.animations=false'"));
        assert!(script.contains("'tui.terminal_title=[]'"));
    }

    /// 验证深色 Codex 恢复命令保留子命令顺序并使用深色主题环境。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn codex_terminal_dark_preserves_resume_and_extra_args() {
        let config_dir = unique_temp_dir();
        let mut global = GlobalConfig::default();
        global.theme = "dark".to_string();
        global.providers = vec![provider(
            "codex-dark",
            "codex",
            AgentConfig {
                extra_args: vec!["--no-alt-screen".to_string()],
                ..AgentConfig::default()
            },
        )];
        let mut ws = workspace();
        ws.default_provider_id = None;
        let mut req = request("codex-dark");
        req.kind = "codex".to_string();
        req.resume_session_id = Some("session-1".to_string());

        let launch = build_resolved_launch(&global, Some(&ws), &req, &config_dir)
            .expect("深色 Codex 恢复应生成启动描述");
        let script = decode_script(&launch);
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }

        expect_env(&launch, "COLORFGBG", "15;0");
        assert!(script.contains("'codex' 'resume' 'session-1' '--no-alt-screen'"));
        assert!(script.contains("'tui.animations=false'"));
        assert!(script.contains("'tui.terminal_title=[]'"));
    }

    /// 验证 Codex 系统回退不注入或创建隔离 CODEX_HOME，并只清理本测试唯一目录。
    #[test]
    fn codex_system_fallback_does_not_create_isolated_home() {
        let config_dir = unique_temp_dir();
        let mut global = GlobalConfig::default();
        global.claude_defaults = legacy_config("global-claude");
        global.codex_defaults = legacy_config("global-codex");
        let mut ws = workspace();
        ws.default_provider_id = None;
        ws.use_global_config = false;
        ws.config = Some(legacy_config("workspace"));
        let mut req = request("unused");
        req.provider_id = None;
        req.kind = "codex".to_string();

        let launch = build_resolved_launch(&global, Some(&ws), &req, &config_dir)
            .expect("Codex 系统回退应生成启动描述");
        let has_codex_home_env = launch.env.iter().any(|(key, _)| key == "CODEX_HOME");
        let codex_homes_exists = config_dir.join("codex-homes").exists();
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }

        assert!(!has_codex_home_env, "系统回退不应注入 CODEX_HOME");
        assert!(!codex_homes_exists, "系统回退不应创建 codex-homes");
    }

    /// 验证命名 Claude 供应商通过应用私有 settings 覆盖用户级环境配置。
    #[test]
    fn named_claude_provider_uses_isolated_flag_settings() {
        let config_dir = unique_temp_dir();
        let provider_id = "claude/../../provider-b";
        let provider_key =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(provider_id.as_bytes());
        let expected_settings = config_dir
            .join("claude-settings")
            .join(provider_key)
            .join("settings.json");
        let mut global = GlobalConfig::default();
        global.providers = vec![provider(
            provider_id,
            "claude",
            AgentConfig {
                base_url: Some("https://provider-b.example.com".to_string()),
                api_key: Some("provider-b-test-key".to_string()),
                model: Some("claude-provider-b".to_string()),
                extra_args: Vec::new(),
            },
        )];

        let launch = build_resolved_launch(
            &global,
            Some(&workspace()),
            &request(provider_id),
            &config_dir,
        )
        .expect("命名 Claude 供应商应生成启动描述");
        let script = decode_script(&launch);
        let expected_path = expected_settings.to_string_lossy();

        assert!(script.contains(&format!("'--settings' {}", quote_arg(&expected_path))));
        let settings_text = std::fs::read_to_string(&expected_settings)
            .expect("命名 Claude 供应商应生成独立 settings.json");
        let settings: serde_json::Value =
            serde_json::from_str(&settings_text).expect("Claude settings 应为有效 JSON");
        assert_eq!(
            settings["env"]["ANTHROPIC_BASE_URL"],
            "https://provider-b.example.com"
        );
        assert_eq!(
            settings["env"]["ANTHROPIC_AUTH_TOKEN"],
            "provider-b-test-key"
        );
        assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "provider-b-test-key");
    }

    /// 验证未选择合法 Claude 供应商时不创建或传入应用 settings。
    #[test]
    fn claude_system_fallback_does_not_use_flag_settings() {
        let config_dir = unique_temp_dir();
        let mut ws = workspace();
        ws.default_provider_id = None;
        let mut req = request("unused");
        req.provider_id = None;

        let launch = build_resolved_launch(&GlobalConfig::default(), Some(&ws), &req, &config_dir)
            .expect("Claude 系统回退应生成启动描述");

        assert!(!decode_script(&launch).contains("'--settings'"));
        assert!(!config_dir.join("claude-settings").exists());
    }

    /// 验证命名供应商优先于项目旧配置，并注入自身连接参数。
    #[test]
    fn named_provider_overrides_project_legacy_config() {
        let mut global = GlobalConfig::default();
        global.providers = vec![ProviderProfile {
            id: "claude-b".to_string(),
            name: "Claude B".to_string(),
            driver: "claude".to_string(),
            config: AgentConfig {
                base_url: Some("https://b.example.com".to_string()),
                api_key: Some("key-b".to_string()),
                model: Some("claude-b-model".to_string()),
                extra_args: Vec::new(),
            },
        }];

        let launch = build_resolved_launch(
            &global,
            Some(&workspace()),
            &request("claude-b"),
            &unique_temp_dir(),
        )
        .expect("命名供应商应生成启动参数");

        expect_env(&launch, "ANTHROPIC_BASE_URL", "https://b.example.com");
        expect_env(&launch, "ANTHROPIC_AUTH_TOKEN", "key-b");
        assert_eq!(launch.kind, "claude");
    }

    /// 验证供应商驱动可覆盖会话遗留类型，确保跨驱动切换正确。
    #[test]
    fn provider_driver_is_authoritative_for_cross_driver_switch() {
        let mut global = GlobalConfig::default();
        global.providers = vec![ProviderProfile {
            id: "claude-a".to_string(),
            name: "Claude A".to_string(),
            driver: "claude".to_string(),
            config: AgentConfig::default(),
        }];

        let mut req = request("claude-a");
        req.kind = "codex".to_string();
        let launch = build_resolved_launch(&global, Some(&workspace()), &req, &unique_temp_dir())
            .expect("供应商驱动应覆盖旧会话类型");

        assert_eq!(launch.kind, "claude");
        assert_eq!(launch.title, "claude");
    }

    /// 断言启动描述包含指定环境变量。
    /// 参数：launch——启动描述；key——变量名；value——期望值；返回：无。
    fn expect_env(launch: &ResolvedLaunch, key: &str, value: &str) {
        assert!(launch
            .env
            .iter()
            .any(|(actual_key, actual_value)| actual_key == key && actual_value == value));
    }
}
