# Workspace Pane Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复保存工作区中的真实会话、正确释放关闭窗格的 PTY、改善 Codex/聚焦体验，并提供可命名窗格之间人工门控的双向任务闭环。

**Architecture:** 前端继续由 Zustand 保存运行时布局，快照新增稳定会话引用并由 App 定向重建 PTY；Pane 名称属于布局槽位。协作任务由 Rust `TaskStore` 独立持久化并执行受控状态迁移，前端只负责确认 Pane 当前活动会话和展示任务抽屉。Codex 适配分别在 Rust 启动参数与 xterm 解析层完成，不修改用户全局配置。

**Tech Stack:** React 19、TypeScript、Zustand、Vitest、xterm.js、Tauri 2、Rust、serde、parking_lot。

---

### Task 1: 扩展布局、窗格名称与稳定会话引用

**Files:**
- Modify: `src/api/types.ts`
- Modify: `src/store/layoutOperations.ts`
- Modify: `src/store/layoutOperations.test.ts`
- Modify: `src/store/layoutStore.ts`
- Create: `src/store/layoutStore.test.ts`
- Modify: `src-tauri/src/config/model.rs`

- [ ] **Step 1: 写失败测试，锁定名称与快照语义**

在 `layoutOperations.test.ts` 增加：拖换内容不交换 `name`；保存快照复制 `sessionRefs`。在 `layoutStore.test.ts` 增加：名称忽略大小写不可重复、空名称清除显式名称、持久化与运行时转换保留名称。

```ts
expect(swappedLeft.name).toBe("web");
expect(swappedRight.name).toBe("server");
expect(snapshot.sessionRefs?.["pty-old"]?.managedSessionId).toBe("managed-1");
expect(renamePane(tree, "right", "WEB").error).toBe("窗格名称已存在");
```

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- src/store/layoutOperations.test.ts src/store/layoutStore.test.ts`

Expected: FAIL，缺少 `name`、`sessionRefs` 或 `renamePane`。

- [ ] **Step 3: 增加类型与纯函数**

在 `types.ts` 增加并同步 Leaf 类型：

```ts
export interface SavedSessionRef {
  managedSessionId?: string;
  workspaceId: string;
  kind: AgentKind;
  providerId?: string;
  mode: "terminal" | "native";
}

export interface LeafNode {
  type: "leaf";
  id: string;
  name?: string;
  sessionIds: string[];
  activeSessionId: string | null;
  locked: boolean;
}

export interface PersistedLeaf {
  type: "leaf";
  id: string;
  name?: string;
  locked: boolean;
  workspaceId?: string;
}

export interface SavedWorkspaceLayout {
  id: string;
  name: string;
  tree: PaneNode;
  activePaneId: string | null;
  createdAt: string;
  sessionRefs?: Record<string, SavedSessionRef>;
}

export interface PersistedLayout {
  version: number;
  tree: PersistedNode | null;
  activePaneId: string | null;
  activeSavedWorkspaceId?: string;
  savedWorkspaces?: SavedWorkspaceLayout[];
  window?: { width: number; height: number; maximized: boolean };
}
```

在 `layoutOperations.ts` 增加：

```ts
export function renamePane(
  tree: PaneNode,
  leafId: string,
  requestedName: string,
): { tree: PaneNode; error?: string };

