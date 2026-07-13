# PowerShell、工作区布局与供应商设置实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 PowerShell 终端新会话，修复窗格拖放/缩放，并把供应商管理拆成独立设置菜单且支持系统配置回退。

**Architecture:** 前端用纯函数统一供应商解析和终端启动选择，`App` 只负责把选择结果交给 PTY。Rust 启动器继续以 PowerShell 为宿主，但无有效供应商时使用空配置，避免注入应用配置。窗格拖放移除 WebView 不可靠的 `dataTransfer.types` 前置判断，设置对话框用本地菜单状态切换两个内容页。

**Tech Stack:** React 19、TypeScript、Zustand、Vitest、Testing Library、react-resizable-panels、Tauri 2、Rust。

---

## Chunk 1: PowerShell 终端与系统配置回退

### Task 1: 统一有效供应商与终端启动选择

**Files:**
- Modify: `src/lib/providers.ts`
- Modify: `src/lib/providers.test.ts`

- [ ] **Step 1: 写失败测试**

新增完整 fixture 和用例：重复 ID、非法 driver 都视为无效；会话无效覆盖回退项目默认；跨 driver 恢复清除 `resumeSessionId`；新终端无有效供应商时返回项目 `agent` 且 `providerId` 为 `undefined`。

```ts
const malformed = [
  ...providers,
  { id: "duplicate", name: "A", driver: "claude" },
  { id: "duplicate", name: "B", driver: "codex" },
  { id: "invalid-driver", name: "Invalid", driver: "other" },
] as ProviderProfile[];

expect(resolveProjectProvider({ defaultProviderId: "duplicate" }, malformed)).toBeNull();
expect(resolveProjectProvider({ defaultProviderId: "invalid-driver" }, malformed)).toBeNull();
expect(resolveNewTerminalSelection(projectWithoutProvider, malformed)).toEqual({
  kind: "claude",
  providerId: undefined,
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm test -- src/lib/providers.test.ts --reporter=verbose`

Expected: FAIL，重复 ID 仍返回第一项，且 `resolveNewTerminalSelection` 尚不存在。

- [ ] **Step 3: 最小实现**

扩展项目选择接口并新增唯一且合法 driver 的匹配 helper，让项目/会话解析复用它：

```ts
interface NewTerminalProjectSelection extends ProjectProviderSelection {
  agent: WorkspaceAgent;
}

function uniqueProviderById(
  id: string | undefined,
  providers: ProviderProfile[],
): ProviderProfile | null {
  if (!id) return null;
  const matches = providers.filter(
    (provider) =>
      provider.id === id &&
      (provider.driver === "claude" || provider.driver === "codex"),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function resolveNewTerminalSelection(
  project: NewTerminalProjectSelection,
  providers: ProviderProfile[],
): TerminalResumeSelection {
  const provider = resolveProjectProvider(project, providers);
  return { kind: provider?.driver ?? project.agent, providerId: provider?.id };
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `npm test -- src/lib/providers.test.ts --reporter=verbose`

Expected: PASS。

### Task 2: 新会话恢复 PTY，保留旧原生会话

**Files:**
- Create: `src/App.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/PaneGrid/PaneLeaf.tsx`
- Test: `src/lib/providers.test.ts`

- [ ] **Step 1: 写 App 编排层失败测试**

使用 Vitest mock `Sidebar` 暴露按钮来触发 `onNewSession/onActivate/onResume`，mock `ptySpawn` 和 store load。断言项目加号和无历史项目激活都会调用 `ptySpawn`，请求含项目目录对应的 `workspaceId`、解析后的 `kind/providerId`；触发旧 `mode="native"` 历史时不调用 `ptySpawn`，而是打开 `native:<id>` Tab。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm test -- src/App.test.tsx --reporter=verbose`

Expected: FAIL，当前项目加号和空项目激活创建原生会话。

- [ ] **Step 3: 接入终端启动选择**

删除默认创建原生会话的 `createNativeConversation` 路径；`newSession` 获取目标窗格和项目后调用：

