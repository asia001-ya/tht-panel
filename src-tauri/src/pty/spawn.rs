//! 原生 Shell 与 AI 初始命令组装。
//!
//! PTY 直接启动用户配置的 PowerShell、PowerShell 7 或 cmd，不传包装脚本或终端改造参数。
//! Claude/Codex 会话把 AI 命令作为一次性初始输入交给 PTY；AI 退出后自然返回 Shell。
//! 唯一合法的命名供应商使用自身配置；没有合法供应商时沿用用户系统配置。
//! 环境变量仅在命名供应商有值时注入，命名 Claude 使用应用私有 settings，命名 Codex
//! 使用隔离的 CODEX_HOME。
//! **绝不修改用户的 ~/.claude 或 ~/.codex 配置文件。**

use std::path::Path;

use base64::Engine;

use crate::config::model::{AgentConfig, GlobalConfig, ProviderProfile, SpawnRequest, Workspace};
use crate::error::AppError;

/// 初始命令使用的 Shell 引用规则。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShellCarrier {
    /// Windows PowerShell 或 PowerShell 7
    PowerShell,
    /// Windows 命令提示符
    Cmd,
}

/// 已解析的启动描述：交给 PtyManager::spawn 直接用来 openpty + spawn_command。
#[derive(Debug, Clone)]
pub struct ResolvedLaunch {
    /// 原生 Shell 程序路径
    pub program: String,
    /// 传给 Shell 的启动参数；原生载体固定为空
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
    /// Shell 启动后由 PTY 写入的一次性命令；纯 Shell 会话为 None
    pub initial_command: Option<String>,
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
    // 宿主 Shell：全局配置指定，缺省 powershell.exe。
    let program = if global.shell_path.trim().is_empty() {
        "powershell.exe".to_string()
    } else {
        global.shell_path.trim().to_string()
    };
    let shell_carrier = resolve_shell_carrier(&program)?;

    // 工作目录：优先工作空间路径，否则用户主目录，再否则当前目录。
    let cwd = ws
        .map(|w| w.path.clone())
        .filter(|p| !p.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string());

