# Panel Redesign Phase B Menu and Workspace Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 legacy PTY AI 路径可回退的前提下，交付项目→会话菜单、可保存/自动更新的工作区、稳定 AI/终端 Tab 引用，以及不改写分屏树的窗口拖动换位。

**Architecture:** `Phase A` 的 Rust v2 repositories 和 `WorkspaceStore` 继续作为持久化真相来源；Phase B 在其上增加窄职责 application services 与 Tauri commands。前端以稳定 `WorkItemRef` 重建布局 store，并把菜单目录状态、当前工作区状态和易失 PTY 运行状态分离；所有调用继续经过可注入 `BackendClient`。

**Tech Stack:** React 19、TypeScript、Zustand、Vitest、Testing Library、Pointer Events、Tauri 2、Rust、serde、Phase A 原子 JSON/双文件事务层。

---

## Chunk 1: 工作区、会话目录与公开 API 边界

### Task 1: 完成 CurrentWorkspace 与 SavedWorkspace 应用服务

**Files:**
- Create: `src-tauri/src/application/clock.rs`
- Create: `src-tauri/src/application/workspace_service.rs`
- Create: `src-tauri/src/application/workspace_mode_service.rs`
- Create: `src-tauri/src/commands/workspace_cmds.rs`
- Create: `src-tauri/src/commands/workspace_mode_cmds.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/mutation_gate.rs`
- Modify: `src-tauri/src/application/quit_gate.rs`
- Modify: `src-tauri/src/compat/config_facade.rs`
- Modify: `src-tauri/src/domain/workspace.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/storage/workspace_store.rs`
- Modify: `src-tauri/src/storage/workspace_transaction.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/workspace_service.rs`
- Test: `src-tauri/tests/workspace_mode.rs`
- Test: `src-tauri/tests/quit_gate.rs`
- Test: `src-tauri/tests/compatibility_facade.rs`

- [ ] **Step 1: 写失败测试固定结构校验和乐观并发边界**

新增：

- `current_workspace_rejects_duplicate_pane_ids`
- `current_workspace_rejects_duplicate_item_refs_inside_one_tree`
- `current_workspace_active_pane_must_reference_leaf`
- `current_workspace_work_pane_active_item_must_be_present_or_null`
- `current_workspace_same_uuid_cross_kind_active_item_is_unambiguous`
- `workspace_phase_a_kind_scoped_active_item_round_trips_without_migration`
- `compat_layout_response_preserves_kind_scoped_active_item`
- `current_workspace_save_preserves_missing_entity_refs_for_placeholder`
- `current_workspace_save_rejects_stale_expected_updated_at`
- `current_workspace_successive_saves_with_frozen_clock_strictly_increase_updated_at`
- `current_workspace_save_cannot_change_source_pointer_from_client`
- `current_workspace_new_blank_clears_source_and_keeps_saved_snapshot_unchanged`
- `current_workspace_new_blank_creates_one_empty_leaf_with_strictly_newer_timestamp`
- `current_workspace_save_rejects_invalid_active_pane_uuid`
- `current_workspace_rejects_invalid_work_item_uuid`
- `current_workspace_rejects_invalid_leaf_project_uuid`
- `current_workspace_quit_flush_requires_matching_token`
- `current_workspace_quit_flush_preserves_stable_items_and_source_pointer`
- `workspace_v2_mode_get_defaults_false`
- `workspace_v2_mode_set_persists_only_workspace_flag`
- `workspace_v2_mode_set_preserves_native_ai_and_all_other_settings`
- `workspace_v2_mode_set_uses_bootstrap_mutation_gate_and_rejects_quiescing`
- `compat_config_set_preserves_workspace_v2_and_native_ai_flags`
- `all_app_settings_writers_patch_only_owned_fields_after_locked_reread`
- `workspace_mutation_commands_take_gate_before_short_runtime_snapshot`
- `workspace_mutation_waiting_on_gate_never_holds_runtime_read_guard`
- `workspace_mutation_commands_call_locked_variant_without_second_gate_acquire`
- `workspace_mode_command_calls_set_locked_after_runtime_guard_is_dropped`

测试构造一个包含 `conversation` 与 `terminal` 混排 items 的合法树，再逐项破坏一个不变量。`application/clock.rs` 定义最小 `pub trait Clock: Send + Sync { fn now(&self) -> DateTime<Utc>; }`、生产 `SystemClock` 与 `next_timestamp(previous, now)`；后者固定返回 `max(now, previous + 1 microsecond)`，溢出失败封闭。集成测试使用可推进/冻结的 FakeClock；连续成功写即使 clock 不前进也必须得到严格递增 `updatedAt`，同一个 CAS token 只能成功一次。

- [ ] **Step 2: 分组运行 CurrentWorkspace、mode 与锁序测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_service`

Expected: FAIL，`WorkspaceService` 和公开写入 DTO 尚不存在；本步骤 Step 1 的 kind-scoped/compat/command tests 必须全部实际执行，不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_mode`

Expected: FAIL，窄 `workspaceV2Enabled` service/command 尚不存在；必须实际执行本步骤 Step 1 的 mode 测试。

Run: `cargo test --manifest-path src-tauri/Cargo.toml workspace_mutation_commands_`

Expected: FAIL，command 的 `gate → runtime snapshot → *_locked` 顺序与无二次 acquire 契约尚未实现；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade compat_config_set_preserves_workspace_v2_and_native_ai_flags`

Expected: FAIL，Phase A compatibility writer 尚未改为 locked reread 后只 patch 自有字段；必须实际命中该新增测试。

- [ ] **Step 3: 定义只允许修改布局载荷的公开输入**

在 `domain/workspace.rs` 增加不含来源指针写权限的：

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentWorkspaceSaveInput {
    pub tree: PaneNode,
    pub active_pane_id: String,
    pub expected_updated_at: DateTime<Utc>,
}
```

公开 DTO 和 Tauri 参数沿用仓库现有 string ID 边界，并在 service 入口复用 Phase A 的 canonical typed-ID parser；实体 ID、pane ID 和 saved-workspace ID 都只接受 lowercase hyphenated UUID，不能用较宽松的 `Uuid::parse_str` 接受 uppercase/braced/simple alias。`sourceSavedWorkspaceId` 只出现在响应 `CurrentWorkspace`；它只能由 create/load/copy/delete saved-workspace 或显式 new-blank 操作改变。继续复用 Phase A 已固定的 `WorkPane.activeItem: WorkItemRef | null` / Rust `Option<WorkItemRef>`，后续任何层都不得退回裸 UUID。结构校验器递归检查：节点 ID 均为合法 UUID 且唯一、至少一个 leaf、split ratio 有限且位于 `0.05..=0.95`、每个稳定 `WorkItemRef` 在一棵树内最多出现一次、`activeItem` 以完整 kind-scoped 引用属于本 leaf items、`activePaneId` 指向 leaf。实体缺失不是结构错误，引用必须原样保留供占位渲染。Phase A 的 v2 schema 从创建之初就使用 kind-scoped `activeItem`；Phase B 不新增设计草案裸 UUID 活动字段的兼容 schema、迁移分支或 fixture。旧 v1 layout 仍只沿用 Phase A 已批准的 `items=[]/activeItem=null` 骨架规则。

- [ ] **Step 4: 写失败测试固定 SavedWorkspace 全部语义**

新增：

- `saved_workspace_create_snapshots_current_and_sets_source`
- `saved_workspace_create_returns_current_and_saved_aggregate`
- `saved_workspace_load_copies_snapshot_and_sets_source`
- `saved_workspace_rename_changes_name_only`
- `saved_workspace_update_from_current_does_not_change_unrelated_source`
- `saved_workspace_copy_current_creates_new_source`
- `saved_workspace_copy_returns_current_and_saved_aggregate`
- `saved_workspace_delete_active_clears_source_and_keeps_current_tree`
- `saved_workspace_delete_inactive_keeps_current_unchanged`
- `saved_workspace_list_quarantines_one_semantically_invalid_record`
- `saved_workspace_rejects_invalid_id_before_repository_lookup`
- `saved_workspace_commands_are_serialized_with_debounced_current_save`
- `saved_workspace_transaction_failure_never_publishes_half_pair`
- `current_workspace_new_blank_write_failure_keeps_previous_current_and_source`

“单个损坏”固定为 `workspace-layouts.json` 仍是合法 JSON，但某条记录违反树结构；服务返回其余有效条目并附公开 `invalidCount`，日志只含记录 ID，不含布局内容。整个 JSON 无法解析时继续按 Phase A repository 损坏策略失败封闭，不能伪装为空列表。

- [ ] **Step 5: 运行 SavedWorkspace 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_service saved_workspace_`

Expected: FAIL，SavedWorkspace application methods 尚不存在。

- [ ] **Step 6: 实现串行化 WorkspaceService**

`WorkspaceService` 组合 Phase A `WorkspaceStore`、`Arc<dyn Clock>` 和 Phase A 唯一的 `Arc<ApplicationMutationGate>`，禁止另建 operation mutex。每个公开 mutation 只取得一次 `MutationGuard`，在 guard 下读取最新快照，再调用对应 `_locked(&MutationGuard, ...)` 方法并委托 `workspace-write-journal` 提交；供 Conversation/Project 编排复用的 `remove_item_references_locked` 只接受现有 guard，绝不重入公开方法。固定锁序为 `ApplicationMutationGate → WorkspaceStore mutex`，读方法只通过 WorkspaceStore 的一致快照接口。公开方法固定为：

```rust
pub fn get_current(&self) -> Result<CurrentWorkspace, AppError>;
pub fn save_current(&self, input: CurrentWorkspaceSaveInput) -> Result<CurrentWorkspace, AppError>;
pub fn save_current_for_quit(&self, guard: &QuitMutationGuard, input: CurrentWorkspaceSaveInput) -> Result<CurrentWorkspace, AppError>;
pub fn new_blank_current(&self) -> Result<CurrentWorkspace, AppError>;
pub fn list_saved(&self) -> Result<SavedWorkspaceList, AppError>;
pub fn create_from_current(&self, name: String) -> Result<SavedWorkspaceMutationResult, AppError>;
pub fn load_saved(&self, id: String) -> Result<CurrentWorkspace, AppError>;
pub fn rename_saved(&self, id: String, name: String) -> Result<SavedWorkspace, AppError>;
pub fn update_saved_from_current(&self, id: String) -> Result<SavedWorkspace, AppError>;
pub fn copy_current(&self, name: String) -> Result<SavedWorkspaceMutationResult, AppError>;
pub fn delete_saved(&self, id: String) -> Result<CurrentWorkspace, AppError>;
```

每个普通 mutation 同时提供仅 crate 内可见的同名 `_locked` 变体，且它们必须验证传入 guard 属于 bootstrap 注入的同一个 gate；公开 wrapper 的唯一职责是 acquire 一次后转调，command 已持 guard 时只能调用下列变体，绝不能再调公开 wrapper：

```rust
pub(crate) fn save_current_locked(&self, guard: &MutationGuard, input: CurrentWorkspaceSaveInput) -> Result<CurrentWorkspace, AppError>;
pub(crate) fn new_blank_current_locked(&self, guard: &MutationGuard) -> Result<CurrentWorkspace, AppError>;
pub(crate) fn create_from_current_locked(&self, guard: &MutationGuard, name: String) -> Result<SavedWorkspaceMutationResult, AppError>;
pub(crate) fn load_saved_locked(&self, guard: &MutationGuard, id: String) -> Result<CurrentWorkspace, AppError>;
pub(crate) fn rename_saved_locked(&self, guard: &MutationGuard, id: String, name: String) -> Result<SavedWorkspace, AppError>;
pub(crate) fn update_saved_from_current_locked(&self, guard: &MutationGuard, id: String) -> Result<SavedWorkspace, AppError>;
pub(crate) fn copy_current_locked(&self, guard: &MutationGuard, name: String) -> Result<SavedWorkspaceMutationResult, AppError>;
pub(crate) fn delete_saved_locked(&self, guard: &MutationGuard, id: String) -> Result<CurrentWorkspace, AppError>;
pub(crate) fn save_current_for_quit_locked(&self, guard: &QuitMutationGuard, input: CurrentWorkspaceSaveInput) -> Result<CurrentWorkspace, AppError>;
```

`SavedWorkspaceMutationResult { current, saved }` 是 create/copy 的原子响应：`current` 必须含事务提交后的新 source 与 `updatedAt`，`saved` 是同一事务创建的快照；禁止只返回 SavedWorkspace 后让前端猜测 CAS 基线。名称 trim 后为 `1..=80` 个 Unicode scalar；同名允许但 ID 必须不同。所有 Current/Saved mutation 使用 `next_timestamp` 保证各自 `updatedAt` 严格递增。`save_current` 比较 `expectedUpdatedAt`，冲突返回 `CONFLICT` 和固定消息，禁止把延迟保存覆盖刚加载的工作区；同一个 expected token 在一次成功后立即失效。若 source 非空，沿用 Phase A 双文件事务自动同步活动 SavedWorkspace。`new_blank_current` 原子写入一个新 UUID 的空 leaf、把它设为 active pane、清空 source 并推进 Current `updatedAt`；它不删除或改写任何 SavedWorkspace。`workspace-write-journal` 为此增加闭合 `NewBlank` action，只允许 CurrentWorkspace target，记录 old/new source/hash并在未知状态失败封闭，不能误走 source!=null 的自动同步分支。前端必须先 flush，因此原活动 source 的最后布局已由普通事务保存；直接后端调用也只能以当前已持久化快照为边界，不能读取前端内存。

`save_current_for_quit` 只复用相同 DTO 校验、CAS 和 WorkspaceStore 事务，不取得普通 mutation permit；command 必须先用匹配 `QuitToken` 取得 Phase A 的专用 `QuitMutationGuard`，再调用该方法。伪造、过期或已取消 token 失败封闭，且该 guard 不能调用 SavedWorkspace、Conversation、Project 或 Provider mutation。普通 `save_current` 在 Quiescing 中继续返回稳定 `QUIESCING`，不能因 Phase B 放宽退出 gate。

`WorkspaceModeService` 只公开 `get() -> bool` 与 `set(enabled) -> Result<(), AppError>`，并提供 `pub(crate) set_locked(&MutationGuard, enabled)`；公开 `set` 只 acquire 一次再转调，command 已持 guard 时只调用 `set_locked`。服务读取/更新 AppSettings 中的 `featureFlags.workspaceV2Enabled`，在 guard 内重读最新 AppSettings 并只替换该布尔值；`nativeAiEnabled`、compatibility IDs、主题、终端和通知字段逐字保持。它不提供通用 FeatureFlags write DTO，防止前端顺带启用 Phase C 前不支持的 native AI。反向同样成立：Phase A `CompatibilityFacade::config_set` 与其他 AppSettings writer 必须在同一 guard 内重读最新文件，只 patch 自己拥有的主题/终端/通知/compatibility 字段，逐字保留 `workspaceV2Enabled/nativeAiEnabled`；禁止用带默认 false 的旧 DTO 整体覆盖 FeatureFlags。

- [ ] **Step 7: 注册薄 Tauri commands 并接入 ReadyRuntime**

注册：

- `current_workspace_get/save`
- `current_workspace_new_blank`
- `current_workspace_flush_for_quit`
- `saved_workspace_list/create/load/rename/update_from_current/copy_current/delete`
- `workspace_v2_mode_get/set`

纯读 command 可在 `StorageRuntime` read guard 内借用 Ready read view。所有普通、短时 repository mutation command 严格沿用 Phase A 顺序：先从 AppState 全局取得 `MutationGuard`，再用短 runtime read guard clone `Arc<ReadyRuntime>`，立即释放 read guard，最后调用 service `_locked(&guard, ...)`；不得持 read guard等待 gate，也不得 clone 后再调用会自行 acquire 的 public service。Task 7 的长时 `work_item_runtime_start` 是唯一例外，使用其专用 `StartAdmission → runtime snapshot → per-item claim → owner MutationLease/follower drop-and-wait` 契约，不能套用完整 MutationGuard。`current_workspace_flush_for_quit` 先取得专用 `QuitMutationGuard`，再短 snapshot 并调用 quit-specific `_locked`。`LegacyReadOnly` 返回 `MIGRATION_REQUIRED`，`Recovering/Blocked` 在 service call 前返回稳定错误。barrier 测试覆盖 migration transition 持 gate等待 runtime write 与 workspace/catalog/mode command 并发不死锁；Phase A 已固定 apply 仅 LegacyReadOnly、recover 仅 Blocked，Ready 的 runtime start 与合法 transition 不并存，伪造 Ready apply 必须在零 runtime/process 修改下失败。commands 不自行锁 repository、不修补 DTO、不读取旧布局文件。

- [ ] **Step 8: 运行 WorkspaceService 全量测试并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_service && cargo test --manifest-path src-tauri/Cargo.toml --test workspace_mode && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate current_workspace_ && cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade && cargo test --manifest-path src-tauri/Cargo.toml bootstrap_ && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；并发测试只观察到完整 current/saved 对，过期写入为可重试冲突而不是静默覆盖。

使用 `@code-simplifier` 审查树校验递归、全局 gate 锁范围和 command 重复；若修改，重跑本步骤。

```bash
git add src-tauri/src/application/clock.rs src-tauri/src/application/workspace_service.rs src-tauri/src/application/workspace_mode_service.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/mutation_gate.rs src-tauri/src/application/quit_gate.rs src-tauri/src/compat/config_facade.rs src-tauri/src/domain/workspace.rs src-tauri/src/storage/repositories.rs src-tauri/src/storage/workspace_store.rs src-tauri/src/storage/workspace_transaction.rs src-tauri/src/commands/workspace_cmds.rs src-tauri/src/commands/workspace_mode_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/workspace_service.rs src-tauri/tests/workspace_mode.rs src-tauri/tests/quit_gate.rs src-tauri/tests/compatibility_facade.rs
git commit -m "feat: 完成工作区快照应用服务"
```

### Task 2: 建立稳定 Conversation 与 TerminalSession 目录服务

**Files:**
- Create: `src-tauri/src/application/conversation_catalog_service.rs`
- Create: `src-tauri/src/application/terminal_catalog_service.rs`
- Create: `src-tauri/src/application/project_service.rs`
- Create: `src-tauri/src/commands/conversation_cmds.rs`
- Create: `src-tauri/src/commands/terminal_cmds.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/mutation_gate.rs`
- Modify: `src-tauri/src/domain/conversation.rs`
- Modify: `src-tauri/src/domain/terminal.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Modify: `src-tauri/src/application/workspace_service.rs`
- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/commands/project_cmds.rs`
- Modify: `src-tauri/src/compat/project_facade.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/catalog_services.rs`

- [ ] **Step 1: 写失败测试固定新会话继承与后端校验**

新增：

- `conversation_create_uses_project_default_pair`
- `conversation_create_uses_global_pair_only_when_project_pair_is_absent`
- `conversation_create_explicit_pair_wins_without_cross_provider_model_mix`
- `conversation_create_requires_enabled_provider_and_matching_model`
- `conversation_create_freezes_project_path_snapshot_without_exposing_it`
- `conversation_create_does_not_start_process_or_runtime_segment`
- `conversation_list_filters_by_project_and_sorts_updated_desc`
- `conversation_list_null_means_all_including_deleted_or_missing_project_refs`
- `conversation_rename_trims_and_updates_timestamp`
- `conversation_delete_rejects_running_or_waiting_approval`
- `conversation_delete_prunes_current_and_saved_refs_before_metadata`
- `conversation_delete_active_ref_selects_next_then_previous_then_null`
- `conversation_delete_preserves_terminal_ref_with_same_uuid`
- `conversation_delete_retry_is_idempotent_after_partial_failure`
- `conversation_delete_locked_reuses_existing_mutation_guard_without_deadlock`
- `conversation_switch_provider_requires_idle_or_failed_without_live_binding`
- `conversation_switch_provider_rejects_pending_outcome_until_drain`
- `conversation_switch_provider_requires_enabled_matching_pair`
- `conversation_switch_provider_new_empty_without_segment_or_history_defers_new_segment`
- `conversation_provider_switch_capability_distinguishes_any_same_pair_and_context_bridge`
- `conversation_switch_provider_legacy_source_without_segment_requires_context_bridge`
- `conversation_switch_provider_with_segments_allows_only_latest_frozen_pair`
- `conversation_switch_provider_cross_pair_requires_phase_d_context_bridge`
- `conversation_switch_provider_clears_needs_provider_selection`
- `conversation_provider_repair_new_empty_allows_valid_pair`
- `conversation_provider_repair_same_frozen_pair_clears_selection_without_new_segment`
- `conversation_provider_repair_context_bearing_returns_context_bridge_required`
- `catalog_errors_serialize_retry_later_and_context_bridge_required`
- `conversation_commands_take_gate_before_runtime_snapshot_and_call_locked`
- `catalog_public_wrapper_acquires_once_and_locked_variant_never_reacquires`

`ConversationCreateInput` 只含 `projectId`、可选 `providerId/modelId` 和可选标题；测试确认任何前端传入的 driver 字符串都不存在于契约，driver 由 provider 反查。创建阶段只生成稳定元数据，Phase C 前不启动 CLI，也不创建伪 RuntimeSegment。

- [ ] **Step 2: 运行 Conversation 目录测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test catalog_services conversation_`

