//! 启动命令组装（spawn.rs，坑集中地，对照计划 8.6 / 风险 3、4）。
//!
//! 三种模式（shell / claude / codex）统一以 PowerShell 为宿主，解决 `.cmd` shim、
//! PATH 解析问题，并让 AI 退出后仍留在 shell（"通用终端"定位）：
//!   - shell:  `powershell.exe -NoLogo`（cwd = 工作空间目录）
//!   - agent:  `powershell.exe -NoLogo -NoExit -EncodedCommand <base64(UTF-16LE)>`
//!             脚本 = `chcp 65001 | Out-Null; [Console]::OutputEncoding=...UTF8; & claude --model m --resume id ...`
//!
//! 用 `-EncodedCommand` 规避引号地狱（base64 的是 UTF-16LE 字节）。配置来源：
//! `use_global_config ? GlobalConfig.{claude,codex}Defaults : workspace.config`，整套取用不做字段级合并。
//! env 注入仅在有值时进行、不进命令行；codex 独立配置额外生成隔离的 CODEX_HOME。
//! **绝不修改用户的 ~/.claude 或 ~/.codex 配置文件。**

use std::path::Path;

use base64::Engine;

use crate::config::model::{AgentConfig, GlobalConfig, SpawnRequest, Workspace};
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
///   - `global`：全局配置（提供 shell_path 与统一配置默认值）；
///   - `ws`：目标工作空间（None 表示纯 shell / 未绑定，cwd 退化到用户主目录）；
///   - `req`：启动请求（kind / resume / cols / rows）；
///   - `config_dir`：应用配置目录（用于生成隔离 CODEX_HOME）。
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

    let kind = req.kind.clone();

    // 纯 shell 模式：只起 PowerShell，不注入 env、不拼 AI 命令。
    if kind == "shell" {
        return Ok(ResolvedLaunch {
            program,
            args: vec!["-NoLogo".to_string(), "-ExecutionPolicy".to_string(), "Bypass".to_string()],
            cwd,
            env: Vec::new(),
            title: "PowerShell".to_string(),
            kind,
            resumed_from: None,
        });
    }

    // AI 模式（claude / codex）：解析该用哪套配置。
    // useGlobalConfig=true 或无独立 config → 用全局默认；否则用工作空间独立配置。
    let use_global = ws.map(|w| w.use_global_config).unwrap_or(true);
    let resolved_cfg: AgentConfig = if use_global {
        match kind.as_str() {
            "codex" => global.codex_defaults.clone(),
            _ => global.claude_defaults.clone(),
        }
    } else {
        ws.and_then(|w| w.config.clone()).unwrap_or_default()
    };

    let mut env: Vec<(String, String)> = Vec::new();
    let mut ai_args: Vec<String> = Vec::new();

    // 可执行名（经 PowerShell 宿主，靠 PATH 解析，兼容 .exe 与 .cmd shim）。
    let exe = match kind.as_str() {
        "codex" => "codex",
        _ => "claude",
    };

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

    // env 注入（仅在有值时；不写入命令行避免密钥泄漏到进程列表）。
    match kind.as_str() {
        "codex" => {
            if let Some(key) = non_empty(&resolved_cfg.api_key) {
                env.push(("OPENAI_API_KEY".to_string(), key));
            }
            // 独立配置：生成隔离 CODEX_HOME + config.toml（含 model / base_url / env_key）。
            if !use_global {
                if let Some(ws) = ws {
                    let codex_home = prepare_codex_home(config_dir, &ws.id, &resolved_cfg)?;
                    env.push(("CODEX_HOME".to_string(), codex_home));
                }
            }
        }
        _ => {
            if let Some(base) = non_empty(&resolved_cfg.base_url) {
                env.push(("ANTHROPIC_BASE_URL".to_string(), base));
            }
            if let Some(key) = non_empty(&resolved_cfg.api_key) {
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
    let title = if req.resume_session_id.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
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

/// 生成并写入隔离的 CODEX_HOME 目录及其 config.toml。
///
/// 目录：`{config_dir}/codex-homes/{wsId}`。每次 spawn 都重写 config.toml，
/// 使模型 / base_url 的配置改动即时生效（该目录由本应用独占管理，不涉及用户 ~/.codex）。
/// 参数：config_dir——应用配置目录；ws_id——工作空间 id；cfg——已解析的 AI 配置。
/// 返回：CODEX_HOME 绝对路径字符串或 AppError。
fn prepare_codex_home(
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