export function replaceLeafSession(
  tree: PaneNode,
  leafId: string,
  oldSessionId: string,
  newSessionId: string,
): PaneNode;
```

`swapLeafContents` 只交换 `sessionIds/activeSessionId`，保持 `id/name/locked`。

- [ ] **Step 4: 接入 layoutStore**

`toRuntime/toPersisted` 读写 `name`。为 store 增加：

```ts
renamePane: (leafId: string, name: string) => string | null;
replaceSession: (leafId: string, oldId: string, newId: string) => void;
setRestoreError: (leafId: string, message: string | null) => void;
restoreErrors: Record<string, string>;
activeSavedWorkspaceId: string | null;
saveCurrentWorkspace: (
  name: string,
  sessionRefs?: Record<string, SavedSessionRef>,
) => SavedWorkspaceLayout | null;
restoreSavedWorkspace: (id: string) => SavedWorkspaceLayout | null;
```

保存新快照或恢复已有快照时设置 `activeSavedWorkspaceId`；首次加载旧布局时为 null。同步给 Rust `PersistedLayout.active_saved_workspace_id: Option<String>`，依靠 serde default 保持旧文件兼容。所有新增/修改函数添加中文参数与返回值注释。

- [ ] **Step 5: 运行 GREEN 并提交**

Run: `npm.cmd test -- src/store/layoutOperations.test.ts src/store/layoutStore.test.ts`

Expected: PASS。

Commit: `feat(layout): 增加窗格名称与稳定会话引用`

---

### Task 2: 修正项目点击和活动窗格视觉

**Files:**
- Modify: `src/components/Sidebar/WorkspaceItem.tsx`
- Modify: `src/components/Sidebar/WorkspaceItem.test.tsx`
- Modify: `src/components/Sidebar/Sidebar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles/main.css`

- [ ] **Step 1: 写失败测试**

`WorkspaceItem.test.tsx` 验证点击项目名称只调用 `toggleExpand`，点击 `+` 仅调用一次 `onNewSession`。`App.test.tsx` 验证 Ctrl 项目激活不调用 `ptySpawn`。

```ts
await user.click(screen.getByText("Panel"));
expect(useWorkspaceStore.getState().expandedIds.has("project-1")).toBe(true);
expect(onNewSession).not.toHaveBeenCalled();

await user.click(screen.getByTitle("新会话"));
expect(onNewSession).toHaveBeenCalledOnce();
```

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- src/components/Sidebar/WorkspaceItem.test.tsx src/App.test.tsx`

Expected: FAIL，项目点击仍调用 `onActivate` 并触发 spawn。

- [ ] **Step 3: 最小实现**

从 `WorkspaceItemProps/SidebarProps` 移除项目行的 `onActivate` 链路；`.ws-item-row` 直接调用 `toggleExpand(ws.id)`。App 的 Ctrl+1..9 处理器只展开目标项目并触发侧边栏定位事件，不调用 `activateWorkspace/newSession`。

把 `.pane-active` 改为主题强调边框：

```css
.pane-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--focus-ring), 0 0 10px var(--focus-ring);
}
```

- [ ] **Step 4: 运行 GREEN 并提交**

Run: `npm.cmd test -- src/components/Sidebar/WorkspaceItem.test.tsx src/App.test.tsx`

Expected: PASS。

Commit: `fix(sidebar): 项目点击仅展开并强化活动窗格`

---

### Task 3: 关闭 Tab/Pane 时释放终端会话

**Files:**
- Modify: `src/components/PaneGrid/PaneGrid.tsx`
- Modify: `src/components/PaneGrid/PaneLeaf.tsx`
- Modify: `src/components/PaneGrid/PaneGrid.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/api/commands.ts`
- Modify: `src/store/sessionStore.ts`

- [ ] **Step 1: 写失败测试**

扩展 PaneGrid 测试替身，使关闭 Tab/Pane 通过 props 回调 App。App 测试模拟两个终端 Tab 和一个 Native Tab：关闭终端调用 `ptyKill`、移除 sessionStore、关闭布局 Tab 并清除 ManagedSession 的 `ptySessionId`；关闭 Pane 对其中所有终端执行相同行为；恢复保存工作区不调用 `ptyKill`。