Expected: FAIL，目录服务尚不存在。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test catalog_services catalog_errors_`

Expected: FAIL，公开错误映射尚不存在；必须实际执行未以 `conversation_` 开头的错误契约测试。

Run: `cargo test --manifest-path src-tauri/Cargo.toml conversation_commands_`

Expected: FAIL，Conversation command 尚未实现单次 gate 与 `_locked` 调用顺序；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test catalog_services catalog_public_wrapper_`

Expected: FAIL，公开 wrapper/locked 变体的单次 acquire 契约尚未实现；必须实际命中该新增测试。

- [ ] **Step 3: 实现 ConversationCatalogService**

服务使用 Phase A `ProviderResolver` 解析完整 provider/model 对，并写入 `currentProviderId/currentModelId`；创建时同时把当前 active Project.path 冻结进 Phase A 内部 `Conversation.projectPathSnapshot`，后续项目改名/改路径不能改变该会话新首段的 cwd。该字段不进入公开 summary/DTO；首段启动时只能把它复制到新 `RuntimeSegment.cwdSnapshot`，恢复既有 segment 时只读 source segment 已冻结的 `cwdSnapshot`。创建/重命名时间统一来自 Task 1 的 `Arc<dyn Clock>`。默认标题为“新会话”，长度 `1..=120`。Conversation/Terminal 两个 catalog service 与 Project 删除编排都注入 Task 1 的同一个 `Arc<ApplicationMutationGate>`；公开 mutation 各自取得一次 `MutationGuard`，跨服务调用只能使用 `_locked(&MutationGuard, ...)`，固定锁序为 `ApplicationMutationGate → catalog repository/WorkspaceStore`，禁止调用会重新取锁的公开方法。`WorkspaceService::remove_item_references_locked` 只接受 kind-scoped `&[WorkItemRef]`，绝不接受裸 UUID；Conversation 删除只传 conversation variant，即使 TerminalSession 恰有相同 UUID 也必须保留。删除顺序固定为：复用 Phase A `LegacyEntityDeletionGuard` 确认无 live binding、非终态 segment 或 pending outcome → 原子更新 current/saved 布局 → 删除 Conversation 元数据。Task 7 必须扩展同一预检，使 per-item start claim、exit-settling generation 和尚未完成 replay/cleanup 的 outcome journal 同样在任何布局/metadata 写前阻止 Conversation 删除、provider switch 与 `project_delete(true)`；不得在各 service 复制不一致的局部判断。若最后一步失败，会话仍存在且可从菜单重新打开；重试不得损坏布局。不得删除项目目录、供应商修订、密钥或事件/checkpoint 审计残留；这些文件不进入任何 catalog/list，物理清理延后到 Phase E 的引用审计和用户授权。

Conversation 的 mutation API 必须成对存在：公开 `create/rename/delete/switch_provider` wrapper 只 acquire 一次并转调 `pub(crate) create_locked/rename_locked/delete_locked/switch_provider_locked(&MutationGuard, ...)`；ProjectService 等跨领域编排和 Tauri command 已持 guard 时只能调用 locked 变体。只读 `list/provider_switch_capability` 不取得 mutation gate。locked 变体不允许自行 acquire、等待 runtime write guard 或调用另一个公开 mutation；测试用计数 gate 断言每条命令恰好一次 acquire。

只读 `provider_switch_capability(id)` 返回判别联合：全新空会话为 `any`；已有可恢复 segment 为 `sameFrozenPairOnly { providerId, modelId }`；有 legacy source、任何 context-bearing event 或 event read error 为 `contextBridgeRequired`。它不暴露 revision/secret/runtime namespace，且 mutation 仍必须重新校验，不能把 capability 当授权 token。这里必须区分“供应商修复”和“跨上下文切换”：`any` 或 `sameFrozenPairOnly` 可以修复 `needsProviderSelection`，后者只能重新确认最新 segment 已冻结的同一 pair且不创建新 segment；`contextBridgeRequired` 不是可提交的修复，必须返回/展示 `CONTEXT_BRIDGE_REQUIRED` 并等待 Phase D。`switch_provider(id, provider_id, model_id)` 只允许 `ConversationState::Idle | Failed`，并先复用 Phase A deletion/lifecycle guard 确认无 process-live binding、非终态 segment 或 pending outcome；Task 7 再把 start claim 与 settling generation 纳入同一检查。pending journal 即使已写终态但尚未删除也返回新增稳定错误 `AppError::RetryLater`，公开序列化固定为 `RETRY_LATER/运行结果仍在收敛，请稍后重试`。使用同一 `ProviderResolver` 验证启用且成对匹配的 provider/model。只有“无 RuntimeSegment、无 `LegacyHistorySource`，且 event store 可证明 `has_no_context_bearing_events`”的全新空 Conversation 才可更新任意 pair、清除 `needsProviderSelection`，下一次 legacy 启动创建首个冻结 segment；任何 user/assistant/tool/LegacyTranscriptBlock/summary/bridge 等上下文事件或 event read error 都失败封闭为新增 `AppError::ContextBridgeRequired`，公开序列化固定为 `CONTEXT_BRIDGE_REQUIRED/现有上下文需要通过桥接后才能切换`。已有 segment 时，请求 pair 必须与最新可恢复 segment 的冻结 provider/model 完全相同，才可作为修复/no-op 清除 selection 标志；跨 pair 同样等待 Phase D ContextBridge。任何路径都不得改写 Conversation.id、历史事件、已有 RuntimeSegment 或旧 revision；Running/WaitingApproval 返回 `CONFLICT`。两个新错误的内部原因仍需脱敏，且加入 `error.rs` 序列化测试。

- [ ] **Step 4: 运行 Conversation 目录测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test catalog_services`

Expected: PASS；此时已写入的 Conversation、error、command 和 public-wrapper tests 全部通过，公开 mutation 与项目编排复用同一 guard，不发生非重入死锁。

- [ ] **Step 5: 写失败测试固定稳定纯终端元数据**

新增：

- `terminal_create_uses_project_path_as_default_cwd`
- `terminal_create_project_requires_existing_project`
- `terminal_list_keeps_stopped_sessions_after_restart`
- `terminal_rename_updates_metadata_not_runtime_pty_id`
- `terminal_delete_rejects_running_runtime_binding_or_running_state`
- `terminal_delete_prunes_workspace_refs_and_never_deletes_cwd`
- `terminal_delete_active_ref_selects_adjacent_without_touching_same_uuid_conversation`
- `terminal_delete_preserves_conversation_ref_with_same_uuid`
- `terminal_delete_metadata_failure_after_layout_cleanup_is_retryable`
- `terminal_create_project_variant_rejects_cwd_override`
- `terminal_list_null_means_all_including_standalone_and_orphans`
- `terminal_create_standalone_requires_absolute_existing_cwd`
- `project_delete_false_keeps_conversations_and_terminals_without_active_precheck`
- `project_delete_false_moves_project_to_internal_history_tombstone`
- `project_delete_false_history_import_after_restart_uses_conversation_and_segment_snapshots`
- `project_tombstone_changes_status_and_reserves_id_without_retargeting_history`
- `project_list_never_exposes_internal_history_tombstones`
- `project_delete_false_clears_every_matching_pane_project_context`
- `project_delete_true_deletes_only_conversations_and_keeps_terminals_for_repair`
- `project_delete_true_rejects_active_conversation_without_partial_delete`
- `project_delete_false_failure_matrix_is_idempotent`
- `project_delete_true_failure_matrix_is_idempotent`
- `project_delete_true_removes_conversations_in_one_snapshot`
- `project_delete_batch_repairs_active_refs_in_current_and_every_saved_workspace`
- `project_service_reuses_phase_a_history_tombstones_without_second_schema`
- `project_save_and_compat_workspace_save_still_preserve_history_tombstones`
- `project_id_reserved_by_phase_a_history_tombstone_cannot_be_recreated`
- `terminal_commands_take_gate_before_runtime_snapshot_and_call_locked`
- `project_commands_take_gate_before_runtime_snapshot_and_call_locked`
- `terminal_and_project_locked_variants_never_reacquire_gate`

`TerminalSessionCreateInput` 使用 `#[serde(tag = "scope", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]` 的判别联合，而不是互相矛盾的可选字段：`Project { project_id, title?, shell_descriptor }` 不接受 cwd，后端只从 Project.path 派生；`Standalone { cwd, title?, shell_descriptor }` 不接受 projectId，且 cwd 必须为绝对、存在的目录。对应 TypeScript 使用 `scope: "project" | "standalone"` 的同构联合。

- [ ] **Step 6: 分组运行 Terminal、Project 与目录锁序测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test catalog_services terminal_`

Expected: FAIL，TerminalCatalogService 尚不存在。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test catalog_services project_`

Expected: FAIL，ProjectService 删除编排尚不存在；必须实际执行本步骤新增的 project 测试。

Run: `cargo test --manifest-path src-tauri/Cargo.toml terminal_commands_`

