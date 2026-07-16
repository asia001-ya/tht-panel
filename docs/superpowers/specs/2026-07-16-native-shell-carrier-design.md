# 原生 Shell 载体设计

## 目标与边界

工作区终端只使用用户配置的 `powershell.exe`、`pwsh.exe` 或 `cmd.exe` 作为原生载体。应用保留一键启动 Claude/Codex、供应商选择和会话恢复，但不再通过包装脚本、终端控制序列或 CLI 覆盖参数改造 Shell 与 AI TUI。

本设计取代《工作区窗格生命周期与协作设计》中的“Codex 终端适配”和基于私有 OSC 判断 AI 前台状态的实现。布局、会话恢复、关闭释放、Pane 命名和协作任务状态机继续保留。

## 启动架构

`ResolvedLaunch` 继续描述宿主程序、工作目录、环境变量和会话元数据，并新增可选的初始命令行。PTY 启动顺序固定为：

1. 根据全局 `shellPath` 启动原生 Shell，不传入 `EncodedCommand`、编码切换、`ExecutionPolicy Bypass` 或 `NoExit` 参数。
2. 将供应商所需环境变量放入 Shell 子进程环境，密钥不进入命令行。
3. PTY 写入端就绪后，把 `claude ...` 或 `codex ...` 作为一条普通键盘输入写入，并追加一个回车。
4. AI 退出后自然返回原生 Shell 提示符，应用不输出或解析私有退出标记。

纯 Shell 会话没有初始 AI 命令。初始命令写入失败时立即终止刚创建的 PTY 并返回错误，避免留下无法使用的后台进程。

## Shell 与命令构造

支持范围仅为 PowerShell 系列和 Windows cmd：

- `powershell.exe`、`pwsh.exe`：使用 PowerShell 单引号规则构造 AI 参数。
- `cmd.exe`：使用 cmd 双引号规则构造 AI 参数。
- 其他 `shellPath` 返回明确配置错误，不猜测兼容语法。

命令构造只负责 AI 可执行名、恢复参数、模型、命名 Claude 的私有 settings 路径及用户配置的额外参数。不得拼接 `chcp`、控制台编码、窗口标题、动画、颜色或光标相关命令。

## 供应商行为

供应商管理保持现状：会话显式供应商优先，其次为项目默认供应商；没有合法供应商时使用系统现有配置。命名供应商仍可通过以下进程级配置隔离：

- Claude：`ANTHROPIC_BASE_URL`、认证变量及 `--settings`。
- Codex：`OPENAI_API_KEY`、`CODEX_HOME`。

不再注入 `COLORFGBG`，也不再追加 `tui.animations=false` 或 `tui.terminal_title=[]`。这些变化只影响新启动的会话，已运行 PTY 不迁移、不重启。

## 终端呈现

xterm 继续承担 PTY 渲染、主题配色、字体、滚动、搜索和尺寸适配。删除 DECSCUSR 光标拦截，CLI 发出的颜色、标题和光标控制序列按 xterm 默认行为处理。PTY 子进程不再强制写入 `TERM` 或 `COLORTERM`，以 Shell 自身环境为准。

应用仍可被动扫描 BEL 以维护 waiting 通知；该扫描不修改、过滤或补写终端字节。

## 协作任务

协作任务仍由用户在确认页主动派发或转交，写入方式等同键盘输入。由于不再用私有标记追踪 AI 是否仍在前台，后端只校验会话存在、未结束、类型为 Claude/Codex 且状态不是 waiting/dead。

确认页明确提示：仅在目标 AI 界面仍打开时执行。若 AI 已退出并回到 Shell，应用不声称能可靠识别，也不自动重试。任务状态并发锁、单次写入和模糊交付错误处理继续保留。

## 测试与验收

- Rust 单元测试覆盖 PowerShell、pwsh、cmd 的载体识别和参数引用。
- 启动描述测试断言不存在编码脚本、TUI 覆盖、`COLORFGBG` 和私有 OSC。
- PTY 测试覆盖初始命令只写一次、纯 Shell 不写命令以及写入失败后清理进程。
- 前端测试删除光标拦截断言，并保留主题、Pane、恢复和任务抽屉回归。
- 手工验证 PowerShell 与 cmd 的提示符、颜色、光标、Claude/Codex 启动、退出回 Shell、供应商切换和会话恢复。

验收标准是：终端表现与直接打开对应 Shell 后手工执行同一 AI 命令一致，应用不再插入用户可见或不可见的 Shell/TUI 改造逻辑。
