# 工作区窗格生命周期与协作设计

## 目标与边界

本次改动解决保存工作区无法恢复会话、窗格关闭不释放 PTY、项目点击误创建会话、活动窗格辨识不足、Codex 浅色与闪烁问题，并增加可命名窗格和人工门控的双向任务协作。

文中的“关闭窗口”指关闭分屏窗格或其中的 Tab。应用主窗口右上角关闭仍隐藏到托盘，不改变现有保活行为。切换已保存工作区只切换视图并 detach，不终止后台 PTY。

协作首版采用 B 方案：应用维护任务状态，但由用户确认接收、上报和转交。系统不解析自然语言终端输出，不声称自动判断代码是否修改成功。

## 数据模型

### 窗格与保存工作区

`LeafNode` 和 `PersistedLeaf` 增加可选 `name`。名称属于布局槽位，拖动交换 Tab 内容时名称保留在原窗格；在当前布局内按忽略大小写方式保持唯一。没有显式名称时，显示活动会话所属项目名；第一次绑定项目后以项目名作为默认可编辑名称。

`SavedWorkspaceLayout` 增加可选 `sessionRefs`，键为快照中的 Tab ID，值为稳定恢复描述：

- `managedSessionId`：已命名终端或 Native 会话的稳定 ID；
- `workspaceId`、`kind`、`providerId`：无法 resume 时重建终端所需信息；
- `mode`：`terminal` 或 `native`。

```ts
interface SavedSessionRef {
  managedSessionId?: string;
  workspaceId: string;
  kind: "claude" | "codex" | "shell";
  providerId?: string;
  mode: "terminal" | "native";
}
```

旧快照没有 `sessionRefs` 时，先尝试匹配仍存活的 PTY，再按 ManagedSession 中保存的旧 `ptySessionId` 反查；仍无法匹配时显示“旧会话无法恢复”占位，不静默创建错误供应商的会话。

### 协作任务

任务独立落盘到应用配置目录的 `collaboration-tasks.json`，不混入聊天消息或布局 JSON。核心字段为：

```ts
interface PaneTask {
  id: string;
  savedWorkspaceId?: string;
  sourcePaneId: string;
  targetPaneId: string;
  sourcePaneName: string;
  targetPaneName: string;
  title: string;
  request: string;
  status: "queued" | "dispatched" | "reported" | "forwarded" | "closed" | "cancelled";
  report?: string;
  outcome?: "completed" | "blocked";
  dispatchedToSessionId?: string;
  forwardedToSessionId?: string;
  createdAt: string;
  updatedAt: string;
}
```

任务使用 Pane ID 做路由，名称只用于展示。保存工作区 ID 用于隔离多个包含相同 Pane ID 的快照；未保存的当前布局使用空 `savedWorkspaceId`，只允许当前可见 Pane 之间协作。

## 会话恢复与释放

保存工作区时复制布局，并为每个 Tab 生成稳定 `sessionRefs`。恢复时逐个窗格处理：

1. Native 会话按 ManagedSession ID 直接恢复 Tab。
2. 保存的 PTY 仍存活时直接重新挂载。
3. ManagedSession 已被其他布局恢复且其新 PTY 仍存活时，复用新 PTY。
4. 有 AI 会话 ID 时，在原窗格按原供应商 resume。
5. 没有可 resume 的 AI ID 时，按保存的项目、类型和供应商在原窗格新建终端。
6. 配置或供应商已不存在时，把错误记录到运行时 `restoreErrors[leafId]` 并在原 Leaf 显示恢复错误，由用户选择替代供应商；不自动回退到系统配置。

恢复过程必须定向到快照原 Leaf，不经过普通“自动选择落点”逻辑。切换工作区前不调用 `ptyKill`，因此切回时优先复用存活会话。

关闭终端 Tab 时调用 `ptyKill`、移除 sessionStore 项、清理 pendingSessions，并把对应 ManagedSession 的 `ptySessionId` 清空但保留 `aiSessionId`。关闭整个 Pane 时对其中全部终端 Tab 执行相同流程，全部释放成功后再删除布局节点。Native 会话没有常驻 PTY，仅关闭视图；正在执行的一次性 Native 请求允许自然结束。

## 项目与窗格交互