Expected: FAIL，Terminal command 尚未实现 `gate → runtime snapshot → *_locked` 顺序；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml project_commands_`

Expected: FAIL，Project command/CompatibilityFacade 尚未统一委托同一 locked 编排；不得是 `0 tests`。

- [ ] **Step 7: 实现 TerminalCatalogService 与项目删除编排**

稳定 `TerminalSession` 与 Phase A 进程内 `LegacyRuntimeBindings` 分离，创建/重命名时间同样使用注入的 `Clock`。删除单个终端前查询 process-live binding、持久化 `TerminalState::Running` 和 Phase B 扩展的 terminal pending outcome；任一存在返回 `CONFLICT/RETRY_LATER`，必须先 stop/drain。Task 7 引入 start claim/settling generation 后，删除与重新打开必须复用同一 kind-scoped inflight preflight，一次检查 `startClaim/liveBinding/settlingGeneration/pendingOutcome`，封闭“spawn 尚未注册 binding”和“exit 尚未写 journal”的窗口；任何一项未收敛都不得改布局、删 metadata 或启动第二棵进程树。删除顺序固定为 `预检 → WorkspaceService.remove_item_references_locked([WorkItemRef::Terminal { id }]) → 单次 terminal-sessions snapshot 删除`；相同 UUID 的 Conversation ref 保留。若最后一步失败，布局已无引用但终端元数据仍在菜单可重新打开，重试把缺失布局引用视为成功并继续，NotFound 也幂等成功，绝不删除 cwd。

Terminal 的公开 `create/rename/delete` 与 Project 的公开 `delete` 只负责 acquire 一次后转调 `pub(crate) *_locked(&MutationGuard, ...)`；ProjectFacade、Project command、Terminal command 以及 Conversation 批量删除编排已持 guard 时一律调用 locked 变体。所有 locked 变体先验证 guard provenance，再按 `catalog/WorkspaceStore` 固定锁序执行，不能短暂释放后重取 gate，也不能调用公开 wrapper。

Project 删除由独立 `ProjectService` 编排，`project_cmds` 与 `CompatibilityFacade::ProjectFacade` 都委托它，不能把跨领域流程塞进 command 或 TerminalCatalogService。它直接复用 Phase A 已定义的 `ProjectsFile.historyTombstones` 与 ID 保留规则，不在 Phase B 再造第二种 schema、迁移路径或 tombstone fixture。Phase B 只能用 tombstone 判定 `projectStatus=deleted` 和阻止稳定 ID 被重建；历史定位始终读取 Conversation 自身冻结的 `projectPathSnapshot` 与每个 RuntimeSegment 的 `cwdSnapshot`，绝不把 tombstone 内部 path 回灌、覆盖或重定向旧历史。内部 tombstone 继续不进入公开 Project list/DTO，也不能用于创建新 Conversation/Terminal/launch；所有 active Project writer 仍在同一 mutation guard 下重读并保留完整 tombstone 集合，任何 active Project ID 与 tombstone ID 相同都返回 `CONFLICT`。`deleteConversations=false` 沿用 Phase A 的“active Project 原子移入 tombstone并保留 Conversation/TerminalSession”，`true` 沿用“无 tombstone且先预检全部 Conversation”。Phase B 的新增职责仅是把该流程集中到 ProjectService、清理 current 与每个 SavedWorkspace 的稳定引用，并向目录 summary 暴露 `deleted/missing`；Phase E 才能在引用审计和用户授权后物理清理 tombstone/event/checkpoint 审计残留。

随后用一次 WorkspaceStore 事务把所有 `WorkPane.projectId==deletedProjectId` 置 null，并且仅在 true 时移除 kind-scoped Conversation items；false 保留所有 Conversation/TerminalSession items，true 也始终保留 TerminalSession items。`remove_item_references_locked` 必须同时修复 current 与每个 SavedWorkspace 的 `activeItem`：若被删项正是 active，优先选择删除前同索引处的下一项，否则前一项，否则 null；批量删除先过滤再按原有顺序选择，完整 `WorkItemRef` 比较确保同 UUID 的另一 kind 不受影响。true 必须先对全部关联 Conversation 做一致的 inflight 预检：live/nonterminal、start claim、settling generation、pending outcome 任一存在即零写失败；通过后再用一次原子 ConversationsFile snapshot 批量删除，最后从 active Projects 删除且不建 tombstone。false 跳过 Conversation inflight 预检与 ConversationsFile 并安装 tombstone。故障矩阵覆盖每个原子写之前/之后，重试把已清理引用/已删 Conversation/已建 tombstone 当成功并最终收敛。所有路径始终不调用磁盘目录删除。

- [ ] **Step 8: 注册目录 commands 并固定公开返回类型**

注册：

- `conversation_list/create/rename/delete`
- `conversation_provider_switch_capability`
- `conversation_switch_provider`
- `terminal_session_list/create/rename/delete`

list 的 `projectId=null` 精确定义为“无过滤、返回全部”，不是只查询 projectless；standalone/orphan/tombstone 分组由前端基于 projectId/projectStatus 过滤。Conversation summary 必须含稳定 `id`，`currentProviderId/currentModelId` 均为 nullable（迁移的 `needsProviderSelection=true` 会话允许二者为空），另含 projectId、`projectStatus: "active" | "deleted" | "missing"`、title、state、needsProviderSelection 和时间戳，不含 tombstone path 或 ProviderRevision.secretRef。Terminal summary 同样含稳定 `id` 与 `runtimeAttached` 布尔值，不返回易失 PTY ID；其 `projectStatus` 为 `"active" | "deleted" | "missing" | null`，且当且仅当 `projectId=null` 的 standalone terminal 时为 null。所有写命令只在 ReadyRuntime 可用。

每条普通目录写 command 的固定模板为：`AppState.acquire_mutation_guard()` → 短 runtime read guard clone `Arc<ReadyRuntime>` → 立即 drop runtime guard → 调对应 service `*_locked(&guard, ...)`。它们不得先 clone runtime 再等待 gate、不得持 runtime guard 等 gate、不得调用会自行 acquire 的 public wrapper。`project_cmds` 与 `CompatibilityFacade::ProjectFacade` 必须共享 ProjectService 的 locked 编排，不能各自实现删除事务；集成测试同时阻塞 gate/runtime writer 证明无锁反转和二次 acquire。

- [ ] **Step 9: 运行目录服务、兼容门面和全量 Rust 回归**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test catalog_services && cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS；Phase A `projectDelete(id, deleteConversations)` 契约不变，true 仅删除 Conversation，TerminalSession 保留为可修复元数据；legacy ManagedSession 仍能映射到稳定 Conversation/TerminalSession。

- [ ] **Step 10: 代码简化审查并提交**

使用 `@code-simplifier` 审查 Conversation/Terminal 两个服务的公共校验和删除编排；只抽取真正共享的小函数，不合并不同生命周期。若修改，重跑 Step 9。

```bash
git add src-tauri/src/application/conversation_catalog_service.rs src-tauri/src/application/terminal_catalog_service.rs src-tauri/src/application/project_service.rs src-tauri/src/application/workspace_service.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/mutation_gate.rs src-tauri/src/commands/conversation_cmds.rs src-tauri/src/commands/terminal_cmds.rs src-tauri/src/commands/project_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/compat/project_facade.rs src-tauri/src/domain/conversation.rs src-tauri/src/domain/terminal.rs src-tauri/src/storage/repositories.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/src/error.rs src-tauri/src/lib.rs src-tauri/tests/catalog_services.rs
git commit -m "feat: 新增会话与纯终端目录服务"
```

### Task 3: 扩展 v2 DTO、BackendClient 与安全 Fake

**Files:**
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/v2/types.test.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Create: `src/api/workspaceClient.test.ts`
- Modify: `src/test/FakeBackendClient.ts`

- [ ] **Step 1: 写失败契约测试固定稳定引用与命令参数**

测试覆盖：

- `workItemRef_key_is_kind_scoped_and_stable`
- `currentWorkspaceSaveInput_has_no_sourceSavedWorkspaceId`
- `backendClient_savedWorkspace_methods_match_public_contract`
- `backendClient_workspace_v2_mode_is_narrow_boolean_contract`
- `backendClient_current_workspace_new_blank_has_no_client_layout_payload`
- `backendClient_conversation_create_has_no_driver_or_secret`
- `backendClient_conversation_switch_provider_has_no_driver_revision_or_secret`
- `conversationProviderSwitchCapability_is_read_only_and_contains_no_revision_or_secret`
- `backendClient_rename_returns_authoritative_trimmed_summary`
- `conversationSummary_has_stable_id_and_nullable_selection`
- `terminalCreateInput_is_discriminated_by_scope`
- `terminalSummary_standalone_has_null_project_status`
- `terminalSummary_does_not_expose_runtimePtySessionId`
- `workPane_active_item_is_kind_scoped_ref_not_bare_uuid`
- `tauriClient_forwards_expectedUpdatedAt_and_delete_flags`
- `tauriClient_forwards_quit_token_only_to_current_workspace_flush`
- `tauriClient_workspace_v2_mode_set_cannot_carry_native_ai_flag`

定义唯一前端 key helper：

```ts
export function workItemKey(item: WorkItemRef): string {
  return item.kind === "conversation"
    ? `conversation:${item.conversationId}`
    : `terminal:${item.terminalSessionId}`;
}
```

- [ ] **Step 2: 运行客户端契约测试并确认失败**

Run: `npm run test -- src/api/v2/types.test.ts src/api/workspaceClient.test.ts`

Expected: FAIL，新 DTO 和 client 方法尚不存在。

- [ ] **Step 3: 补全公开 DTO**

在 `src/api/v2/types.ts` 增加：

- `ConversationSummary`、`ConversationCreateInput`
- `ConversationProviderSwitchCapability`
- `TerminalSessionSummary`、`TerminalSessionCreateInput`
- `CurrentWorkspaceSaveInput`
- `SavedWorkspaceSummary`、`SavedWorkspaceList`、`SavedWorkspaceMutationResult`
- `PaneNode/WorkPane/WorkItemRef` 的 v2 完整字段

`ConversationSummary` 精确使用 `id/projectId/projectStatus/title/currentProviderId/currentModelId/state/needsProviderSelection/createdAt/updatedAt`，其中两个 current selection 字段为 `string | null`，projectStatus 为 `active|deleted|missing`；不暴露 runtime namespace、tombstone path、secretRef、`projectPathSnapshot`、segment `cwdSnapshot` 或其他原生配置路径。`TerminalSessionSummary` 精确使用 `id/projectId/projectStatus/title/cwd/state/runtimeAttached/createdAt/updatedAt`，其中 projectStatus 为 `active|deleted|missing|null`，standalone 的 `projectId/projectStatus` 必须同时为 null；不暴露 runtime PTY ID。`WorkPane` 精确使用 `activeItem: WorkItemRef | null`，不得再声明任何裸 UUID 活动项字段；所有 active/close/restore 比较都调用 `workItemKey` 或比较完整判别联合。`SavedWorkspaceSummary` 精确使用 `id/name/paneCount/createdAt/updatedAt`；paneCount 由后端对已校验 tree 计算。`SavedWorkspaceMutationResult` 精确为 `{ current: CurrentWorkspace; saved: SavedWorkspace }`。`TerminalSessionCreateInput` 精确为：

`ConversationProviderSwitchCapability` 精确为 `{ mode: "any" } | { mode: "sameFrozenPairOnly"; providerId: string; modelId: string } | { mode: "contextBridgeRequired" }`；它只用于决定 Phase B 对话框展示，不替代 mutation 侧的 lifecycle/provider/context 重新校验。

```ts
export type TerminalSessionCreateInput =
  | {
      scope: "project";
      projectId: string;
      title?: string;
      shellDescriptor: ShellDescriptor;
    }
  | {
      scope: "standalone";
      cwd: string;
      title?: string;
      shellDescriptor: ShellDescriptor;
    };
```

- [ ] **Step 4: 扩展 BackendClient 三个实现**

签名固定为：

```ts
currentWorkspaceGet(): Promise<CurrentWorkspace>;
currentWorkspaceSave(input: CurrentWorkspaceSaveInput): Promise<CurrentWorkspace>;
currentWorkspaceFlushForQuit(input: CurrentWorkspaceSaveInput, quitToken: QuitToken): Promise<CurrentWorkspace>;
currentWorkspaceNewBlank(): Promise<CurrentWorkspace>;
workspaceV2ModeGet(): Promise<boolean>;
workspaceV2ModeSet(enabled: boolean): Promise<void>;
savedWorkspaceList(): Promise<SavedWorkspaceList>;
savedWorkspaceCreate(name: string): Promise<SavedWorkspaceMutationResult>;
savedWorkspaceLoad(id: string): Promise<CurrentWorkspace>;
savedWorkspaceRename(id: string, name: string): Promise<SavedWorkspace>;
savedWorkspaceUpdateFromCurrent(id: string): Promise<SavedWorkspace>;
savedWorkspaceCopyCurrent(name: string): Promise<SavedWorkspaceMutationResult>;
savedWorkspaceDelete(id: string): Promise<CurrentWorkspace>;
conversationList(projectId: string | null): Promise<ConversationSummary[]>;
conversationCreate(input: ConversationCreateInput): Promise<ConversationSummary>;
conversationRename(id: string, title: string): Promise<ConversationSummary>;
conversationProviderSwitchCapability(id: string): Promise<ConversationProviderSwitchCapability>;
conversationSwitchProvider(id: string, providerId: string, modelId: string): Promise<ConversationSummary>;
conversationDelete(id: string): Promise<void>;
terminalSessionList(projectId: string | null): Promise<TerminalSessionSummary[]>;
terminalSessionCreate(input: TerminalSessionCreateInput): Promise<TerminalSessionSummary>;
terminalSessionRename(id: string, title: string): Promise<TerminalSessionSummary>;
terminalSessionDelete(id: string): Promise<void>;
```

`TauriBackendClient` 只做 camelCase 参数转发；`currentWorkspaceFlushForQuit` 是唯一可携带 `quitToken` 的 v2 workspace 方法，普通 save 和其他 mutation 的参数类型中不得出现 token。`FakeBackendClient` 维护可控响应、调用记录、deferred promise 和逐方法故障注入，不复制生产 store 逻辑。

- [ ] **Step 5: 运行客户端、类型和构建测试**

Run: `npm run test -- src/api/v2/types.test.ts src/api/workspaceClient.test.ts src/api/client.test.ts && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: PASS；序列化 Fake 调用记录不含 secret、API key、runtime PTY ID 或 source pointer 写入参数。

- [ ] **Step 6: 代码简化审查并提交**

使用 `@code-simplifier` 审查 client 方法样板和 Fake deferred helper；若修改，重跑 Step 5。

```bash
git add src/api/v2/types.ts src/api/v2/types.test.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/workspaceClient.test.ts src/test/FakeBackendClient.ts
git commit -m "feat: 扩展工作区与会话公开 API"
```

### Task 4: 建立可注入的目录与 SavedWorkspace stores

**Files:**
- Create: `src/store/conversationCatalogStore.ts`
- Create: `src/store/conversationCatalogStore.test.ts`
- Create: `src/store/terminalCatalogStore.ts`
- Create: `src/store/terminalCatalogStore.test.ts`
- Create: `src/store/savedWorkspaceStore.ts`
- Create: `src/store/savedWorkspaceStore.test.ts`
- Modify: `src/store/projectStore.ts`
- Test: `src/store/projectStore.test.ts`
- Modify: `src/store/uiStore.ts`

- [ ] **Step 1: 写失败测试固定目录并发与失效策略**

新增：

- `conversationCatalog_loadAll_groups_by_project`
- `conversationCatalog_loadAll_uses_null_as_unfiltered_and_keeps_orphans`
- `conversationCatalog_ignores_stale_response_after_newer_refresh`
- `conversationCatalog_create_inserts_without_process_id`
- `conversationCatalog_delete_removes_only_after_backend_success`
- `conversationCatalog_failed_delete_refetches_authoritative_catalog_before_rethrow`
- `conversationCatalog_switch_provider_updates_only_after_backend_success`
- `conversationCatalog_rename_applies_authoritative_summary_and_ignores_stale_result`
- `terminalCatalog_keeps_stopped_metadata_after_runtime_detach`
- `terminalCatalog_loadAll_uses_null_as_unfiltered_and_keeps_standalone`
- `terminalCatalog_never_derives_stable_id_from_pty_id`
- `terminalCatalog_failed_delete_refetches_authoritative_catalog_before_rethrow`
- `terminalCatalog_rename_applies_authoritative_summary_and_ignores_stale_result`
- `projectStore_delete_forwards_explicit_conversation_choice_without_writing_other_stores`
- `projectStore_exposes_notLoaded_loading_error_loaded_without_false_missing_projects`

每个 load 使用递增 request generation；旧 Promise 后返回时不得覆盖新结果。删除禁止乐观移除；无论后端成功或失败都重新 list 对应 catalog，因为后端可能已先清布局、后删 metadata。refresh 完成后成功路径提交权威列表，失败路径保留原始 mutation 错误并附加脱敏 refresh 状态，不能假设“错误=零副作用”。

- [ ] **Step 2: 运行目录 store 测试并确认失败**

Run: `npm run test -- src/store/conversationCatalogStore.test.ts src/store/terminalCatalogStore.test.ts src/store/projectStore.test.ts`

Expected: FAIL，新目录 store 尚不存在，且 projectStore 尚未暴露明确 load state/显式 deleteConversations；跨目录刷新留给 Task 9 的 Ready action coordinator。

- [ ] **Step 3: 实现两个专责目录 store 工厂**

导出 `createConversationCatalogStore(client)` 与 `createTerminalCatalogStore(client)`；模块不创建生产单例，Task 10 `readyStores` 是唯一实例化位置并通过 props/context 注入组件。Conversation state 按 `projectId` 建索引并保留稳定 summary；Terminal catalog 只表达稳定元数据。Ready+workspaceV2 路径从 Task 7 的 `workItemRuntimeStore` 读取易失 PTY attachment，compat/Legacy 路径继续保留旧 `sessionStore`，两者都不得把 PTY ID写进 catalog。project/conversation/terminal 三个 catalog 都暴露 `notLoaded/loading/error/loaded`；只有 Project 为 loaded 后才能计算 deleted/missing group，loading 显示不可操作 skeleton，error 显示 retry。stores 不 import `invoke` 或彼此写 state；projectStore 也不直接刷新 Conversation/Terminal，Task 9 coordinator 通过注入的窄 refresh ports 完成跨目录动作，避免双重刷新和循环依赖。

- [ ] **Step 4: 写失败测试固定 SavedWorkspace 操作与冲突处理**

新增：

- `savedWorkspaceStore_list_keeps_invalid_count_warning`
- `savedWorkspaceStore_create_applies_aggregate_current_and_saved`
- `savedWorkspaceStore_load_waits_for_layout_flush_then_replaces_current`
- `savedWorkspaceStore_update_from_current_flushes_latest_layout_before_backend_call`
- `savedWorkspaceStore_create_copy_and_delete_flush_before_backend_call`
- `savedWorkspaceStore_new_blank_flushes_then_replaces_current_without_deleting_saved`
- `savedWorkspaceStore_holds_exclusive_layout_barrier_through_authoritative_replace`
- `savedWorkspaceStore_flush_or_backend_failure_releases_barrier_without_stale_replace`
- `savedWorkspaceStore_stale_action_result_cannot_overwrite_newer_load`
- `savedWorkspaceStore_delete_active_keeps_returned_current_tree`
- `savedWorkspaceStore_copy_applies_aggregate_current_and_saved`
- `savedWorkspaceStore_mutation_failure_keeps_previous_catalog`
- `savedWorkspaceStore_mutation_success_applies_returned_current_before_saved_refresh_failure`
- `savedWorkspaceStore_conflict_reload_freezes_layout_until_current_and_saved_reads_settle`

Store 只维护 saved summaries、invalidCount、busy action token 和公开错误；CurrentWorkspace 本体由 Phase B Chunk 2 的 layoutStore 持有。测试先注入最小 `WorkspaceLayoutPort { runExclusive, flushPersist, replaceFromBackend }`，其中 replace 只能使用本次 exclusive operation 的 opaque token，避免两个 Zustand store 直接互相 import 单例并防止 barrier 外权威覆盖。

- [ ] **Step 5: 运行 SavedWorkspace store 测试并确认失败**

Run: `npm run test -- src/store/savedWorkspaceStore.test.ts`

Expected: FAIL，savedWorkspaceStore 尚不存在。

- [ ] **Step 6: 实现 SavedWorkspace store 和窄布局端口**

create/load/updateFromCurrent/copy/delete/newBlank 都通过 `layoutPort.runExclusive("saved-workspace", async token => ...)` 包裹“冻结本地布局动作 → `await flushPersist()` → 后端 mutation → 权威 current replace/必要的 list refresh”的完整区间，因为它们会替换 current 或读取后端 current 生成/更新 snapshot；rename 不读取 current，可直接执行。barrier 开始时取消尚未完成的 pane drag/resize，所有 split/ratio/tab/open/close/swap 动作在 store 层和控件层同时禁用；迟到 pointerup/onLayout 也必须 no-op。flush 失败必须零后端 mutation并释放 barrier；后端 mutation 未提交或 action token 已过期时禁止 replace。若 create/load/copy/delete 已成功返回 authoritative Current，必须先在同一 token barrier 内应用它，再尝试 saved list refresh；后续 refresh 失败只把 saved list 标成可重试 error并保留旧 summaries，不能回滚已提交的 current/source/CAS。newBlank 只替换 returned Current，saved list 本身不变。每次 action 另持单调 action token；较旧 action 的响应只结束自己的 Promise，不改新状态。发生 `CONFLICT` 时立即保持/建立 exclusive+conflict reload barrier，冻结所有 layout mutation并在同一 barrier 内重新获取 current 与 saved list；两个权威读取和 replace 都收敛前不得解除，任一读取失败则保持冻结并要求显式 retry，绝不自动重放旧布局写入。

- [ ] **Step 7: 运行 store 全量测试、代码简化审查并提交**

Run: `npm run test -- src/store/conversationCatalogStore.test.ts src/store/terminalCatalogStore.test.ts src/store/savedWorkspaceStore.test.ts src/store/projectStore.test.ts && npm run typecheck`

Expected: PASS；无 act warning、未处理 Promise 或跨 store 单例循环依赖。

使用 `@code-simplifier` 审查三个 store 的 generation/token 样板；若修改，重跑本步骤。

```bash
git add src/store/conversationCatalogStore.ts src/store/conversationCatalogStore.test.ts src/store/terminalCatalogStore.ts src/store/terminalCatalogStore.test.ts src/store/savedWorkspaceStore.ts src/store/savedWorkspaceStore.test.ts src/store/projectStore.ts src/store/projectStore.test.ts src/store/uiStore.ts
git commit -m "feat: 新增菜单目录与工作区快照状态"
```

### Task 5: 通过 Chunk 1 跨层回归

