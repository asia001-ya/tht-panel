# Native Shell Carrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作区直接启动 PowerShell、PowerShell 7 或 cmd，再通过一次普通终端输入启动 Claude/Codex，同时保留供应商和恢复配置。

**Architecture:** `spawn.rs` 只解析原生 Shell、供应商环境和首条 AI 命令；`manager.rs` 在 PTY 写入端就绪后写入该命令，失败时终止子进程。终端输出不再携带私有 OSC 状态，xterm 也不再拦截光标控制序列。

**Tech Stack:** Rust、portable-pty、Tauri 2、React 19、TypeScript、xterm.js、Vitest

---

### Task 1: 构造原生 Shell 与初始 AI 命令

**Files:**
- Modify: `src-tauri/src/pty/spawn.rs`
- Modify: `src-tauri/src/config/model.rs`

- [x] **Step 1: 写入失败测试**

在 `spawn.rs` 测试中断言 PowerShell/pwsh/cmd 的 `args` 为空、AI 会话提供 `initial_command`、纯 Shell 不提供初始命令，并拒绝其他载体；断言命令不含 `EncodedCommand`、`chcp`、TUI 覆盖、`COLORFGBG` 或私有 OSC。为 PowerShell 单引号和 cmd 双引号各加入一个包含空格/引号的参数用例。

在 `model.rs` 测试中断言：

```rust
#[test]
fn global_config_defaults_to_windows_powershell() {
    assert_eq!(GlobalConfig::default().shell_path, "powershell.exe");
}
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::spawn::tests`

Expected: FAIL，因为 `ResolvedLaunch` 尚无 `initial_command`，并且现有启动仍使用编码脚本。

- [x] **Step 3: 最小实现**

给 `ResolvedLaunch` 增加：

```rust
/// Shell 启动后由 PTY 写入的一次性命令；纯 Shell 会话为 None。
pub initial_command: Option<String>,
```

增加私有 `ShellCarrier`、载体识别和参数引用函数。PowerShell 参数使用单引号并把内部单引号翻倍；cmd 参数使用双引号并按 Windows 命令行规则转义反斜杠和引号。`build_resolved_launch` 对三个支持载体一律返回空 `args`，AI 命令保存到 `initial_command`；删除编码、TUI、颜色和退出标记拼装。把默认 `shell_path` 改为 `powershell.exe`。

- [x] **Step 4: 运行测试并确认 GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::spawn::tests`

Expected: PASS。

### Task 2: 写入初始命令并移除伪前台状态

**Files:**
- Modify: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/pty/session.rs`
- Modify: `src-tauri/src/pty/activity.rs`
- Modify: `src-tauri/src/commands/task_cmds.rs`

- [x] **Step 1: 写入失败测试**

在 `manager.rs` 中为下述接口加入记录写入端、失败写入端和终止计数测试：

```rust
fn write_initial_command_or_terminate<F>(
    writer: &mut dyn Write,
    initial_command: Option<&str>,
    terminate: F,
) -> Result<(), AppError>
where
    F: FnOnce();
```

断言 AI 命令只追加一个 `\r`、纯 Shell 零写入、写入失败恰好调用一次终止回调。把协作校验测试改为仅依赖会话 ID、Claude/Codex 类型和非 waiting/dead 状态。

- [x] **Step 2: 运行测试并确认 RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::manager::tests`

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::task_cmds::tests`

Expected: FAIL，因为初始命令写入接口尚不存在，协作校验仍要求私有前台标记。

- [x] **Step 3: 最小实现**

PTY 取得 writer/killer 后调用 `write_initial_command_or_terminate`，错误时杀死刚创建的子进程并返回。删除 `TERM`/`COLORTERM` 注入、`AgentForeground`、退出 OSC 扫描及相关会话字段；会话结束/kill 只把状态置为 `Dead`。`validate_task_prompt_session` 不再接收 `agent_active`。

- [x] **Step 4: 运行测试并确认 GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS。

### Task 3: 恢复 xterm 默认控制行为并提示人工确认

**Files:**
- Modify: `src/terminal/xtermManager.test.ts`
- Modify: `src/terminal/xtermManager.ts`
- Modify: `src/components/Tasks/PaneTaskDrawer.test.tsx`
- Modify: `src/components/Tasks/PaneTaskDrawer.tsx`

- [x] **Step 1: 写入失败测试**

把光标测试改为断言 `createTerm` 使用 xterm 默认光标配置，CLI 的 DECSCUSR 不被应用代码改写。在任务确认测试中断言显示“仅在目标 AI 界面仍打开时执行”的警告。

- [x] **Step 2: 运行测试并确认 RED**

Run: `npm test -- src/terminal/xtermManager.test.ts src/components/Tasks/PaneTaskDrawer.test.tsx`

Expected: FAIL，因为当前注册了 DECSCUSR 拦截器且确认页没有警告。

- [x] **Step 3: 最小实现**

删除 `steadyCursorStyle`、`cursorBlink`/`cursorStyle` 强制值和 `registerCsiHandler`；在确认内容下增加固定警告，明确 AI 若已退出回到 Shell，程序无法可靠识别。

- [x] **Step 4: 全量验证**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `git diff --check`

Expected: 全部成功，且 `rg -n "EncodedCommand|COLORFGBG|tht-panel-agent-exit|tui.animations|tui.terminal_title|registerCsiHandler|COLORTERM|xterm-256color" src src-tauri/src` 无业务代码命中。