- 点击项目行或项目名只切换展开状态，不聚焦或创建会话。
- `+` 明确新建项目默认 AI 会话；“新开终端”等显式入口仍可创建会话。
- Ctrl+1..9 只展开并定位项目，不隐式创建会话。
- 活动 Pane 使用主题强调色边框和轻量外发光，拖放目标继续使用运行状态色，二者视觉上可区分。
- Pane 名称显示在操作区锁定按钮左侧；双击进入内联编辑，Enter 保存、Escape 取消、空名称恢复项目默认名，重名时就地提示。

## Codex 终端适配

Codex 启动环境根据应用主题注入 `COLORFGBG`：浅色使用 `0;15`，深色使用 `15;0`。保留 Campbell ANSI 调色板，不再通过全局改黑白色值影响 PowerShell 和 Claude。

xterm 注册 DECSCUSR 处理器，把 CLI 请求的闪烁 block/underline/bar 光标转换为对应的稳定光标；这是因为 Codex 输出的控制序列会覆盖初始化时的 `cursorBlink: false`。

Codex 启动参数额外覆盖 `tui.animations=false` 和 `tui.terminal_title=[]`，关闭状态 spinner 与项目标题动画。该覆盖只作用于本应用启动的 Codex 进程，不修改用户全局 `~/.codex/config.toml`。

## 双向任务协作

标题栏增加“任务”入口和未处理数量徽标。任务抽屉只展示当前布局相关任务，并执行固定状态转换：

1. 来源 Pane 创建任务，选择当前布局内另一个已命名目标 Pane，状态为 `queued`。
2. 目标 Pane 用户查看请求并点击“接收并注入”；应用再次显示目标活动 Tab、会话状态和最终提示预览。
3. 前端在确认页解析并冻结目标 Pane 当前活动 `sessionId`；Rust 复合命令校验任务的 `targetPaneId`、提交的 `sessionId`、PTY 存活状态及任务状态，随后写入单行结构化提示和唯一一个 `\r`，状态变为 `dispatched`。
4. 目标完成后，用户选择“完成”或“受阻”，填写报告并上报，状态变为 `reported`。
5. 来源 Pane 用户点击“转交来源”，应用重新确认来源活动 Tab，再注入包含任务 ID、原请求、结果和报告的单行提示，状态变为 `forwarded`。
6. 用户核验后关闭任务。仅 `queued` 可取消；已经 `dispatched` 的任务若无法完成，必须以 `blocked` 结果上报，不能删除执行痕迹。

首版仅支持当前活动的 Claude/Codex 终端，不支持 Shell 或 Native Chat。允许当前保存工作区内跨项目 Pane 协作。`waiting` 状态禁止注入，其他非 dead 状态要求用户明确确认；活动 Tab 在创建任务后变化时必须重新确认。

注入内容使用 JSON 序列化，过滤 CR、LF、ESC 和其他 C0 控制字符，避免一条任务变成多条终端命令。写入成功但任务落盘失败时明确提示“目标可能已收到，请人工核对”，禁止自动重试。

## 后端接口与错误处理

新增任务命令：列表、创建、接收并注入、上报、转交、关闭和取消。合法迁移固定为 `queued → dispatched → reported → forwarded → closed`，另允许 `queued → cancelled`；状态迁移、任务 Pane 归属、PTY 存活校验和输入清理均在 Rust 完成，前端不能任意覆盖任务对象。Pane 当前活动 Tab 属于前端运行时状态，由确认页冻结并传入，后端不伪造该映射。

配置读取继续使用缺失字段默认值，保证旧 layout.json、workspaces.json 和 sessions.json 可加载。损坏的任务文件返回可见配置错误，不覆盖原文件。关闭、恢复和任务注入失败均保留当前 UI 状态并显示可操作错误，不吞异常。

## 验证标准

- 保存包含两个终端和一个 Native 会话的工作区，重启后在原 Pane 恢复；存活 PTY 不重复创建。
- 关闭 Tab/Pane 后对应进程消失；切换保存工作区后进程仍存活且切回可继续输出。
- 点击项目名不调用 spawn，点击 `+` 只创建一次。
- Pane 名称可编辑、持久化、不可重名，拖换内容不交换名称。
- 浅色 Codex 输入区可读，光标与项目 spinner 不再闪烁；深色、PowerShell 和 Claude 配色不回归。
- web → server → 上报 → web → 关闭任务完整闭环可运行；waiting、dead、Tab 变化、控制字符和非法状态转换均被拒绝或要求重新确认。
- 前端 Vitest、TypeScript、Vite build、Rust 单元测试、`cargo check` 与 `rustfmt --check` 全部通过，并完成真实 Tauri 双 Pane 烟测。
