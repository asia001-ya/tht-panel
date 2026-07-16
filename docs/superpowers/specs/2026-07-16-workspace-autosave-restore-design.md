# 工作区自动保存与会话恢复设计

## 目标与边界

保存的工作区从「手动冻结快照」改为「创建即激活、变动自动同步」的活文档，并接通已有但从未执行的会话恢复引擎，使点击工作区时既恢复布局也恢复会话。同时把侧栏项目行的展开图标改为文件夹形态、收紧图标与名称间距，并为会话历史展开加入风琴动画。

恢复引擎 `src/lib/workspaceSnapshots.ts`（`buildSessionRefs`、`planWorkspaceRestore`）的规划语义不变；PTY 生命周期、供应商解析、落点规则等既有机制全部沿用。

## 会话恢复接线

恢复引擎已测试完备但无人调用。补齐两侧接线，不改引擎：

**保存侧**：每次快照写入（含自动同步）都调用 `buildSessionRefs(tree, runtimeSessions, historyCache, pendingSessions)`，将稳定会话引用存入 `SavedWorkspaceLayout.sessionRefs`。

**恢复侧**：App 层新增 `restoreWorkspace(savedWorkspaceId)` 编排，流程：

1. 对快照 `sessionRefs` 涉及的每个 `workspaceId` 现场 `managedSessionList` 刷新历史；刷新失败的记入 `failedWorkspaceIds`（`loadHistory` 不记失败，不能依赖启动预热缓存）。
2. `restoreSavedWorkspace(savedWorkspaceId)` 替换布局树并置激活。
3. `planWorkspaceRestore({ snapshot, runtimeSessions, managedSessions, workspaces, providers, failedWorkspaceIds })` 生成动作列表，逐个执行：
   - `keep`：PTY 仍存活，`replaceSession(leafId, oldTabId, sessionId)` 原位换绑（两者相同则无操作）。
   - `native`：`replaceSession` 指向原生会话 Tab。
   - `spawn`：复用 `resolveTerminalResumeSelection` 与现有 `spawnInto` 回绑逻辑，以 `resumeSessionId`（来自 ManagedSession.aiSessionId）重建终端；无可恢复 AI 会话 ID 时按引用的 kind/providerId 新起会话。
   - `error`：`setRestoreError(leafId, message)` 并 toast 汇总条数。
4. PaneLeaf 渲染 `restoreErrors[leafId]`：窗格内显示错误占位文案（当前该状态无任何消费者）。

恢复过程中同一快照内动作按 Leaf 先序串行执行，避免落点与回绑竞态。

## 工作区自动保存

- **创建**：侧栏「工作区」分组标题右侧新增「+」按钮，点击后行内输入名称，确认即以当前布局与当前 `sessionRefs` 创建工作区并设为 `activeSavedWorkspaceId`。顶部导航「保存当前工作区」按钮及其行内输入移除。
- **自动同步**：`activeSavedWorkspaceId` 非空时，布局树、Tab 或会话绑定发生变动即把 `{ tree, activePaneId, sessionRefs }` 写回激活工作区，沿用 `persist()` 现有 300ms debounce 落盘通道；`sessionRefs` 在写回时由 App 层构建（跨 store 数据不进入 layoutStore）。
- **切换**：点击其他工作区直接执行恢复编排，无确认提示（当前工作区已实时保存）。点击当前激活工作区不重复恢复。
- **删除**：删除激活工作区时清空激活态（store 已有该逻辑），之后的变动不归属任何工作区，仅落盘默认布局。
- **旧数据**：既有无 `sessionRefs` 的快照仍可恢复（引擎已有 legacy 推导路径），首次变动写回后自动升级为含引用的格式。

## 项目行图标与间距

- `WorkspaceItem` 的展开指示由 `ChevronRight` 改为 lucide `Folder`（折叠）/`FolderOpen`（展开），`icons.ts` 补充再导出；不再使用旋转变换。
- `ws-item-row` 的 `gap` 由 8px 收紧为 5px；状态圆点 badge 位置不变。

## 会话历史风琴动画

- 会话历史容器改为常驻 DOM：外层 `display: grid; grid-template-rows: 0fr ↔ 1fr; transition: grid-template-rows 0.18s ease`，内层 `min-height: 0; overflow: hidden`。
- 列表内容首次展开时挂载（保持按需加载历史行为），之后保持挂载以支持收起动画。`prefers-reduced-motion` 下禁用过渡。

## 测试与验收

- 引擎既有测试不变。
- 新增前端测试：保存/自动同步写入 `sessionRefs`；恢复编排对 keep/native/spawn/error 四类动作的执行与错误占位渲染；「+」新建即激活；变动后 debounce 写回激活工作区；WorkspaceItem 文件夹图标切换；风琴容器类名与常驻 DOM。
- 全量门槛：`npm test`、`npm run typecheck`、`npm run build` 通过。
- 手工验收：开两个 AI 会话并保存 → 关闭其中一个 PTY → 点击工作区：存活会话原位复用、关闭的以 resume 重建、布局与 Tab 顺序一致；供应商缺失或历史加载失败时窗格显示错误占位而非静默空白。