```ts
expect(commandMocks.ptyKill).toHaveBeenCalledWith("pty-web");
expect(useSessionStore.getState().sessions["pty-web"]).toBeUndefined();
expect(commandMocks.managedSessionUpdate).toHaveBeenCalledWith(
  expect.objectContaining({ id: "managed-web", ptySessionId: undefined }),
);
```

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- src/components/PaneGrid/PaneGrid.test.tsx src/App.test.tsx`

Expected: FAIL，现有关闭只修改布局。

- [ ] **Step 3: 实现 App 生命周期编排**

为 `PaneGrid` 增加明确回调：

```ts
interface PaneGridProps {
  onCloseTab: (leafId: string, sessionId: string) => Promise<void>;
  onClosePane: (leaf: LeafNode) => Promise<void>;
}
```

App 增加 `releaseSession`：Native Tab 只关闭视图；终端先 `ptyKill`，再删除运行时记录和 `pendingSessions`，查找 ManagedSession 后保存 `{ ptySessionId: undefined }`，最后关闭 Tab。关闭 Pane 先依次释放全部终端，再调用 layoutStore.closePane；任何真实 kill 失败时保留 Pane 并显示错误，不静默移除。

- [ ] **Step 4: 运行 GREEN 并提交**

Run: `npm.cmd test -- src/components/PaneGrid/PaneGrid.test.tsx src/App.test.tsx`

Expected: PASS。

Commit: `fix(pty): 关闭窗格时释放终端会话`

---

### Task 4: 保存工作区定向恢复会话

**Files:**
- Create: `src/lib/workspaceSnapshots.ts`
- Create: `src/lib/workspaceSnapshots.test.ts`
- Modify: `src/components/Sidebar/Sidebar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/store/layoutStore.ts`
- Modify: `src/components/PaneGrid/PaneLeaf.tsx`
- Modify: `src/components/PaneGrid/PaneGrid.test.tsx`

- [ ] **Step 1: 写纯函数失败测试**

定义恢复计划：Native 直接打开；存活旧 PTY 复用；ManagedSession 当前新 PTY 存活则替换；有 AI ID 则 resume；否则按保存配置新建；配置缺失产生 Leaf 错误。

```ts
export type RestoreAction =
  | { kind: "keep"; leafId: string; oldTabId: string; sessionId: string }
  | { kind: "native"; leafId: string; oldTabId: string; managedSessionId: string }
  | { kind: "spawn"; leafId: string; oldTabId: string; ref: SavedSessionRef; managed?: ManagedSession }
  | { kind: "error"; leafId: string; message: string };
```

测试覆盖同一 ManagedSession 已在其他布局恢复时不重复 spawn。

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- src/lib/workspaceSnapshots.test.ts src/App.test.tsx`

Expected: FAIL，缺少快照引用构建和恢复编排。

- [ ] **Step 3: 实现快照纯函数**

`buildSessionRefs(tree, runtimeSessions, historyCache)` 为每个 Tab 生成 `SavedSessionRef`；Native ID 解析为 ManagedSession ID，终端按 `ptySessionId` 反查。`planWorkspaceRestore` 不执行副作用，只返回有序 action。

- [ ] **Step 4: 接入保存和恢复**

Sidebar 改为调用 App 的 `onSaveWorkspace(name)` 与 `onRestoreWorkspace(id)`。App 保存前构建 refs；恢复前加载涉及项目的 ManagedSession，然后先应用快照树，再逐 Leaf 执行 action。为 `spawnInto` 增加可选 `replaceSessionId`，新 PTY 启动后用 `layoutStore.replaceSession` 原位替换快照旧 ID。

恢复顺序固定为 Leaf 先序、Leaf 内 Tab 顺序；失败写入 `restoreErrors[leafId]`，不影响其他 Pane。

PaneLeaf 在没有可显示 Tab 且存在 `restoreErrors[leaf.id]` 时展示错误文本和“重新选择供应商”入口；测试确保一个 Leaf 失败不会阻止其他 Leaf 恢复。

- [ ] **Step 5: 运行 GREEN 并提交**

Run: `npm.cmd test -- src/lib/workspaceSnapshots.test.ts src/App.test.tsx`