```ts
const selection = resolveNewTerminalSelection(workspace, providers);
await spawnInto(leafId, {
  workspaceId: wsId,
  kind: selection.kind,
  providerId: selection.providerId,
  cols: INIT_COLS,
  rows: INIT_ROWS,
});
```

`activateWorkspace` 没有历史/活跃终端时调用 `newSession`。`resumeSession` 对 `mode === "native"` 的旧记录仍调用 `openNativeConversation`。

- [ ] **Step 4: 更新空窗格文案**

把“新建原生 AI 会话”改为“新建终端会话”。

- [ ] **Step 5: 运行前端相关检查**

Run: `npm test -- src/App.test.tsx src/lib/providers.test.ts src/lib/workItems.test.ts --reporter=verbose`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。保留终端首次命名仍使用的 `managedSessionCreate`，只移除不再使用的 `resolveProjectProvider` 和原生会话创建函数相关 import。

### Task 3: Rust 无供应商时使用系统配置

**Files:**
- Modify: `src-tauri/src/pty/spawn.rs`
- Test: `src-tauri/src/pty/spawn.rs`

- [ ] **Step 1: 写失败测试**

拆分三个独立测试组：

1. 请求/项目 provider 的重复 ID 和非法 driver 均无效；无效请求 ID 可回退唯一有效的项目默认。
2. 把 legacy global defaults 和 workspace config 显式填为非空，无有效 provider 时仍使用空配置：PowerShell 参数含 `-NoExit/-EncodedCommand`，`env` 为空，解码脚本没有 legacy model/URL 参数。
3. Codex 系统回退使用 `std::env::temp_dir().join(format!("tht-panel-{}", Uuid::new_v4()))` 作为唯一 `config_dir`，构建后断言 `<config_dir>/codex-homes` 不存在；测试结束仅清理该唯一临时目录。

- [ ] **Step 2: 运行测试确认 RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::spawn::tests -- --nocapture`

Expected: 各测试分别因 `.find()` 接受重复/非法项、legacy defaults 泄漏或创建 `CODEX_HOME` 而失败。

- [ ] **Step 3: 最小实现**

私有 helper 只接受唯一匹配且 driver 为 `claude/codex` 的 provider。供应商按“请求有效匹配 → 项目默认有效匹配 → 无”解析。没有 provider 时使用 `AgentConfig::default()`；只有命名 provider 存在时才注入配置和创建隔离 `CODEX_HOME`。保留 PowerShell 编码命令和纯 Shell 分支。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::spawn::tests -- --nocapture`

Expected: PASS。

- [ ] **Step 5: 提交 Chunk 1**

```bash
git add src/App.tsx src/App.test.tsx src/lib/providers.ts src/lib/providers.test.ts src/components/PaneGrid/PaneLeaf.tsx src-tauri/src/pty/spawn.rs
git commit -m "fix: 恢复 PowerShell 终端会话"
```

## Chunk 2: 同工作区窗格布局拖动

### Task 4: 修复 WebView 窗格拖放并强化分隔线

**Files:**
- Create: `src/components/PaneGrid/PaneGrid.test.tsx`
- Modify: `src/components/PaneGrid/PaneGrid.tsx`
- Modify: `src/components/PaneGrid/PaneLeaf.tsx`
- Modify: `src/styles/main.css`
- Modify: `src/store/layoutOperations.test.ts`

- [ ] **Step 1: 写失败测试**