    // 纯 Shell 模式：只起原生载体，不注入环境或输入 AI 命令。
    if req.kind == "shell" {
        return Ok(ResolvedLaunch {
            program,
            args: Vec::new(),
            cwd,
            env: Vec::new(),
            title: match shell_carrier {
                ShellCarrier::PowerShell => "PowerShell".to_string(),
                ShellCarrier::Cmd => "命令提示符".to_string(),
            },
            kind: "shell".to_string(),
            resumed_from: None,
            initial_command: None,
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

    // AI 可执行名由原生 Shell 通过 PATH 解析，兼容 .exe 与 .cmd shim。
    let executable = match kind.as_str() {
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
    for argument in &resolved_cfg.extra_args {
        if !argument.trim().is_empty() {
            ai_args.push(argument.clone());
        }
    }

    // env 注入（仅在有值时；不写入命令行避免密钥泄漏到进程列表）。
    match kind.as_str() {
        "codex" => {
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

    let initial_command = build_initial_command(shell_carrier, executable, &ai_args)?;

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
        args: Vec::new(),
        cwd,
        env,
        title,
        kind,
        resumed_from: non_empty(&req.resume_session_id),
        initial_command: Some(initial_command),
    })
}

/// 识别程序路径对应的受支持 Shell 载体。
/// 参数：program——Shell 可执行文件名或完整路径；返回：引用规则或明确配置错误。
fn resolve_shell_carrier(program: &str) -> Result<ShellCarrier, AppError> {
    let file_name = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program)
        .to_ascii_lowercase();
    match file_name.as_str() {
        "powershell.exe" | "pwsh.exe" => Ok(ShellCarrier::PowerShell),
        "cmd.exe" => Ok(ShellCarrier::Cmd),
        _ => Err(AppError::Config(format!(
            "不支持的 Shell 载体: {program}；仅支持 powershell.exe、pwsh.exe 或 cmd.exe"
        ))),
    }
}

/// 按载体规则构造一条可作为普通终端输入的 AI 命令。
/// 参数：carrier——Shell 类型；executable——固定 AI 可执行名；args——AI 参数。
/// 返回：不含输入控制字符的命令行；发现控制字符时返回不回显参数的配置错误。
fn build_initial_command(
    carrier: ShellCarrier,
    executable: &str,
    args: &[String],
) -> Result<String, AppError> {
    for value in std::iter::once(executable).chain(args.iter().map(String::as_str)) {
        if value.chars().any(char::is_control) {
            return Err(AppError::Config(
                "AI 启动参数包含不支持的控制字符".to_string(),
            ));
        }
        if carrier == ShellCarrier::Cmd && value.contains('!') {
            return Err(AppError::Config(
                "cmd 启动参数包含不支持的感叹号".to_string(),
            ));
        }
    }

    let quote_arg: fn(&str) -> String = match carrier {
        ShellCarrier::PowerShell => quote_powershell_arg,
        ShellCarrier::Cmd => quote_cmd_arg,
    };
    let mut command = executable.to_string();
    for arg in args {
        command.push(' ');
        command.push_str(&quote_arg(arg));
    }
    Ok(command)
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

/// 按 PowerShell 单引号规则引用一个参数。
/// 参数：value——原始参数；返回：内部单引号翻倍后的单引号字面量。
fn quote_powershell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// 按 cmd 与 Windows 程序参数解析规则引用一个已验证参数。
/// 参数：value——不含感叹号或控制字符的参数；返回：可阻止其余元字符展开并逐字还原的双引号参数。
fn quote_cmd_arg(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
                quoted.push_str("\"\"");
                backslashes = 0;
            }
            '%' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
                quoted.push('"');
                quoted.push('^');
                quoted.push(character);
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

/// 转义 TOML 双引号字符串中的反斜杠与双引号。
/// 参数：s——原始字符串；返回：转义后可安全嵌入 `"..."` 的内容。
fn toml_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::model::ProviderProfile;
    use std::path::PathBuf;
    use uuid::Uuid;

    /// 测试临时目录清理守卫，作用域退出或 panic 展开时尽量删除唯一测试目录。
    struct TempDirCleanup(PathBuf);

    impl Drop for TempDirCleanup {
        /// 清理守卫持有的测试目录；参数为可变自身引用；返回值为空。
        fn drop(&mut self) {
            if self.0.exists() {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

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

    /// 读取 AI 会话的一次性初始命令。
    /// 参数：launch——启动描述；返回：必须存在的初始命令引用。
    fn initial_command(launch: &ResolvedLaunch) -> &str {
        launch
            .initial_command
            .as_deref()
            .expect("AI 启动描述应包含初始命令")
    }

    /// 生成测试专用临时目录；参数为空，返回带随机 UUID 的唯一目录路径。
    fn unique_temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("tht-panel-{}", Uuid::new_v4()))
    }

    /// 把字符串编码为 UTF-16 码元的十六进制文本，供真实 cmd 参数探针逐字比对。
    /// 参数：value——待编码字符串；返回：仅含 ASCII 十六进制字符的编码结果。
    #[cfg(windows)]
    fn utf16_hex(value: &str) -> String {
        use std::fmt::Write as _;

        let mut encoded = String::with_capacity(value.encode_utf16().count() * 4);
        for unit in value.encode_utf16() {
            write!(&mut encoded, "{unit:04X}").expect("写入 String 不应失败");
        }
        encoded
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

    /// 验证 AI 由原生 PowerShell 承载，且启动描述不包含任何 Shell/TUI 改造。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn agent_launch_uses_native_shell_and_plain_initial_command() {
        let mut workspace = workspace();
        workspace.default_provider_id = None;
        let launch = build_resolved_launch(
            &GlobalConfig::default(),
            Some(&workspace),
            &request("unused"),
            Path::new("."),
        )
        .expect("AI 启动描述应生成");
        let command = initial_command(&launch);

        assert_eq!(launch.program, "powershell.exe");
        assert!(launch.args.is_empty());
        assert_eq!(command, "claude");
        assert!(launch.env.is_empty());
        for forbidden in [
            "EncodedCommand",
            "chcp",
            "ExecutionPolicy",
            "NoExit",
            "tui.animations",
            "tui.terminal_title",
            "COLORFGBG",
            "tht-panel-agent-exit",
            "\u{1b}]777",
        ] {
            assert!(!command.contains(forbidden), "初始命令不应包含 {forbidden}");
        }
    }

    /// 验证三个受支持载体都直接启动，纯 Shell 不写入初始命令。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn supported_shell_carriers_start_without_arguments() {
        for shell_path in ["powershell.exe", "pwsh.exe", r"C:\Windows\System32\cmd.exe"] {
            let mut global = GlobalConfig::default();
            global.shell_path = shell_path.to_string();
            let mut req = request("unused");
            req.kind = "shell".to_string();

            let launch = build_resolved_launch(&global, Some(&workspace()), &req, Path::new("."))
                .expect("受支持 Shell 应生成启动描述");

            assert_eq!(launch.program, shell_path);
            assert!(launch.args.is_empty());
            assert!(launch.initial_command.is_none());
            assert!(launch.env.is_empty());
        }
    }

    /// 验证三个受支持载体都能原样启动 Claude 与 Codex，并仅通过初始输入传递 AI 命令。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn supported_shell_carriers_launch_both_ai_commands() {
        for shell_path in ["powershell.exe", "pwsh.exe", "cmd.exe"] {
            for kind in ["claude", "codex"] {
                let mut global = GlobalConfig::default();
                global.shell_path = shell_path.to_string();
                let mut workspace = workspace();
                workspace.default_provider_id = None;
                let mut req = request("unused");
                req.kind = kind.to_string();
                req.provider_id = None;

                let launch = build_resolved_launch(&global, Some(&workspace), &req, Path::new("."))
                    .expect("受支持 Shell 应生成 AI 启动描述");

                assert_eq!(launch.program, shell_path);
                assert!(launch.args.is_empty());
                assert!(launch.initial_command.is_some());
                assert!(
                    initial_command(&launch).starts_with(kind),
                    "{shell_path} 的初始命令应以 {kind} 开头"
                );
            }
        }
    }

    /// 验证未知 Shell 不会套用未经确认的命令引用规则。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn unsupported_shell_carrier_is_rejected() {
        let mut global = GlobalConfig::default();
        global.shell_path = "bash.exe".to_string();

        let error = build_resolved_launch(
            &global,
            Some(&workspace()),
            &request("unused"),
            Path::new("."),
        )
        .expect_err("未知 Shell 应返回配置错误");

        assert!(matches!(error, AppError::Config(_)));
        assert!(error.to_string().contains("bash.exe"));
    }

    /// 验证 PowerShell 参数使用单引号并安全转义内部单引号。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn powershell_argument_uses_single_quote_rules() {
        assert_eq!(
            quote_powershell_arg("two words 'quoted'"),
            "'two words ''quoted'''"
        );
    }