Expected: PASS。

Commit: `feat(workspace): 恢复保存布局中的会话`

---

### Task 5: Pane 名称编辑 UI

**Files:**
- Modify: `src/components/PaneGrid/PaneLeaf.tsx`
- Modify: `src/components/PaneGrid/PaneGrid.test.tsx`
- Modify: `src/styles/main.css`

- [ ] **Step 1: 写失败测试**

测试默认显示项目名；双击名称进入输入框；Enter 保存；Escape 取消；重复名显示错误；名称元素位于锁定按钮之前。

```ts
fireEvent.doubleClick(screen.getByText("Panel"));
fireEvent.change(screen.getByRole("textbox", { name: "窗格名称" }), {
  target: { value: "server" },
});
fireEvent.keyDown(screen.getByRole("textbox", { name: "窗格名称" }), {
  key: "Enter",
});
expect(useLayoutStore.getState().tree).toMatchObject({ name: "server" });
```

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- src/components/PaneGrid/PaneGrid.test.tsx`

Expected: FAIL，无编辑入口和 Pane name。

- [ ] **Step 3: 实现内联编辑**

PaneLeaf 使用本地 `draftName/editing/nameError`；展示值为 `leaf.name ?? wsName ?? "未命名"`。输入框 `aria-label="窗格名称"`，Enter 调用 `renamePane`，Escape 恢复，blur 保存。把名称节点移动到 `.pane-actions` 内且位于锁定按钮左侧。

- [ ] **Step 4: 运行 GREEN 并提交**

Run: `npm.cmd test -- src/components/PaneGrid/PaneGrid.test.tsx`

Expected: PASS。

Commit: `feat(pane): 支持命名工作区窗格`

---

### Task 6: 修复 Codex 浅色主题与闪烁

**Files:**
- Modify: `src-tauri/src/pty/spawn.rs`
- Modify: `src/terminal/xtermManager.ts`
- Create: `src/terminal/xtermManager.test.ts`

- [ ] **Step 1: 写 Rust 失败测试**

在 `spawn.rs` 测试命名和系统回退 Codex：浅色环境包含 `COLORFGBG=0;15`，深色包含 `15;0`；解码后的命令含两个配置覆盖且不修改用户配置文件。

```rust
expect_env(&light_launch, "COLORFGBG", "0;15");
assert!(decode_script(&light_launch).contains("'tui.animations=false'"));
assert!(decode_script(&light_launch).contains("'tui.terminal_title=[]'"));
```

- [ ] **Step 2: 运行 Rust RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml codex_terminal_`

Expected: FAIL，缺少主题环境和 TUI 覆盖。

- [ ] **Step 3: 最小 Rust 实现**

`build_resolved_launch` 在 `kind == "codex"` 时注入：

```rust
env.push((
    "COLORFGBG".to_string(),
    if global.theme == "dark" { "15;0" } else { "0;15" }.to_string(),
));
ai_args.extend([
    "-c".to_string(),
    "tui.animations=false".to_string(),
    "-c".to_string(),
    "tui.terminal_title=[]".to_string(),
]);
```

保证 resume 子命令和现有 extraArgs 的顺序测试继续通过。

- [ ] **Step 4: 写 xterm RED**

在 jsdom 中创建 Terminal，写入 `CSI 5 SP q` 和 `CSI 3 SP q`，等待 `onWriteParsed` 后断言 `cursorBlink === false`，并分别保持 bar/underline 样式。

Run: `npm.cmd test -- src/terminal/xtermManager.test.ts`

Expected: FAIL，xterm 内置处理器会把 cursorBlink 改回 true。

- [ ] **Step 5: 注册稳定光标处理器**

`createTerm` 使用 proposed parser API 注册 DECSCUSR handler，将 0/1/2 映射 steady block，3/4 映射 steady underline，5/6 映射 steady bar，并始终返回 `true` 阻止默认闪烁处理。