**Files:**
- Verify only: all files changed in Tasks 1-4

- [ ] **Step 1: 运行前端完整门禁**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部成功；Phase A 迁移、供应商和旧界面测试无回归。

- [ ] **Step 2: 运行 Rust 完整门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；WorkspaceService 并发/CAS、目录删除顺序、CompatibilityFacade 与 legacy launch 均通过。

- [ ] **Step 3: 静态核对稳定/易失边界**

Run: `rg -n "runtimePtySessionId|ptySessionId|secretRef|apiKey|sourceSavedWorkspaceId" src/api/v2 src/store/conversationCatalogStore.ts src/store/terminalCatalogStore.ts src/store/savedWorkspaceStore.ts src-tauri/src/commands`

Expected: runtime PTY ID 不出现在 v2 持久化 DTO；secretRef/apiKey 不出现在公开目录响应；sourceSavedWorkspaceId 只出现在 CurrentWorkspace 响应/读取路径，不出现在保存输入。

- [ ] **Step 4: 核对提交和用户改动隔离**

Run: `git status --short && git diff --check`

Expected: 执行 worktree 中无意外未提交文件；主工作区原有 `package-lock.json`、`AGENTS.md` 和生成文件未被复制或暂存。

## Chunk 2: 稳定布局、运行时桥接与项目菜单

### Task 6: 建立 v2 WorkspaceLayoutStore 与退出安全自动保存

**Files:**
- Create: `src/store/workspaceLayoutStore.ts`
- Create: `src/store/workspaceLayoutStore.test.ts`
- Modify: `src/store/savedWorkspaceStore.ts`
- Modify: `src/store/savedWorkspaceStore.test.ts`

- [ ] **Step 1: 写失败测试固定稳定布局动作**

新增：

- `workspaceLayout_load_preserves_mixed_item_order_and_source`
- `workspaceLayout_load_keeps_missing_refs_for_placeholder`
- `workspaceLayout_open_existing_item_focuses_without_duplication`
- `workspaceLayout_locked_pane_rejects_only_new_items`
- `workspaceLayout_never_mixes_different_project_contexts_in_one_pane`
- `workspaceLayout_standalone_terminal_targets_only_null_context_pane`
- `workspaceLayout_incompatible_target_splits_next_to_active_when_possible`
- `workspaceLayout_auto_split_sets_new_leaf_project_context_from_item_not_source`
- `workspaceLayout_all_locked_keeps_catalog_entity_without_starting_runtime`
- `workspaceLayout_closing_last_item_preserves_empty_pane_project_context`
- `workspaceLayout_splitPane_creates_empty_inherited_context_leaf_and_marks_dirty`
- `workspaceLayout_closePane_last_leaf_is_noop`
- `workspaceLayout_closePane_removes_only_layout_refs_and_never_stops_runtime`
- `workspaceLayout_close_active_pane_selects_next_then_previous_leaf`
- `workspaceLayout_toggleLock_setActivePane_and_activateItem_mark_only_real_changes`
- `workspaceLayout_setRatio_rejects_non_finite_clamps_bounds_and_same_value_is_noop`
- `workspaceLayout_close_item_selects_adjacent_and_never_stops_runtime`
- `workspaceLayout_mutations_never_change_source_or_server_timestamp`
- `workspaceLayout_replace_from_backend_invalidates_older_action`
- `workspaceLayout_tree_helpers_preserve_unique_leaf_and_item_ids`
- `workspaceLayout_same_uuid_cross_kind_activate_and_close_are_unambiguous`
- `workspaceLayout_exclusive_barrier_blocks_every_public_mutation_and_late_ratio`
- `workspaceLayout_exclusive_barrier_allows_only_tokened_authoritative_replace`
- `workspaceLayout_exclusive_failure_releases_actions_and_preserves_dirty_error`
- `workspaceLayout_exclusive_after_backend_mutation_keeps_authority_unknown_barrier_on_refresh_error`
- `workspaceLayout_authority_retry_releases_barrier_only_after_current_catalog_project_and_saved_refreshes_succeed`
- `workspaceLayout_wait_for_exclusive_idle_rejects_while_authority_is_unknown`
- `workspaceLayout_quit_cannot_begin_while_authority_reload_is_frozen`
- `workspaceLayout_wait_for_exclusive_idle_resolves_after_authoritative_replace_and_refresh`
- `workspaceLayout_load_error_never_enables_mutation_or_saves_default_tree`

Store 使用 v2 `CurrentWorkspace`，不把 PTY ID、provider revision、secret 或前端临时拖动状态写入 tree。`openItem(item, itemProjectId, preferredPaneId?)` 以 `workItemKey` 查重：已存在则只激活原 pane/item。新 item 的落点只允许未锁且 `pane.projectId===itemProjectId`，或空 pane 且 projectId=null；项目 item 首次进入空 null pane 时把 pane.projectId 设为该项目，standalone terminal 只进入 null-context pane。选择顺序固定为兼容的 preferred → active → 先序其他 pane；没有兼容 pane但存在未锁 pane 时，在 active（若未锁）否则先序第一个未锁 pane 旁创建新 leaf并放入 item。这个 auto-split 不是普通 `splitPane` 的“继承 source context”：新 leaf 必须显式使用 `itemProjectId`（standalone 为 null），否则会把 Project A item 放进 Project B context。全锁时只保留 catalog entity、返回可解释错误且不得启动 runtime。`closeItem` 只移除布局引用，不删除实体/终止进程；关闭最后 item 后保留 pane.projectId 作为空窗口上下文。

Store 明确导出 `splitPane/closePane/toggleLock/setRatio/setActivePane/activateItem/openItem/closeItem`，其中 `activateItem/closeItem` 接受完整 `WorkItemRef`，不得接受裸 UUID。普通 split 新 leaf 继承 source project context、items 为空且 unlocked；最后一个 leaf 不可关闭。closePane 只删布局引用，绝不 kill/delete WorkItem；若关闭的是 active leaf，按关闭前 leaf 先序优先选择下一项、否则前一项，保证 `activePaneId` 始终引用仍存在的 leaf。ratio 必须 finite 并钳制到 `0.05..=0.95`；与当前值在 `1e-4` 内相同、重复 active/lock/item 选择均为 no-op，不递增 dirty generation。其余真实变化统一经过 `mutateLayout`。`loadState!=="loaded"`、exclusive barrier、authority-unknown barrier、conflict reload barrier 或 quit barrier 存在时，全部公开 mutation 都返回可解释 no-op/error且绝不创建 dirty；内部 backend replace 只能凭当前 barrier token 执行。

- [ ] **Step 2: 写失败测试固定 persist pump、CAS 与 quit-token**

新增：

- `workspaceLayout_debounces_to_latest_snapshot`
- `workspaceLayout_never_runs_two_current_saves_concurrently`
- `workspaceLayout_dirty_during_inflight_is_saved_by_next_iteration`
- `workspaceLayout_stale_response_cannot_replace_newer_local_tree`
- `workspaceLayout_conflict_fetches_authoritative_current_without_replay`
- `workspaceLayout_conflict_reload_barrier_blocks_edits_until_authoritative_replace`
- `workspaceLayout_conflict_reload_failure_keeps_every_action_frozen_until_retry_succeeds`
- `workspaceLayout_background_failure_is_caught_and_keeps_dirty`
- `workspaceLayout_flush_waits_until_persisted_generation_matches_dirty`
- `workspaceLayout_quit_flush_joins_preparing_save_then_uses_token_command`
- `workspaceLayout_quit_flush_retries_only_quiescing_rejection_with_token`
- `workspaceLayout_quit_flush_propagates_non_quiescing_inflight_error`
- `workspaceLayout_quit_flush_never_sends_token_to_ordinary_save`
- `workspaceLayout_cancelled_quit_keeps_dirty_state_retryable`
- `workspaceLayout_active_source_persist_emits_notification_without_refreshing_catalog`
- `workspaceLayout_persist_notification_stale_refresh_cannot_overwrite_newer_saved_action`

测试使用 fake timers 与 deferred Promise，明确断言调用顺序和并发数；`CONFLICT` 后重新获取后端 current、保留公开错误提示，并禁止自动重放旧快照覆盖刚加载的 SavedWorkspace。

- [ ] **Step 3: 运行 store 测试并确认失败**

Run: `npm run test -- src/store/workspaceLayoutStore.test.ts src/store/savedWorkspaceStore.test.ts`

Expected: FAIL，v2 layout store 与 production layout port 尚不存在。

- [ ] **Step 4: 实现可注入 v2 layout store**

导出 `createWorkspaceLayoutStore(client, scheduler)`，状态至少包含完整 `current`、`loadState: notLoaded|loading|error|loaded`、`persistError`、`dirtyGeneration`、`persistedGeneration`、`exclusiveReason`、`authorityReload: idle|required|reloading|error`、`conflictReload` 和 `quitBarrier`。初始占位树只用于 loading skeleton，`currentWorkspaceGet` 成功前不挂载/启用可写 Grid；load 失败显示 retry，任何布局 action/save 都是零调用。所有树编辑通过一个 `mutateLayout` 入口递增 generation 并启动 300ms 防抖；`sourceSavedWorkspaceId` 与 `updatedAt` 只接受后端响应，任何本地 action 都没有写权限。

单一 persist pump 捕获 `tree/activePaneId/expectedUpdatedAt`，普通路径调用 `currentWorkspaceSave`。成功后更新 CAS 时间戳；若捕获后又有本地编辑，只更新基线时间并继续下一轮，不用旧响应替换新树。每次成功且 `sourceSavedWorkspaceId!=null` 时通过 `subscribePersisted` 发出 `{ sourceSavedWorkspaceId, persistedGeneration }`；layout store 只发通知，不刷新或写任何 catalog。Task 10 `readyStores` 作为唯一 Ready coordinator 据此触发 saved list 的 generation-safe refresh，使自动同步后的 paneCount/updatedAt 及时更新；layout store 不自行重算 summary，也不 import saved store。`CONFLICT` 出现时立即建立内部 conflict reload barrier、取消 drag/resize并阻止全部公开 mutation（包括 split/ratio/tab/open/close/swap/active/lock），然后调用 `currentWorkspaceGet` 原子替换，设置“工作区已在其他操作中更新”并清除旧 dirty generation；authoritative get 失败则保持 barrier/error直到显式 retry 成功，不能让用户在已知过期基线上继续编辑，也不能把 get 等待期间的新动作悄悄覆盖。网络/存储错误保留 dirty 供显式重试。

`beginQuitBarrier()` 必须同步冻结全部 v2 layout action、取消 drag/resize/controller 临时状态，再由 App 调用 `flushPersist({ quitToken })`；barrier 建立前已排队但尚未落下的 pointerup/onLayout 也只能 no-op。`flushPersist({ quitToken })` 先取消 timer 并加入已有普通 inflight。若 prepare 抢先进入 Quiescing，已创建但尚未取得 ordinary permit 的 save 会以稳定 `QUIESCING`、底层零写失败；quit flush 只把这一特定错误视为该 generation 仍 dirty，并改用 `currentWorkspaceFlushForQuit` 重试。普通 inflight 成功则沿用其新 CAS 基线；其他错误原样传播并由 App cancel quit。带 token 后所有仍 dirty 的后续迭代只调用专用命令。token 不得进入 store state、日志或普通请求；退出 cancel 成功后 App 调 `cancelQuitBarrier()` 恢复 action/scheduler，成功退出不解除。

- [ ] **Step 5: 导出窄布局端口适配器**

从 layout factory 导出只含 `runExclusive/waitForExclusiveIdle/flushPersist/replaceFromBackend/reloadCurrent/subscribePersisted/beginQuitBarrier/cancelQuitBarrier` 的 `WorkspaceLayoutPort` 适配器，供 saved store、Ready action coordinator 和 App 注入。`runExclusive` 使用单一 opaque `ExclusiveLease`；回调在任何后端 mutation 发出前失败时正常释放。回调一旦调用 `lease.markAuthorityUnknown()`，普通 Promise 成功或失败都不得释放 barrier：此后只有同一 lease 可以 `replaceFromBackend`，且 Ready coordinator 必须在 CurrentWorkspace、相关 Conversation/Terminal catalogs、Project list 与 SavedWorkspace list 全部刷新成功后调用 `completeAuthoritativeRefresh()` 才能释放。刷新失败调用 `failAuthoritativeRefresh(redactedError)`，保留 lease、现有 UI 与冻结状态；UI 只能通过该 lease 的显式 retry 再取全部权威快照。旧/伪造 lease、普通 reload 或其他 action 都不能清除此 barrier。

嵌套/并发 exclusive action返回`CONFLICT`，不能相互覆盖。`waitForExclusiveIdle()`只等待已经开始的operation完成，不启动新动作；若conflict reload正在重试则等待，若conflict/authority reload已进入显式error则拒绝退出并要求先retry，不能在未知CAS上继续。`beginQuitBarrier()`在retained authority lease存在时失败并保持冻结，不得让退出flush从未知CurrentWorkspace CAS继续。Task 10在同步设置isQuitting、阻止新exclusive action后用它完成退出交接。Task 6不创建生产组合根，也不引用尚未实现的runtime bridge；各store文件只导出factory/type，测试可独立注入fake。

- [ ] **Step 6: 运行测试、类型检查并提交**

Run: `npm run test -- src/store/workspaceLayoutStore.test.ts src/store/savedWorkspaceStore.test.ts && npm run typecheck`

Expected: PASS；fake timers 清理完整，无未处理 rejection、循环 import 或并发保存。

使用 `@code-simplifier` 审查 persist pump、generation 比较和树递归；若修改，重跑本步骤。

```bash
git add src/store/workspaceLayoutStore.ts src/store/workspaceLayoutStore.test.ts src/store/savedWorkspaceStore.ts src/store/savedWorkspaceStore.test.ts
git commit -m "feat: 新增稳定工作区布局状态"
```

### Task 7: 建立稳定 WorkItem 与 legacy PTY 的易失绑定桥

**Files:**
- Create: `src-tauri/src/application/work_item_runtime_service.rs`
- Create: `src-tauri/src/commands/work_item_runtime_cmds.rs`
- Create: `src-tauri/tests/work_item_runtime.rs`
- Create: `src-tauri/tests/fixtures/runtime-outcomes/phase-a-segment.json`
- Modify: `src-tauri/tests/quit_gate.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/mutation_gate.rs`
- Modify: `src-tauri/src/application/quit_gate.rs`
- Modify: `src-tauri/src/application/legacy_entity_deletion_guard.rs`
- Modify: `src-tauri/src/application/conversation_catalog_service.rs`
- Modify: `src-tauri/src/application/terminal_catalog_service.rs`
- Modify: `src-tauri/src/application/project_service.rs`
- Modify: `src-tauri/src/compat/launch_facade.rs`
- Modify: `src-tauri/src/compat/runtime_bindings.rs`
- Modify: `src-tauri/src/compat/session_facade.rs`
- Modify: `src-tauri/src/pty/lifecycle.rs`
- Modify: `src-tauri/src/storage/runtime_outcome_store.rs`
- Modify: `src-tauri/src/domain/terminal.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/events.ts`
- Modify: `src/api/workspaceClient.test.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Create: `src/store/workItemRuntimeStore.ts`
- Create: `src/store/workItemRuntimeStore.test.ts`

- [ ] **Step 1: 写两组失败 Rust 测试固定 admission/binding 与 outcome/quit 边界**

新增：

把 list、start claim、admission、live binding 与 spawn 前校验测试放入 `mod admission_and_binding`；把 spawn 后提交失败清理、settling、outcome journal、replay 与 late exit 测试放入 `mod outcome_and_quit`，并把 `quit_gate.rs` 的新增 Terminal outcome 测试放入 `mod terminal_outcome`。三个模块必须可被 Cargo 独立过滤，先完成 admission 红绿，再进入 outcome/quit。

- `work_item_runtime_list_returns_only_live_bindings`
- `work_item_runtime_list_excludes_dead_binding_with_pending_outcome`
- `work_item_runtime_attachment_uses_stable_ref_and_ephemeral_pty_id`
- `work_item_runtime_conversation_reuses_live_binding`
- `work_item_runtime_concurrent_conversation_start_has_one_process_owner`
- `work_item_runtime_conversation_rejects_needs_provider_selection`
- `work_item_runtime_legacy_history_without_segment_stays_read_only`
- `work_item_runtime_conversation_rejects_missing_project_without_fallback`
- `work_item_runtime_new_conversation_uses_conversation_project_path_snapshot`
- `work_item_runtime_resume_uses_source_segment_cwd_snapshot_after_project_path_change`
- `work_item_runtime_conversation_resume_requires_current_pair_to_match_frozen_segment`
- `work_item_runtime_conversation_without_segment_creates_new_frozen_launch`
- `work_item_runtime_terminal_uses_persisted_cwd_and_shell_descriptor`
- `work_item_runtime_orphan_terminal_uses_persisted_cwd_without_project_fallback`
- `work_item_runtime_concurrent_terminal_start_has_one_process_owner`
- `work_item_runtime_start_claim_blocks_conversation_delete_switch_and_project_delete_true`
- `work_item_runtime_settling_blocks_conversation_delete_switch_and_project_delete_true`
- `work_item_runtime_pending_outcome_blocks_conversation_delete_switch_and_project_delete_true`
- `work_item_runtime_start_claim_blocks_terminal_delete_before_binding_commit`
- `work_item_runtime_settling_and_pending_outcome_block_terminal_delete`
- `work_item_runtime_restart_preflight_rejects_start_claim_settling_and_pending_outcome`
- `work_item_runtime_bootstrap_replays_outcomes_before_any_restart_is_admitted`
- `work_item_runtime_same_uuid_conversation_and_terminal_have_independent_claims_and_bindings`
- `work_item_runtime_uses_bootstrap_application_and_quit_gate_instances`
- `work_item_runtime_start_command_takes_admission_before_runtime_snapshot`
- `work_item_runtime_follower_drops_admission_before_waiting`
- `work_item_runtime_owner_converts_admission_without_second_quit_permit`
- `work_item_runtime_quit_prepare_waits_for_owner_not_follower`
- `work_item_runtime_never_reacquires_public_launch_gate`
- `work_item_runtime_terminal_commit_failure_terminates_tree_before_error`
- `work_item_runtime_old_exit_callback_cannot_detach_new_generation`
- `work_item_runtime_terminal_exit_updates_state_without_persisting_pty_id`
- `work_item_runtime_terminal_outcome_retry_and_restart_converge`
- `work_item_runtime_same_uuid_segment_and_terminal_outcomes_use_distinct_journal_keys`
- `work_item_runtime_replays_phase_a_bare_uuid_segment_outcome_then_cleans_legacy_file`
- `work_item_runtime_conflicting_legacy_and_canonical_outcomes_fail_closed`
- `work_item_runtime_unknown_outcome_filename_fails_closed`
- `work_item_runtime_outcome_settled_event_emits_only_after_repository_commit`
- `work_item_runtime_explicit_kill_nonzero_exit_settles_stopped`
- `work_item_runtime_preflight_validation_error_never_marks_entity_failed`
- `work_item_runtime_spawn_or_commit_failure_persists_failed_before_return`
- `work_item_runtime_quiescing_rejects_new_start`
- `work_item_runtime_pending_outcome_must_drain_or_return_retry_later_before_start`
- `work_item_runtime_settling_before_journal_blocks_restart_and_terminal_delete`
- `quit_gate_pending_terminal_outcome_blocks_exit`
- `quit_gate_late_terminal_callback_is_caught_by_sealing_final_drain`
- `quit_gate_terminal_outcome_drain_must_finish_before_exiting`

`LegacyWorkItemAttachment` 是运行态 DTO，只含 `item: WorkItemRef`、`ptySessionId` 和公开状态；它不得嵌入 `CurrentWorkspace`、catalog summary 或 repository JSON。

- [ ] **Step 2: 运行 admission/binding 子集并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime admission_and_binding`