    /// 验证 cmd 参数同时满足 cmd 引号状态与 Windows 程序参数解析规则。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn cmd_argument_uses_windows_quote_rules() {
        assert_eq!(
            quote_cmd_arg(r#"two words "quoted"\"#),
            r#""two words ""quoted""\\""#
        );
    }

    /// 验证 PTY 初始命令拒绝输入控制字符，且配置错误不会回显敏感参数。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn initial_command_rejects_control_characters_without_leaking_arguments() {
        for control_character in ['\r', '\n', '\u{1b}'] {
            let sensitive_marker = "sensitive-session-id";
            let sensitive_argument = format!("{sensitive_marker}{control_character}private-suffix");
            let mut workspace = workspace();
            workspace.default_provider_id = None;
            let mut req = request("unused");
            req.provider_id = None;
            req.resume_session_id = Some(sensitive_argument.clone());

            let error = build_resolved_launch(
                &GlobalConfig::default(),
                Some(&workspace),
                &req,
                Path::new("."),
            )
            .expect_err("含输入控制字符的参数应被拒绝");
            let error_message = error.to_string();

            assert!(matches!(error, AppError::Config(_)));
            assert!(!error_message.contains(sensitive_marker));
            assert!(!error_message.contains(&sensitive_argument));
        }
    }

    /// 验证 cmd 拒绝会触发延迟展开的感叹号，且配置错误不会回显敏感参数。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn cmd_initial_command_rejects_exclamation_mark_without_leaking_argument() {
        let sensitive_argument = "sensitive!private";
        let mut global = GlobalConfig::default();
        global.shell_path = "cmd.exe".to_string();
        let mut workspace = workspace();
        workspace.default_provider_id = None;
        let mut req = request("unused");
        req.provider_id = None;
        req.resume_session_id = Some(sensitive_argument.to_string());

        let error = build_resolved_launch(&global, Some(&workspace), &req, Path::new("."))
            .expect_err("cmd 参数中的感叹号应被拒绝");
        let error_message = error.to_string();

        assert!(matches!(error, AppError::Config(_)));
        assert!(!error_message.contains(sensitive_argument));
        assert!(!error_message.contains("sensitive"));
    }

    /// 验证真实 cmd 通过直接 exe 或 npm 风格 shim 时都逐字传递参数，且不会执行旁路命令。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[cfg(windows)]
    #[test]
    fn cmd_arguments_round_trip_through_real_cmd() {
        use std::io::Write as _;
        use std::process::{Command, Stdio};

        let temp_dir = unique_temp_dir();
        let _cleanup = TempDirCleanup(temp_dir.clone());
        std::fs::create_dir_all(&temp_dir).expect("应创建 cmd 探针临时目录");
        let probe_path = temp_dir.join("argv-probe.cjs");
        std::fs::write(
            &probe_path,
            r#"var args = process.argv.slice(2);
var lines = ["COUNT:" + args.length];
for (var i = 0; i < args.length; i++) {
    var value = String(args[i]);
    var encoded = "";
    for (var j = 0; j < value.length; j++) {
        var unit = value.charCodeAt(j).toString(16).toUpperCase();
        while (unit.length < 4) unit = "0" + unit;
        encoded += unit;
    }
    lines.push(i + ":" + encoded);
}
process.stdout.write(lines.join("\n") + "\n");
"#,
        )
        .expect("应写入 cmd argv 探针");
        std::fs::write(
            temp_dir.join("argv-probe.cmd"),
            "@ECHO off\r\nnode.exe \"%~dp0argv-probe.cjs\" %*\r\n",
        )
        .expect("应写入 npm 风格 cmd 探针载体");

        let arguments = vec![
            String::new(),
            "two words".to_string(),
            r#"embedded"quote"#.to_string(),
            r#"slash\"quote"#.to_string(),
            r#"trailing\"#.to_string(),
            r#"&|<>^()%"#.to_string(),
            "%THT_PANEL_CMD_PROBE%".to_string(),
            r#"boundary\%THT_PANEL_CMD_PROBE%\"#.to_string(),
            r#"x" & echo CMD_INJECTION & rem ""#.to_string(),
        ];
        let mut quoted_arguments = String::new();
        for argument in &arguments {
            quoted_arguments.push(' ');
            quoted_arguments.push_str(&quote_cmd_arg(argument));
        }
        // npm 风格 shim 依赖 PATH 解析；NoDefaultCurrentDirectoryInExePath=1 时
        // cmd 不从当前目录找 .cmd，因此显式把探针目录前置到 PATH。
        let probe_search_path = std::env::var_os("PATH").map_or_else(
            || temp_dir.as_os_str().to_owned(),
            |existing| {
                let mut joined = temp_dir.as_os_str().to_owned();
                joined.push(";");
                joined.push(existing);
                joined
            },
        );

        let mut outputs = Vec::new();
        for (carrier_name, command_prefix) in [
            (
                "direct exe",
                format!("node.exe {}", quote_cmd_arg(&probe_path.to_string_lossy())),
            ),
            ("npm 风格 .cmd", "argv-probe.cmd".to_string()),
        ] {
            for delayed_expansion in [false, true] {
                let delayed_flag = if delayed_expansion { "/V:ON" } else { "/V:OFF" };
                let command = format!("{command_prefix}{quoted_arguments}");
                let mut child = Command::new("cmd.exe")
                    .args(["/D", "/Q", delayed_flag])
                    .env("THT_PANEL_CMD_PROBE", "EXPANDED")
                    .env("PATH", &probe_search_path)
                    .current_dir(&temp_dir)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .expect("应启动真实交互式 cmd");
                let mut stdin = child.stdin.take().expect("交互式 cmd 应提供标准输入");
                stdin
                    .write_all(format!("{command}\r\nexit\r\n").as_bytes())
                    .expect("应向交互式 cmd 写入探针命令");
                drop(stdin);
                outputs.push((
                    carrier_name,
                    delayed_flag,
                    child.wait_with_output().expect("应等待真实 cmd argv 探针"),
                ));
            }
        }
        let mut expected_lines = vec![format!("COUNT:{}", arguments.len())];
        expected_lines.extend(
            arguments
                .iter()
                .enumerate()
                .map(|(index, value)| format!("{index}:{}", utf16_hex(value))),
        );
        for (carrier_name, delayed_flag, output) in outputs {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                output.status.success(),
                "cmd {carrier_name} {delayed_flag} 探针失败；stdout={stdout:?}；stderr={stderr:?}"
            );
            assert!(
                !stdout.contains("CMD_INJECTION"),
                "cmd {carrier_name} {delayed_flag} 执行了参数中的旁路命令：{stdout:?}"
            );
            let actual_lines = stdout
                .lines()
                .filter_map(|line| {
                    line.find("COUNT:")
                        .map(|index| line[index..].to_string())
                        .or_else(|| {
                            line.chars()
                                .next()
                                .filter(char::is_ascii_digit)
                                .map(|_| line.to_string())
                        })
                })
                .collect::<Vec<_>>();
            assert_eq!(
                actual_lines, expected_lines,
                "cmd {carrier_name} {delayed_flag} 未逐字还原 argv"
            );
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
        let command = initial_command(&launch);
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }

        assert_eq!(launch.kind, "claude");
        assert!(command.contains("strict-provider-model"));
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
        let command = initial_command(&launch);
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }

        assert_eq!(launch.kind, "codex");
        assert!(launch.env.is_empty(), "严格系统模式不应改造 Shell 环境");
        assert!(!command.contains("project-default-model"));
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
        assert!(launch.args.is_empty());
        assert!(launch.initial_command.is_none());
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
        let command = initial_command(&launch);

        assert_eq!(launch.kind, "claude");
        assert!(command.contains("project-default-model"));
        assert!(!command.contains("duplicate-valid-model"));
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
        assert!(initial_command(&launch).contains("project-default-model"));
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
        let command = initial_command(&launch);

        assert_eq!(launch.kind, "claude");
        assert!(command.contains("project-default-model"));
        assert!(!command.contains("illegal-request-model"));
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
        assert!(!initial_command(&launch).contains("duplicate-valid-model"));
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
        assert!(!initial_command(&launch).contains("illegal-driver-model"));
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
            let command = initial_command(&launch);

            assert!(launch.args.is_empty());
            assert!(launch.env.is_empty(), "系统回退不应注入应用环境变量");
            for marker in legacy_markers {
                assert!(!command.contains(marker), "命令不应包含旧配置标记 {marker}");
            }
        }
    }

    /// 验证 Codex 系统回退不注入主题变量或 TUI 覆盖。
    /// 参数：无；返回：无，断言失败时由测试框架报告。
    #[test]
    fn codex_system_launch_does_not_override_terminal_behavior() {
        let mut ws = workspace();
        ws.default_provider_id = None;
        let mut req = request("unused");
        req.kind = "codex".to_string();
        req.provider_id = None;

        let launch =
            build_resolved_launch(&GlobalConfig::default(), Some(&ws), &req, Path::new("."))
                .expect("浅色 Codex 应生成启动描述");
        let command = initial_command(&launch);

        assert!(launch.env.is_empty());
        assert_eq!(command, "codex");
        assert!(!command.contains("tui.animations"));
        assert!(!command.contains("tui.terminal_title"));
    }

    /// 验证 Codex 恢复命令保留子命令顺序与用户附加参数。
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
        let command = initial_command(&launch);
        if config_dir.exists() {
            std::fs::remove_dir_all(&config_dir).expect("应只清理本测试创建的唯一临时目录");
        }

        assert!(command.contains("codex 'resume' 'session-1' '--no-alt-screen'"));
        assert!(!launch.env.iter().any(|(key, _)| key == "COLORFGBG"));
        assert!(!command.contains("tui.animations"));
        assert!(!command.contains("tui.terminal_title"));
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
        let command = initial_command(&launch);
        let expected_path = expected_settings.to_string_lossy();

        assert!(command.contains(&format!(
            "'--settings' {}",
            quote_powershell_arg(&expected_path)
        )));
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

        assert!(!initial_command(&launch).contains("'--settings'"));
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