- [ ] **Step 6: 运行 GREEN 并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml codex_terminal_`

Run: `npm.cmd test -- src/terminal/xtermManager.test.ts src/terminal/themes.test.ts`

Expected: PASS。

Commit: `fix(codex): 适配浅色终端并关闭闪烁`

---

### Task 7: 建立持久化任务模型与状态机

**Files:**
- Create: `src-tauri/src/collaboration/mod.rs`
- Create: `src-tauri/src/collaboration/model.rs`
- Create: `src-tauri/src/collaboration/store.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: 写 TaskStore RED**

测试创建、按保存工作区过滤、合法状态流、非法跳转、queued 取消、损坏 JSON 备份与原子写入。

```rust
assert!(store.transition(&id, TaskStatus::Reported).is_err());
store.transition(&id, TaskStatus::Dispatched)?;
store.report(&id, TaskOutcome::Completed, "API 已增加 /users")?;
assert_eq!(store.get(&id)?.status, TaskStatus::Reported);
```

- [ ] **Step 2: 运行 RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml collaboration::store`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现模型和仓库**

`PaneTask` 与前端字段一致；`TaskStatus/TaskOutcome` 使用 camelCase serde。`TaskStore` 持有 `PathBuf + Mutex<TasksFile>`，写入 `collaboration-tasks.json.tmp` 后 rename。公开方法只允许：`list/create/mark_dispatched/report/mark_forwarded/close/cancel/get`，每个方法内校验固定状态。

AppState 增加 `pub tasks: TaskStore`，使用 `config.config_dir()` 初始化。所有新增函数写中文用途、参数和返回值注释。

- [ ] **Step 4: 运行 GREEN 并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml collaboration::store`

Expected: PASS。

Commit: `feat(tasks): 增加窗格协作任务状态机`

---

### Task 8: 增加受控任务注入命令

**Files:**
- Create: `src-tauri/src/commands/task_cmds.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/pty/manager.rs`

- [ ] **Step 1: 写命令层与序列化 RED**

把核心逻辑放在可测试普通函数中，Tauri command 只转发。测试同 Pane 拒绝、Pane 不匹配、shell/waiting/dead 拒绝、控制字符清理、合法注入只有一个结尾 `\r`、重复 dispatch/forward 拒绝。

```rust
let prompt = build_task_prompt(&task)?;
assert_eq!(prompt.matches('\r').count(), 1);
assert!(!prompt.contains('\n'));
assert!(!prompt.contains('\u{1b}'));
```

- [ ] **Step 2: 运行 RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml task_cmds`

Expected: FAIL，命令和校验函数不存在。

- [ ] **Step 3: 实现 PTY 查询与复合命令**

PtyManager 增加只读 `info(session_id) -> Result<PtySessionInfo, AppError>`。任务命令接口：

```rust
task_list(saved_workspace_id: Option<String>)
task_create(req: CreatePaneTaskRequest)
task_dispatch(task_id: String, target_pane_id: String, session_id: String)
task_report(task_id: String, outcome: TaskOutcome, report: String)
task_forward(task_id: String, source_pane_id: String, session_id: String)
task_close(task_id: String)
task_cancel(task_id: String)
```

dispatch/forward 校验 task Pane ID、会话 kind 为 claude/codex、状态非 waiting/dead，再 `pty.write`。提示通过 serde JSON 生成后替换所有 C0 字符为空格，最后仅附加一个 `\r`。写入成功、任务落盘失败时返回包含“目标可能已收到”的显式错误，禁止自动重试。

- [ ] **Step 4: 运行 GREEN 并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml task_cmds`

Expected: PASS。

Commit: `feat(tasks): 支持窗格任务派发与转交`

---

### Task 9: 实现前端任务抽屉与 Pane 路由