Expected: FAIL，稳定 WorkItem 尚无专用 list/start service、claim 或 admission；不得是 `0 tests`，此时不运行 outcome 组掩盖失败原因。

- [ ] **Step 3: 实现 list/start claim、admission 与安全启动提交**

公开只读 `list_live()` 和 mutation `start(item, cols, rows)`。只有 process host 明确 live 且无 pending outcome 的 binding 才可返回/复用；死亡进程但因 outcome 持久化失败保留的 binding 不得暴露为 attachment。为删除、provider switch、project delete(true) 与重新打开/恢复定义唯一 kind-scoped `runtime_inflight_state(item)` 预检，原子观察 `startClaim/liveBinding/settlingGeneration/pendingOutcome`；各 service 只能复用它，不能维护各自不完整的布尔判断。start/restart 必须先按下一段协议取得唯一 per-item claim；follower 退出 admission 后等待，owner 才以自身 claim 身份执行 preflight。owner 可复用已 live binding；若存在 settling 返回 `RETRY_LATER`，若仅有 pending outcome则在保持 claim、但不持 mutation/runtime/binding lock时尝试 drain，失败返回 `RETRY_LATER`，不能覆盖旧终态。drain 后 owner 在同一 claim 下重验 live/settling/outcome，再决定创建新进程；删除/provider switch 等其他 mutation 始终看见该 claim并被阻止。Ready bootstrap 必须先 replay Phase A legacy Segment 与 Phase B kind-scoped Segment/Terminal outcomes并完成冲突/未知文件预检，再开放任何 runtime start；replay 未收敛时 Ready 构造失败，不能让重启入口绕过。Conversation 随后拒绝 `needsProviderSelection` 和非 active Project，Project lookup 只决定启动资格，绝不再提供 cwd 或回退当前/首个 Project。有 RuntimeSegment 时，current provider/model 必须与最新可恢复 segment 的冻结 pair 匹配，并从 source segment 的内部 `cwdSnapshot` 恢复；项目后来改路径不能改变恢复位置。只有无 segment、无 legacy source、event store 可证明无任何 context-bearing event 的全新空 Conversation 才从内部 `Conversation.projectPathSnapshot` 创建首个 launch并把同一路径复制进新 segment.cwdSnapshot。snapshot 缺失/非法一律失败封闭，两个字段都不进入运行态 DTO、catalog summary或错误。其他情况返回 `CONTEXT_BRIDGE_REQUIRED`。TerminalSession 只有在统一 claim/preflight/drain/recheck 全部通过后才读取自身持久化 cwd/shellDescriptor；即使 projectId=null 或 Project 已缺失也不回退其他目录，注册 stable terminal binding 后启动 plain PTY。`TerminalState::Failed` 不是终态死路，只要该 preflight 已收敛就允许显式重新打开。

同一 stable item 的并发 start 使用 `LegacyRuntimeBindings` 中的 per-item start claim，等待首个 owner 的结果，不能生成两个进程。command 不能先取完整 `MutationGuard`：固定顺序为 `ApplicationMutationGate::admit_start()` 取得仅含一个 ordinary Quit permit、但不持 mutation mutex 的 `StartAdmission` → 短 runtime read clone ReadyRuntime并释放 → 校验 UUID/尺寸 → service 尝试 per-item claim。若成为 follower，立即 drop admission，再在无 Quit permit、无 mutation/runtime/binding lock 下等待 owner 结果；若成为唯一 owner，把同一 admission 消费式转换为 `MutationLease`，不得登记第二个 permit，再调用 `LegacyLaunchService::start_work_item_locked(&lease, ...)`。lease 的短 `lock()` 只包裹 repository/binding 快照与提交；spawn、terminate、tree-empty wait 全在 mutation mutex 外，但原 ordinary permit 覆盖整个 owner operation，因此 quit prepare 等 owner 完成而不被 follower 阻塞。claim 在 owner 发布最终 attachment/error 前始终进入统一 `runtime_inflight_state`：Conversation delete/switch、project delete(true)、Terminal delete 以及新的 restart owner 发现 claim/settling/pending outcome 必须在任何布局/metadata/spawn 写前返回 `CONFLICT` 或 `RETRY_LATER`。任何 runtime snapshot 失败都先 drop admission；任何公开 launch/acquire 重入都由测试失败。

- [ ] **Step 4: 运行 admission/binding 子集并确认通过**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime admission_and_binding && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；并发 start 只有一个 owner/process，follower 不持 permit/lock，spawn 前校验零状态修改，且普通目录 mutation 始终看见 claim。

- [ ] **Step 5: 运行 outcome/quit 子集并确认仍失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime outcome_and_quit && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate terminal_outcome`

Expected: FAIL，Terminal/Segment outcome、settling generation、legacy replay 与 sealing drain 尚未实现；admission 组通过不能把本组伪装为完成。

- [ ] **Step 6: 实现 kind-scoped outcome、settling 与退出 replay**

Terminal 目标在释放/返回进程前必须提交 stable binding 与 Running metadata；若进程已创建后 binding、metadata 或 start outcome 持久化失败，owner 必须用已持有的 Job/process-tree controller 终止并等待 tree-empty ack，确认无孤儿后把后端权威 Conversation/Terminal 状态收敛为 Failed，再返回 Err。纯参数/provider/项目校验等 spawn 前错误必须零状态修改。binding 带单调 generation，旧 PTY 的迟到 exit callback 只能收敛自己的 generation，不能移除已重新打开的新 attachment。扩展 Phase A `RuntimeOutcomeStore` 为受控 target enum，使 TerminalSession 的 Stopped/Failed 也具备后台重试与启动 replay；新 journal key 固定为 kind-scoped `segment-<uuid>.json` 与 `terminal-<uuid>.json`，解析只接受这两类，same UUID 两种 outcome 可共存且绝不覆盖。载荷不含 PTY ID、cwd 或 shell 参数。终端 `runtimePtySessionId` 仍为 `serde(skip)`；重启后 bindings 为空。

向后兼容 Phase A 已可能留下的 `runtime-outcomes/<segmentId>.json` 裸 UUID 文件名和旧 AI payload：它只能映射为 Segment target。启动扫描先按文件名/载荷完整预检；仅旧格式存在时按原子 replay 应用并在成功后删除旧文件（可选择先规范化为 `segment-...`，但崩溃重试不能重复状态转换）。旧/新同 target 同时存在且 bytes/语义不完全一致、未知文件名或旧 payload 声称 Terminal target 时全部失败封闭、零 repository/文件修改；完全等价双格式可幂等收敛为单一 canonical 文件。QuitGate Sealing 的 final drain 必须同时扫描旧 AI、新 Segment 和 Terminal outcomes；任何 pending/late Terminal outcome、未知或冲突文件都阻止 Exiting，只有全部权威状态应用且目录清空后才退出。

PTY root exit 先把 binding generation 原子标记为 settling，再发 `work-item-runtime://settling { item, bindingGeneration }` 并移除 live attachment，不允许前端按 exitCode 推导 Stable 状态。这个内存标记必须早于 outcome journal 创建；统一 inflight preflight 在“已 exit、journal 尚未出现”的窗口也让 start/restart/delete/provider switch/project delete(true) 返回 `RETRY_LATER`，直到该 generation 的 repository commit+journal cleanup 完成。Phase A lifecycle/outcome 分类仍是唯一真相：explicit kill/shutdown 即使 root exitCode 非零也为 Stopped，自然非零才为 Failed。只有 RuntimeOutcomeStore 已原子应用到 Conversations/TerminalSessions repository并删除对应 journal 后，才清除 settling binding并发 `work-item-runtime://settled { item, bindingGeneration, state }`；重试期间保持 settling，不得提前发。新 generation 已绑定时，旧 generation 的 settling/settled 事件都忽略。

注册 `work_item_runtime_list/start`，只在 Ready 可用。参数中的 item 必须先验证 UUID；cols/rows 使用现有 PTY 上下限。错误不返回 program、cwd、environment 或 secret。

- [ ] **Step 7: 运行 outcome/quit 子集并确认通过**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime outcome_and_quit && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate terminal_outcome && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；旧/新 outcome 重放幂等，未知/冲突文件零修改失败封闭，settled 只在 repository commit 与 journal cleanup 后发出，Sealing 必须等全部 Terminal/Segment outcome 收敛。

- [ ] **Step 8: 写失败前端 store 测试**

新增：

- `workItemRuntime_refresh_indexes_by_work_item_key`
- `workItemRuntime_start_deduplicates_same_item_promise`
- `workItemRuntime_session_event_resolves_only_matching_pty`
- `workItemRuntime_exit_detaches_but_keeps_stable_catalog_entity`
- `workItemRuntime_start_overlays_running_before_catalog_refresh`
- `workItemRuntime_exit_marks_settling_without_classifying_exit_code`
- `workItemRuntime_settled_event_applies_authoritative_state_and_refreshes_catalog`
- `workItemRuntime_explicit_kill_nonzero_settled_stopped_is_not_failed`
- `workItemRuntime_stale_list_cannot_resurrect_exited_attachment`
- `workItemRuntime_refresh_retries_when_event_generation_changes`
- `workItemRuntime_dispose_unsubscribes_events_and_rejects_late_updates`
- `workItemRuntime_partial_listener_failure_unsubscribes_successes_and_blocks_ready`
- `workItemRuntime_dispose_before_late_listener_resolve_immediately_unlistens`
- `workItemRuntime_never_derives_stable_id_from_pty_id`
- `workItemRuntime_failure_keeps_layout_reference_and_redacted_error`
- `workItemRuntime_start_failure_refreshes_authoritative_catalog`
- `workItemRuntime_validation_failure_refresh_confirms_entity_was_not_marked_failed`

- [ ] **Step 9: 运行前端 store 测试并确认失败**

Run: `npm run test -- src/store/workItemRuntimeStore.test.ts src/api/workspaceClient.test.ts`

Expected: FAIL，listener 注册、event generation、防迟到更新和权威 catalog refresh 尚未实现；不得直接进入实现。

- [ ] **Step 10: 实现客户端与运行态 store**

BackendClient 增加 `workItemRuntimeList` 和 `workItemRuntimeStart`；Tauri client 只转发稳定 `WorkItemRef` 与尺寸。`createWorkItemRuntimeStore(client, events, catalogInvalidator)` 先并行注册 session-state/session-exit、`settling`、`settled` 四类 listener，全部成功后才发 list；任一 listener 失败立即调用已成功的 unlisten、进入公开 error、禁止 start/list-ready并显示 retry。dispose 在 listener Promise 尚未 resolve 时设置 generation tombstone，迟到 resolve 必须立刻调用其 unlisten。订阅完成后再发 list 请求并捕获 `eventGeneration`；响应时 generation 已变化则丢弃并重取，直到获得无事件穿插的快照，禁止旧 list 在 exit 后复活 attachment。store 按 `workItemKey` 保存 attachment并维护反向 PTY 索引；`ensureStarted` 对同 item 复用一个 Promise，成功立即覆盖 effective state=running，失败保留布局 Tab并调用注入的 catalogInvalidator 获取权威 summary，因为 spawn/commit cleanup 可能已持久化 Failed；validation error 的同一刷新应证明状态未变，前端不得凭 error code自行标 Failed。

Ready 组合根提供统一 `effectiveWorkItemState`：live attachment/session-state 事件优先于 catalog snapshot；`settling` 事件只显示“正在收敛”并清除 attachment，不读取 exitCode；`settled` 携带的后端权威 state 才更新 overlay并触发 generation-safe catalog refresh。refresh 响应若早于事件 generation则丢弃；后端 outcome 尚 pending 时不得显示旧 running，commit/event 后再刷新。factory 返回 `dispose()`，注销全部 Channel/listener、使迟到 Promise 失效并清理测试 timer。