在 jsdom 中重置 Zustand layout store，渲染含两个 leaf 的 `PaneGrid`，模拟可读写但 `types=[]` 的 WebView `DataTransfer`。断言：开始合法窗格拖动后目标 dragover 被接管并出现反馈；取消、dragleave 和 drop 都清除反馈；非窗格 dragover 不被接管；自拖放不交换；合法 drop 调用数据层交换。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm test -- src/components/PaneGrid/PaneGrid.test.tsx --reporter=verbose`

Expected: FAIL，当前 `types.includes(PANE_DRAG_TYPE)` 阻止 WebView dragover，且目标局部状态无法由源 dragend 清理。

- [ ] **Step 3: 最小实现**

把 `draggedLeafId/dropTargetLeafId` 提升到 `PaneGrid`，通过递归 props 传给 `PaneLeaf`。拖动开始写入自定义类型和 `text/plain` 并设置共享 source；只有共享 source 存在时 dragover 才 `preventDefault`、设置 `dropEffect="move"` 和目标反馈。drop 只在 source 与 target 不同时交换，drop/dragend 统一清理 source 和 target；非窗格拖动不接管。

- [ ] **Step 4: 写比例与数据层 characterization tests**

在 `PaneGrid.test.tsx` mock `react-resizable-panels`，触发 `onLayout([35, 65])` 并断言 store ratio 写为 `0.35`，两个 Panel 都收到 `minSize=10`。在 `layoutOperations.test.ts` 增加“非空与空窗格交换”，断言根 ratio、leaf ID、locked 保持不变且只交换内容。

- [ ] **Step 5: 运行 characterization tests 确认现有行为**

Run: `npm test -- src/components/PaneGrid/PaneGrid.test.tsx src/store/layoutOperations.test.ts --reporter=verbose`

Expected: 比例写回、`minSize=10`、空窗格交换及 ratio/ID/locked 保持用例直接 PASS，证明本次只需修复拖动事件路径；共享拖动状态用例按 Step 1-3 完成 RED/GREEN。

- [ ] **Step 6: 强化分隔线交互**

保留 `minSize={10}`，把分隔线稳定为 8px 命中区，增加 `position: relative`、`z-index: 2`、`touch-action: none`，并为 pane panel 设置 `min-width/min-height: 0`。

- [ ] **Step 7: 运行布局测试确认 GREEN**

Run: `npm test -- src/components/PaneGrid/PaneGrid.test.tsx src/store/layoutOperations.test.ts --reporter=verbose`

Expected: PASS。

- [ ] **Step 8: 提交 Chunk 2**

```bash
git add src/components/PaneGrid/PaneGrid.tsx src/components/PaneGrid/PaneGrid.test.tsx src/components/PaneGrid/PaneLeaf.tsx src/styles/main.css src/store/layoutOperations.test.ts
git commit -m "fix: 恢复工作区窗格拖动布局"
```

## Chunk 3: 设置菜单与供应商空状态

### Task 5: 设置对话框拆分为菜单页

**Files:**
- Create: `src/components/dialogs/SettingsDialog.test.tsx`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/components/settings/ProviderManager.tsx`
- Modify: `src/components/settings/ProviderManager.test.tsx`
- Modify: `src/components/dialogs/WorkspaceDialog.tsx`
- Modify: `src/store/uiStore.ts`
- Modify: `src/components/ui/icons.ts`
- Modify: `src/styles/dialogs.css`

- [ ] **Step 1: 写失败测试**

每个测试前后分别初始化/恢复 `useUiStore` 的 `settingsOpen/settingsSection` 和 `useSettingsStore` 的配置。使用非空供应商 fixture 断言默认“常规”页不显示供应商行；点击“供应商管理”后显示供应商页。使用空 fixture 同时断言“未添加供应商，将使用系统 Claude/Codex 配置”和“添加供应商”按钮。断言 `openSettings("providers")` 可直接打开供应商页，覆盖项目对话框快捷入口。