**Files:**
- Modify: `src/api/types.ts`
- Modify: `src/api/commands.ts`
- Create: `src/store/taskStore.ts`
- Create: `src/store/taskStore.test.ts`
- Create: `src/components/Tasks/PaneTaskDrawer.tsx`
- Create: `src/components/Tasks/PaneTaskDrawer.test.tsx`
- Modify: `src/components/PaneGrid/PaneLeaf.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles/main.css`

- [ ] **Step 1: 写 store 状态流 RED**

前端 store 只调用后端命令后覆盖返回对象，不本地伪造状态。测试 load/create/dispatch/report/forward/close/cancel，失败保留旧状态与错误。

Run: `npm.cmd test -- src/store/taskStore.test.ts`

Expected: FAIL，store 不存在。

- [ ] **Step 2: 实现 API 与 store**

同步 `PaneTask/TaskStatus/TaskOutcome/CreatePaneTaskRequest` 类型；commands.ts 添加七个 invoke 包装。taskStore 保存 `tasks/loading/error/drawerPaneId`，每个动作成功后 upsert，失败写 error。

- [ ] **Step 3: 写 UI RED**

测试：来源 Pane 只能选择当前布局其他已命名 Pane；空 Pane、Shell、Native、dead/waiting 禁止接收；确认页显示冻结 session；Tab 变化要求重新确认；上报 completed/blocked；reported 可转交；徽标显示未处理数量。

```ts
expect(screen.getByRole("option", { name: "server" })).toBeTruthy();
expect(screen.queryByRole("option", { name: "web" })).toBeNull();
expect(screen.getByRole("button", { name: "接收并注入" })).toBeDisabled();
```

Run: `npm.cmd test -- src/components/Tasks/PaneTaskDrawer.test.tsx`

Expected: FAIL，组件不存在。

- [ ] **Step 4: 实现任务抽屉与 Pane 入口**

PaneLeaf 标题栏增加任务图标和徽标；点击把当前 Pane ID 写入 taskStore。App 根部渲染一个 `PaneTaskDrawer`。创建任务时保存 source/target Pane ID 与显示名称；dispatch/forward 前读取 layoutStore 当前 Leaf 和 activeSessionId，展示 session kind/state，并把确认时 ID 传给后端。Drawer 不解析终端输出，只显示后端任务状态。

- [ ] **Step 5: 运行 GREEN 并提交**

Run: `npm.cmd test -- src/store/taskStore.test.ts src/components/Tasks/PaneTaskDrawer.test.tsx src/components/PaneGrid/PaneGrid.test.tsx`

Expected: PASS。

Commit: `feat(tasks): 增加窗格双向协作界面`

---

### Task 10: 全量回归、简化与真实烟测

**Files:**
- Review only: 本计划所有改动文件

- [ ] **Step 1: 运行 code-simplifier**

仅审查本任务 diff，删除重复分支、收敛命名和错误处理，不改变公开行为或任务状态机。

- [ ] **Step 2: 运行完整自动化验证**

Run: `npm.cmd test`

Expected: 现有与新增前端测试全部 PASS。

Run: `npm.cmd run typecheck`

Expected: exit 0。

Run: `npm.cmd run build`

Expected: exit 0；仅允许现有 chunk-size warning。

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: 所有 Rust 与集成测试 PASS。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: exit 0。

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: exit 0。

Run: `git diff --check`

Expected: exit 0。

- [ ] **Step 3: 启动 Tauri 真实验证**

Run: `npm.cmd run tauri -- dev`

依次验证：项目点击不建会话；保存/切换/重启恢复；Tab/Pane 关闭后进程消失；Pane 名称编辑与拖换；浅/深 Codex 输入区和稳定光标；两个命名 Pane 完成 queued → dispatched → reported → forwarded → closed。

- [ ] **Step 4: 最终审查并提交**

检查无真实 API key、终端内容、本机配置目录或生成文件进入 git。最终提交只包含计划范围内源码、测试与文档。

Commit: `feat: 完成工作区窗格生命周期与协作`