- [ ] **Step 11: 运行跨层测试、简化并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate quit_gate_ && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/store/workItemRuntimeStore.test.ts src/api/workspaceClient.test.ts && npm run typecheck`

Expected: PASS；repository/工作区 JSON 搜索不到 `ptySessionId`，并发 start 只调用一次 fake process host。

使用 `@code-simplifier` 审查 start claim、stable/ephemeral 映射和客户端样板；若修改，重跑本步骤。

```bash
git add src-tauri/src/application/work_item_runtime_service.rs src-tauri/src/application/legacy_entity_deletion_guard.rs src-tauri/src/application/conversation_catalog_service.rs src-tauri/src/application/terminal_catalog_service.rs src-tauri/src/application/project_service.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/mutation_gate.rs src-tauri/src/application/quit_gate.rs src-tauri/src/commands/work_item_runtime_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/compat/launch_facade.rs src-tauri/src/compat/runtime_bindings.rs src-tauri/src/compat/session_facade.rs src-tauri/src/pty/lifecycle.rs src-tauri/src/storage/runtime_outcome_store.rs src-tauri/src/domain/terminal.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/runtime-outcomes/phase-a-segment.json src-tauri/tests/work_item_runtime.rs src-tauri/tests/quit_gate.rs src/api/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/events.ts src/api/workspaceClient.test.ts src/test/FakeBackendClient.ts src/store/workItemRuntimeStore.ts src/store/workItemRuntimeStore.test.ts
git commit -m "feat: 连接稳定工作项与易失终端"
```

### Task 8: 渲染 AI/终端混排的稳定工作区

**Files:**
- Create: `src/components/Workspace/WorkspaceGrid.tsx`
- Create: `src/components/Workspace/WorkspaceGrid.test.tsx`
- Create: `src/components/Workspace/WorkPane.tsx`
- Create: `src/components/Workspace/WorkPane.test.tsx`
- Create: `src/components/Workspace/WorkItemTab.tsx`
- Create: `src/components/Workspace/StoppedConversationPanel.tsx`
- Create: `src/components/Workspace/MissingWorkItemPanel.tsx`
- Modify: `src/terminal/TerminalPane.tsx`
- Modify: `src/terminal/TerminalPane.test.tsx`
- Create: `src/terminal/ptyAttachmentCoordinator.ts`
- Create: `src/terminal/ptyAttachmentCoordinator.test.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/types.ts`
- Modify: `src/api/workspaceClient.test.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src-tauri/src/pty/session.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/pty/pump.rs`
- Modify: `src-tauri/src/commands/pty_cmds.rs`
- Create: `src-tauri/tests/pty_attachment.rs`
- Modify: `src/styles/main.css`

- [ ] **Step 1: 写失败组件测试固定混排与占位语义**

新增：

- `workPane_renders_conversation_and_terminal_tabs_in_saved_order`
- `workPane_uses_kind_scoped_react_keys`
- `workPane_live_attachment_mounts_terminal_by_ephemeral_id_only`
- `workPane_stopped_terminal_offers_explicit_reopen`
- `workPane_failed_terminal_offers_explicit_reopen`
- `workPane_stopped_conversation_loads_legacy_history_before_resume`
- `workPane_active_project_stopped_conversation_offers_resume`
- `workPane_deleted_or_missing_project_conversation_is_history_only_without_resume`
- `workPane_needs_provider_selection_disables_resume_and_opens_repair`
- `workPane_catalog_not_loaded_or_loading_shows_non_destructive_skeleton`
- `workPane_catalog_error_shows_retry_without_remove`
- `workPane_loaded_not_found_keeps_tab_and_offers_remove_reference`
- `workPane_close_tab_does_not_kill_or_delete_entity`
- `workspaceGrid_preserves_nested_split_ids_and_ratios`
- `workspaceGrid_wires_split_close_lock_active_and_tab_actions`
- `workspaceGrid_initial_onLayout_same_ratio_does_not_mark_dirty`
- `workspaceGrid_not_loaded_loading_or_error_never_mounts_writable_tree`
- `terminalPane_stale_detach_after_swap_cannot_detach_new_attachment`
- `terminalPane_stale_attach_completion_cannot_replace_new_attachment`
- `terminalPane_swap_remount_preserves_output_without_kill`
- `ptyAttachmentCoordinator_serializes_attach_detach_per_session`
- `ptyAttachmentCoordinator_waits_for_backend_allocated_client_epoch_before_attach`
- `ptyAttachmentCoordinator_recreation_after_webview_reload_uses_newer_client_epoch`
- `ptyAttachmentCoordinator_superseded_epoch_promise_never_calls_attach`
- `backendClient_pty_client_begin_attach_detach_forward_same_attachment_token`
- `tauriClient_forwards_attachment_token_without_relabeling`
- `fakeBackendClient_records_epoch_token_and_supports_deferred_attach_detach`
- `pty_attachment_client_begin_strictly_increases_without_touching_any_session_sink`
- `pty_attachment_frontend_restart_epoch_orders_above_existing_session_token`
- `pty_attachment_stale_attach_token_cannot_replace_new_sink`
- `pty_attachment_same_epoch_higher_sequence_replaces_lower_sequence_only`
- `pty_attachment_late_old_epoch_attach_cannot_replace_new_webview_sink`
- `pty_attachment_detach_clears_only_matching_token`
- `pty_attachment_send_failure_clears_only_observed_token`

- [ ] **Step 2: 运行组件测试并确认失败**

Run: `npm run test -- src/components/Workspace/WorkspaceGrid.test.tsx src/components/Workspace/WorkPane.test.tsx src/terminal/TerminalPane.test.tsx src/terminal/ptyAttachmentCoordinator.test.ts src/api/workspaceClient.test.ts && cargo test --manifest-path src-tauri/Cargo.toml --test pty_attachment`

Expected: FAIL，Ready 工作区组件尚不存在。

- [ ] **Step 3: 实现稳定 WorkPane 渲染**

`WorkspaceGrid` 只订阅 v2 layout store并在 `loadState=loaded` 后递归渲染可写 split；notLoaded/loading 显示不可操作 skeleton，error 显示 retry，禁止渲染默认树、触发 `onLayout` 或任何 save。`WorkPane` 按 `items` 原顺序渲染 Tab，用 conversation/terminal catalog 查标题和状态，并用完整 `WorkItemRef/workItemKey` 判定 active，same UUID 跨 kind 仍只有一个 active。catalog 状态必须区分 `notLoaded/loading/error/loaded`：前两者显示不可删除 skeleton，error 显示 retry，只有 `loaded` 且按稳定 ID 确认 not found 才显示 `MissingWorkItemPanel` 与移除引用按钮；任何迟到/失败加载都不能把真实实体误判为缺失。

分屏、关闭 pane、锁定、active pane、Tab 激活/关闭按钮全部接 Task 6 的显式 action；`react-resizable-panels` 的 `onLayout` 只在 ratio 真正变化时写 store，首次 mount 回报默认比例不得制造 dirty save。关闭 pane/Tab 不终止仍在运行的 attachment，菜单可再次定位或打开稳定实体。

live attachment 才向 `TerminalPane` 传易失 PTY ID。`TerminalState::Stopped | Failed` 都显示“重新打开终端”，点击调用 runtime store；Failed 不能成为无恢复入口的死状态。非 live AI 会话先通过现有兼容 history API 读取稳定 Conversation 的 Panel/已导入历史投影。只有 `projectStatus=active` 且不需要 provider 修复时显示“恢复兼容会话”；`projectStatus=deleted|missing` 固定为历史只读并显示原因，不调用 runtime start。`needsProviderSelection` 根据 Task 9 的 repair capability 显示可提交修复或 ContextBridge 只读说明，不尝试启动。Phase D 前 AI 仍使用 legacy PTY，不能在本任务伪造原生消息状态。

PTY attach/detach 使用后端分配 epoch 的易失、单调 `PtyAttachmentToken { clientEpoch, sequence }`，不用随机 token，也不能只靠 WebView 内存从 generation 1 重启。每次创建 `ptyAttachmentCoordinator` 时先调用一次 `BackendClient.ptyAttachmentClientBegin()`；Rust `PtyManager` 用 checked-add 分配全进程严格递增的正整数 `clientEpoch`，此操作不读取或修改任何 PTY sink。coordinator 在该 epoch 内为每个 `ptySessionId` 分配严格递增的正整数 `sequence`，并按 session 串行 `ptyAttach(sessionId, token, onMessage)` / `ptyDetach(sessionId, token)`。epoch Promise 返回前不得创建 Channel 或 attach；若 coordinator 已 supersede/dispose，迟到 epoch 只丢弃且不触碰 session。模块热重载或整个 WebView 重建会创建新 coordinator 并取得更高 epoch，因此即使每个 session 的本地 sequence 又从 1 开始，完整 token 仍高于旧 WebView。`src/api/types.ts`、`TauriBackendClient`、`FakeBackendClient` 和 Rust command 必须原样转发完整 token；Fake 只记录 begin/attach/detach/deferred/error，不复制生产 sink 逻辑。

后端 `PtySession` 保存 lexicographic `lastAttachmentToken` 与可选 `AttachedSink { token, channel }`；token 只接受当前进程已签发的 `clientEpoch`、`sequence>=1` 且两个分量均在闭合整数上限内。`pty_attach` 只有 token 严格大于 session high-water 才推进 watermark并安装新 sink；较小或相等 token 幂等成功但不得替换。全局 epoch 分配与 session attach 分离：即使旧 WebView 的 `clientBegin` 请求迟到并取得更高 epoch，只要旧 JS 已销毁就不会修改任何 session；已发送的旧 attach token 一定低于新 WebView token并被忽略。`pty_detach` 只有 token 与当前 sink 完全相等才清除，其他值幂等 no-op，watermark 永不降低。pump 发送失败也只清除当时观察到的同一 token。frontend queue 与 backend token high-water 是两层独立保护，token 不进入 repository、layout、catalog、日志或错误。unmount/dispose 必须让迟到 Promise 失效并释放 Channel；跨父 swap 或 WebView 重建时，无论 attach/detach IPC 完成顺序如何，最终 sink 只能属于最高 token，swap 不 kill 进程，ring snapshot+后续 data 仍连续可见。

旧 `PaneGrid`、`layoutStore`、`Sidebar` 继续保留给 LegacyReadOnly 路径；Ready 组件不得 import `workspaceStore` 或把 ManagedSession/PTY ID写回布局。

- [ ] **Step 4: 运行组件、无障碍与构建测试**

Run: `npm run test -- src/components/Workspace/WorkspaceGrid.test.tsx src/components/Workspace/WorkPane.test.tsx src/terminal/TerminalPane.test.tsx src/terminal/ptyAttachmentCoordinator.test.ts src/api/workspaceClient.test.ts && cargo test --manifest-path src-tauri/Cargo.toml --test pty_attachment && npm run typecheck && npm run build`

Expected: PASS；混排顺序稳定，缺失一项不阻断其他 pane。

- [ ] **Step 5: 代码简化审查并提交**

使用 `@code-simplifier` 审查 item resolver、重复占位分支和 selector 粒度；若修改，重跑 Step 4。

```bash
git add src/components/Workspace/WorkspaceGrid.tsx src/components/Workspace/WorkspaceGrid.test.tsx src/components/Workspace/WorkPane.tsx src/components/Workspace/WorkPane.test.tsx src/components/Workspace/WorkItemTab.tsx src/components/Workspace/StoppedConversationPanel.tsx src/components/Workspace/MissingWorkItemPanel.tsx src/terminal/TerminalPane.tsx src/terminal/TerminalPane.test.tsx src/terminal/ptyAttachmentCoordinator.ts src/terminal/ptyAttachmentCoordinator.test.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/types.ts src/api/workspaceClient.test.ts src/test/FakeBackendClient.ts src-tauri/src/pty/session.rs src-tauri/src/pty/manager.rs src-tauri/src/pty/pump.rs src-tauri/src/commands/pty_cmds.rs src-tauri/tests/pty_attachment.rs src/styles/main.css
git commit -m "feat: 渲染稳定混合工作区"
```

### Task 9: 实现项目→会话菜单与供应商修复入口

**Files:**
- Create: `src/components/Sidebar/ReadySidebar.tsx`
- Create: `src/components/Sidebar/ReadySidebar.test.tsx`
- Create: `src/components/Sidebar/ProjectMenuItem.tsx`
- Create: `src/components/Sidebar/ConversationMenuItem.tsx`
- Create: `src/components/Sidebar/TerminalMenuItem.tsx`
- Modify: `src/components/dialogs/ProjectDeleteDialog.tsx`
- Test: `src/components/dialogs/ProjectDeleteDialog.test.tsx`
- Create: `src/components/dialogs/ConversationProviderDialog.tsx`
- Create: `src/components/dialogs/ConversationProviderDialog.test.tsx`
- Modify: `src/components/ui/ContextMenu.tsx`
- Modify: `src/store/projectStore.ts`
- Modify: `src/store/conversationCatalogStore.ts`
- Modify: `src/store/terminalCatalogStore.ts`
- Modify: `src/store/uiStore.ts`
- Modify: `src/styles/main.css`
- Modify: `src/styles/sidebar.css`
- Modify: `src/styles/dialogs.css`

- [ ] **Step 1: 写失败测试固定信息架构和选择语义**

新增：

- `readySidebar_has_new_project_search_projects_then_workspaces`
- `readySidebar_ends_with_keyboard_reachable_provider_and_settings_entries`
- `readySidebar_has_no_duplicate_global_conversation_group`
- `readySidebar_filter_matches_project_or_child_conversation`
- `readySidebar_filter_matches_child_terminal`
- `readySidebar_groups_projectless_terminals_separately_from_missing_projects`
- `readySidebar_delayed_or_failed_project_load_never_marks_all_children_missing`
- `readySidebar_project_delete_false_keeps_conversation_and_terminal_in_deleted_project_group`
- `readySidebar_project_delete_true_keeps_only_terminal_in_missing_project_group`
- `projectMenuItem_expands_keyboard_and_loads_stable_children`
- `projectMenuItem_marks_active_project_with_aria_current`
- `conversationMenuItem_marks_active_item_and_shows_provider_state_time`
- `terminalMenuItem_shows_stopped_state_and_reopens_stable_terminal`
- `terminalMenuItem_shows_failed_state_and_reopens_stable_terminal`
- `missing_project_conversation_cannot_start_but_remains_deletable`
- `missing_project_terminal_reopens_only_from_persisted_cwd_and_shell`
- `conversation_click_focuses_existing_item_or_opens_in_unlocked_pane`
- `conversation_create_persists_metadata_before_starting_legacy_runtime`
- `terminal_create_uses_public_shell_setting_in_project_variant_without_cwd`
- `readyDelete_flushes_layout_before_conversation_terminal_and_project_delete`
- `readyDelete_flush_failure_calls_no_delete_command`
- `readyDelete_waits_inflight_save_before_backend_workspace_mutation`
- `readyDelete_holds_exclusive_layout_barrier_until_authoritative_refresh_finishes`
- `readyDelete_late_drag_resize_or_tab_action_cannot_dirty_during_backend_delete`
- `readyDelete_refresh_failure_keeps_authority_unknown_barrier_and_all_actions_frozen`
- `readyDelete_saved_workspace_refresh_failure_also_keeps_authority_unknown_barrier`
- `readyDelete_retry_refresh_releases_barrier_only_after_current_catalog_project_and_saved_succeed`
- `readyDelete_quit_is_rejected_while_authoritative_refresh_is_unknown`
- `conversationProviderDialog_needs_selection_new_empty_is_repairable`
- `conversationProviderDialog_needs_selection_same_frozen_pair_is_repairable`
- `conversationProviderDialog_context_bridge_required_is_read_only_not_false_submit`
- `conversationProviderDialog_same_frozen_pair_only_disables_other_pairs`

- [ ] **Step 2: 写失败测试固定右键操作和删除选择**

覆盖项目“编辑、设置默认供应商、新建 AI 会话、新建纯终端、删除”，会话“重命名、切换供应商、在窗口中打开、删除”。为消除设计中“会话移动到窗口”和“本期不移动单个 Tab”的冲突，固定规则：未打开的会话可选择未锁 pane 打开；已打开的会话只定位现有 pane，不跨 pane 移动单 Tab，整窗换位由 Chunk 3 操作。

复用 Phase A `ProjectDeleteDialog` 的显式“保留会话元数据/同时删除 Conversation”与 TerminalSession/磁盘目录保留说明，只扩展 ReadySidebar 接线和 tombstone 文案；active/nonterminal/start claim/settling/pending outcome 预检失败时对话框保持打开并显示稳定错误，不能弱化为仅检查 UI state。`ConversationProviderDialog` 打开后先读取 `conversationProviderSwitchCapability`：`needsProviderSelection` 的全新空会话在 `any` 模式可选择任意启用 pair；`sameFrozenPairOnly` 是可提交的同 pair 修复，只允许返回的 pair并明确“不创建新运行段”；`contextBridgeRequired` 显示“Phase D 上下文桥接后可切换”的只读说明且没有提交按钮。它仍只提交 providerId/modelId，对 live/nonterminal/start claim/settling/pending outcome 禁用，并在成功后只通过 Ready action coordinator generation-safe 刷新匹配 Conversation catalog；mutation 返回 `CONTEXT_BRIDGE_REQUIRED` 时也必须收敛到只读说明，不能无限重试假可用操作。

- [ ] **Step 3: 运行菜单测试并确认失败**

Run: `npm run test -- src/components/Sidebar/ReadySidebar.test.tsx src/components/dialogs/ProjectDeleteDialog.test.tsx src/components/dialogs/ConversationProviderDialog.test.tsx`

Expected: FAIL，Ready 菜单尚不存在。

- [ ] **Step 4: 实现可访问菜单与操作编排**

项目/会话行使用 button 或等价键盘语义，支持 Enter/Space、可见 focus 和 `aria-expanded/aria-current`。`ContextMenu` 增加 `disabled`、`role="menu"`、初始聚焦、上下键/Home/End/Escape；禁用项不可点击。搜索只过滤展示，不修改 store。ReadySidebar 在 SavedWorkspace 分组之后固定提供“模型供应商”和“全局设置”两个键盘可达入口，分别复用 Phase A `ProviderManager` 与 `SettingsDialog`；供应商修复对话框也只能跳转同一 ProviderManager，不能创建第二套管理 UI。

项目展开后同时渲染稳定 Conversation 与 TerminalSession；Terminal 行显示 running/stopped/failed，点击 stopped 或 failed 行都通过 stable ref 重新打开，不能从旧 PTY ID重建身份。Conversation/Terminal rename 都使用后端返回的 trim 后 authoritative summary，旧 action token 不得覆盖新标题；Terminal 右键菜单明确包含“重命名、重新打开/定位、删除”。搜索命中 Project、Conversation 或 Terminal 任一标题时保留其必要父分组。`projectId=null` 的 standalone terminal 进入“独立终端”分组；`projectStatus=deleted` 的子项进入“已删除项目”分组，`missing` 才进入“缺失项目”分组，不能只凭当前 Project 数组为空推断。deleted/missing Conversation 可查看已导入历史，或由 Conversation.`projectPathSnapshot` 与各 segment.`cwdSnapshot` 定位的只读历史，但禁止 start；tombstone 只提供 deleted 状态和稳定 ID 保留，绝不参与历史路径选择。此类会话只保留查看/删除与未来修复入口；Terminal 可按自身持久化 cwd/shellDescriptor 重开，绝不默认绑定其他 Project。

新建 AI 固定顺序为 `conversationCreate → layout.openItem → workItemRuntimeStart`；只有 openItem 成功放入/定位 Tab 才调用 runtime start，全锁等布局拒绝时稳定 Conversation 留在菜单但零 spawn。spawn 失败仍保留稳定 Conversation 与 Tab。新建终端从公开 AppSettings 的 `shellPath` 构造 `ShellDescriptor { executable, args: [] }`，固定顺序为 `terminalSessionCreate(Project variant，不传 cwd) → layout.openItem → runtime start`，同样只在 openItem 成功后启动；自定义 args 只来自专用终端设置，不读取项目/会话文本。

Conversation/Terminal/Project 删除都会改 WorkspaceStore，因此 Ready action coordinator 必须使用 Task 6 `layout.runExclusive("catalog-delete", lease => ...)` 覆盖 `flushPersist → delete command → current/catalog/project 权威 refresh/replace` 全区间；barrier 开始即取消 drag/resize，迟到 pointerup、split、ratio、Tab/open/close action 都不得置 dirty。flush 失败发生在任何 mutation 发出前，零 delete 调用并正常释放 barrier；已有 inflight save 必须完成并更新 CAS 后才发删除。

delete command 一旦发出，无论返回成功还是错误都立即调用 `lease.markAuthorityUnknown()`，因为后端可能已经原子清理 CurrentWorkspace 和每个 SavedWorkspace 引用、仅在后续 metadata 写失败。随后在同一 lease 内重新获取 CurrentWorkspace、相关 Conversation/Terminal catalogs、Project list 与 SavedWorkspace list；只有四类响应都成功、generation仍匹配且各 store authoritative replace 完成后，才展示原始 mutation结果并调用 `completeAuthoritativeRefresh()` 释放 barrier。任一权威 refresh（包括 SavedWorkspace list）失败都调用 `failAuthoritativeRefresh`，保留现有 UI、冻结全部布局/目录 action并显示组合后的脱敏错误；显式“重试刷新”必须复用 retained lease 重取全部四类来源，不能只刷新失败的一个 store。刷新完全成功前禁止退出、保存、删除、provider repair、runtime start和任何布局编辑，绝不能在未知 CAS/目录/SavedWorkspace updatedAt 上继续。Conversation/Terminal/project/saved stores 与组件不得互相触发跨目录 refresh；删除、runtime start/settled、provider repair 的 refresh统一归 Task 10 `readyStores` action coordinator。切换供应商使用 Task 2/3 的专用 API，不通过旧 Workspace/AgentConfig 写路径。

- [ ] **Step 5: 运行测试、简化并提交**

Run: `npm run test -- src/components/Sidebar/ReadySidebar.test.tsx src/components/dialogs/ProjectDeleteDialog.test.tsx src/components/dialogs/ConversationProviderDialog.test.tsx src/store/projectStore.test.ts src/store/conversationCatalogStore.test.ts src/store/terminalCatalogStore.test.ts && npm run typecheck`

Expected: PASS；键盘操作无 act warning，失败 spawn 不产生孤儿 PTY 或丢失稳定实体。

使用 `@code-simplifier` 审查菜单 action 组装和重复对话框状态；若修改，重跑本步骤。

```bash
git add src/components/Sidebar/ReadySidebar.tsx src/components/Sidebar/ReadySidebar.test.tsx src/components/Sidebar/ProjectMenuItem.tsx src/components/Sidebar/ConversationMenuItem.tsx src/components/Sidebar/TerminalMenuItem.tsx src/components/dialogs/ProjectDeleteDialog.tsx src/components/dialogs/ProjectDeleteDialog.test.tsx src/components/dialogs/ConversationProviderDialog.tsx src/components/dialogs/ConversationProviderDialog.test.tsx src/components/ui/ContextMenu.tsx src/store/projectStore.ts src/store/conversationCatalogStore.ts src/store/terminalCatalogStore.ts src/store/uiStore.ts src/styles/main.css src/styles/sidebar.css src/styles/dialogs.css
git commit -m "feat: 重构项目与会话菜单"
```

### Task 10: 接入 SavedWorkspace 菜单并切换 Ready 应用壳

**Files:**
- Create: `src/store/readyStores.ts`
- Create: `src/store/readyStores.test.ts`
- Create: `src/components/Sidebar/SavedWorkspaceSection.tsx`
- Create: `src/components/Sidebar/SavedWorkspaceSection.test.tsx`
- Create: `src/components/dialogs/WorkspaceNameDialog.tsx`
- Create: `src/components/dialogs/WorkspaceNameDialog.test.tsx`
- Modify: `src/components/Sidebar/ReadySidebar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/components/dialogs/SettingsDialog.test.tsx`
- Modify: `src/hooks/useHotkeys.ts`
- Modify: `src/store/settingsStore.ts`
- Modify: `src/store/uiStore.ts`
- Modify: `src/styles/main.css`
- Modify: `src/styles/sidebar.css`
- Modify: `src/styles/dialogs.css`

- [ ] **Step 1: 写失败测试固定 SavedWorkspace 列表与动作**

新增：

- `savedWorkspaceSection_shows_name_pane_count_and_active_source`
- `savedWorkspaceSection_invalid_count_is_warning_not_total_failure`
- `savedWorkspaceSection_unsaved_button_creates_named_snapshot`
- `savedWorkspaceSection_new_blank_flushes_active_source_then_clears_source_without_delete`
- `savedWorkspaceSection_active_source_reports_auto_save`
- `savedWorkspaceSection_click_flushes_then_loads_returned_current`
- `savedWorkspaceSection_rename_update_copy_delete_use_backend_result`
- `savedWorkspaceSection_delete_active_keeps_current_tree_as_temporary`
- `savedWorkspaceSection_older_action_cannot_replace_newer_load`
- `savedWorkspaceSection_active_source_auto_save_refreshes_pane_count_and_updated_at`
- `savedWorkspaceSection_stale_auto_refresh_cannot_overwrite_newer_action`

- [ ] **Step 2: 写失败 App 测试固定 Ready/Legacy 分路**

新增：

- `app_ready_flag_true_loads_ready_stores_once_after_migration_gate`
- `app_ready_flag_true_renders_ready_sidebar_and_workspace_grid`
- `app_ready_layout_not_loaded_or_loading_renders_blocking_skeleton_not_grid`
- `app_ready_layout_load_error_shows_retry_and_zero_save_calls`
- `app_ready_runtime_subscription_error_blocks_grid_and_start_until_retry`
- `app_ready_persist_error_shows_retry_save_and_keeps_dirty_until_success`
- `app_ready_flag_false_keeps_compat_ready_shell_and_loads_no_ready_store`
- `app_legacy_read_only_keeps_legacy_sidebar_and_pane_grid`
- `app_recovering_or_blocked_loads_no_business_store`
- `app_ready_quit_flushes_v2_layout_with_quit_token`
- `app_ready_quit_flushes_settings_before_prepare`
- `app_ready_quit_waits_existing_exclusive_action_before_quit_barrier`
- `app_ready_quit_waits_active_run_exclusive_through_current_replace_and_refresh`
- `app_ready_quit_order_is_exclusive_idle_then_settings_prepare_layout_and_quit`
- `app_ready_quit_does_not_prepare_with_unresolved_conflict_reload`
- `app_ready_quit_does_not_prepare_with_retained_authority_unknown_lease`
- `app_v2_settings_flush_failure_cancels_local_barrier_without_backend_cancel`
- `app_ready_flag_false_quit_keeps_compat_layout_flush`
- `app_v2_shell_toggle_off_then_quit_still_flushes_v2`
- `app_compat_shell_toggle_on_then_quit_still_flushes_compat`
- `app_legacy_quit_uses_read_only_noop_flush_and_calls_no_layout_write`
- `app_is_quitting_disables_ready_create_load_and_runtime_start`
- `app_v2_quit_barrier_cancels_drag_and_blocks_late_layout_actions_before_flush`
- `app_v2_quit_cancel_releases_barrier_only_after_backend_cancel_succeeds`
- `app_unmount_disposes_ready_runtime_events_once`
- `readyStores_owns_all_cross_catalog_refresh_without_store_import_cycles`
- `readyStores_runtime_start_failure_refreshes_only_matching_catalog`
- `readyStores_settled_event_refreshes_matching_catalog_generation_safely`
- `readyStores_delete_mutation_marks_authority_unknown_before_interpreting_result`
- `readyStores_delete_refresh_failure_retains_lease_and_freezes_all_producers`
- `readyStores_delete_saved_workspace_refresh_failure_retains_same_lease`
- `readyStores_delete_retry_refetches_current_related_catalogs_projects_and_saved_as_one_generation`
- `readyStores_delete_retry_releases_lease_only_after_all_four_authoritative_sources_succeed`
- `settings_workspace_v2_toggle_persists_restart_required_without_hot_switch`

- [ ] **Step 3: 运行 SavedWorkspace 与 App 测试并确认失败**

Run: `npm run test -- src/components/Sidebar/SavedWorkspaceSection.test.tsx src/components/dialogs/WorkspaceNameDialog.test.tsx src/store/readyStores.test.ts src/App.test.tsx`

Expected: FAIL，SavedWorkspace UI 和 Ready 应用壳尚未接线。

- [ ] **Step 4: 实现工作区分组和命名对话框**

分组显示“保存当前工作区”“新建临时空白工作区”和 saved list。`sourceSavedWorkspaceId=null` 时保存按钮打开名称对话框并 create；非空时显示“已自动保存”，另存使用右键“复制为新工作区”。“新建临时空白工作区”通过 saved store 的 newBlank action 先 flush 当前 source，再调用 `currentWorkspaceNewBlank` 并应用返回 Current；它不删除或改写任何 SavedWorkspace。右键提供重命名、用当前布局更新、复制、删除；所有可能替换 current 的操作由 saved store 先 flush，再应用后端返回的完整 `CurrentWorkspace`。

列表项用后端 summary 的 `paneCount`，不得前端读取损坏 workspace tree 重新计数。当前 source 使用 `aria-current`；`invalidCount>0` 只显示警告，不泄露损坏布局内容。

- [ ] **Step 5: 切换 Ready 应用壳并保留兼容分支**

`readyStores.ts` 在所有依赖已经存在后作为唯一生产组合根创建 layout、conversation catalog、terminal catalog、runtime bridge 和 saved-workspace stores，并把 Task 6 的窄 layout port 与 project/conversation/terminal refresh ports 注入 saved store/Ready action coordinator；projectStore 不直接 import 或写两个子目录 store。组合根先完整启动 runtime event subscriptions，全部成功后才并行执行稳定 runtime list/catalog/current/saved loads；runtime listener 或 current layout 未 ready 时 App 显示阻断 skeleton/error+retry，不挂载可写 WorkspaceGrid，也不允许 start。catalog 成功不能替代 layout/runtime ready。

组合根是唯一跨 store action coordinator。它把 runtime store 的 `catalogInvalidator` 接到 kind-scoped catalog refresh：start 失败或 settled event 只刷新匹配 Conversation/Terminal，validation 失败刷新后保持原状态，spawn/commit failure 刷新出后端 Failed；provider repair、delete 和 project mutation 同样只由这里编排相关目录 refresh，任何 catalog/layout store 都不得 import 另一个 store 或自行发跨目录请求。

delete/project mutation 发出后，组合根立即把 Task 6 `ExclusiveLease` 标为 authority unknown，再以单一 action generation 并行获取 CurrentWorkspace、受影响 Conversation/Terminal catalogs、Project list 和 SavedWorkspace list；四类来源全部成功后按固定顺序替换 stores 并完成 lease。任一来源失败都保存 retained lease 与失败集合，冻结 create/load/delete/provider repair/runtime start/layout action；显式 retry 必须重取全部四类来源并丢弃较旧 generation，不能只补一个失败请求或释放布局 barrier。SavedWorkspace refresh 同样使用 action generation，旧响应不得覆盖更新的 rename/load/delete 或较新 auto-save。组合根还订阅 layout `subscribePersisted`：active source 自动保存成功时触发 SavedWorkspace list generation-safe refresh，使 paneCount/updatedAt 与后端同步。组合根暴露幂等 `dispose()` 清理所有 unlisten、subscription、timer 和迟到 action token；App unmount/壳切换测试断言只清理一次。App 仅在 runtime=Ready 且 `workspaceV2Enabled=true` 后加载该组合根并渲染 `ReadySidebar + WorkspaceGrid`。

Ready App 必须订阅 v2 layout `persistError`，在 WorkspaceGrid 上方显示脱敏持久错误和“重试保存”；点击只调用同一串行 persist pump，成功后清除 banner，失败保留 dirty/banner。exclusive barrier 期间按钮按当前操作禁用；barrier因 action失败释放后仍可重试，quit barrier 未取消时不可重试普通保存。Phase A compat layoutStore 的 banner 不能代替此订阅。

`workspaceV2Enabled` 默认保持 false。Ready 首次读取 flag 后冻结本进程 `activeShellMode: "v2" | "compat"`；渲染、store 创建/dispose、hotkeys 和 quit flush 全程只看该值，不再读取后来持久化的 flag。compat mode 使用 Phase A 可写 Sidebar/PaneGrid；LegacyReadOnly 使用相同 legacy 组件但写禁用；Recovering/Blocked 由 migration gate 独占。SettingsDialog 增加“新版菜单与工作区（实验）”开关，只调用 Task 1/3 的 `workspaceV2ModeGet/Set(boolean)`，不能提交完整 FeatureFlags 或改变 `nativeAiEnabled`；成功后提示重启，当前进程不热切换。测试覆盖两种启动模式及运行中反向 toggle 后退出，不能用 migration runtime 状态替代功能开关。

退出时先同步设置 `isQuitting=true` 并冻结所有新 create/load/delete/runtime/exclusive producer；若已有 SavedWorkspace/delete 等 active `runExclusive` action，必须 `await layout.waitForExclusiveIdle()` 让其后端 mutation、authoritative current replace 和全部权威 refresh 完整收敛，不能在 operation Promise/permit 释放前抢先 prepare，也不能只等待后端 command 而漏掉前端 CAS 更新。v2 在 exclusive idle 后立即同步 `layout.beginQuitBarrier()` 并取消 drag/resize，随后可写 Ready 壳统一 `await settingsStore.flushPersist()`；settings 失败时 QuitGate 仍为 Running，先取消 v2 barrier再恢复 producers。LegacyReadOnly 的 settings/layout flush 都是本地 no-op。settings 成功后调用 `appPrepareQuit()` 取得 token，`activeShellMode=v2` 使用 v2 `flushPersist({ quitToken })`，compat 可写 Ready 使用 Phase A compatibility flush。持久化 flag 的新值只影响下次启动。顺序固定为 `freeze producers → wait active runExclusive idle → begin v2 layout quit barrier → settings flush → prepare → layout flush → appQuit`，其中 `settings flush → prepare → layout flush` 不得交换。prepare 后失败先调用 backend cancel，只有 cancel 成功后才 `layout.cancelQuitBarrier()` 并恢复动作；prepare 前失败不调用 backend cancel，但必须取消本地 v2 barrier，若本地 barrier 取消/producer 恢复失败则继续保持冻结并显示错误。`useHotkeys` 与 dispose 同样按 frozen activeShellMode 分路：v2 的 Ctrl+1..9 选择排序后的 Project，compat 壳使用旧 workspace adapter；输入框内不截获 pane 移动以外的无关按键。

- [ ] **Step 6: 运行前端全量回归、简化并提交**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: PASS；Ready/Legacy 不同时加载或写入彼此的 store，退出失败不会丢失 dirty workspace。

使用 `@code-simplifier` 审查 App runtime 分支、Ready store 加载和 SavedWorkspace action token；若修改，重跑本步骤。

```bash
git add src/components/Sidebar/SavedWorkspaceSection.tsx src/components/Sidebar/SavedWorkspaceSection.test.tsx src/components/Sidebar/ReadySidebar.tsx src/components/dialogs/WorkspaceNameDialog.tsx src/components/dialogs/WorkspaceNameDialog.test.tsx src/components/dialogs/SettingsDialog.tsx src/components/dialogs/SettingsDialog.test.tsx src/App.tsx src/App.test.tsx src/hooks/useHotkeys.ts src/store/readyStores.ts src/store/readyStores.test.ts src/store/settingsStore.ts src/store/uiStore.ts src/styles/main.css src/styles/sidebar.css src/styles/dialogs.css
git commit -m "feat: 接入已保存工作区与新版应用壳"
```

### Task 11: 通过 Chunk 2 跨层回归

**Files:**
- Verify only: all files changed in Tasks 6-10

- [ ] **Step 1: 运行前端完整门禁**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部成功；Ready 菜单没有重复“对话”组，混排 Tab、缺失占位、SavedWorkspace CAS 和退出 token 测试通过。

- [ ] **Step 2: 运行 Rust 完整门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；start claim、QuitGate、WorkspaceService 与 legacy lifecycle 无回归。

- [ ] **Step 3: 静态核对稳定引用和兼容隔离**

Run: `rg -n "ptySessionId|runtimePtySessionId|apiKey|secretRef|quitToken" src/store/workspaceLayoutStore.ts src/components/Workspace src/components/Sidebar/ReadySidebar.tsx src/api/v2 src-tauri/src/domain/workspace.rs`

Expected: 布局/domain 文件没有 PTY/secret；`quitToken` 只出现在退出调用边界；WorkPane 仅从 runtime attachment 读取 PTY ID。

- [ ] **Step 4: 核对 Chunk 大小和提交范围**

Run: `$planPath = 'docs/superpowers/plans/2026-07-10-panel-redesign-phase-b-menu-workspace.md'; $lines = @(Get-Content -LiteralPath $planPath); $starts = @(for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^## Chunk ') { $i } }); $sizes = @(for ($i = 0; $i -lt $starts.Count; $i++) { $end = if ($i + 1 -lt $starts.Count) { $starts[$i + 1] } else { $lines.Count }; [pscustomobject]@{ Chunk = $lines[$starts[$i]]; Lines = $end - $starts[$i] } }); $sizes | Format-Table -AutoSize; if (@($sizes | Where-Object { $_.Lines -gt 1000 }).Count -ne 0) { throw 'Phase B plan chunk exceeds 1000 lines' }`

Expected: 三个 Chunk 均不超过 1000 行；命令打印每个 Chunk 的实际行数，超限立即失败。

Run: `git diff --check && git status --short`

Expected: 无空白错误或意外生成文件；主工作区用户已有改动未进入实现 worktree。

## Chunk 3: 窗口载荷换位、键盘替代与 Phase B 验收

### Task 12: 实现纯函数载荷交换与方向目标选择

**Files:**
- Create: `src/store/paneTree.ts`
- Create: `src/store/paneTree.test.ts`
- Create: `src/components/Workspace/paneGeometry.ts`
- Create: `src/components/Workspace/paneGeometry.test.ts`
- Modify: `src/store/workspaceLayoutStore.ts`
- Modify: `src/store/workspaceLayoutStore.test.ts`

- [ ] **Step 1: 写失败测试固定 swapPanePayload**

覆盖同父、跨父、空窗口、多 Tab、same UUID 跨 kind active ref、锁定窗口和同源 no-op。测试在交换前后提取 split/leaf `id`、父子关系、direction 和 ratio，断言逐项相同；只允许两个 leaf 的 `items/activeItem/projectId/locked` 互换。`activeItem` 作为完整 WorkItemRef 随载荷移动，锁定状态随载荷移动且不阻止交换，target 成为 active pane。

- [ ] **Step 2: 写失败测试固定方向候选算法**

`findDirectionalTarget(sourceId, direction, rects)` 只考虑目标中心位于指定半平面的 pane，先按垂直于移动方向的边缘投影重叠长度降序，再按中心距离升序，最后按 paneId 字典序稳定破同分；无候选返回 null。覆盖嵌套布局、零重叠、等距、缺失 rect 和自身过滤。

- [ ] **Step 3: 运行纯函数测试并确认失败**

Run: `npm run test -- src/store/paneTree.test.ts src/components/Workspace/paneGeometry.test.ts src/store/workspaceLayoutStore.test.ts`

Expected: FAIL，交换和几何选择尚不存在。

- [ ] **Step 4: 实现纯函数并接入 layout action**

`swapPanePayload` 不读取 DOM、不生成 ID、不重建 split。layout store 的 `swapPanes(sourceId, targetId)` 在有效不同 pane 时一次 set tree/activePaneId、标 dirty，并立即启动 persist pump 而不等 300ms；同源/缺失 pane 返回 no-op 且不保存。保存失败保留本地交换与 dirty error，允许重试。

- [ ] **Step 5: 运行测试、简化并提交**

Run: `npm run test -- src/store/paneTree.test.ts src/components/Workspace/paneGeometry.test.ts src/store/workspaceLayoutStore.test.ts && npm run typecheck`

Expected: PASS；任何场景的 ratio、位置 ID 和树拓扑均不改变。

使用 `@code-simplifier` 审查双 leaf 更新和方向排序；若修改，重跑本步骤。

```bash
git add src/store/paneTree.ts src/store/paneTree.test.ts src/store/workspaceLayoutStore.ts src/store/workspaceLayoutStore.test.ts src/components/Workspace/paneGeometry.ts src/components/Workspace/paneGeometry.test.ts
git commit -m "feat: 实现窗口载荷换位算法"
```

### Task 13: 增加 Pointer 拖动、投放高亮和键盘替代

**Files:**
- Create: `src/components/Workspace/PaneSwapController.tsx`
- Create: `src/components/Workspace/PaneSwapController.test.tsx`
- Create: `src/components/Workspace/usePaneSwapDrag.ts`
- Create: `src/components/Workspace/usePaneSwapDrag.test.tsx`
- Modify: `src/components/Workspace/WorkspaceGrid.tsx`
- Modify: `src/components/Workspace/WorkspaceGrid.test.tsx`
- Modify: `src/components/Workspace/WorkPane.tsx`
- Modify: `src/components/Workspace/WorkPane.test.tsx`
- Modify: `src/components/ui/ContextMenu.tsx`
- Modify: `src/hooks/useHotkeys.ts`
- Modify: `src/hooks/useHotkeys.test.ts`
- Modify: `src/styles/main.css`

- [ ] **Step 1: 写失败 Pointer Events 测试**

新增：

- `paneDrag_starts_only_from_dedicated_handle`
- `paneDrag_start_sets_pointer_capture_on_dedicated_handle`
- `paneDrag_pointer_over_valid_drop_zone_highlights_target`
- `paneDrag_tab_button_splitter_and_workspace_blank_are_invalid`
- `paneDrag_topmost_blocker_prevents_falling_through_to_underlying_drop_zone`
- `paneDrag_same_source_is_noop`
- `paneDrag_escape_cancels_without_save`
- `paneDrag_escape_blur_and_pointercancel_release_capture`
- `paneDrag_lostpointercapture_clears_state_without_swap`
- `paneDrag_pointer_up_outside_cancels`
- `paneDrag_exclusive_or_quit_barrier_cancels_and_late_pointerup_is_noop`
- `paneDrag_valid_drop_swaps_once_and_releases_capture`
- `paneDrag_unmount_cleans_global_listeners_and_capture`
- `workspaceGrid_mount_layout_effect_measures_all_leaf_rects_before_direction_action`
- `workspaceGrid_position_only_change_with_same_size_remeasures_all_leaf_rects`
- `workspaceGrid_root_resize_scroll_and_layout_change_coalesce_full_rect_remeasure`
- `workspaceGrid_unmount_unregisters_rect_and_disconnects_observer`
- `workspaceGrid_stale_resize_observer_callback_after_unmount_is_ignored`

测试 mock `elementsFromPoint`/pointer capture，不依赖 jsdom 实际布局；drop target 必须显式带 pane ID，不能用最近 DOM 祖先猜测分隔条或空白。命中列表的最上层元素若是 Tab、按钮、splitter 或显式 blocker，必须立即判无效，不能跳过 blocker 继续选择下面的 pane drop-zone。

- [ ] **Step 2: 写失败键盘和右键测试**

活动 pane 支持 `Alt+Shift+ArrowLeft/Right/Up/Down`；input、textarea、contenteditable 和 xterm textarea 中不截获。右键菜单提供四个“向…移动”项，无方向候选时 disabled。独立拖动把手是可聚焦 button，`aria-label` 说明“移动整个窗口（包含全部标签页）”。

- [ ] **Step 3: 运行交互测试并确认失败**

Run: `npm run test -- src/components/Workspace/PaneSwapController.test.tsx src/components/Workspace/usePaneSwapDrag.test.tsx src/components/Workspace/WorkspaceGrid.test.tsx src/components/Workspace/WorkPane.test.tsx src/hooks/useHotkeys.test.ts`

Expected: FAIL，拖动 controller 和 pane 快捷键尚不存在。

- [ ] **Step 4: 实现单一拖动 controller**

`PaneSwapController` 管理唯一 drag state：source、hoverTarget、pointerId 和当前 handle；pane 只注册 drop-zone element/rect。只有专用 handle 的 primary-button pointerdown 可以启动，成功登记 state 后立即对该 handle 调 `setPointerCapture(pointerId)`；capture 失败则取消启动且零布局修改。pointer move 通过 `elementsFromPoint` 检查从最上层开始的命中：首个显式 blocker（Tab、任意按钮、splitter、workspace blank 或标记 blocker）立即取消 target，不能穿透；只有首个未被 blocker 遮挡的显式 drop-zone 才合法。pointer up 仅对不同合法 target 调用一次 `swapPanes`。Escape、pointercancel、窗口 blur、拖出工作区后释放都必须先在 `hasPointerCapture(pointerId)` 为真时对当前 handle 调 `releasePointerCapture(pointerId)`，再清空高亮；lostpointercapture 只做幂等清理，不改变 tree。controller 同时订阅 layout `exclusiveReason/authorityReload/conflictReload/quitBarrier`；任一 barrier 出现立即 release capture/清空高亮，之后迟到 pointerup 必须 no-op，不能在 flush 后新增 dirty generation。

禁止同时使用 HTML5 drag state 和 Pointer Events；Tab、关闭、锁定、分屏按钮调用 stopPropagation 仍不能启动拖动。换位期间只渲染 CSS 高亮，不把 hover 写入持久化 store。

- [ ] **Step 5: 实现方向移动入口**

Grid 在 mount 后用 `useLayoutEffect` 同步测量全部已注册 leaf，首次方向操作前不得只依赖尚未触发的 observer。每个 leaf 与 workspace root 各有 `ResizeObserver`；任一 leaf/root resize、split/close/ratio/onLayout/tree 变化、workspace 滚动或 window resize 都通过同一个 `requestAnimationFrame` 调度器重测全部 leaf，而不是只更新尺寸改变的 pane，从而覆盖“位置平移但自身宽高不变”。scroll listener 使用 capture 或绑定实际滚动容器，dispose 时一并移除；连续事件同一 frame 只测一次。

registry entry 绑定 paneId 和 mount generation，迟到 layout effect、rAF 或 observer callback 只有 generation 仍匹配时才能更新。leaf close/unmount 时必须先使 generation 失效、从 rect registry 删除 paneId，再 disconnect 对应 observer；root unmount 取消待执行 rAF、断开 root/leaf observers并移除 resize/scroll listener，方向算法永远不读取 stale pane。快捷键和右键共用 `findDirectionalTarget` 与同一 `swapPanes` action。没有目标时不 preventDefault、不持久化；有目标时 target 成为 active 并立即保存。

- [ ] **Step 6: 运行交互、无障碍、简化并提交**

Run: `npm run test -- src/components/Workspace src/hooks/useHotkeys.test.ts && npm run typecheck && npm run build`

Expected: PASS；无残留 window listener、同一次 pointerup 只交换一次，键盘与右键结果一致。

使用 `@code-simplifier` 审查事件清理、target 判定和快捷键重复；若修改，重跑本步骤。

```bash
git add src/components/Workspace/PaneSwapController.tsx src/components/Workspace/PaneSwapController.test.tsx src/components/Workspace/usePaneSwapDrag.ts src/components/Workspace/usePaneSwapDrag.test.tsx src/components/Workspace/WorkspaceGrid.tsx src/components/Workspace/WorkspaceGrid.test.tsx src/components/Workspace/WorkPane.tsx src/components/Workspace/WorkPane.test.tsx src/components/ui/ContextMenu.tsx src/hooks/useHotkeys.ts src/hooks/useHotkeys.test.ts src/styles/main.css
git commit -m "feat: 增加窗口拖动与键盘换位"
```

### Task 14: 完成 Phase B 自动化与手工验收

**Files:**
- Create: `docs/verification/phase-b-menu-workspace.md`
- Verify only: all Phase B files

- [ ] **Step 1: 创建脱敏验收记录**

记录环境、commit、命令、PASS/FAIL、截图文件名和已知边界；不写 API key、完整用户路径、终端内容或真实对话。文档必须逐项覆盖项目→会话菜单、SavedWorkspace create/load/auto-save/new-blank、混排 Tab、缺失引用、拖动/键盘换位、退出 flush 和 LegacyReadOnly 回退。

- [ ] **Step 2: 运行前端完整门禁**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部成功，且没有 skipped/focused test。

- [ ] **Step 3: 运行 Rust 完整门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；QuitGate、workspace transaction、runtime binding 和 legacy launch 回归通过。

- [ ] **Step 4: 运行静态安全检查**

Run: `rg -n "apiKey|ANTHROPIC_API_KEY|OPENAI_API_KEY|runtimePtySessionId|ptySessionId" src/api/v2 src/store/workspaceLayoutStore.ts src/components/Sidebar/ReadySidebar.tsx src-tauri/src/domain src-tauri/src/storage`

Expected: v2 持久化 DTO、布局和 storage JSON 无密钥正文或 PTY ID；允许的运行态命中逐项记录原因。

Run: `$phaseABase = git log --grep='^test: 记录 Phase A 验收证据$' -n 1 --format='%H'; if (-not $phaseABase) { throw 'Phase A base commit not found' }; git diff --exit-code "$phaseABase..HEAD" -- src-tauri/tauri.conf.json src-tauri/capabilities`

Expected: Phase B 不修改 CSP 或 capabilities，也不扩大 Tauri 权限；当前 `csp:null` 是 Phase D 原生消息启用前的明确阻断项，不能在 Phase B 宣称已加固。

- [ ] **Step 5: 手工验证 Ready 工作流**

Run: `$env:THT_PANEL_SMOKE = '1'; $targetRoot = (Resolve-Path 'src-tauri\target').Path; $targetPrefix = $targetRoot.TrimEnd('\', '/') + '\'; $phaseBSmoke = [IO.Path]::GetFullPath((Join-Path $targetRoot ('phase-b-smoke-ready-' + [guid]::NewGuid()))); $phaseBProject = [IO.Path]::GetFullPath((Join-Path $targetRoot ('phase-b-smoke-project-' + [guid]::NewGuid()))); foreach ($path in @($phaseBSmoke, $phaseBProject)) { if (-not $path.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "smoke path escaped src-tauri/target" }; if (Test-Path -LiteralPath $path) { throw "smoke path already exists" } }; New-Item -ItemType Directory -Path $phaseBProject | Out-Null; $env:THT_PANEL_CONFIG_DIR = $phaseBSmoke; npm run tauri -- dev`

Expected: `$THT_PANEL_CONFIG_DIR` 是本次唯一、尚不存在且 canonical 位于 `src-tauri/target/` 下的隔离配置根；Project fixture 使用另一个同样位于 target 下的空目录，两者都不是仓库根、HOME、真实应用配置或彼此的子目录。首次 fresh 启动仍是 Ready+compat 壳；在 Settings 中启用“新版菜单与工作区（实验）”，正常退出。smoke 标志不得暗中覆盖持久化 feature flag。随后在同一 PowerShell 和同一配置根运行：

Run: `npm run tauri -- dev`

Expected:

1. 第二次启动进入 v2 Ready 壳。先在“模型供应商”创建隔离的非生产测试 Codex provider：名称 `Phase B Smoke`、baseUrl `http://127.0.0.1:9/v1`、secret `phase-b-smoke-not-production`、model `phase-b-smoke-model`；不点“连接测试”、不输入任何模型 prompt，也不得读取用户全局认证。新建 Project 时路径只能选择本次 `$phaseBProject` 空目录，并显式选择该 provider/model 为默认，然后创建 AI Conversation 与纯 TerminalSession，菜单直接显示项目子项。不得选择真实仓库、HOME 或用户工作目录。AI legacy spawn 允许因假端点/CLI缺失失败，但稳定 Conversation 与 Tab 必须保留；真实模型输出不属于 Phase B smoke。
2. 在至少三个含嵌套 split 的 pane 中混排 AI/terminal Tab；同 UUID 跨 kind 只引用自动化 fixture，不手工篡改 ID。保存工作区，执行 split/close 后确认 active SavedWorkspace 的 paneCount 自动刷新；再选择“新建临时空白工作区”，确认 source 变 null、旧 SavedWorkspace 未删除且重新加载可恢复原布局。测试 Ready persist error/banner 只引用自动化故障注入证据。
3. 停止运行后，active Project 的 AI 显示只读历史与恢复入口；deleted/missing Project 的 AI 只读且无恢复按钮；terminal 显示重新打开。正常删除实体时其布局引用及 activeItem 被修复且其余布局不受影响。缺失实体占位只引用 `workPane_loaded_not_found_keeps_tab_and_offers_remove_reference` 及后端保留缺失引用的自动化 fixture 证据，不通过手工破坏 JSON 制造。
4. 拖动同父/跨父/空 pane，及键盘四方向移动，窗口载荷交换但 split ratio/位置不变；同一 live terminal 换位后仍持续输出，旧 detach 不拆新 sink。
5. 正常退出时确认 quit barrier 先冻结交互、最新布局 flush 后进程结束；保存失败、tree-ack/outcome、listener 注册失败和 QuitGate cancel 分支只以 fake repository/process host 的自动化测试证据验收，手工烟测不得通过改权限、破坏 JSON 或杀真实进程来制造故障。正常退出第二次实例后，在同一 shell/配置根运行：

Run: `npm run tauri -- dev`

Expected: 第三次启动仍进入 v2 Ready 壳；Project/provider/Conversation/TerminalSession 与保存工作区均存在，加载后混排顺序、完整 `activeItem` kind、active pane、locked、project context 和 split ratio 保持。确认后正常退出。

- [ ] **Step 6: 验证兼容回退**

先关闭上一烟测实例，再运行：

Run: `$targetRoot = (Resolve-Path 'src-tauri\target').Path; $targetPrefix = $targetRoot.TrimEnd('\', '/') + '\'; $legacySmoke = [IO.Path]::GetFullPath((Join-Path $targetRoot ('phase-b-smoke-legacy-' + [guid]::NewGuid()))); if (-not $legacySmoke.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'legacy smoke path escaped src-tauri/target' }; if (Test-Path -LiteralPath $legacySmoke) { throw 'legacy smoke path already exists' }; Copy-Item -Recurse -LiteralPath 'src-tauri\tests\fixtures\migration\v1' -Destination $legacySmoke; $env:THT_PANEL_SMOKE = '1'; $env:THT_PANEL_CONFIG_DIR = $legacySmoke; npm run tauri -- dev`

Expected: 取消迁移后显式进入 LegacyReadOnly，旧只读 Sidebar/PaneGrid 可显示且写操作被禁用；Ready 与 Legacy 不混用 stores。配置根是本次新建、canonical 位于 `src-tauri/target/` 的唯一隔离目录，不得使用或嵌套真实应用配置、HOME、仓库根或 Ready smoke 配置根。

- [ ] **Step 7: 恢复 smoke 环境变量**

Run: `Remove-Item Env:THT_PANEL_CONFIG_DIR -ErrorAction SilentlyContinue; Remove-Item Env:THT_PANEL_SMOKE -ErrorAction SilentlyContinue`

Expected: 当前 shell 不再设置调试配置目录或 smoke 标志；不得删除 config/project smoke 文件夹，保留作证据直到用户明确批准清理。

- [ ] **Step 8: 代码简化终审并提交验收记录**

使用 `@code-simplifier` 对 Phase B 最近修改代码做最终行为保持审查；若产生修改，先用 `git diff --name-only` 精确列出这些代码文件，重跑 Steps 2-4，只暂存该清单并以 `refactor: 简化 Phase B 工作区实现` 单独提交，确认 worktree 重新干净。不得把简化后的代码遗留到仅文档提交。最后再单独提交验收记录：

```bash
git add docs/verification/phase-b-menu-workspace.md
git commit -m "test: 记录菜单与工作区验收"
```

- [ ] **Step 9: 以 Phase A 验收提交为基线审计全部已提交范围**

Run: `$phaseABase = git log --grep='^test: 记录 Phase A 验收证据$' -n 1 --format='%H'; if (-not $phaseABase) { throw 'Phase A base commit not found' }; git diff --check "$phaseABase..HEAD"; git diff --name-only "$phaseABase..HEAD"; git status --short`

Expected: `git diff --check` 成功；文件清单逐项属于 Tasks 1-14 的 Phase B 实现或 `docs/verification/phase-b-menu-workspace.md`，不含主工作区已有 `package-lock.json`、`AGENTS.md`、`tsconfig.node.tsbuildinfo`、smoke/capture 目录或其他生成物；`git status --short` 为空。不得用通常为空的 `git diff --cached --name-only` 代替已提交范围审计。