在 `ProviderManager.test.tsx` 先写失败测试：新增供应商时把多行文本解析为去空白、去空行的 `extraArgs: string[]`；编辑现有供应商时把 `extraArgs` 回填为逐行文本并保存。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm test -- src/components/dialogs/SettingsDialog.test.tsx src/components/settings/ProviderManager.test.tsx --reporter=verbose`

Expected: FAIL，当前没有设置菜单/section 状态、快捷入口不能直达供应商页，编辑器也没有 `extraArgs` 控件。

- [ ] **Step 3: 最小实现**

`uiStore` 增加 `settingsSection: "general" | "providers"`，`openSettings(section = "general")` 和 `setSettingsSection`。`SettingsForm` 左侧使用带图标按钮的菜单“常规/供应商管理”，右侧按 store section 渲染。常规页保留现有外观和终端控件；供应商页只渲染 `ProviderManager`。`WorkspaceDialog` 的“前往设置添加供应商”调用 `openSettings("providers")`。

`ProviderManager` 增加“附加参数（每行一个）” textarea；加载编辑项时 `join("\n")`，保存时逐行 trim 并过滤空行，空结果不写 `extraArgs`。

- [ ] **Step 4: 更新供应商空状态与布局 CSS**

空状态使用批准文案且保留添加按钮。新增专用 `.settings-shell/.settings-nav/.settings-content/.settings-nav-item`，不修改通用 `.dialog-body` 行为；`.dialog-settings` 宽 720px，菜单 160px，内容 `minmax(0, 1fr)` 并独立滚动。`@media (max-width: 640px)` 时菜单改为顶部横向、内容单列，验证 600×500 窗口无横向溢出。

- [ ] **Step 5: 运行设置测试确认 GREEN**

Run: `npm test -- src/components/dialogs/SettingsDialog.test.tsx src/components/settings/ProviderManager.test.tsx --reporter=verbose`

Expected: PASS。

- [ ] **Step 6: 提交 Chunk 3**

```bash
git add src/components/dialogs/SettingsDialog.tsx src/components/dialogs/SettingsDialog.test.tsx src/components/dialogs/WorkspaceDialog.tsx src/components/settings/ProviderManager.tsx src/components/settings/ProviderManager.test.tsx src/store/uiStore.ts src/components/ui/icons.ts src/styles/dialogs.css
git commit -m "feat: 增加供应商管理设置菜单"
```

## Chunk 4: 集成验证

### Task 6: 完整验证与主程序合并

**Files:**
- Verify the authoritative scope from `git diff --name-only $(git merge-base dev HEAD) HEAD` plus any current worktree diff; expected files are those listed in Tasks 1-5 only.

- [ ] **Step 1: 代码简化复核**

先取 `$base = git merge-base dev HEAD`，检查 `$base..HEAD` 的全部已提交改动和当前工作树 diff，删除重复选择逻辑和无用 import，不做架构扩展。用 `git diff --name-only $base HEAD` 核对没有计划外文件。

- [ ] **Step 2: 完整自动验证**

Run: `npm test`

Expected: 全部测试通过。

Run: `npm run typecheck && npm run build`

Expected: 类型检查和生产构建通过。

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: Rust 测试、检查和格式通过。

Run: `$base = git merge-base dev HEAD; git diff --check $base HEAD; git diff --check`

Expected: 无空白错误。

- [ ] **Step 3: Tauri 手工验证**

Run: `npm run tauri -- dev`

按三条原子流程验证：

1. 终端：在无供应商项目点击“新会话”，预期进入 PowerShell 并尝试裸 `claude/codex`；CLI 存在则读取系统配置，CLI 不存在则 PowerShell 显示 command-not-found 但终端仍可输入。再选择命名供应商启动，预期 driver/模型按供应商生效。
2. 布局：在同一项目创建两个窗格，拖动分隔线到约 35/65，预期比例变化且不低于 10%；拖动标题栏交换非空/空窗格，预期内容交换、锁定与位置不变；取消拖动后反馈消失。
3. 设置：切换“常规/供应商管理”，空供应商页显示系统配置文案和添加按钮；新增/编辑供应商并填写两行附加参数，预期保存后逐行回填；将窗口调到 600×500，预期无横向溢出。

- [ ] **Step 4: 合并回主程序**

先向用户明确请求“将已验证分支 fast-forward 合并到主程序 `dev`”的批准；未获得批准时保留分支和 worktree，不修改主工作树。

获得批准后，确认功能分支所有 tracked 改动已提交。主工作树 `D:\AI\tht-panel` 必须仍在 `dev` 且 tracked-clean；已有 `AGENTS.md/tsconfig.node.tsbuildinfo` 保持未跟踪、不暂存。若主分支没有新增提交，执行：

```powershell
git -C D:\AI\tht-panel merge --ff-only codex/powershell-layout-settings
```

若不能 fast-forward 或出现新的 tracked 改动，停止合并并报告，不自动覆盖。合并后在主工作树重新运行 `npm test`、`npm run typecheck`、`npm run build` 和 `cargo test --manifest-path src-tauri/Cargo.toml`，全部通过后正常启动 Tauri。
