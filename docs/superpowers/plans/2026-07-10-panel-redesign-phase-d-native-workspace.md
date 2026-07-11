# Panel Redesign Phase D Native Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持纯终端与显式 legacy 终端兼容模式可回退的前提下，交付安全、可分页、可流式更新的原生 AI 消息工作区，并在迁移、安全和真实 CLI 门禁通过后把 `nativeAiEnabled` 切为默认开启。

**Architecture:** Rust 继续作为会话事件、ContextBridge、运行模式、供应商切换和生命周期的真相来源；React 通过唯一 `BackendClient`、可控事件 Hub 与 generation/cursor-safe store 读取完成事件并消费内存 delta。AI Conversation 由原生消息 Pane 或显式 legacy 终端兼容 Pane 二选一渲染，TerminalSession 始终走 xterm；安全切换由严格 CSP、无 raw HTML Markdown、最小 capability、外链确认、QuitGate 和可回滚 rollout gate 共同约束。

**Tech Stack:** React 19、TypeScript 5.8、Zustand 5、Vitest、Testing Library、`@tanstack/react-virtual`、`react-markdown`、`remark-gfm`、Tauri 2、Rust 2021、serde、Phase A-C 的 ConversationManager/ConversationEventStore/RuntimeActivityRegistry/QuitGate/BackendClient/FakeBackendClient。

---

## Chunk 1: 事件窗口、ContextBridge 与单运行模式真相

### Phase D 硬边界与跨阶段不变量

- Phase D 只能在 Phase A-C 的自动化与必需真实 CLI 门禁完成后实施；不得用 Phase D UI 掩盖 Phase C 未通过的协议、fixture、Job containment 或事件 append 失败。
- `Conversation.id`、`RuntimeSegment.id`、`ProviderProfile.id`、`ProviderRevision.id`、`ModelProfile.id` 和 `WorkItemRef` 继续使用稳定 typed ID；前端不得以 `modelName`、PTY ID、原生 thread/session ID 或数组下标作为会话、消息、供应商或 Tab 身份。
- `WorkPane.activeItem` 继续是完整 kind-scoped `WorkItemRef | null`；本阶段不得重新引入裸 UUID 活动项、重复 Tab 身份或运行时 PID/PTTY ID 持久化。
- Phase C 的 `AssistantDelta` 继续只存在内存/Tauri Channel；Phase D 只分页读取完成事件，绝不把 delta、虚拟列表测量值、滚动位置或 Composer 草稿写入 `conversation-events/*.jsonl`。
- Phase D 不得重定义 Phase C 容量/编码边界：runtime 协议 JSONL 继续使用独立 `MAX_PROTOCOL_JSONL_FRAME_BYTES=1 MiB`，事件 JSONL 继续使用 `MAX_EVENT_JSONL_LINE_BYTES=2 MiB`、单 Conversation `64 MiB` 和同一个 `ConversationEventCapacityLedger`；查询、ContextBridge 与供应商切换不得复制 writer、计数器或把协议 frame 上限误用于事件行。
- 原生 AI Pane 与 legacy AI xterm Pane 对同一 Conversation 严格二选一；TerminalSession 始终由 `TerminalPane` 渲染。任何错误或能力不足都不得静默从原生模式降级到 PowerShell/PTY，用户只能通过显式“终端兼容模式”操作切换。
- ContextBridge 的唯一来源是 Panel 完成事件或 LegacyHistoryImporter 已明确导入的事件；不读取用户全局 Claude/Codex history，不调用模型生成隐藏摘要，不把密钥、环境变量值、敏感工具输出或未完成 delta带入目标供应商。
- 供应商切换、执行模式切换、rollout/rollback、退出和删除继续复用 Phase A-C 的单一 `ApplicationMutationGate`、per-conversation lane、`RuntimeActivityRegistry` 与 `QuitGate`；不得新建第二套全局 mutex、活动计数或退出状态机。
- 所有 adapter 输出继续只经过应用级唯一 `RuntimeOutputRelay`，闭合为 `RuntimeAdapterOutput::{Event, Control}`；`SharedServiceRecoveryRequired` 只进 ConversationManager 内部 coordinator，绝不进入 Tauri/WebView。持久 `eventId` 继续排除 server generation；前端提交审批后不得合成 `ApprovalResolved`，只有 Phase C 在客户端 response 后收到相同 RPC ID 的 `serverRequest/resolved` 才能持久化该事件。
- Phase D 只移除已被 v2/native 路径完全替代的旧 DTO、旧 mutation command 和旧配置写入口；legacy terminal compatibility、PTY attach/write/resize/kill、LegacyReadOnly 读取和迁移恢复必须保留。最终孤儿事件/密钥/runtime 目录 GC 与安装包审计属于 Phase E，不在本计划执行。
- 任何文件删除都必须在执行到对应步骤时再次列出精确文件、说明零引用证据并取得用户明确批准；本计划本身不构成未来删除授权。

### 文件职责图

- `src-tauri/src/application/conversation_query_service.rs`：只读完成事件窗口、容量摘要和不透明 cursor；不启动 runtime。
- `src/api/nativeEventHub.ts`：生产环境只注册一次 `onNativeRuntimeEvent`，按稳定 Conversation ID 分发并负责引用计数/unlisten。
- `src/store/nativeConversationStore.ts`：generation/cursor-safe 分页、eventId/sequence 去重、delta 内存态和 gap catch-up。
- `src-tauri/src/application/context_bridge.rs`：确定性、可见、脱敏且有界的桥接预览；不写 repository、不产生模型请求。
- `src-tauri/src/storage/conversation_switch_transaction.rs`：协调 ContextBridge event、ProviderSwitched event、Conversation selection 与 prepared segment；事件字节仍由 Phase C `conversation_event_append` staging+journal writer提交，不自建第二套 append。
- `src-tauri/src/application/conversation_execution_transition.rs`：供应商切换与执行模式切换共用的 per-conversation transition claim；只分配单一切换所有权，不复制lane或runtime状态机。
- `src-tauri/src/application/conversation_execution_mode_service.rs`：`inherit/native/legacyTerminal` 持久模式和 native/PTY 互斥门禁。

### Task 1: 建立完成事件窗口与 BackendClient/Tauri/Fake 订阅边界

**Files:**
- Create: `src-tauri/src/application/conversation_query_service.rs`
- Create: `src-tauri/src/commands/conversation_event_cmds.rs`
- Create: `src-tauri/tests/conversation_query.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/storage/conversation_event_append.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/v2/types.test.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/events.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Create: `src/api/nativeEventHub.ts`
- Create: `src/api/nativeEventHub.test.ts`
- Create: `src/api/conversationEventsClient.test.ts`

- [ ] **Step 1: 写失败 Rust 测试固定不透明 cursor、完成事件和容量边界**

新增：

- `conversation_query_open_returns_tail_completed_events_in_sequence_order`
- `conversation_query_window_never_returns_assistant_delta`
- `conversation_query_older_cursor_is_bound_to_conversation_epoch_and_upper_sequence`
- `conversation_query_live_cursor_advances_without_replaying_completed_event`
- `conversation_query_cursor_from_other_conversation_is_rejected_before_file_read`
- `conversation_query_cursor_from_previous_store_epoch_is_stale_not_guessed`
- `conversation_query_rejects_noncanonical_conversation_id_and_forged_cursor`
- `conversation_query_page_limit_is_one_to_two_hundred`
- `conversation_query_page_payload_is_bounded_to_four_mib_and_can_return_one_two_mib_assistant_event`
- `conversation_query_reports_used_max_remaining_and_near_full_capacity`
- `conversation_query_snapshot_reads_window_cursor_and_capacity_from_one_committed_ledger_epoch`
- `conversation_query_concurrent_runtime_append_returns_complete_pre_or_post_commit_snapshot`
- `conversation_query_concurrent_import_never_reads_stage_checkpoint_or_uncommitted_bytes`
- `conversation_query_concurrent_context_switch_never_mixes_old_window_with_new_capacity_snapshot`
- `conversation_query_capacity_splits_committed_and_reserved_without_counting_stage_or_journal`
- `conversation_query_active_turn_reservation_reduces_effective_remaining_without_changing_window`
- `conversation_query_reservation_release_or_commit_updates_capacity_monotonically`
- `conversation_query_deleted_project_conversation_remains_readable_by_conversation_id`
- `conversation_query_missing_conversation_never_exposes_orphan_event_file`
- `conversation_query_debug_error_and_cursor_contain_no_path_prompt_secret_or_raw_event`

cursor 必须由后端生成并绑定 `{ conversationId, storeEpoch, direction, upperSequenceExclusive }`；公开类型只把它作为最大 512 字节的 opaque string，前端不得解码、拼接或以 cursor 作为 React key。`open` 返回尾页、`olderCursor` 和用于 gap catch-up 的 `liveCursor`；`readCursor` 只接受后端签发值。单页compact public payload上限固定4 MiB，保证Phase C合法2 MiB Assistant事件可单独返回；达到上限时在事件边界截断页数，绝不截断事件正文。

- [ ] **Step 2: 运行查询测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test conversation_query`

Expected: FAIL，`ConversationQueryService`、cursor codec 和 commands 尚不存在；不得是 `0 tests`。

- [ ] **Step 3: 实现只读事件窗口服务和薄 Tauri commands**

公开 DTO 固定为：

```rust
pub struct ConversationEventWindow {
    pub conversation_id: ConversationId,
    pub events: Vec<ConversationCompletedEventPublic>,
    pub older_cursor: Option<ConversationEventCursor>,
    pub live_cursor: ConversationEventCursor,
    pub first_sequence: Option<u64>,
    pub last_sequence: Option<u64>,
    pub capacity: ConversationEventCapacity,
}

pub struct ConversationEventCapacity {
    pub committed_bytes: u64,
    pub reserved_bytes: u64,
    pub max_bytes: u64,
    pub effective_remaining_bytes: u64,
    pub state: EventCapacityState, // Ok | NearLimit | Full
}
```

`storeEpoch` 是 `ConversationEventStore` 本次 Ready 构建时生成的随机进程内 ID，不写 JSON；应用重启后旧 cursor 固定返回 `CURSOR_STALE`。cursor 本身是随机 canonical UUID，只作为 `ConversationQueryService` 有界 registry 的 key；registry value 保存conversation/storeEpoch/committedEpoch/direction/upperSequence并设置10分钟TTL和1024项上限。未知、过期或伪造token在读取任何event文件前失败；每次read返回下一批新token，前端不能构造状态。

`open/read`必须通过Phase C同一`ConversationEventCapacityLedger`与per-conversation event writer取得一个原子`CapacitySnapshot { ledgerEpoch, committedEpoch, committedBytes, reservedBytes, lastCommittedSequence }`。其中`reservedBytes`是该Conversation全部active turn reservations的精确和；exclusive import lease单独阻止新reservation，import/switch的预计算或`.stage`字节在正式commit前既不算committed也不伪装成可用空间。窗口在writer guard保护下只读取`[0, committedBytes)`的完整event lines；公开capacity逐项返回`committedBytes`、`reservedBytes`、`maxBytes`和`effectiveRemainingBytes=maxBytes-committedBytes-reservedBytes`，`NearLimit/Full`按`committed+reserved`判定。固定锁序为`capacity ledger/event writer → 文件range read → release writer → cursor registry insert`，绝不持cursor registry锁反向等待writer。

runtime append、LegacyHistoryImporter和ContextBridge switch继续经同一writer串行，因此每次响应的window/cursor/capacity只能来自同一ledger epoch：不能返回旧events配新committed bytes、漏掉active reservation而虚增effective remaining、读到prefix stage，或直接以磁盘当前length越过ledger。reservation创建只增加`reservedBytes`并保持committed窗口不变；release把reserved单调归零，commit则在同一ledger临界区把精确staged bytes从reserved转入committed，任何观察者只能看到转换前或转换后完整状态。

`open(conversationId, limit)` 从该committed snapshot最后完整事件向前读取；`read(cursor, limit)`先验证cursor绑定的store/committed epoch，再在新的committed snapshot中返回older或live catch-up窗口。只投影 Phase C 可持久化完成事件，未知/损坏事件仍走既有Blocked策略，不能跳过后伪装完整历史。

注册 `conversation_event_window_open` 与 `conversation_event_window_read`。两者只在 Ready 可用、只读、不取得 mutation permit、不 probe CLI、不读取 SecretStore；command 只解析 ID/limit/cursor 后委托 service。

- [ ] **Step 4: 写失败 TypeScript 契约和事件 Hub 测试**

新增：

- `conversationEventWindow_cursor_is_opaque_and_not_used_as_event_identity`
- `backendClient_open_and_read_event_window_match_tauri_and_fake`
- `tauriBackendClient_forwards_cursor_without_decoding_or_relabeling`
- `fakeBackendClient_supports_window_deferred_error_and_capacity`
- `nativeEventHub_registers_exactly_one_backend_listener`
- `nativeEventHub_dispatches_only_matching_conversation`
- `nativeEventHub_refcounts_multiple_panes_for_same_conversation`
- `nativeEventHub_last_unsubscribe_calls_backend_unlisten_once`
- `nativeEventHub_partial_listener_failure_leaves_no_subscription`
- `nativeEventHub_dispose_before_late_listen_resolution_immediately_unlistens`
- `nativeEventHub_old_generation_callback_cannot_reach_new_subscriber`
- `nativeEventHub_terminal_events_are_not_dropped_or_reordered_by_dispatch`
- `nativeEventHub_public_union_cannot_represent_runtime_control_output`

- [ ] **Step 5: 运行客户端测试并确认失败**

Run: `npm run test -- src/api/v2/types.test.ts src/api/conversationEventsClient.test.ts src/api/nativeEventHub.test.ts`

Expected: FAIL，新窗口 DTO/client 方法和 `nativeEventHub` 尚不存在；三个文件都必须被 Vitest 收集。

- [ ] **Step 6: 扩展 BackendClient、Tauri 和 Fake 并实现单订阅 Hub**

`BackendClient` 增加：

```ts
conversationEventWindowOpen(conversationId: string, limit: number): Promise<ConversationEventWindow>;
conversationEventWindowRead(cursor: string, limit: number): Promise<ConversationEventWindow>;
```

沿用 Phase C 的：

```ts
onNativeRuntimeEvent(callback: (event: NativeRuntimeEvent) => void): Promise<() => void>;
```

`TauriBackendClient` 只转发 camelCase 参数；`FakeBackendClient` 保存调用、deferred、error 和窗口结果，不复制 cursor/parser/store 逻辑。`createNativeEventHub(client)` 在首个订阅者出现时注册一次 Phase C listener，以 `conversationId` Map 分发；每个订阅记录本地 generation token，最后一个订阅释放时调用唯一 unlisten。listener 建立失败时全部等待者收到同一脱敏错误且无残留回调。公开 `NativeRuntimeEvent` 只能是 `RuntimeAdapterOutput::Event` 的脱敏投影；`Control` 分支在 Rust relay/coordinator 内消费，TypeScript union、Fake emitter和Tauri Channel都不能构造 `SharedServiceRecoveryRequired`。

- [ ] **Step 7: 运行跨层测试并做代码简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_query && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/api/v2/types.test.ts src/api/conversationEventsClient.test.ts src/api/nativeEventHub.test.ts && npm run typecheck`

Expected: PASS；cursor不能跨Conversation/Ready epoch使用，并发reservation/append/import/switch下window/cursor/committed/reserved/effectiveRemaining来自同一ledger epoch且不虚增容量；BackendClient/Tauri/Fake/Hub契约一致，测试无未处理Promise。

使用 `@code-simplifier` 审查 cursor codec、完成事件投影和 Hub 引用计数；若产生修改，重跑本步骤。

- [ ] **Step 8: 提交事件窗口边界**

```bash
git add src-tauri/src/application/conversation_query_service.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/storage/conversation_event_append.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/src/commands/conversation_event_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/conversation_query.rs src/api/v2/types.ts src/api/v2/types.test.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/events.ts src/api/nativeEventHub.ts src/api/nativeEventHub.test.ts src/api/conversationEventsClient.test.ts src/test/FakeBackendClient.ts
git commit -m "feat(native-ui): 增加会话事件窗口边界"
```

### Task 2: 实现 generation/cursor-safe 原生 Conversation store

**Files:**
- Create: `src/store/nativeConversationStore.ts`
- Create: `src/store/nativeConversationStore.test.ts`
- Modify: `src/store/readyStores.ts`
- Test: `src/store/readyStores.test.ts`

- [ ] **Step 1: 写失败测试固定初始化、分页和 stale response 规则**

新增：

- `nativeConversation_open_applies_only_latest_conversation_generation`
- `nativeConversation_open_subscribes_before_window_and_catches_events_during_load`
- `nativeConversation_initial_window_is_sorted_and_deduplicated_by_event_id_sequence`
- `nativeConversation_load_older_uses_server_cursor_and_preserves_existing_order`
- `nativeConversation_stale_older_response_after_reload_is_ignored`
- `nativeConversation_cursor_stale_reopens_without_replaying_local_guess`
- `nativeConversation_gap_uses_live_cursor_until_sequences_are_contiguous`
- `nativeConversation_gap_reload_failure_freezes_send_and_exposes_retry`
- `nativeConversation_duplicate_completed_event_is_idempotent`
- `nativeConversation_same_event_id_with_different_content_fails_closed`
- `nativeConversation_dispose_unsubscribes_and_invalidates_late_window`
- `nativeConversation_readyStores_owns_one_event_hub_without_store_import_cycle`

测试顺序固定为：先建立 Hub subscription并捕获 event generation，再请求初始窗口；窗口返回后若订阅期间收到比 `lastSequence` 更新的完成事件，则通过 `liveCursor` 补齐，不能丢事件或把到达顺序当持久 sequence。

- [ ] **Step 2: 运行窗口状态测试并确认失败**

Run: `npm run test -- src/store/nativeConversationStore.test.ts src/store/readyStores.test.ts`

Expected: FAIL，store 尚不存在，`readyStores` 仍未创建 Native event hub。

- [ ] **Step 3: 实现稳定完成事件和 cursor 状态**

导出 `createNativeConversationStore(client, eventHub)`，每个 Conversation lane 至少保存：

```ts
interface NativeConversationViewState {
  conversationId: string;
  generation: number;
  loadState: "notLoaded" | "loading" | "loaded" | "error";
  completedByEventId: Map<string, PersistedConversationEvent>;
  orderedEventIds: string[];
  olderCursor: string | null;
  liveCursor: string | null;
  firstSequence: number | null;
  lastSequence: number | null;
  capacity: ConversationEventCapacity | null;
  gapState: "clear" | "catchingUp" | "blocked";
}
```

所有异步 action 捕获 `{conversationId,generation}`；响应不匹配时只结束自己的 Promise，不改当前 state。完成事件以 `(eventId, sequence)` 双重校验：完全相同幂等，ID/sequence 与内容冲突进入 blocked并重新 open，禁止保留“最后到达者”。cursor 只保存在对应 lane 内，切换/重开 Conversation 后旧 cursor 立即作废。

- [ ] **Step 4: 写失败测试固定内存 delta、完成替换和容量释放**

新增：

- `nativeConversation_delta_is_keyed_by_segment_turn_message_and_sequence`
- `nativeConversation_delta_duplicate_sequence_is_idempotent`
- `nativeConversation_delta_gap_waits_for_next_or_terminal_catchup`
- `nativeConversation_completion_replaces_delta_with_authoritative_content`
- `nativeConversation_terminal_error_discards_partial_delta_without_fake_completion`
- `nativeConversation_old_segment_generation_delta_cannot_touch_new_turn`
- `nativeConversation_delta_over_two_mib_drops_buffer_and_waits_for_backend_terminal_error`
- `nativeConversation_turn_memory_over_eight_mib_releases_all_buffers`
- `nativeConversation_dispose_releases_delta_arrays_and_drafts_from_store_state`
- `nativeConversation_capacity_near_limit_warns_and_full_disables_send`

- [ ] **Step 5: 运行 delta 测试并确认失败**

Run: `npm run test -- src/store/nativeConversationStore.test.ts -t "delta|capacity|completion|terminal"`

Expected: FAIL，store 尚未维护 Phase C ephemeral delta 或容量状态；不得是 `0 tests`。

- [ ] **Step 6: 实现有界 delta lane 与有效视图 selector**

delta 使用 chunk array，不在每个 token 上反复拼接整串；key 固定为 `segmentId:turnId:messageId`，并验证单调 `deltaSequence`。单消息达到 Phase C `2 MiB` 或单 turn达到 `8 MiB` 时立即释放对应 chunk引用、设置“等待后端终态”错误，不在前端自行构造 RuntimeError/AssistantMessageCompleted；后端 terminal event到达后清空 lane。完成消息到达时只渲染 authoritative completed content并删除 delta。store 暴露 `selectRenderableTimeline(conversationId)`，把完成事件与当前唯一 ephemeral assistant row按 sequence/turn边界合并，但不把合并结果写回持久 state。

容量 `Full` 时 Composer send gate固定关闭并提供“新建会话”入口；`NearLimit` 只警告，不自动删除/归档。自动归档与 GC 属于 Phase E。

- [ ] **Step 7: 运行 store 全量测试、简化并提交**

Run: `npm run test -- src/store/nativeConversationStore.test.ts src/store/readyStores.test.ts && npm run typecheck`

Expected: PASS；stale窗口/事件不能污染当前 lane，delta从不进入完成事件 Map，容量满不发送。

使用 `@code-simplifier` 审查 generation guard、cursor action 和 delta chunk map；若修改，重跑本步骤。

```bash
git add src/store/nativeConversationStore.ts src/store/nativeConversationStore.test.ts src/store/readyStores.ts src/store/readyStores.test.ts
git commit -m "feat(native-ui): 增加原生会话状态"
```

### Task 3: 实现确定性 ContextBridge 预览与跨供应商事务

**Files:**
- Create: `src-tauri/src/application/context_bridge.rs`
- Create: `src-tauri/src/application/conversation_execution_transition.rs`
- Create: `src-tauri/src/application/conversation_switch_service.rs`
- Create: `src-tauri/src/storage/conversation_switch_transaction.rs`
- Create: `src-tauri/src/commands/conversation_switch_cmds.rs`
- Create: `src-tauri/tests/context_bridge.rs`
- Create: `src-tauri/tests/conversation_switch_transaction.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src-tauri/src/application/conversation_catalog_service.rs`
- Modify: `src-tauri/src/domain/conversation.rs`
- Modify: `src-tauri/src/domain/conversation_event.rs`
- Modify: `src-tauri/src/runtime/limits.rs`
- Modify: `src-tauri/src/storage/conversation_event_append.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/error.rs`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/nativeRuntimeClient.test.ts`
- Modify: `src/test/FakeBackendClient.ts`

- [ ] **Step 1: 写失败测试固定确定性、可见来源和脱敏规则**

新增：

- `context_bridge_uses_only_panel_or_explicitly_imported_completed_events`
- `context_bridge_prefers_visible_summary_then_recent_completed_rounds`
- `context_bridge_without_summary_is_byte_deterministic`
- `context_bridge_never_calls_runtime_adapter_process_or_model`
- `context_bridge_excludes_ephemeral_delta_pending_approval_and_unknown_raw_payload`
- `context_bridge_redacts_secret_environment_and_sensitive_tool_output_before_hash`
- `context_bridge_truncated_tool_output_keeps_visible_marker_and_original_count_only`
- `context_bridge_preview_lists_source_target_event_range_and_omitted_count`
- `context_bridge_preview_content_exactly_matches_commit_payload`
- `context_bridge_limit_reuses_two_hundred_events_and_two_hundred_fifty_six_kib`
- `context_bridge_over_limit_offers_limited_manual_or_new_conversation_without_auto_choice`
- `context_bridge_manual_text_is_visible_bounded_and_never_treated_as_model_summary`
- `context_bridge_debug_error_and_preview_token_hide_content_path_secret_and_revision_config`

- [ ] **Step 2: 运行 ContextBridge 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test context_bridge`

Expected: FAIL，bridge builder/preview token 尚不存在；不得是 `0 tests`。

- [ ] **Step 3: 实现纯 ContextBridge builder 和签名预览 token**

复用 Phase C 的 `MAX_CONTEXT_EVENTS=200` 与 `MAX_CONTEXT_BYTES=256 KiB`，不得复制不同 magic number。builder 输入为已提交、已脱敏的 domain events和可选 `summaryEventId`，输出公开 `ContextBridgePreview`：

```rust
pub struct ContextBridgePreview {
    pub preview_token: ContextBridgePreviewToken,
    pub source_provider_id: ProviderId,
    pub target_provider_id: ProviderId,
    pub target_model_id: ModelId,
    pub included_event_ids: Vec<EventId>,
    pub included_bytes: u64,
    pub omitted_event_count: u64,
    pub limited_content: String,
    pub can_continue_limited: bool,
    pub can_use_manual: bool,
    pub can_create_new_conversation: bool,
}
```

`limitedContent` 必须完整展示给用户，commit发送的桥接文本逐字等于用户确认的 limited/manual内容；不得另附隐藏 system prompt。token 用进程内 MAC 绑定 Conversation.updatedAt、当前 provider/model、最后 eventId/sequence、目标 provider currentRevisionId/model snapshot、redaction version和 content hash。preview 不读取 SecretStore、不创建 segment、不改 Conversation、不启动 adapter。

- [ ] **Step 4: 写失败测试固定切换预检和事务恢复矩阵**

新增：

- `conversation_switch_rejects_running_waiting_approval_cancelling_start_claim_and_pending_outcome`
- `conversation_switch_requires_enabled_target_and_provider_scoped_model_id`
- `conversation_switch_same_pair_is_noop_without_event_or_segment`
- `conversation_switch_preview_stales_when_event_conversation_or_revision_changes`
- `conversation_switch_limited_manual_and_new_conversation_are_explicit_distinct_actions`
- `conversation_switch_commit_creates_prepared_segment_with_frozen_target_revision_model_and_cwd`
- `conversation_switch_commit_keeps_conversation_id_and_preserves_old_segments_as_terminal_history`
- `conversation_switch_commit_persists_visible_context_bridge_and_provider_switched_events`
- `conversation_switch_commit_sets_bridge_event_id_on_prepared_segment`
- `conversation_switch_send_starts_prepared_segment_with_exact_visible_bridge_content`
- `conversation_switch_crash_matrix_converges_event_conversation_and_segment_atomically`
- `conversation_switch_commit_reuses_execution_transition_claim_and_blocks_mode_switch_or_send`
- `conversation_switch_idle_native_shutdown_waits_callback_outcome_and_target_tree_before_selection_commit`
- `conversation_switch_legacy_kill_waits_tree_empty_settling_and_outcome_before_selection_commit`
- `conversation_switch_shared_codex_detaches_only_source_binding_and_keeps_peer_running`
- `conversation_switch_shutdown_failure_keeps_old_selection_and_publishes_no_new_sink_or_event`
- `conversation_switch_crash_retry_never_publishes_old_and_new_runtime_sinks_together`
- `conversation_switch_reuses_capacity_ledger_and_runtime_append_stage_journal_writer`
- `conversation_switch_active_turn_reservation_or_import_lease_rejects_before_stage`
- `conversation_switch_batch_counts_committed_reservations_and_bytes_against_sixty_four_mib`
- `conversation_switch_never_uses_one_mib_protocol_limit_for_two_mib_event_line`
- `conversation_switch_unknown_event_or_repository_hash_fails_closed_without_mutation`
- `conversation_switch_recovery_waits_for_runtime_append_and_import_recovery_before_manager_ready`
- `conversation_switch_same_model_name_different_provider_never_reuses_revision_namespace_or_native_identity`

- [ ] **Step 5: 运行事务测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test conversation_switch_transaction`

Expected: FAIL，prepared segment、switch journal和 recovery尚不存在。

- [ ] **Step 6: 实现 per-conversation 切换服务和崩溃可恢复事务**

在 `RuntimeSegmentState` 增加 `Prepared`，含义为“目标 selection/context 已冻结但尚无 process/binding/model request”。新增共享`ConversationExecutionTransitionRegistry`；provider switch commit与Task 4 mode switch必须取得同一Conversation的单一transition claim，claim覆盖runtime关闭、事务提交和结果发布，阻止并发send/start/第二种切换。`ConversationSwitchService::commit`固定取得ordinary Quit permit、per-conversation lane和transition claim，在短mutation section重验preview token、selection generation、active turn/approval/cancel/start claim及当前runtime handle；Running/WaitingApproval/Cancelling继续拒绝，Idle但仍有native binding或live legacy compatibility PTY则进入主动关闭，不能把“idle”当成已detach。

释放mutation/manager/PTY/repository锁后，native source必须调用`RuntimeAdapter::shutdown(binding, deadline)`：Claude/独占Job确认target process tree-empty；共享Codex只detach source Conversation binding并等待其pending callback/lifecycle permit/outcome收敛，存在同revision peer时不得关闭共享server或影响peer，最后一个binding才按adapter规则确认Job tree-empty。legacy source必须取得PtyManager唯一KillClaim，终止对应兼容PTY并确认整棵tree-empty，再等待binding detached、settling清除和RuntimeOutcomeStore drain。任一shutdown/kill/tree ack/callback/outcome失败都保持旧selection，不创建event stage/switch journal/prepared segment，也不发布新renderer sink。

runtime完全收敛后，commit以同一transition claim重新进入短mutation section，重验preview token、selection/runtime generation和“source无live handle”，再按Phase C锁序取得同一Conversation的`ConversationEventCapacityLedger`/writer；存在任一active turn reservation或exclusive import lease时，在创建`.stage`、switch journal或新selection前返回`RETRY_LATER`。两个完成事件先做compact serialization与事件行上限校验，再按`committed bytes + 全部 reservations + 本批精确 staging bytes <= 64 MiB`校验；这里使用事件`2 MiB` line limit和非助手事件子上限，绝不复用协议`1 MiB` frame limit。

跨 repository 事务只扩展 Phase C writer的窄 prepared-batch协调接口：事件字节写入 `conversation-events/<conversationId>.runtime-append-<transactionId>.stage`并sync，`conversation-switch-journal.json`只引用该受守卫 basename、staging length/hash、event IDs、旧/新 Conversation/segment hash与stage；随后仍由 `conversation_event_append` 安装自己的 append journal、重验 stage并append+sync事件文件，再安装 ConversationsFile/prepared segment，最后按阶段清理两个journal与stage。switch journal不保存bridge正文、自由路径或secret；正文只存在已脱敏event stage/正式事件文件。任何 crash point都由同一 writer验证 event file old/full/prefix状态，不允许switch事务直接append、整文件replace或绕过ledger吃掉已计费turn reservation。

恢复只接受old/new/known partial状态；unknown hash保持全部字节不变并让Ready Blocked。Bootstrap必须先按Phase C收敛runtime event append；若同Conversation仍有LegacyHistoryImporter journal/exclusive import lease，则先由既有importer recovery收敛并释放lease，switch recovery不得竞争。两者干净后才恢复switch journal，且必须早于ConversationManager构造、`RuntimeOutputRelay`绑定和Ready发布。重启时Job kill-on-close保证旧runtime不存活；恢复/重试必须验证source binding为空和旧outcome已收敛，才完成或回滚selection事务，任何阶段都不能同时发布旧/新sink。Phase C其余恢复顺序不变。

commit零模型请求；下一次`ConversationManager::send`看到active prepared segment时，用其frozen target revision/model/cwd和`bridgeEventId`构造adapter start context，成功后才进入Starting/Running。旧segments、provider revision和既有events作为不可改写的历史记录保留，但source segment必须已由权威shutdown outcome终结为Stopped/Interrupted且无live binding/process；不得把“保留历史”实现成旧runtime继续存活。

`strategy="newConversation"` 不执行switch transaction：前端改用现有 `conversationCreate` 创建新稳定Conversation，并明确无上下文。`strategy="manual"` 的文本作为用户可见 `ContextBridgePrepared` event保存，受相同 256 KiB 上限，不伪装成模型summary。

- [ ] **Step 7: 扩展 BackendClient/Tauri/Fake**

新增：

```ts
conversationProviderSwitchPreview(input: ConversationProviderSwitchPreviewInput): Promise<ContextBridgePreview>;
conversationProviderSwitchCommit(input: ConversationProviderSwitchCommitInput): Promise<ConversationProviderSwitchResult>;
```

commit input只含稳定Conversation/provider/model ID、previewToken和`limited|manual`策略；不接受driver、revision、modelName、runtime namespace、native session ID或hidden context。Fake记录token/strategy并支持stale/deferred/error，不复制builder。

- [ ] **Step 8: 运行桥接/manager/bootstrap回归和简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test context_bridge && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_switch_transaction && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/api/nativeRuntimeClient.test.ts && npm run typecheck`

Expected: PASS；preview/commit一致、无隐形模型调用，任一崩溃点恢复后selection/segment/events全部旧或全部新。

使用 `@code-simplifier` 审查bridge选择、token验证和switch事务阶段；若修改，重跑本步骤。

- [ ] **Step 9: 提交 ContextBridge 与切换事务**

```bash
git add src-tauri/src/application/context_bridge.rs src-tauri/src/application/conversation_execution_transition.rs src-tauri/src/application/conversation_switch_service.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/application/conversation_catalog_service.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/domain/conversation.rs src-tauri/src/domain/conversation_event.rs src-tauri/src/runtime/limits.rs src-tauri/src/storage/conversation_switch_transaction.rs src-tauri/src/storage/conversation_event_append.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/src/storage/mod.rs src-tauri/src/storage/repositories.rs src-tauri/src/commands/conversation_switch_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/error.rs src-tauri/tests/context_bridge.rs src-tauri/tests/conversation_switch_transaction.rs src/api/v2/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/nativeRuntimeClient.test.ts src/test/FakeBackendClient.ts
git commit -m "feat(native-ui): 增加上下文桥接供应商切换"
```

### Task 4: 建立 Conversation 执行模式与 native/legacy 单 sink 门禁

**Files:**
- Create: `src-tauri/src/application/conversation_execution_mode_service.rs`
- Create: `src-tauri/src/commands/conversation_execution_mode_cmds.rs`
- Create: `src-tauri/tests/conversation_execution_mode.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/conversation_execution_transition.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src-tauri/src/application/work_item_runtime_service.rs`
- Modify: `src-tauri/src/application/legacy_entity_deletion_guard.rs`
- Modify: `src-tauri/src/domain/conversation.rs`
- Modify: `src-tauri/src/storage/schema.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/workspaceClient.test.ts`
- Modify: `src/test/FakeBackendClient.ts`

- [ ] **Step 1: 写失败测试固定 `inherit/native/legacyTerminal` 解析**

新增：

- `conversation_execution_mode_defaults_to_inherit_without_second_migration_schema`
- `conversation_execution_mode_inherit_resolves_native_only_when_global_flag_true`
- `conversation_execution_mode_explicit_legacy_overrides_native_default`
- `conversation_execution_mode_explicit_native_is_blocked_when_global_flag_false`
- `conversation_execution_mode_terminal_session_is_always_terminal_and_has_no_mode`
- `conversation_execution_mode_public_summary_contains_effective_and_preference_not_revision_or_pty`
- `conversation_execution_mode_unknown_value_fails_repository_open`
- `conversation_execution_mode_compat_and_other_writers_preserve_preference`

- [ ] **Step 2: 写失败测试固定切换互斥和路由拒绝**

新增：

- `conversation_mode_switch_rejects_native_running_waiting_approval_cancelling_and_pending_callback`
- `conversation_mode_switch_to_legacy_actively_shuts_idle_native_binding_before_persist`
- `conversation_mode_switch_to_native_requires_legacy_pty_tree_empty_and_outcome_settled`
- `conversation_mode_native_to_legacy_calls_adapter_shutdown_and_waits_callback_and_outcome_drain`
- `conversation_mode_shared_codex_native_to_legacy_detaches_only_target_binding_peer_and_job_continue`
- `conversation_mode_shared_codex_last_binding_shutdown_may_close_server_after_tree_empty`
- `conversation_mode_legacy_to_native_claims_pty_kill_and_waits_tree_empty_before_outcome_drain`
- `conversation_mode_shutdown_or_tree_ack_failure_keeps_old_preference_and_renderer_generation`
- `conversation_mode_switch_start_claim_settling_or_pending_outcome_is_retry_later`
- `conversation_mode_switch_keeps_events_segments_and_conversation_id`
- `native_send_rejects_effective_legacy_before_secret_process_or_event_write`
- `legacy_work_item_runtime_start_rejects_effective_native_before_pty_spawn`
- `conversation_mode_race_can_publish_only_native_binding_or_legacy_attachment_not_both`
- `conversation_mode_unsupported_native_never_auto_changes_to_legacy`
- `conversation_mode_quiescing_rejects_change_without_partial_write`

- [ ] **Step 3: 运行模式测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test conversation_execution_mode`

Expected: FAIL，执行模式字段、service和route guard尚不存在。

- [ ] **Step 4: 实现持久偏好、effective resolver 和 `_locked` mutation**

领域枚举固定为：

```rust
pub enum ConversationExecutionModePreference {
    Inherit,
    Native,
    LegacyTerminal,
}
```

effective规则：全局 `nativeAiEnabled=false` 时 `Inherit` 为legacy且显式Native返回`NATIVE_AI_DISABLED`；全局true时`Inherit|Native`为native，显式LegacyTerminal为legacy。`ConversationSummary`返回`executionModePreference`和`effectiveExecutionMode`，不返回runtime binding。

service公开wrapper只取得一次ordinary Quit permit、per-conversation lane与mode-transition claim；短 mutation section重验目标偏好、effective模式、start/settling/pending outcome并冻结当前renderer generation，随后释放mutation/runtime锁再执行外部关闭。native处于Running/WaitingApproval/Cancelling或仍有prepared start/pending callback时继续拒绝切换；只有Idle但仍保留binding的native会进入主动shutdown。原生→legacy只要仍有binding就必须调用Phase C `RuntimeAdapter::shutdown(binding, deadline)`；等待该binding的relay callback/lifecycle permit归零、ConversationManager移除binding并把RuntimeOutcomeStore应用/清空。共享Codex只能detach目标Conversation binding：同revision仍有peer Conversation时，peer turn/binding继续运行且shared server/Job保持开放；只有目标是最后一个binding时，adapter才允许按既有idle/shutdown规则关闭server并确认tree-empty。legacy兼容PTY即使仍存活也可在用户显式确认后进入终止流程：legacy→native必须取得PtyManager唯一KillClaim，主动终止该Conversation兼容PTY并确认整棵Job tree-empty，再等待binding detached、settling清除和RuntimeOutcomeStore drain；不得把“当前看起来无输出”当作已关闭。

关闭成功后重新进入短 mutation section，以同一transition claim重验Conversation generation、当前偏好和零runtime handle，才持久化新 preference并返回新`ConversationSummary`；任何adapter shutdown、tree-empty ack、callback/outcome drain或最终保存失败都不写新偏好，前端保持旧renderer generation并显示可重试错误。整个外部shutdown/kill/wait过程不持ApplicationMutationGate mutex、manager map lock、PTY lock或repository lock；transition claim持续阻止并发send/start/第二次mode switch。

在`ConversationManager::send`入口和`WorkItemRuntimeService::start`入口分别重算effective模式并失败封闭，防止UI竞态绕过。两条路都以同一Conversation lane/generation登记所有权；任何时刻最多一种runtime handle可发布。前端只能在`conversationExecutionModeSet`成功返回新summary后更换renderer，不能在点击确认时先卸载当前sink。

- [ ] **Step 5: 扩展 client/Fake 并运行跨层测试**

`BackendClient`增加：

```ts
conversationExecutionModeSet(
  conversationId: string,
  preference: "inherit" | "native" | "legacyTerminal",
): Promise<ConversationSummary>;
```

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_execution_mode && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/api/workspaceClient.test.ts && npm run typecheck`

Expected: PASS；native/legacy路由互斥；共享Codex切换只detach目标binding，peer与shared server/Job继续运行，最后一个binding才允许关闭；TerminalSession路径完全不受Conversation模式影响。

- [ ] **Step 6: 代码简化审查并提交**

使用 `@code-simplifier` 审查effective resolver、inflight preflight复用和command锁序；若修改，重跑Step 5。

```bash
git add src-tauri/src/application/conversation_execution_mode_service.rs src-tauri/src/application/conversation_execution_transition.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/application/work_item_runtime_service.rs src-tauri/src/application/legacy_entity_deletion_guard.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/domain/conversation.rs src-tauri/src/storage/schema.rs src-tauri/src/storage/repositories.rs src-tauri/src/commands/conversation_execution_mode_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/conversation_execution_mode.rs src/api/v2/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/workspaceClient.test.ts src/test/FakeBackendClient.ts
git commit -m "feat(native-ui): 增加会话执行模式门禁"
```

### Task 5: 通过 Chunk 1 跨层门禁

**Files:**
- Verify only: all files changed in Tasks 1-4

- [ ] **Step 1: 运行前端事件/store/client门禁**

Run: `npm run test -- src/api/v2/types.test.ts src/api/conversationEventsClient.test.ts src/api/nativeEventHub.test.ts src/api/nativeRuntimeClient.test.ts src/api/workspaceClient.test.ts src/store/nativeConversationStore.test.ts src/store/readyStores.test.ts && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部PASS；无stale cursor污染、无listener泄漏、无delta持久化或未处理Promise。

- [ ] **Step 2: 运行 Rust 查询/桥接/模式/恢复门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_query && cargo test --manifest-path src-tauri/Cargo.toml --test context_bridge && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_switch_transaction && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_execution_mode && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部PASS；preview零模型请求，switch crash matrix幂等，Ready前所有switch journal收敛。

- [ ] **Step 3: 静态核对稳定身份和敏感边界**

Run: `rg -n "modelName.*key|ptySessionId|runtimePtySessionId|externalSessionId|secretRef|apiKey|AssistantDelta" src/store/nativeConversationStore.ts src/api/nativeEventHub.ts src/api/v2 src-tauri/src/application/context_bridge.rs src-tauri/src/application/conversation_switch_service.rs`

Expected: `modelName`不用于key/归属；PTY/native session/secret不进入Conversation store或公开switch DTO；`AssistantDelta`只在ephemeral分支命中。

- [ ] **Step 4: 核对Chunk行数并执行计划评审**

Run: `$p='docs/superpowers/plans/2026-07-10-panel-redesign-phase-d-native-workspace.md'; $lines=Get-Content -LiteralPath $p; $starts=@(for($i=0;$i -lt $lines.Count;$i++){if($lines[$i] -match '^## Chunk '){$i}}); $end=if($starts.Count -gt 1){$starts[1]}else{$lines.Count}; if(($end-$starts[0]) -gt 1000){throw 'Phase D Chunk 1 exceeds 1000 lines'}`

Expected: Chunk 1不超过1000行。

使用plan-document-reviewer按设计规格第8.3、12-17节和Phase A-C计划复核Chunk 1；Issues Found必须修复并重新评审，Approved后才能进入Chunk 2。

## Chunk 2: 原生消息界面、交互与 WebView 安全

### Task 6: 渲染虚拟化消息流、工具状态和容量提示

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/components/Conversation/NativeConversationPane.tsx`
- Create: `src/components/Conversation/NativeConversationPane.test.tsx`
- Create: `src/components/Conversation/ConversationHeader.tsx`
- Create: `src/components/Conversation/MessageList.tsx`
- Create: `src/components/Conversation/MessageList.test.tsx`
- Create: `src/components/Conversation/MessageRow.tsx`
- Create: `src/components/Conversation/ToolCard.tsx`
- Create: `src/components/Conversation/CapacityBanner.tsx`
- Create: `src/components/Conversation/messageViewModel.ts`
- Create: `src/components/Conversation/messageViewModel.test.ts`
- Create: `src/styles/conversation.css`
- Modify: `src/main.tsx`
- Modify: `src/store/nativeConversationStore.ts`
- Modify: `src/store/nativeConversationStore.test.ts`

- [ ] **Step 1: 写失败 view-model 测试固定统一事件到可见行的投影**

新增：

- `messageView_user_and_assistant_rows_keep_persisted_event_id_keys`
- `messageView_ephemeral_assistant_row_uses_segment_turn_message_identity`
- `messageView_provider_switched_and_context_bridge_are_visible_system_rows`
- `messageView_tool_started_output_completed_group_by_tool_identity`
- `messageView_unknown_safe_summary_is_labeled_not_rendered_as_model_text`
- `messageView_runtime_error_never_includes_raw_payload_path_or_secret`
- `messageView_same_model_name_providers_are_labeled_by_provider_id_and_display_name`
- `messageView_completion_removes_matching_ephemeral_row_without_duplicate`
- `messageView_order_uses_persisted_sequence_not_timestamp_or_arrival_order`

- [ ] **Step 2: 运行 view-model 测试并确认失败**

Run: `npm run test -- src/components/Conversation/messageViewModel.test.ts`

Expected: FAIL，消息投影尚不存在；不得是 `0 tests`。

- [ ] **Step 3: 实现纯 message view-model**

只把 domain event union映射为闭合行类型：`user | assistant | assistantStreaming | tool | approval | providerSwitch | status | usage | error | legacyBlock`。持久行key固定为`eventId`；ephemeral行key固定为`ephemeral:<segmentId>:<turnId>:<messageId>`。provider label从ProviderStore按稳定providerId查询；modelName只显示，不参与归属、分组或React key。

ToolOutput的`truncated/originalByteCount`必须可见；默认折叠超过8 KiB的输出，展开只展示后端已持久化的bounded文本，不请求raw payload。`LegacyTranscriptBlock`明确标为“旧记录，结构可能不完整”，不能伪造成用户/助手对话。

- [ ] **Step 4: 写失败虚拟化、锚点和容量组件测试**

新增：

- `messageList_initial_load_starts_at_tail_without_rendering_all_rows`
- `messageList_virtualizes_to_visible_rows_plus_small_overscan`
- `messageList_load_older_preserves_first_visible_event_anchor`
- `messageList_older_failure_keeps_scroll_and_retry_action`
- `messageList_new_completion_auto_scrolls_only_when_user_is_near_bottom`
- `messageList_streaming_delta_updates_one_virtual_row_without_reordering_history`
- `messageList_gap_blocked_disables_composer_and_shows_retry`
- `messageList_near_limit_shows_warning_without_auto_delete`
- `messageList_full_capacity_disables_send_and_offers_new_conversation`
- `messageList_tool_output_is_collapsed_and_truncation_is_visible`
- `messageList_two_mib_assistant_message_does_not_eagerly_markdown_parse_full_content`
- `messageList_unmount_cancels_measurement_and_ignores_late_resize_callback`
- `nativeConversationPane_loading_error_and_empty_states_are_distinct`

- [ ] **Step 5: 运行组件测试并确认失败**

Run: `npm run test -- src/components/Conversation/MessageList.test.tsx src/components/Conversation/NativeConversationPane.test.tsx`

Expected: FAIL，组件与virtualizer依赖尚不存在；两个文件都必须被收集。

- [ ] **Step 6: 添加 virtualizer 依赖并实现消息 Pane**

Run: `npm install @tanstack/react-virtual@^3.13.12`

Expected: `package.json`和`package-lock.json`只增加该生产依赖及其传递项。

`MessageList`使用`useVirtualizer`，row key来自Task 6 Step 3；overscan固定6。加载older前记录首个可见持久eventId及其offset，权威窗口应用并重新measure后恢复同一event锚点。只有距离底部≤80px时，新delta/completion自动跟随；用户向上阅读时显示“回到底部”按钮，不抢滚动。Assistant正文超过256 KiB时先渲染64 KiB安全预览和字节数，用户显式展开后才交给SafeMarkdown；不得在虚拟row首次mount时同步解析整条2 MiB正文。

`NativeConversationPane`负责load/retry/header/list/capacity/composer slot组合，不自己调用BackendClient或解析event。`CapacityBanner`在NearLimit显示used/max与“新建会话”，Full同时禁用send；不提供自动删除/压缩按钮。

- [ ] **Step 7: 运行组件、类型和构建测试**

Run: `npm run test -- src/components/Conversation/messageViewModel.test.ts src/components/Conversation/MessageList.test.tsx src/components/Conversation/NativeConversationPane.test.tsx src/store/nativeConversationStore.test.ts && npm run typecheck && npm run build`

Expected: PASS；大量历史只挂载可见行，分页后锚点不跳，full容量零send调用。

- [ ] **Step 8: 代码简化审查并提交**

使用 `@code-simplifier` 审查event投影、virtualizer测量和scroll分支；若修改，重跑Step 7。

```bash
git add package.json package-lock.json src/components/Conversation/NativeConversationPane.tsx src/components/Conversation/NativeConversationPane.test.tsx src/components/Conversation/ConversationHeader.tsx src/components/Conversation/MessageList.tsx src/components/Conversation/MessageList.test.tsx src/components/Conversation/MessageRow.tsx src/components/Conversation/ToolCard.tsx src/components/Conversation/CapacityBanner.tsx src/components/Conversation/messageViewModel.ts src/components/Conversation/messageViewModel.test.ts src/styles/conversation.css src/main.tsx src/store/nativeConversationStore.ts src/store/nativeConversationStore.test.ts
git commit -m "feat(native-ui): 渲染虚拟化原生消息流"
```

### Task 7: 实现 Composer、取消与能力门控审批卡片

**Files:**
- Create: `src/components/Conversation/NativeComposer.tsx`
- Create: `src/components/Conversation/NativeComposer.test.tsx`
- Create: `src/components/Conversation/ApprovalCard.tsx`
- Create: `src/components/Conversation/ApprovalCard.test.tsx`
- Create: `src/components/Conversation/ConversationStatusBar.tsx`
- Modify: `src/components/Conversation/NativeConversationPane.tsx`
- Modify: `src/components/Conversation/NativeConversationPane.test.tsx`
- Modify: `src/components/Conversation/MessageRow.tsx`
- Modify: `src/components/Conversation/ToolCard.tsx`
- Modify: `src/store/nativeConversationStore.ts`
- Modify: `src/store/nativeConversationStore.test.ts`
- Modify: `src/store/readyStores.ts`
- Modify: `src/App.tsx`
- Test: `src/App.test.tsx`

- [ ] **Step 1: 写失败 Composer 键盘、IME 和发送状态测试**

新增：

- `nativeComposer_plain_enter_sends_once_and_prevents_newline`
- `nativeComposer_shift_enter_inserts_newline_without_send`
- `nativeComposer_enter_during_composition_does_not_send`
- `nativeComposer_compositionend_followed_by_enter_sends_once`
- `nativeComposer_ctrl_alt_or_meta_enter_is_not_plain_send`
- `nativeComposer_whitespace_only_is_disabled`
- `nativeComposer_success_clears_only_the_submitted_draft_generation`
- `nativeComposer_send_failure_keeps_draft_and_shows_redacted_error`
- `nativeComposer_new_typing_during_inflight_is_not_cleared_by_old_success`
- `nativeComposer_running_turn_replaces_send_with_stop`
- `nativeComposer_capacity_gap_quit_or_mode_barrier_disables_send`
- `nativeComposer_isQuitting_blocks_keyboard_button_and_late_send`

- [ ] **Step 2: 运行 Composer 测试并确认失败**

Run: `npm run test -- src/components/Conversation/NativeComposer.test.tsx`

Expected: FAIL，Composer尚不存在。

- [ ] **Step 3: 实现消费型发送 action 和 IME-safe Composer**

Composer局部保存draft/composition状态，不写Zustand/localStorage/event log。plain Enter的判定同时要求`!shiftKey && !ctrlKey && !altKey && !metaKey && !isComposing && !compositionRef.current`；Shift+Enter保留浏览器换行。send action捕获draftGeneration并调用Phase C `nativeConversationSend(conversationId, text)`；只有同generation成功才清空。错误不回显input/argv/provider URL。

store按Conversation保存当前`NativeTurnReceipt`与action token，重复send/cancel复用或拒绝，不并发发命令。cancel input只从receipt派生conversation/segment/turn IDs，前端不能编辑。`capabilities.cancelTurn=false`时不显示伪Stop成功，显示“当前版本不支持结构化取消”和显式终端兼容入口。

- [ ] **Step 4: 写失败审批卡片和工具状态测试**

新增：

- `approvalCard_renders_only_pending_request_with_exact_capability_true`
- `approvalCard_shows_operation_reason_target_scope_and_risk_flags`
- `approvalCard_offers_only_approve_once_and_deny`
- `approvalCard_destructive_operation_has_no_permanent_allow`
- `approvalCard_double_click_submits_one_decision`
- `approvalCard_submit_never_synthesizes_resolved_before_matching_backend_event`
- `approvalCard_stale_or_resolved_request_is_disabled`
- `approvalCard_failed_decision_refetches_live_events_before_retry`
- `approvalCard_capability_false_renders_safe_rejection_notice_not_fake_buttons`
- `approvalCard_workspace_outside_network_and_elevation_risks_are_explicit`
- `toolCard_resolved_is_not_completed_until_tool_completed_event`
- `toolCard_abandoned_approval_never_looks_denied_by_user`
- `nativeConversation_quit_barrier_disables_pending_approval_actions`

- [ ] **Step 5: 运行审批测试并确认失败**

Run: `npm run test -- src/components/Conversation/ApprovalCard.test.tsx src/components/Conversation/NativeConversationPane.test.tsx`

Expected: FAIL，审批卡片/能力gate尚未实现。

- [ ] **Step 6: 实现能力门控审批与权威终态**

ApprovalCard只消费Phase C持久`ApprovalRequested`和当前`RuntimeCapabilities.approvals===true`；decision固定`approveOnce|deny`。提交调用`nativeConversationResolveApproval`后只记录本地action pending，不写store事件、不乐观合成resolved；只有后端已发送client response并收到相同RPC ID的`serverRequest/resolved`后发布的权威`ApprovalResolved`才能结束pending视觉，工具最终状态继续等待`ToolCompleted`。request已resolved/abandoned、segment/turn generation变化或capability变false时按钮立即失效。

capability false时不构造请求或自动批准；若后端安全拒绝隐藏交互，消息流显示结构化说明和“切换到终端兼容模式”，不显示批准按钮。风险flags按闭合字段渲染：workspace外路径、网络、权限提升、破坏性写入；任何未知风险至少显示“未识别风险，建议拒绝”。

- [ ] **Step 7: 运行Composer/审批/App回归和简化审查**

Run: `npm run test -- src/components/Conversation/NativeComposer.test.tsx src/components/Conversation/ApprovalCard.test.tsx src/components/Conversation/NativeConversationPane.test.tsx src/store/nativeConversationStore.test.ts src/App.test.tsx && npm run typecheck && npm run build`

Expected: PASS；IME不误发、取消/审批无重复、quit后零新native mutation。

使用 `@code-simplifier` 审查draft generation、action token和approval状态投影；若修改，重跑本步骤。

- [ ] **Step 8: 提交 Composer 与审批 UI**

```bash
git add src/components/Conversation/NativeComposer.tsx src/components/Conversation/NativeComposer.test.tsx src/components/Conversation/ApprovalCard.tsx src/components/Conversation/ApprovalCard.test.tsx src/components/Conversation/ConversationStatusBar.tsx src/components/Conversation/NativeConversationPane.tsx src/components/Conversation/NativeConversationPane.test.tsx src/components/Conversation/MessageRow.tsx src/components/Conversation/ToolCard.tsx src/store/nativeConversationStore.ts src/store/nativeConversationStore.test.ts src/store/readyStores.ts src/App.tsx src/App.test.tsx
git commit -m "feat(native-ui): 增加编辑发送取消与审批"
```

### Task 8: 收紧 Markdown、CSP、外链与 Tauri capability

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/components/Conversation/SafeMarkdown.tsx`
- Create: `src/components/Conversation/SafeMarkdown.test.tsx`
- Create: `src/components/Conversation/ExternalLinkDialog.tsx`
- Create: `src/components/Conversation/ExternalLinkDialog.test.tsx`
- Modify: `src/components/Conversation/MessageRow.tsx`
- Create: `src-tauri/src/application/external_link_service.rs`
- Create: `src-tauri/src/commands/external_link_cmds.rs`
- Create: `src-tauri/tests/external_link.rs`
- Create: `src-tauri/tests/webview_security.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/nativeRuntimeClient.test.ts`
- Modify: `src/test/FakeBackendClient.ts`

- [ ] **Step 1: 写失败 Markdown 安全测试**

新增：

- `safeMarkdown_raw_html_is_rendered_as_text_or_removed_never_dom`
- `safeMarkdown_never_imports_or_enables_rehype_raw`
- `safeMarkdown_has_no_dangerouslySetInnerHTML`
- `safeMarkdown_javascript_data_file_and_custom_scheme_links_are_not_clickable`
- `safeMarkdown_http_https_link_is_button_requiring_confirmation`
- `safeMarkdown_remote_image_never_fetches_and_shows_alt_placeholder`
- `safeMarkdown_code_block_is_text_only_and_never_executes`
- `safeMarkdown_long_url_and_control_chars_are_rejected`
- `safeMarkdown_markdown_error_falls_back_to_plain_text`
- `safeMarkdown_secret_like_text_is_not_copied_to_error_or_telemetry`

- [ ] **Step 2: 运行Markdown测试并确认失败**

Run: `npm run test -- src/components/Conversation/SafeMarkdown.test.tsx src/components/Conversation/ExternalLinkDialog.test.tsx`

Expected: FAIL，安全renderer/对话框尚不存在。

- [ ] **Step 3: 移除未使用的前端 notification binding并安装 Markdown 依赖**

Run: `npm uninstall @tauri-apps/plugin-notification`

Expected: 只从`package.json/package-lock.json`移除前端JS binding；`src-tauri/Cargo.toml`中的`tauri-plugin-notification`、`lib.rs`的plugin init和`pty/pump.rs`的`NotificationExt`保持不变。

Run: `npm install react-markdown@^10.1.0 remark-gfm@^4.0.1`

Expected: lockfile只增加这两个直接依赖及传递项；不得安装`rehype-raw`。

`SafeMarkdown`固定`skipHtml`，只允许p/strong/em/del/ul/ol/li/blockquote/code/pre/table/thead/tbody/tr/th/td/hr/br和自定义link/image组件。link不渲染可导航`href`，而是button触发ExternalLinkDialog；image一律显示alt占位，不加载remote/data/blob源。本任务禁止`dangerouslySetInnerHTML`，静态测试/rg命中即失败。

- [ ] **Step 4: 写失败后端外链确认和 capability/CSP 测试**

新增：

- `external_link_preview_accepts_only_http_https_without_credentials_or_control`
- `external_link_preview_normalizes_host_and_returns_no_os_side_effect`
- `external_link_token_is_single_use_short_lived_and_bound_to_url`
- `external_link_open_without_preview_or_with_stale_token_is_zero_side_effect`
- `external_link_open_uses_injected_browser_and_never_shell_command`
- `external_link_error_debug_hides_query_fragment_and_full_url`
- `webview_security_csp_is_non_null_and_has_no_remote_script_or_connect_wildcard`
- `webview_security_csp_forbids_object_frame_form_base_and_inline_script`
- `webview_security_dev_csp_allows_only_local_vite_and_hmr_extra_origins`
- `webview_security_capability_has_only_event_listen_unlisten_and_dialog_open`
- `webview_security_unused_frontend_notification_binding_and_webview_default_permission_are_removed`
- `webview_security_rust_notification_plugin_init_and_pty_pump_usage_are_retained`
- `webview_security_custom_external_link_command_adds_no_opener_or_shell_capability`

- [ ] **Step 5: 运行安全配置测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test external_link && cargo test --manifest-path src-tauri/Cargo.toml --test webview_security`

Expected: FAIL，当前`csp:null`、`core:default`/plugin defaults和外链service不满足门禁。

- [ ] **Step 6: 实现两阶段外链确认、严格 CSP 和最小 capability**

`ExternalLinkService::preview(url)`只接受≤2048 bytes的http/https URL，拒绝userinfo、控制字符和非默认解析歧义，返回`{ token, displayOrigin, displayTarget, insecureHttp }`；`displayTarget`只含规范host与bounded path，query/fragment固定显示为“已隐藏”，避免确认框泄露token。registry只在内存保存完整规范URL，token 60秒过期且单次消费。`open(token)`通过可注入`ExternalBrowser`执行；Windows生产实现使用`ShellExecuteW`直接打开规范URL，不调用cmd/PowerShell，不新增opener/shell plugin权限，非Windows返回稳定Unsupported。

`tauri.conf.json` production CSP固定为：

```text
default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'
```

`devCsp`只额外允许`http://localhost:1420`与`ws://localhost:1420`用于Vite/HMR，仍无remote wildcard、`unsafe-eval`或inline script。若Tauri实际生成的IPC origin不同，先以`npm run tauri -- dev`的CSP错误和生成schema为证据调整到精确本地origin；不得用`*`、`https:`或恢复`csp:null`绕过。

`src-tauri/capabilities/default.json`固定只保留：

```json
[
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "dialog:allow-open"
]
```

移除已经静态确认无`src/`调用的`@tauri-apps/plugin-notification`前端binding，并从WebView capability移除`notification:default`；Rust `tauri-plugin-notification`依赖、`.plugin(tauri_plugin_notification::init())`和`pty/pump.rs`的`NotificationExt`必须保留，因为PTY pump仍从Rust侧发送等待输入提醒。Rust内部调用不为WebView保留整个`:default`权限；若未来新增前端通知调用，必须另开最小`allow-*`权限评审。为`ShellExecuteW`只增加`windows-sys`的`Win32_UI_Shell` feature。

注册`external_link_preview/open`并扩展BackendClient/Tauri/Fake；open只接token，不接受第二次URL或`confirmed:boolean`。

- [ ] **Step 7: 运行安全、前端和Tauri开发门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test external_link && cargo test --manifest-path src-tauri/Cargo.toml --test webview_security && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/components/Conversation/SafeMarkdown.test.tsx src/components/Conversation/ExternalLinkDialog.test.tsx src/api/nativeRuntimeClient.test.ts && npm run typecheck && npm run build`

Expected: PASS；raw HTML/危险scheme不产生可导航DOM，capability没有default/opener/shell权限。

Run: `rg -n 'dangerouslySetInnerHTML|rehype-raw|csp"\s*:\s*null|core:default|dialog:default|notification:default' src src-tauri package.json`

Expected: 生产代码/config零命中；负向测试字符串必须用fixture拼接或限定到测试文件并逐项说明。

Run: `$rustNotificationRefs=@(rg -n "tauri-plugin-notification|tauri_plugin_notification::init|NotificationExt" src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/pty/pump.rs); if($LASTEXITCODE -ne 0 -or $rustNotificationRefs.Count -lt 3){$rustNotificationRefs; throw 'required Rust notification chain is missing'}; $frontendNotificationRefs=@(rg -n "@tauri-apps/plugin-notification" src package.json); if($LASTEXITCODE -notin 0,1){throw 'frontend notification audit failed'}; if($frontendNotificationRefs.Count -gt 0){$frontendNotificationRefs; throw 'unused frontend notification binding remains'}; $rustNotificationRefs`

Expected: 输出分别包含Rust依赖、plugin init与PTY pump使用；前端binding零命中。不得为追求静态扫描零命中删除仍在使用的Rust通知链路。

- [ ] **Step 8: 代码简化审查并提交安全边界**

使用 `@code-simplifier` 审查Markdown component map、URL validator/token registry和capability差异；若修改，重跑Step 7。

```bash
git add package.json package-lock.json src/components/Conversation/SafeMarkdown.tsx src/components/Conversation/SafeMarkdown.test.tsx src/components/Conversation/ExternalLinkDialog.tsx src/components/Conversation/ExternalLinkDialog.test.tsx src/components/Conversation/MessageRow.tsx src-tauri/src/application/external_link_service.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/commands/external_link_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/capabilities/default.json src-tauri/tests/external_link.rs src-tauri/tests/webview_security.rs src/api/v2/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/nativeRuntimeClient.test.ts src/test/FakeBackendClient.ts
git commit -m "feat(security): 收紧消息渲染与WebView权限"
```

### Task 9: 将 Ready WorkPane 分路到 native AI、Terminal 和显式兼容模式

**Files:**
- Create: `src/components/Workspace/ConversationWorkItem.tsx`
- Create: `src/components/Workspace/ConversationWorkItem.test.tsx`
- Create: `src/components/dialogs/ContextBridgeDialog.tsx`
- Create: `src/components/dialogs/ContextBridgeDialog.test.tsx`
- Create: `src/components/dialogs/ConversationExecutionModeDialog.tsx`
- Create: `src/components/dialogs/ConversationExecutionModeDialog.test.tsx`
- Modify: `src/components/Workspace/WorkPane.tsx`
- Modify: `src/components/Workspace/WorkPane.test.tsx`
- Modify: `src/components/Workspace/StoppedConversationPanel.tsx`
- Modify: `src/components/Sidebar/ReadySidebar.tsx`
- Modify: `src/components/Sidebar/ReadySidebar.test.tsx`
- Modify: `src/components/Sidebar/ConversationMenuItem.tsx`
- Modify: `src/components/dialogs/ConversationProviderDialog.tsx`
- Modify: `src/components/dialogs/ConversationProviderDialog.test.tsx`
- Modify: `src/store/readyStores.ts`
- Modify: `src/store/conversationCatalogStore.ts`
- Modify: `src/store/workItemRuntimeStore.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles/dialogs.css`
- Modify: `src/styles/main.css`

- [ ] **Step 1: 写失败 WorkPane 单 sink 和稳定 Tab 测试**

新增：

- `conversationWorkItem_effective_native_mounts_native_pane_and_no_terminal`
- `conversationWorkItem_effective_legacy_mounts_terminal_only_after_live_attachment`
- `conversationWorkItem_terminal_session_always_mounts_terminal_path`
- `conversationWorkItem_never_calls_work_item_runtime_start_for_native_conversation`
- `conversationWorkItem_never_subscribes_native_events_for_legacy_conversation`
- `conversationWorkItem_mode_change_unmounts_old_sink_before_starting_new_sink`
- `conversationWorkItem_late_pty_attach_cannot_replace_native_pane`
- `conversationWorkItem_late_native_event_cannot_reach_legacy_generation`
- `workPane_mixed_order_and_kind_scoped_active_item_remain_unchanged`
- `workPane_same_uuid_conversation_terminal_still_have_distinct_keys_and_renderers`
- `conversationWorkItem_unsupported_native_shows_explicit_compatibility_action_without_auto_fallback`

- [ ] **Step 2: 运行WorkPane测试并确认失败**

Run: `npm run test -- src/components/Workspace/ConversationWorkItem.test.tsx src/components/Workspace/WorkPane.test.tsx`

Expected: FAIL，Conversation renderer/router尚不存在。

- [ ] **Step 3: 实现ConversationWorkItem路由器**

`WorkPane`继续按完整`WorkItemRef`选择entity；Conversation委托`ConversationWorkItem`，TerminalSession继续直接走Phase B `TerminalPane`。native effective mode从`readyStores.nativeConversationStore`取lane并渲染`NativeConversationPane`；legacy effective mode只通过`workItemRuntimeStore.ensureStarted`获得PTY attachment后渲染TerminalPane。

路由器持单调mode generation：切换时先dispose旧native subscription或等待旧PTY detach/settle，再允许新sink；迟到事件/attach Promise只清理自己，不得安装。没有任何组件同时挂载native和xterm DOM。

- [ ] **Step 4: 写失败任意启用供应商切换与ContextBridge UI测试**

新增：

- `conversationProviderDialog_lists_every_enabled_provider_and_provider_scoped_model`
- `conversationProviderDialog_running_or_waiting_approval_disables_switch_until_cancelled_or_complete`
- `contextBridgeDialog_shows_exact_limited_content_source_target_range_and_omitted_count`
- `contextBridgeDialog_continue_limited_requires_explicit_confirmation`
- `contextBridgeDialog_manual_text_is_visible_and_bounded`
- `contextBridgeDialog_new_conversation_calls_create_without_switch_commit`
- `contextBridgeDialog_stale_preview_refetches_and_requires_reconfirm`
- `contextBridgeDialog_commit_refreshes_catalog_and_timeline_generation_safely`
- `contextBridgeDialog_provider_switched_marker_remains_visible_after_restart`
- `contextBridgeDialog_same_model_name_providers_keep_distinct_ids_and_labels`
- `executionModeDialog_enter_legacy_requires_explicit_confirmation`
- `executionModeDialog_return_to_inherit_waits_pty_settle_before_native_mount`
- `executionModeDialog_failure_keeps_old_mode_and_single_sink`

- [ ] **Step 5: 运行菜单/对话框测试并确认失败**

Run: `npm run test -- src/components/dialogs/ContextBridgeDialog.test.tsx src/components/dialogs/ConversationExecutionModeDialog.test.tsx src/components/dialogs/ConversationProviderDialog.test.tsx src/components/Sidebar/ReadySidebar.test.tsx`

Expected: FAIL，Phase B只读ContextBridge说明尚未升级为preview/commit流程。

- [ ] **Step 6: 实现右键任意供应商切换和显式兼容模式**

Conversation右键菜单固定包含“切换供应商”“使用/退出终端兼容模式”。切换供应商先读取全部enabled ProviderSummary和provider-scoped models，再调用preview；有上下文时必须进入ContextBridgeDialog，无上下文也仍由后端preview/commit决定，前端不猜。limited/manual/new Conversation三条路径分别执行Task 3 API或现有conversationCreate。

生成中、waitingApproval、cancelling、start claim、settling或pending outcome时菜单disabled，并显示先完成/取消的原因。commit成功后`readyStores`在一个action generation中刷新Conversation catalog、关闭旧native lane、重开event window；stale旧refresh不能覆盖。

执行模式对话框明确说明legacy模式使用交互CLI/xterm、没有结构化消息/审批卡片，且仍受PTY安全边界。模式切换绝不修改global flag；失败保持旧renderer。unsupported capability只提供按钮，不自动触发。

- [ ] **Step 7: 更新新建Conversation与App分支**

当effective native时，新建顺序为`conversationCreate → layout.openItem`，不再自动`workItemRuntimeStart`；用户首次发送才由ConversationManager启动adapter。effective legacy才沿用`create → openItem → workItemRuntimeStart`。全锁pane导致open失败时稳定Conversation保留且零runtime start/send。

App退出/壳dispose先冻结mode/provider dialog和native Composer，再等待ready action coordinator收敛，最后沿用Phase B/C QuitGate顺序；不得因新增pane绕过layout/settings flush。

- [ ] **Step 8: 运行工作区/菜单/App全量测试和简化审查**

Run: `npm run test -- src/components/Workspace/ConversationWorkItem.test.tsx src/components/Workspace/WorkPane.test.tsx src/components/dialogs/ContextBridgeDialog.test.tsx src/components/dialogs/ConversationExecutionModeDialog.test.tsx src/components/dialogs/ConversationProviderDialog.test.tsx src/components/Sidebar/ReadySidebar.test.tsx src/App.test.tsx src/store/readyStores.test.ts && npm run typecheck && npm run build`

Expected: PASS；同一Conversation始终单sink，任意enabled provider可通过可见bridge切换，TerminalSession/xterm无回归。

使用 `@code-simplifier` 审查router generation、dialog action和readyStores协调；若修改，重跑本步骤。

- [ ] **Step 9: 提交Ready工作区分路**

```bash
git add src/components/Workspace/ConversationWorkItem.tsx src/components/Workspace/ConversationWorkItem.test.tsx src/components/Workspace/WorkPane.tsx src/components/Workspace/WorkPane.test.tsx src/components/Workspace/StoppedConversationPanel.tsx src/components/Sidebar/ReadySidebar.tsx src/components/Sidebar/ReadySidebar.test.tsx src/components/Sidebar/ConversationMenuItem.tsx src/components/dialogs/ContextBridgeDialog.tsx src/components/dialogs/ContextBridgeDialog.test.tsx src/components/dialogs/ConversationExecutionModeDialog.tsx src/components/dialogs/ConversationExecutionModeDialog.test.tsx src/components/dialogs/ConversationProviderDialog.tsx src/components/dialogs/ConversationProviderDialog.test.tsx src/store/readyStores.ts src/store/conversationCatalogStore.ts src/store/workItemRuntimeStore.ts src/App.tsx src/App.test.tsx src/styles/dialogs.css src/styles/main.css
git commit -m "feat(native-ui): 分路原生会话与终端兼容模式"
```

### Task 10: 为原生 keepAlive 增加费用确认并接入活动、托盘和退出

**Files:**
- Create: `src-tauri/src/application/native_keep_alive_service.rs`
- Create: `src-tauri/src/commands/native_keep_alive_cmds.rs`
- Create: `src-tauri/tests/native_keep_alive.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/conversation_execution_mode_service.rs`
- Modify: `src-tauri/src/application/conversation_switch_service.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src-tauri/src/application/runtime_activity_registry.rs`
- Modify: `src-tauri/src/application/runtime_shutdown_coordinator.rs`
- Modify: `src-tauri/src/domain/conversation.rs`
- Modify: `src-tauri/src/domain/project.rs`
- Modify: `src-tauri/src/domain/settings.rs`
- Modify: `src-tauri/src/storage/schema.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/compat/config_facade.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/tray.rs`
- Modify: `src-tauri/tests/runtime_activity.rs`
- Modify: `src-tauri/tests/conversation_execution_mode.rs`
- Modify: `src-tauri/tests/conversation_switch_transaction.rs`
- Modify: `src-tauri/tests/bootstrap_order.rs`
- Modify: `src-tauri/tests/quit_gate.rs`
- Modify: `src-tauri/tests/tray_quit.rs`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Create: `src/components/dialogs/NativeKeepAliveDialog.tsx`
- Create: `src/components/dialogs/NativeKeepAliveDialog.test.tsx`
- Modify: `src/keepAliveManager.ts`
- Modify: `src/keepAliveManager.test.ts`
- Modify: `src/components/dialogs/WorkspaceDialog.tsx`
- Modify: `src/components/dialogs/WorkspaceDialog.test.tsx`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: 写失败后端测试固定迁移不自动授权和费用绑定**

新增：

- `native_keep_alive_migrated_project_setting_has_no_consent`
- `native_keep_alive_preview_shows_bounded_instruction_provider_model_interval_and_next_time_without_secret`
- `native_keep_alive_confirm_requires_confirmed_potential_charge_true`
- `native_keep_alive_consent_binds_ready_epoch_mode_selection_provider_revision_model_segment_generation_and_hashes`
- `native_keep_alive_provider_revision_model_instruction_interval_or_mode_change_invalidates_consent`
- `native_keep_alive_provider_switch_away_then_back_never_reactivates_old_consent`
- `native_keep_alive_legacy_mode_away_then_native_back_never_reactivates_old_consent`
- `native_keep_alive_segment_lineage_generation_advance_never_reactivates_old_consent`
- `native_keep_alive_ready_restart_persistently_expires_previous_boot_consent`
- `native_keep_alive_rollout_or_rollback_epoch_change_never_reactivates_old_consent`
- `native_keep_alive_tick_requires_native_flag_effective_native_idle_and_matching_consent`
- `native_keep_alive_tick_skips_busy_conversation_without_queueing_or_charging`
- `native_keep_alive_tick_uses_conversation_manager_and_never_legacy_pty_write`
- `native_keep_alive_quiescing_rejects_new_tick_before_model_request`
- `native_keep_alive_revoke_is_idempotent_and_keeps_history`
- `native_keep_alive_public_debug_error_and_activity_hide_prompt_secret_path_and_revision_config`

- [ ] **Step 2: 运行后端keepAlive测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test native_keep_alive`

Expected: FAIL，consent/service/commands尚不存在。

- [ ] **Step 3: 实现显式 consent 和受控 tick**

Conversation新增持久单调`executionSelectionGeneration`与`segmentLineageGeneration`：每次成功provider/model selection commit或execution mode preference变化都递增前者；每次旧segment lineage因provider switch、adapter recovery或显式runtime终结而被替换时递增后者，普通同segment turn不递增。切走再切回原provider/model/mode仍产生新generation，禁止值回退或从字段相等推导“还是同一授权”。AppSettings新增由所有writer逐字保留的`nativeKeepAliveConsentEpoch: u64`，Task 12每次rollout apply/rollback原子递增；Ready实例另生成不持久化的随机`readyEpoch`。

Conversation持久化可选`NativeKeepAliveConsent { id, readyEpoch, nativeKeepAliveConsentEpoch, executionModePreference, effectiveExecutionMode, executionSelectionGeneration, providerId, providerRevisionId, modelId, segmentLineageGeneration, projectKeepAliveConfigHash, instructionHash, consentHash, confirmedAt }`；不复制instruction/prompt正文。`consentHash`由后端MAC绑定全部字段与redaction/schema version。`preview`从Project现有keepAlive设置、Conversation当前selection/mode/generations、ProviderRevision和当前Ready epoch生成公开摘要，并把将发送的bounded instruction逐字展示给用户；instruction可进入确认对话框但不得进入Debug/Error/RuntimeActivity或托盘摘要。`confirm`要求`confirmedPotentialCharge=true`并在同一transition claim+mutation guard内重验全部generation/hash/selection；mode/switch service在自己的成功事务内递增generation，旧consent只标Expired而不重新解释。重启后新`readyEpoch`与持久旧consent必不匹配，因此旧授权不会在之后任一启动复活。

`tick(conversationId, consentId)`先取得ordinary Quit permit、per-conversation lane并确认无execution transition claim，随后在短mutation snapshot中逐项重验global flag/consent epoch、ready epoch、mode preference/effective mode、selection/provider/revision/model、segment lineage、instruction/config hash、状态idle和下一次调度；任一不匹配原子标记schedule expired并在secret/process/model request前返回`consentExpired`。验证通过才委托ConversationManager send Project当前keepAlive input；busy固定SKIP并不排队。结果只返回`sent|skippedBusy|consentExpired|disabled`，不返回模型正文或usage。scheduler不绕过event quota、capability或ContextBridge。

- [ ] **Step 4: 写失败前端确认、调度和退出测试**

新增：

- `nativeKeepAliveDialog_explains_each_tick_may_charge_and_shows_provider_model_next_time`
- `nativeKeepAliveDialog_requires_checkbox_before_confirm`
- `nativeKeepAliveDialog_cancel_calls_no_confirm_or_tick`
- `nativeKeepAliveDialog_stale_preview_requires_reconfirm`
- `keepAlive_native_tick_uses_consent_id_and_catches_quiescing`
- `keepAlive_native_tick_never_calls_pty_write`
- `keepAlive_provider_switch_or_mode_change_stops_schedule_until_reconfirmed`
- `keepAlive_switch_away_back_segment_rebuild_or_restart_cannot_revive_old_timer`
- `keepAlive_pause_on_quit_waits_started_submission_and_resumes_one_schedule_after_cancel`
- `app_quit_summary_counts_native_keep_alive_turn_through_runtime_activity`
- `tray_hidden_keeps_confirmed_schedule_running_and_badge_updates`
- `tray_exit_waiting_approval_or_native_turn_uses_same_quit_request`

- [ ] **Step 5: 运行前端/lifecycle测试并确认失败**

Run: `npm run test -- src/components/dialogs/NativeKeepAliveDialog.test.tsx src/keepAliveManager.test.ts src/components/dialogs/WorkspaceDialog.test.tsx src/App.test.tsx`

Expected: FAIL，native费用确认和consent调度尚未接线。

- [ ] **Step 6: 接入BackendClient、UI、RuntimeActivity和QuitGate**

新增`nativeKeepAlivePreview/Confirm/Revoke/Tick`方法；DTO不接受providerRevisionId、prompt或secret，confirm只提交previewToken和显式布尔。Fake记录调用/deferred/error。

WorkspaceDialog保留旧Project.keepAlive配置，但native模式旁显示“尚未授权模型请求”；用户选择具体Conversation后打开NativeKeepAliveDialog。`keepAliveManager`按nextAt调tick，busy不排队，`consentExpired`立即移除该consentId对应timer并要求重新preview/confirm；切走再切回、segment rebuild、rollout/rollback或应用重启都不能从local state恢复旧timer。每个周期最多一次，fake clock测试不用真实sleep。

active tick从ConversationManager进入现有`nativeTurns`活动计数；tray/quit summary继续只显示数量。退出prepare阻止新tick，已开始submission完成登记后由RuntimeShutdownCoordinator统一cancel/contain/drain；隐藏到tray不暂停已确认schedule。取消退出只恢复一份timer。

- [ ] **Step 7: 运行keepAlive、活动、退出和托盘回归**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test native_keep_alive && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_execution_mode && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_switch_transaction && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_activity && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate && cargo test --manifest-path src-tauri/Cargo.toml --test tray_quit && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/components/dialogs/NativeKeepAliveDialog.test.tsx src/keepAliveManager.test.ts src/components/dialogs/WorkspaceDialog.test.tsx src/App.test.tsx && npm run typecheck`

Expected: PASS；旧keepAlive配置不自动计费，确认后provider/model/next time可见，mode/provider/segment/rollout/restart任一generation变化后旧consent与timer均不可复活，QuitGate/托盘行为统一。

- [ ] **Step 8: 代码简化审查并提交**

使用 `@code-simplifier` 审查consent hash、tick admission和timer恢复；若修改，重跑Step 7。

```bash
git add src-tauri/src/application/native_keep_alive_service.rs src-tauri/src/application/conversation_execution_mode_service.rs src-tauri/src/application/conversation_switch_service.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/application/runtime_activity_registry.rs src-tauri/src/application/runtime_shutdown_coordinator.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/domain/conversation.rs src-tauri/src/domain/project.rs src-tauri/src/domain/settings.rs src-tauri/src/storage/schema.rs src-tauri/src/storage/repositories.rs src-tauri/src/compat/config_facade.rs src-tauri/src/commands/native_keep_alive_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/tray.rs src-tauri/tests/native_keep_alive.rs src-tauri/tests/conversation_execution_mode.rs src-tauri/tests/conversation_switch_transaction.rs src-tauri/tests/bootstrap_order.rs src-tauri/tests/runtime_activity.rs src-tauri/tests/quit_gate.rs src-tauri/tests/tray_quit.rs src/api/v2/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/test/FakeBackendClient.ts src/components/dialogs/NativeKeepAliveDialog.tsx src/components/dialogs/NativeKeepAliveDialog.test.tsx src/keepAliveManager.ts src/keepAliveManager.test.ts src/components/dialogs/WorkspaceDialog.tsx src/components/dialogs/WorkspaceDialog.test.tsx src/App.test.tsx
git commit -m "feat(native-ui): 增加原生保活费用确认"
```

### Task 11: 通过 Chunk 2 安全与工作区门禁

**Files:**
- Verify only: all files changed in Tasks 6-10

- [ ] **Step 1: 运行前端完整门禁**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部PASS；无focused/skipped test、act warning、listener/timer泄漏或未处理rejection。

- [ ] **Step 2: 运行Rust安全/lifecycle完整门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test external_link && cargo test --manifest-path src-tauri/Cargo.toml --test webview_security && cargo test --manifest-path src-tauri/Cargo.toml --test native_keep_alive && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_activity && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate && cargo test --manifest-path src-tauri/Cargo.toml --test tray_quit && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部PASS；CSP/capability严格、Job/event/outcome未收敛时不退出。

- [ ] **Step 3: 运行生产安全静态扫描**

Run: `rg -n 'dangerouslySetInnerHTML|rehype-raw|target=._blank|window\.open|location\.href|csp"\s*:\s*null|core:default|dialog:default|notification:default|shell:|opener:' src src-tauri package.json`

Expected: 生产代码/config零危险命中；外链只能命中`external_link_preview/open`自定义命令与负向测试。

Run: `rg -n "ptySessionId|runtimePtySessionId|modelName.*(key|id)|secretRef|apiKey" src/components/Conversation src/components/Workspace/ConversationWorkItem.tsx src/store/nativeConversationStore.ts`

Expected: native UI/store不持PTY/secret；modelName只显示；legacy xterm的PTY ID只在运行态router分支出现且不持久化。

- [ ] **Step 4: 核对Chunk行数并执行计划评审**

Run: `$p='docs/superpowers/plans/2026-07-10-panel-redesign-phase-d-native-workspace.md'; $lines=Get-Content -LiteralPath $p; $starts=@(for($i=0;$i -lt $lines.Count;$i++){if($lines[$i] -match '^## Chunk '){$i}}); $end=if($starts.Count -gt 2){$starts[2]}else{$lines.Count}; if(($end-$starts[1]) -gt 1000){throw 'Phase D Chunk 2 exceeds 1000 lines'}`

Expected: Chunk 2不超过1000行。

使用plan-document-reviewer按设计规格第6、8.3、13-15、17节和Phase B/C接口复核Chunk 2；重点确认IME、审批能力gate、virtualization/capacity、无raw HTML、严格CSP、最小capability、单sink、RuntimeActivity/QuitGate/tray/keepAlive费用确认均闭环。

## Chunk 3: 安全默认切换、迁移清理与 Phase D 验收

### Task 12: 建立 nativeAiEnabled rollout/rollback 门而暂不改变默认值

**Files:**
- Create: `src-tauri/src/application/native_ai_rollout_service.rs`
- Create: `src-tauri/src/commands/native_ai_rollout_cmds.rs`
- Create: `src-tauri/tests/native_ai_rollout.rs`
- Modify: `src-tauri/src/application/native_keep_alive_service.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/runtime_activity_registry.rs`
- Modify: `src-tauri/src/application/runtime_shutdown_coordinator.rs`
- Modify: `src-tauri/src/domain/settings.rs`
- Modify: `src-tauri/src/storage/schema.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/compat/config_facade.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/tests/native_keep_alive.rs`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/components/dialogs/SettingsDialog.test.tsx`
- Modify: `src/store/settingsStore.ts`
- Modify: `src/store/settingsStore.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: 写失败测试固定 rollout schema、前置条件和字段所有权**

新增：

- `native_ai_rollout_schema_starts_at_zero_with_phase_c_flag_false`
- `native_ai_rollout_preflight_requires_ready_v2_workspace_and_security_schema`
- `native_ai_rollout_preflight_rejects_pending_migration_compat_workspace_switch_event_or_outcome_journal`
- `native_ai_rollout_preflight_rejects_native_identity_or_repository_validation_failure`
- `native_ai_rollout_preflight_runs_no_model_request_and_reads_no_secret_value`
- `native_ai_rollout_apply_requires_explicit_confirmation_and_matching_preflight_token`
- `native_ai_rollout_apply_sets_workspace_v2_and_native_flags_in_one_atomic_app_settings_write`
- `native_ai_rollout_apply_preserves_theme_terminal_compatibility_ids_and_other_fields`
- `native_ai_rollout_apply_requires_restart_and_does_not_hot_switch_runtime`
- `native_ai_rollout_apply_increments_keep_alive_consent_epoch_atomically`
- `native_ai_rollout_all_other_app_settings_writers_preserve_rollout_fields`
- `native_ai_rollout_forged_stale_or_cross_config_token_is_zero_write_conflict`

`workspaceV2Enabled=true` 是native消息工作区前置；rollout可以把旧默认false与native flag同一原子写改为true，但rollback只关闭native flag，继续保留v2工作区和稳定布局。

- [ ] **Step 2: 运行rollout测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test native_ai_rollout native_ai_rollout_`

Expected: FAIL，rollout service/schema尚不存在；不得是 `0 tests`。

- [ ] **Step 3: 实现只拥有feature rollout字段的窄service**

`FeatureFlags`增加：

```rust
pub struct FeatureFlags {
    pub native_ai_enabled: bool,
    pub workspace_v2_enabled: bool,
    pub native_ai_rollout_version: u32,
    pub native_ai_rollback_reason: Option<NativeAiRollbackReason>,
    pub native_keep_alive_consent_epoch: u64,
}
```

本任务保持fresh/default/migration的`nativeAiEnabled=false`、`nativeAiRolloutVersion=0`，只交付显式apply/rollback能力。`preflight()`只读验证：Ready v2 repositories、所有已知Journal/outcome为空、ConversationManager/NativeIdentity可构造、CSP security schema常量=1、capability文件build-time测试已通过；不probe provider、不读secret、不启动adapter。返回进程内MAC token绑定AppSettings hash、schema marker、pending journal inventory和runtime activity generation。

`apply(token, confirmed=true)`必须在`transition mutex → ordinary Quit permit → ApplicationMutationGate → 短runtime snapshot`顺序重验，且无active native/legacy/terminal start、turn、approval、cancel、connection test或keepAlive submission；单次原子AppSettings写设置workspace v2/native true、rolloutVersion=1、rollbackReason=null，并对`nativeKeepAliveConsentEpoch`做checked increment。当前进程只记录“重启后生效”，App继续使用启动时冻结的shell/native mode；epoch已经变化，任何旧keepAlive consent即使rollback后再次apply也不能匹配。

- [ ] **Step 4: 写失败 rollback、活动和 UI 测试**

新增：

- `native_ai_rollback_requires_explicit_confirmation_and_reason`
- `native_ai_rollback_rejects_running_turn_waiting_approval_cancelling_connection_test_or_keep_alive`
- `native_ai_rollback_waits_event_outcome_and_switch_journal_drain`
- `native_ai_rollback_sets_native_false_keeps_workspace_v2_true_and_preserves_history`
- `native_ai_rollback_does_not_delete_segment_event_provider_secret_or_runtime_directory`
- `native_ai_rollback_requires_restart_and_current_process_stays_frozen`
- `native_ai_rollback_increments_keep_alive_consent_epoch_atomically`
- `native_ai_rollback_then_apply_never_reactivates_old_keep_alive_consent`
- `native_ai_rollback_after_restart_routes_inherit_conversation_to_legacy_terminal`
- `settings_native_rollout_shows_restart_security_and_rollback_effects`
- `settings_native_rollout_apply_and_rollback_require_separate_async_confirmation`
- `settings_native_rollout_error_keeps_current_frozen_mode`
- `app_startup_freezes_native_mode_once_and_does_not_hot_read_flag`

- [ ] **Step 5: 运行rollback/UI测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test native_ai_rollout native_ai_rollback_ && npm run test -- src/components/dialogs/SettingsDialog.test.tsx src/store/settingsStore.test.ts src/App.test.tsx`

Expected: FAIL，rollback门和设置UI尚未实现。

- [ ] **Step 6: 实现安全rollback和BackendClient/UI契约**

`rollback(confirmed, reason)`只在native已启用且RuntimeActivity live counts全零、所有native event/outcome/switch journal已drain时执行；同一AppSettings原子写设置`nativeAiEnabled=false`、保留`workspaceV2Enabled=true/rolloutVersion=1`、记录闭合reason code并checked increment `nativeKeepAliveConsentEpoch`。它不终止未确认进程、不删历史、不改Conversation preference；旧consent立即进入Expired且不能被后续apply复活。重启后Inherit effective legacy，显式Native显示disabled并提供修复。

BackendClient增加`nativeAiRolloutPreflight/Apply/Rollback/Status`；apply只收token+confirmed，rollback只收confirmed+闭合reason，不接受任意feature对象。SettingsDialog显示当前启动模式、持久化下次模式和重启提示；按钮执行中禁用，错误脱敏。

- [ ] **Step 7: 运行rollout/rollback全量回归和简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test native_ai_rollout && cargo test --manifest-path src-tauri/Cargo.toml --test native_keep_alive && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_activity && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/components/dialogs/SettingsDialog.test.tsx src/store/settingsStore.test.ts src/App.test.tsx && npm run typecheck`

Expected: PASS；本任务结束时默认仍false，显式isolated rollout/rollback可用且不热切换，每次转换都使旧keepAlive consent永久失配。

使用 `@code-simplifier` 审查preflight inventory、transition锁序和settings字段patch；若修改，重跑本步骤。

- [ ] **Step 8: 提交rollout门**

```bash
git add src-tauri/src/application/native_ai_rollout_service.rs src-tauri/src/application/native_keep_alive_service.rs src-tauri/src/application/runtime_activity_registry.rs src-tauri/src/application/runtime_shutdown_coordinator.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/domain/settings.rs src-tauri/src/storage/schema.rs src-tauri/src/storage/repositories.rs src-tauri/src/compat/config_facade.rs src-tauri/src/commands/native_ai_rollout_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/error.rs src-tauri/tests/native_ai_rollout.rs src-tauri/tests/native_keep_alive.rs src/api/v2/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/test/FakeBackendClient.ts src/components/dialogs/SettingsDialog.tsx src/components/dialogs/SettingsDialog.test.tsx src/store/settingsStore.ts src/store/settingsStore.test.ts src/App.tsx src/App.test.tsx
git commit -m "feat(native-ui): 增加原生模式切换与回滚门"
```

### Task 13: 通过迁移 smoke 后移除旧 mutation DTO/commands/write path

**Files:**
- Create: `src-tauri/src/application/app_settings_service.rs`
- Create: `src-tauri/src/compat/legacy_read_dto.rs`
- Create: `src-tauri/src/commands/settings_cmds.rs`
- Modify: `src-tauri/src/compat/mod.rs`
- Modify: `src-tauri/src/compat/facade.rs`
- Modify: `src-tauri/src/compat/config_facade.rs`
- Modify: `src-tauri/src/compat/project_facade.rs`
- Modify: `src-tauri/src/compat/session_facade.rs`
- Modify: `src-tauri/src/compat/layout_facade.rs`
- Modify: `src-tauri/src/commands/config_cmds.rs`
- Modify: `src-tauri/src/commands/project_cmds.rs`
- Modify: `src-tauri/src/commands/session_cmds.rs`
- Modify: `src-tauri/src/commands/pty_cmds.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/types.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src/store/settingsStore.ts`
- Modify: `src/store/settingsStore.test.ts`
- Modify: `src/store/workspaceStore.ts`
- Modify: `src/store/sessionStore.ts`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/components/dialogs/SettingsDialog.test.tsx`
- Modify: `src/components/PaneGrid/PaneGrid.tsx`
- Modify: `src/components/Sidebar/Sidebar.tsx`
- Modify: `src/App.tsx`
- Create: `src-tauri/tests/legacy_write_cutover.rs`
- Create: `src-tauri/tests/app_settings_service.rs`
- Create: `src/api/legacyWriteCutover.test.ts`
- Modify: `src/App.test.tsx`
- Delete only after renewed user approval: `src-tauri/src/compat/legacy_dto.rs`

- [ ] **Step 1: 在删除前写失败契约测试固定保留/移除清单**

新增：

- `legacy_cutover_keeps_legacy_read_only_config_project_session_history_projection`
- `legacy_cutover_keeps_pty_attach_detach_write_resize_kill_for_terminal_and_explicit_compatibility`
- `legacy_cutover_keeps_work_item_runtime_start_and_legacy_launch_service`
- `legacy_cutover_removes_config_set_workspace_save_workspace_delete_layout_save_commands`
- `legacy_cutover_removes_managed_session_create_update_delete_commands`
- `legacy_cutover_removes_direct_legacy_ai_pty_spawn_command`
- `legacy_cutover_backend_client_has_no_removed_mutation_methods`
- `legacy_cutover_fake_has_no_silent_compatibility_mutation_fallback`
- `legacy_cutover_legacy_read_only_ui_has_no_enabled_write_action`
- `legacy_cutover_native_rollback_uses_v2_execution_mode_not_removed_commands`
- `legacy_cutover_generate_handler_registers_each_remaining_command_once`
- `app_settings_update_replaces_legacy_config_set_for_theme_terminal_and_notification_fields`
- `app_settings_update_preserves_provider_compatibility_rollout_and_workspace_flags`
- `app_settings_backend_client_tauri_and_fake_have_narrow_get_update_contract`

- [ ] **Step 2: 运行cutover测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test app_settings_service && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_write_cutover && npm run test -- src/api/legacyWriteCutover.test.ts src/store/settingsStore.test.ts src/components/dialogs/SettingsDialog.test.tsx src/App.test.tsx`

Expected: FAIL，窄AppSettings service尚不存在且旧mutation方法/command/DTO仍存在；两个Rust test binary和全部Vitest文件都必须被收集。

- [ ] **Step 3: 在同一 PowerShell 会话保存并复用删除前 cutover smoke 根**

前置：Phase A-C verification全部PASS；只使用`src-tauri/target/`下新建配置根、迁移fixture、空项目目录和非生产测试provider。不得使用真实应用配置、HOME、仓库项目或生产密钥。以下smoke与Step 6必须在保留`$phaseDCutoverRoot`的同一PowerShell会话执行；后续命令不得重新生成GUID或换配置根。

Run: `$env:THT_PANEL_SMOKE='1'; $root=(Resolve-Path 'src-tauri\target').Path; $phaseDCutoverRoot=Join-Path $root ('phase-d-cutover-'+[guid]::NewGuid()); Copy-Item -Recurse -LiteralPath 'src-tauri\tests\fixtures\migration\v1' -Destination $phaseDCutoverRoot; $env:THT_PANEL_CONFIG_DIR=$phaseDCutoverRoot; npm run tauri -- dev`

Expected: 首次启动显示迁移预览；确认后进入Ready。用Task 12显式rollout启用v2+native并正常退出，不手改JSON；记录当前shell中的`$phaseDCutoverRoot`，不把完整本机路径写入验收文档。

Run: `if([string]::IsNullOrWhiteSpace($phaseDCutoverRoot) -or -not (Test-Path -LiteralPath $phaseDCutoverRoot -PathType Container)){throw 'phaseDCutoverRoot is missing'}; $env:THT_PANEL_CONFIG_DIR=$phaseDCutoverRoot; npm run tauri -- dev`

Expected: 明确复用第一次启动的同一配置根；重启后AI Conversation默认NativeConversationPane，TerminalSession仍xterm，布局/activeItem/已迁移完成历史可读。可手工验证不产生模型请求的ContextBridge预览/切换、空闲执行模式切换、Settings rollback→重启走legacy compatibility→再次apply；`tauri dev`使用生产`TauriBackendClient`，不得注入或声称执行Fake/fixture delta、取消、审批。未取得Task 15真实provider与费用再授权时，这三项只引用自动化测试证据；真实CLI仍只按Task 15规则执行。

Run: `Remove-Item Env:THT_PANEL_CONFIG_DIR -ErrorAction SilentlyContinue; Remove-Item Env:THT_PANEL_SMOKE -ErrorAction SilentlyContinue`

Expected: 只清除环境变量；`$phaseDCutoverRoot`仍在当前PowerShell会话中供Step 6复用，smoke目录保留至用户另行明确批准清理。

- [ ] **Step 4: 先完成窄设置服务、只读 DTO 迁移和旧写入口改造**

实现`AppSettingsService::get/update_non_provider`和`settings_get/settings_update`命令，公开update DTO只含theme、terminal、notification等非供应商字段；service按`ApplicationMutationGate → locked reread → patch owned fields`保存，逐字保留compatibility IDs、workspace/native flags、rollout version/reason。把SettingsStore/Dialog切到`appSettingsGet/Update`并完成BackendClient/Tauri/Fake契约后，才移除`config_set`。

把LegacyReadOnly需要的只读结构迁入`legacy_read_dto.rs`并让所有facade/command/test改用它；删除BackendClient/Tauri/Fake/commands/store中的旧mutation方法，取消Tauri handler注册。`pty_cmds.rs`只移除直接legacy AI spawn入口，保留attach/detach/write/resize/kill；AI terminal compatibility统一经稳定`work_item_runtime_start`。本步骤必须保留候选`src-tauri/src/compat/legacy_dto.rs`原文件，不删除、移动、清空或覆盖它。

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test app_settings_service && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_write_cutover && cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/api/legacyWriteCutover.test.ts src/store/settingsStore.test.ts src/components/dialogs/SettingsDialog.test.tsx src/App.test.tsx && npm run typecheck && npm run build`

Expected: PASS；窄settings契约已替代`config_set`，LegacyReadOnly只经`legacy_read_dto.rs`编译，旧mutation入口不可调用，候选旧DTO文件仍存在但不再被引用。

- [ ] **Step 5: 全仓审计 snake_case/camelCase 零生产引用后再次取得删除授权**

Run: `$candidate='src-tauri/src/compat/legacy_dto.rs'; if(-not (Test-Path -LiteralPath $candidate -PathType Leaf)){throw 'legacy dto candidate missing before approval'}; $dtoRefs=@(rg -n --hidden -g '!node_modules/**' -g '!dist/**' -g '!src-tauri/target/**' -g '!.git/**' -g '!docs/**' -g '!src-tauri/src/compat/legacy_dto.rs' 'legacy_dto|legacyDto|LegacyDto' .); if($LASTEXITCODE -notin 0,1){throw 'dto reference audit failed'}; if($dtoRefs.Count -gt 0){$dtoRefs; throw 'legacy dto references remain outside candidate'}`

Expected: 候选文件仍存在，但module/type的snake_case/camelCase引用在生产源码、测试和配置中全部为零；只读调用已经逐项迁入`legacy_read_dto.rs`。

Run: `$oldWriterPattern='config_set|configSet|workspace_save|workspaceSave|workspace_delete|workspaceDelete|layout_save|layoutSave|managed_session_(create|update|delete)|managedSession(Create|Update|Delete)|pty_spawn|ptySpawn'; $productionRefs=@(rg -n -g '!**/*.test.*' -g '!**/__tests__/**' -g '!**/fixtures/**' $oldWriterPattern src-tauri/src src); if($LASTEXITCODE -notin 0,1){throw 'production writer audit failed'}; if($productionRefs.Count -gt 0){$productionRefs; throw 'legacy writer remains in production source'}`

Expected: `src-tauri/src`与`src`全部生产模块中的旧writer/command/API snake_case与camelCase零命中；compat/application/store/component路径都在扫描范围内，不能只扫command/client入口。

Run: `$rustTestRefs=@(rg -n $oldWriterPattern src-tauri/tests); $rustTestExit=$LASTEXITCODE; $tsTestRefs=@(rg -n -g '**/*.test.*' $oldWriterPattern src); $tsTestExit=$LASTEXITCODE; if($rustTestExit -notin 0,1 -or $tsTestExit -notin 0,1){throw 'negative contract audit failed'}; if($rustTestRefs.Count -eq 0 -or $tsTestRefs.Count -eq 0){throw 'both Rust and TypeScript cutover contracts must name removed APIs'}; $testRefs=@($rustTestRefs)+@($tsTestRefs); $testRefs; $unexpected=@($testRefs | Where-Object { $_ -notmatch '^(src-tauri[\\/]tests[\\/]legacy_write_cutover\.rs|src[\\/]api[\\/]legacyWriteCutover\.test\.ts):' }); if($unexpected.Count -gt 0){$unexpected; throw 'legacy names appear outside dedicated negative contract tests'}`

Expected: 旧名称只作为字符串出现在`src-tauri/tests/legacy_write_cutover.rs`和`src/api/legacyWriteCutover.test.ts`的“命令/API不存在”负向断言中；若其他测试需要同类断言，先合并到这两个专用文件，不扩大allowlist。`legacy_read_dto.rs`、新settings命令、PTY attach/write/resize/kill与`work_item_runtime_start`继续有正向测试证据。

只有完成Step 4改造、自动化PASS和本步骤零引用审计后，才向用户列出唯一候选`src-tauri/src/compat/legacy_dto.rs`、完整零引用命令/输出摘要、已保留的LegacyReadOnly读取与terminal compatibility边界，并再次请求明确批准。未批准时停止Task 13，不执行任何删除，也不得宣称cutover完成。

- [ ] **Step 6: 获批后删除唯一DTO、运行自动化并复用同一smoke根**

仅在Step 5明确获批后运行：

```bash
git rm src-tauri/src/compat/legacy_dto.rs
```

Expected: 只删除该文件；不删除CompatibilityFacade、LegacyLaunchService、PTY/xterm、PaneGrid/Sidebar LegacyReadOnly读取组件、migration importer或任何event/history/runtime目录。

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test app_settings_service && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_write_cutover && cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/api/legacyWriteCutover.test.ts src/store/settingsStore.test.ts src/components/dialogs/SettingsDialog.test.tsx src/App.test.tsx && npm run typecheck && npm run build`

Expected: PASS；旧写命令不可调用，LegacyReadOnly仍可读，显式兼容模式和TerminalSession仍可运行。

Run: `if([string]::IsNullOrWhiteSpace($phaseDCutoverRoot) -or -not (Test-Path -LiteralPath $phaseDCutoverRoot -PathType Container)){throw 'original phaseDCutoverRoot is unavailable; do not create a replacement'}; $env:THT_PANEL_SMOKE='1'; $env:THT_PANEL_CONFIG_DIR=$phaseDCutoverRoot; npm run tauri -- dev`

Expected: 必须复用Step 3保存的同一配置根且命令中无`NewGuid`；已迁移v2/native数据可读，removed command不会被调用，native/rollback/terminal compatibility仍PASS，旧明文文件不再生成或写回。未取得Task 15真实provider与费用再授权时，不把delta/取消/审批记为本次`tauri dev`手工PASS，只引用对应自动化证据。

Run: `Remove-Item Env:THT_PANEL_CONFIG_DIR -ErrorAction SilentlyContinue; Remove-Item Env:THT_PANEL_SMOKE -ErrorAction SilentlyContinue`

Expected: 环境变量清除；smoke证据目录仍保留，清理需另行明确授权。

- [ ] **Step 7: 代码简化审查并提交cutover**

使用 `@code-simplifier` 审查read DTO、command注册和client残余分支；若修改，重跑Step 6。未经授权不得让simplifier删除其他文件。

```bash
git add src-tauri/src/application/app_settings_service.rs src-tauri/src/compat/legacy_read_dto.rs src-tauri/src/compat/mod.rs src-tauri/src/compat/facade.rs src-tauri/src/compat/config_facade.rs src-tauri/src/compat/project_facade.rs src-tauri/src/compat/session_facade.rs src-tauri/src/compat/layout_facade.rs src-tauri/src/commands/settings_cmds.rs src-tauri/src/commands/config_cmds.rs src-tauri/src/commands/project_cmds.rs src-tauri/src/commands/session_cmds.rs src-tauri/src/commands/pty_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/app_settings_service.rs src-tauri/tests/legacy_write_cutover.rs src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/types.ts src/api/legacyWriteCutover.test.ts src/test/FakeBackendClient.ts src/store/settingsStore.ts src/store/settingsStore.test.ts src/components/dialogs/SettingsDialog.tsx src/components/dialogs/SettingsDialog.test.tsx src/store/workspaceStore.ts src/store/sessionStore.ts src/components/PaneGrid/PaneGrid.tsx src/components/Sidebar/Sidebar.tsx src/App.tsx src/App.test.tsx
git commit -m "refactor(native-ui): 移除旧配置写入口"
```

若Step 5获批并执行，确认`git status --short`显示该删除已包含在本提交；否则本任务保持未完成且不得创建此提交。

### Task 14: 在门禁通过后切换 fresh/upgrade 默认并保留显式 rollback

**Files:**
- Modify: `src-tauri/src/domain/settings.rs`
- Modify: `src-tauri/src/migration/planner.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/native_ai_rollout_service.rs`
- Modify: `src-tauri/tests/native_ai_rollout.rs`
- Modify: `src-tauri/tests/migration_planner.rs`
- Modify: `src-tauri/tests/bootstrap_order.rs`
- Modify: `src/store/settingsStore.test.ts`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: 写失败测试固定最终默认与升级规则**

新增：

- `native_ai_default_fresh_install_is_workspace_v2_true_native_true_rollout_one`
- `native_ai_upgrade_from_phase_c_zero_applies_once_after_clean_bootstrap`
- `native_ai_upgrade_does_not_override_recorded_user_rollback`
- `native_ai_upgrade_pending_or_blocked_journal_never_flips_flag`
- `native_ai_upgrade_preserves_conversation_execution_mode_preferences`
- `native_ai_upgrade_inherit_conversation_resolves_native_after_restart`
- `native_ai_upgrade_explicit_legacy_conversation_stays_legacy`
- `native_ai_default_unsupported_provider_stays_blocked_with_explicit_compatibility_not_silent_global_rollback`
- `native_ai_default_same_model_name_provider_selection_remains_provider_scoped`
- `native_ai_default_rollback_then_restart_routes_inherit_to_legacy_without_data_loss`

- [ ] **Step 2: 运行默认切换测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test native_ai_rollout native_ai_default_ && cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner native_ai_ && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order native_ai_`

Expected: FAIL，Task 12仍保持Phase C默认false。

- [ ] **Step 3: 切换fresh默认并实现幂等upgrade**

仅在Task 13 smoke、自动化、旧写cutover和删除授权步骤全部PASS后修改：fresh `FeatureFlags`固定`workspaceV2Enabled=true/nativeAiEnabled=true/nativeAiRolloutVersion=1`。Phase C v2 settings的version0在bootstrap所有recovery/open/validation成功后，通过Task 12同一atomic writer升级到version1；若存在用户rollback marker则保持native false。pure legacy/no marker仍先走迁移确认，不得在旧文件上写flag。

升级不扫描provider/CLI、不产生模型请求；特定Conversation/provider不支持native时UI显示修复/terminal compatibility，不能静默改global flag。显式rollback继续是唯一全局关闭路径。

- [ ] **Step 4: 运行迁移/bootstrap/App回归和代码简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test native_ai_rollout && cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/store/settingsStore.test.ts src/App.test.tsx && npm run typecheck && npm run build`

Expected: PASS；fresh/upgrade默认native，rollback marker不被覆盖，pending migration/Journal时不提前切换。

使用 `@code-simplifier` 审查default/upgrade/rollback条件；若修改，重跑本步骤。

- [ ] **Step 5: 提交安全默认切换**

```bash
git add src-tauri/src/domain/settings.rs src-tauri/src/migration/planner.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/native_ai_rollout_service.rs src-tauri/tests/native_ai_rollout.rs src-tauri/tests/migration_planner.rs src-tauri/tests/bootstrap_order.rs src/store/settingsStore.test.ts src/App.test.tsx
git commit -m "feat(native-ui): 默认启用原生AI工作区"
```

### Task 15: 固定同 modelName 多供应商并发隔离与真实 CLI PASS/SKIP/FAIL

**Files:**
- Create: `src-tauri/tests/native_workspace_isolation.rs`
- Create: `src/nativeWorkspaceIsolation.test.tsx`
- Modify: `src-tauri/src/runtime/smoke.rs`
- Modify: `src-tauri/src/bin/tht_panel_runtime_smoke.rs`
- Modify: `src-tauri/tests/runtime_cli_smoke_contract.rs`
- Modify: `scripts/cli-smoke.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写失败离线隔离测试**

新增：

- `native_workspace_same_model_two_providers_create_distinct_revision_namespace_jobs_and_bindings`
- `native_workspace_same_model_concurrent_delta_completed_and_approval_events_reach_only_owner_conversation`
- `native_workspace_same_model_event_cursor_and_frontend_lane_never_cross_conversation`
- `native_workspace_same_model_context_bridge_token_cannot_commit_to_other_provider_or_conversation`
- `native_workspace_same_model_provider_switch_preserves_old_segments_and_creates_target_prepared_segment`
- `native_workspace_same_model_cancel_one_turn_does_not_cancel_other_revision`
- `native_workspace_shared_codex_only_shares_same_revision_not_same_model_name`
- `native_workspace_frontend_keys_use_conversation_event_provider_ids_not_model_name`
- `native_workspace_terminal_compatibility_for_one_conversation_does_not_change_other_native_conversation`
- `native_workspace_smoke_root_requires_new_leaf_under_canonical_target_and_rejects_home_repo_default_or_reparse`
- `native_workspace_smoke_changed_root_provider_revision_model_or_case_requires_fresh_confirmation`
- `native_workspace_smoke_rejects_stale_control_env_before_secret_process_or_request`
- `native_workspace_smoke_success_and_failure_clear_control_env_without_deleting_evidence_root`

- [ ] **Step 2: 运行隔离测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test native_workspace_isolation && npm run test -- src/nativeWorkspaceIsolation.test.tsx`

Expected: FAIL，Phase D端到端隔离harness尚不存在。

- [ ] **Step 3: 实现离线跨层harness并修复所有归属为稳定ID**

Rust harness使用两个ProviderProfile/Revision、相同modelName、不同secret sentinel/FakeProcessHost/Job/config root，驱动ConversationManager→Channel→query cursor→ContextBridge；断言任何event、approval、turn、native identity、cursor、bridge token和activity都带稳定Conversation/segment/provider revision归属。前端harness创建两个store lane并交错delta/completion，断言DOM、cancel和provider label不串线。

任何实现若按modelName查provider、复用revision namespace、共享cursor或用“当前active conversation”接事件，先做最小修复再让测试转绿。

- [ ] **Step 4: 扩展真实smoke contract和安全wrapper**

`npm run test:cli-smoke`默认仍是无费用probe。新增真实case组`native-workspace`，保留既有`--runtime --native-workspace --confirm-potential-charge`接口，不新增应用内授权receipt/token。ConfigRoot验证复用生产resolver：每次真实run准备的leaf必须此前不存在，先canonicalize最近存在parent并证明它严格位于canonical `src-tauri/target`，拒绝leaf/parent reparse、`..`、existing file/dir、HOME、默认app config、仓库根或仓库项目路径；创建后再次canonicalize复核。`src-tauri/target`本身位于仓库内是唯一允许前缀，但root不能等于仓库/target根或指向任意source/project目录。

费用授权是执行工作流的人类门：每次真实run前都必须在当前用户对话中列出canonical root脱敏标签、两个Provider/Profile/Revision、model、driver/CLI版本、case manifest和可能费用并取得本轮明确同意；wrapper只把`--confirm-potential-charge`视为“本轮确认已由执行者取得”的必需flag，不保存或伪造授权。root/provider revision/model/case任一变化、命令失败后重跑或新的执行时段都必须重新询问，旧回复不能复用。Node argv仍不接受secret/baseUrl/prompt/model output/native ID。runner复用生产ConversationManager/ContextBridge，不启动WebView，输出每项`PASS|SKIP|FAIL`：

- Codex/Claude各自：新会话、流式完成、下一turn、支持时取消/审批；manifest false能力为SKIP(unsupported)。
- 两个相同modelName provider：并发send、事件归属、namespace/env/job隔离、A→B可见ContextBridge；必须PASS才能验收需求6。
- CLI未安装为SKIP；未提供第二测试provider为SKIP且不能声明隔离已验收；已安装/配置但协议、隔离、CSP前置或ContextBridge失败为FAIL。
- 输出不得含模型正文、工具输出、prompt、secret、完整路径、URL或原生thread/session ID。

- [ ] **Step 5: 运行离线contract和默认probe**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test native_workspace_isolation && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_cli_smoke_contract && npm run test -- src/nativeWorkspaceIsolation.test.tsx && npm run test:cli-smoke -- --probe-only`

Expected: 自动化PASS；probe每driver只输出PASS(version)或SKIP(not installed)，零模型请求。

- [ ] **Step 6: 创建全新隔离根并在真实 CLI case前重新取得费用授权**

本步骤与Step 7在同一PowerShell会话执行。先清除可能遗留的smoke/provider环境变量，再生成此前不存在的leaf；只用该root启动应用配置两个非生产测试provider，期间不得发送消息/keepAlive/连接测试：

Run: `Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue; $targetRoot=(Resolve-Path 'src-tauri\target').Path; $phaseDNativeWorkspaceRoot=Join-Path $targetRoot ('phase-d-native-workspace-'+[guid]::NewGuid()); if(Test-Path -LiteralPath $phaseDNativeWorkspaceRoot){throw 'smoke root must not exist before setup'}; $smokeExit=0; try{$env:THT_PANEL_SMOKE='1'; $env:THT_PANEL_CONFIG_DIR=$phaseDNativeWorkspaceRoot; npm run tauri -- dev; $smokeExit=$LASTEXITCODE} finally {Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue}; if($smokeExit -ne 0){throw "isolated provider setup failed: $smokeExit"}; if(-not (Test-Path -LiteralPath $phaseDNativeWorkspaceRoot -PathType Container)){throw 'isolated root was not created'}`

Expected: 生产ConfigRootResolver确认root由不存在leaf创建、canonical后仍严格位于`src-tauri/target`且无reparse/逃逸；应用只保存两个非生产provider配置并正常退出。无论成功/失败，四个控制环境变量均已清除；`$phaseDNativeWorkspaceRoot`和目录保留，不执行任何目录删除。

Run: `$providerARaw=(Read-Host '输入刚列出的非生产 Provider A canonical lowercase UUID').Trim(); $providerBRaw=(Read-Host '输入刚列出的非生产 Provider B canonical lowercase UUID').Trim(); $providerAParsed=[guid]::ParseExact($providerARaw,'D'); $providerBParsed=[guid]::ParseExact($providerBRaw,'D'); if(-not [string]::Equals($providerARaw,$providerAParsed.ToString('D'),[System.StringComparison]::Ordinal) -or -not [string]::Equals($providerBRaw,$providerBParsed.ToString('D'),[System.StringComparison]::Ordinal)){throw 'provider IDs must be canonical lowercase D UUIDs'}; $phaseDProviderAId=$providerAParsed.ToString('D'); $phaseDProviderBId=$providerBParsed.ToString('D'); if([string]::Equals($phaseDProviderAId,$phaseDProviderBId,[System.StringComparison]::Ordinal)){throw 'two distinct provider IDs are required'}`

Expected: 两个local变量只含本轮新隔离root中的稳定ID，不写环境变量。通过只读probe列出两个Provider显示名/revision、相同modelName、driver/CLI版本、case数量、固定诊断请求、可能费用、审批只ApproveOnce/Deny范围和隔离目录标签；不显示secret、完整baseUrl或完整本机路径。同model隔离必需case优先选择两个同driverProviderRevision；若只能提供跨driver组合，该结果只能作为附加证据，需求6仍标SKIP而非PASS。随后向用户请求本轮明确授权；未获同意时停止并记录SKIP(not authorized)，保持环境变量清空。任何先前回复、其他root或失败run的授权都无效。

- [ ] **Step 7: 运行真实native workspace smoke**

Run: `if([string]::IsNullOrWhiteSpace($phaseDNativeWorkspaceRoot) -or [string]::IsNullOrWhiteSpace($phaseDProviderAId) -or [string]::IsNullOrWhiteSpace($phaseDProviderBId)){throw 'fresh authorized smoke inputs are missing'}; $smokeExit=0; try{$env:THT_PANEL_SMOKE='1'; $env:THT_PANEL_CONFIG_DIR=$phaseDNativeWorkspaceRoot; $env:THT_PANEL_TEST_PROVIDER_A_ID=$phaseDProviderAId; $env:THT_PANEL_TEST_PROVIDER_B_ID=$phaseDProviderBId; npm run test:cli-smoke -- --runtime --native-workspace --confirm-potential-charge --config-root $phaseDNativeWorkspaceRoot --provider-id $phaseDProviderAId --provider-id $phaseDProviderBId; $smokeExit=$LASTEXITCODE} finally {Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue}; if($smokeExit -ne 0){throw "native workspace smoke failed: $smokeExit"}`

Expected: 每case输出PASS/SKIP/FAIL。两个provider已提供且CLI可用时，同model隔离、并发、事件归属和ContextBridge必须PASS；任何隔离串线或协议不兼容为FAIL并阻止Phase D完成。SKIP不能充当需求6或native默认已验收证据。成功或失败后四个控制环境变量均不存在，smoke/evidence root保留且不得自动删除。若需重跑，必须返回Step 6创建另一个此前不存在的root、重新列出inputs/费用并再次询问用户；不能复用本次或更早的人类授权。

- [ ] **Step 8: 代码简化审查并提交隔离/smoke**

使用 `@code-simplifier` 审查harness归属断言、runner case分派和PASS/SKIP/FAIL格式；若修改，重跑Step 5。

```bash
git add src-tauri/tests/native_workspace_isolation.rs src/nativeWorkspaceIsolation.test.tsx src-tauri/src/runtime/smoke.rs src-tauri/src/bin/tht_panel_runtime_smoke.rs src-tauri/tests/runtime_cli_smoke_contract.rs scripts/cli-smoke.mjs package.json
git commit -m "test(native-ui): 增加多供应商原生联调"
```

### Task 16: 完成 Phase D 自动化、手工、安全与迁移验收

**Files:**
- Create: `docs/verification/phase-d-native-workspace.md`
- Verify only: all Phase D files

- [ ] **Step 1: 运行完整前端门禁**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部PASS；无skipped/focused test、act warning、unhandled rejection，native/legacy/terminal三种renderer测试均执行。

- [ ] **Step 2: 运行完整Rust门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部PASS；cursor、switch transaction、execution mode、CSP/capability、keepAlive、rollout、cutover、isolation、QuitGate和Phase A-C回归全部执行。

- [ ] **Step 3: 运行静态安全与旧写路径检查**

Run: `rg -n 'dangerouslySetInnerHTML|rehype-raw|csp"\s*:\s*null|core:default|dialog:default|notification:default|target=._blank|window\.open|EncodedCommand' src src-tauri package.json`

Expected: native消息/安全配置零危险命中；`EncodedCommand`仅允许仍保留的明确legacy terminal compatibility实现并有route gate测试，任何native路径命中FAIL。

Run: `$oldWriterPattern='config_set|configSet|workspace_save|workspaceSave|workspace_delete|workspaceDelete|layout_save|layoutSave|managed_session_(create|update|delete)|managedSession(Create|Update|Delete)|pty_spawn|ptySpawn'; $productionRefs=@(rg -n -g '!**/*.test.*' -g '!**/__tests__/**' -g '!**/fixtures/**' $oldWriterPattern src-tauri/src src); if($LASTEXITCODE -notin 0,1){throw 'final production writer audit failed'}; if($productionRefs.Count -gt 0){$productionRefs; throw 'removed writer remains in production source'}; $dtoRefs=@(rg -n -g '!**/*.test.*' -g '!**/__tests__/**' -g '!**/fixtures/**' 'legacy_dto|legacyDto|LegacyDto' src-tauri/src src); if($LASTEXITCODE -notin 0,1){throw 'final dto audit failed'}; if($dtoRefs.Count -gt 0){$dtoRefs; throw 'deleted dto remains referenced'}`

Expected: `src-tauri/src`与`src`全部生产模块（含compat/application/store/components）中的旧mutation command/API及已删除DTO snake_case/camelCase零命中；负向契约字符串只按Task 13专用测试allowlist审计。

Run: `rg -n "pty_(attach|detach|write|resize|kill)|work_item_runtime_start" src-tauri/src/commands src-tauri/src/lib.rs && rg -n "pty(Attach|Detach|Write|Resize|Kill)|workItemRuntimeStart" src/api`

Expected: 只命中明确保留的PTY attach/detach/write/resize/kill、Tauri注册与`work_item_runtime_start`/BackendClient映射；不得用宽泛`pty_`或`legacy`模式把已移除writer误列为允许项。

Run: `$rustNotificationRefs=@(rg -n "tauri-plugin-notification|tauri_plugin_notification::init|NotificationExt" src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/pty/pump.rs); if($LASTEXITCODE -ne 0 -or $rustNotificationRefs.Count -lt 3){$rustNotificationRefs; throw 'required Rust notification chain is missing'}; $webviewNotificationRefs=@(rg -n "@tauri-apps/plugin-notification|notification:default" src package.json src-tauri/capabilities/default.json); if($LASTEXITCODE -notin 0,1){throw 'WebView notification audit failed'}; if($webviewNotificationRefs.Count -gt 0){$webviewNotificationRefs; throw 'frontend binding or default permission remains'}; $rustNotificationRefs`

Expected: 输出保留Rust notification依赖、init和PTY pump使用；前端binding与WebView默认权限零命中。

- [ ] **Step 4: 运行严格CSP下开发与release构建**

Run: `Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue; $targetRoot=(Resolve-Path 'src-tauri\target').Path; $phaseDSecurityDevRoot=Join-Path $targetRoot ('phase-d-security-dev-'+[guid]::NewGuid()); if(Test-Path -LiteralPath $phaseDSecurityDevRoot){throw 'security dev root must not exist'}; $devExit=0; try{$env:THT_PANEL_SMOKE='1'; $env:THT_PANEL_CONFIG_DIR=$phaseDSecurityDevRoot; npm run tauri -- dev; $devExit=$LASTEXITCODE} finally {Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue}; if($devExit -ne 0){throw "strict CSP dev failed: $devExit"}`

Expected: ConfigRootResolver证明此前不存在的root canonical后严格位于`src-tauri/target`且不是HOME、默认配置、仓库/target根、source/project目录或reparse逃逸。Vite/HMR、本地IPC/Channel订阅、dialog open、xterm、已持久化native消息渲染和外链确认均可用；控制台无CSP violation，外部资源/危险scheme不加载。此步骤只验证开发壳与安全边界，不注入Fake/fixture事件，也不据此声称delta、取消或审批真实执行。成功/失败都清除四个控制环境变量，保留`$phaseDSecurityDevRoot`证据目录且不删除。

Run: `$leaked=@('THT_PANEL_SMOKE','THT_PANEL_CONFIG_DIR','THT_PANEL_TEST_PROVIDER_A_ID','THT_PANEL_TEST_PROVIDER_B_ID' | Where-Object {Test-Path "Env:$_"}); if($leaked.Count -gt 0){throw "smoke env leaked before build: $($leaked -join ',')"}; npm run tauri -- build`

Expected: NSIS构建成功且严格production CSP/capability通过；本阶段只验证构建成功，不做Phase E的最终安装包解包、哈希、签名或installer权限审计。

- [ ] **Step 5: 手工验证fresh/迁移/native/terminal/rollback工作流**

Run: `Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue; $targetRoot=(Resolve-Path 'src-tauri\target').Path; $phaseDManualFreshRoot=Join-Path $targetRoot ('phase-d-manual-fresh-'+[guid]::NewGuid()); if(Test-Path -LiteralPath $phaseDManualFreshRoot){throw 'manual fresh root must not exist'}; $manualExit=0; try{$env:THT_PANEL_SMOKE='1'; $env:THT_PANEL_CONFIG_DIR=$phaseDManualFreshRoot; npm run tauri -- dev; $manualExit=$LASTEXITCODE} finally {Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue}; if($manualExit -ne 0){throw "manual fresh smoke failed: $manualExit"}`

本命令运行的是生产`TauriBackendClient`，不是`FakeBackendClient`或fixture harness。该fresh root不继承Task 15 provider或任何旧授权；若要执行可能计费动作，必须返回Task 15 Step 6创建另一个全新root、重新列明inputs/费用并取得本轮授权，不能复用先前回复。未重新授权时不得点击send/cancel/approval/keepAlive tick，也不得把自动化中的Fake/fixture行为记成`tauri dev`手工PASS；手工记录应写“未执行（未授权）”并引用对应Vitest/Rust/CLI contract命令。

Expected:

1. fresh启动默认v2+native；项目→会话菜单、SavedWorkspace和kind-scoped activeItem仍正常。
2. AI Conversation显示消息流/Composer；Shift+Enter换行、中文IME Enter不误触发提交可离线验证。Enter真实发送、delta→completed替换和cancel仅在Task 15已重新授权时实际执行，否则引用Composer/store/adapter自动化证据。
3. fresh空态和容量文案可见；大历史虚拟滚动、向前分页锚点、near/full行为使用Task 1/2/6自动化与Task 13同一迁移根证据，不在fresh壳中伪造事件。
4. 外链确认、raw HTML/远程图片安全可用已持久化样例或自动化验证；ApprovalRequested/ApproveOnce/Deny/ApprovalResolved/ToolCompleted只在真实已授权case出现时手工验收，否则明确引用审批自动化，不能用Fake卡片冒充Tauri实测。
5. 会话右键可选择enabled provider；无上下文切换和对话框可离线验证。含历史的ContextBridge内容、来源/目标/省略量、limited/manual/new Conversation及重启标记复用Task 13迁移根/自动化证据；真实provider switch模型后续send只归Step 6。
6. 空闲显式legacy terminal模式只挂载一个xterm sink，返回native后TerminalSession仍xterm且不受Conversation模式影响；有live native binding的adapter shutdown和有live legacy PTY的kill/tree-empty/outcome drain由Task 4自动化或Task 15已授权真实case证明。
7. keepAlive必须重新确认费用并显示provider/model/next time；未确认零模型请求。
8. 托盘隐藏不中断PTY，Settings rollback后重启走legacy compatibility且历史/布局保留，重新apply后回native；active turn/approval计数和退出event/outcome收敛只在Task 15已授权真实case执行，否则引用RuntimeActivity/QuitGate自动化证据。

Run: `$leaked=@('THT_PANEL_SMOKE','THT_PANEL_CONFIG_DIR','THT_PANEL_TEST_PROVIDER_A_ID','THT_PANEL_TEST_PROVIDER_B_ID' | Where-Object {Test-Path "Env:$_"}); if($leaked.Count -gt 0){throw "manual smoke env leaked: $($leaked -join ',')"}; if(-not (Test-Path -LiteralPath $phaseDManualFreshRoot -PathType Container)){throw 'manual evidence root missing'}`

Expected: 当前shell四个控制环境变量全部清空；`$phaseDManualFreshRoot`证据目录保留，绝不在finally或验收步骤删除smoke/evidence目录。

- [ ] **Step 6: 汇总真实CLI PASS/SKIP/FAIL**

只引用Task 15本轮明确授权对应的最新真实输出。按driver/case记录：版本、stream、multi-turn、cancel、approval、provider switch、同model双provider隔离、terminal compatibility、shutdown。缺CLI/manifest false能力可SKIP；已安装配置但协议/隔离/安全失败必须FAIL。任何必需Codex baseline、已声明支持能力或双provider隔离FAIL时Phase D保持未完成。若需要重跑，必须返回Task 15 Step 6使用另一个此前不存在的root并再次询问用户；不得复用旧授权或只重复`--confirm-potential-charge`。

- [ ] **Step 7: 执行最终代码简化并重跑受影响门禁**

以下命令与`@code-simplifier`在同一PowerShell会话执行。调用skill前先要求Phase D代码scope干净，并同时拒绝unstaged/staged tracked deletion、rename和既有staged内容；任何命中都停止并单独向用户报告，不能让simplifier或后续`git add`吸收：

Run: `$phaseDCodeScope=@('src','src-tauri/src','src-tauri/tests','scripts','package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock'); $preCached=@(git diff --cached --name-only); $preUnstagedDeletes=@(git diff --diff-filter=D --name-only); $preStagedDeletes=@(git diff --cached --diff-filter=D --name-only); $preUnstagedRenames=@(git diff --diff-filter=R --name-only); $preStagedRenames=@(git diff --cached --diff-filter=R --name-only); $preScopeStatus=@(git status --porcelain --untracked-files=all -- $phaseDCodeScope); if($preCached.Count -gt 0 -or $preUnstagedDeletes.Count -gt 0 -or $preStagedDeletes.Count -gt 0 -or $preUnstagedRenames.Count -gt 0 -or $preStagedRenames.Count -gt 0 -or $preScopeStatus.Count -gt 0){$preCached;$preUnstagedDeletes;$preStagedDeletes;$preUnstagedRenames;$preStagedRenames;$preScopeStatus;throw 'code-simplifier preflight requires globally empty index clean scope and separately authorized deletion or move'}`

Expected: scope干净、staged/unstaged deletion与rename均为零；没有执行`git add`。

使用`@code-simplifier`对Phase D最近修改代码做行为保持终审，重点检查cursor/generation、delta内存、ContextBridge事务、single-sink router、Markdown/URL、keepAlive、rollout和legacy cutover。skill返回后先盘点，不暂存：

Run: `$postCached=@(git diff --cached --name-only); $postUnstagedDeletes=@(git diff --diff-filter=D --name-only); $postStagedDeletes=@(git diff --cached --diff-filter=D --name-only); $postUnstagedRenames=@(git diff --diff-filter=R --name-only); $postStagedRenames=@(git diff --cached --diff-filter=R --name-only); $unexpectedUntracked=@(git status --porcelain --untracked-files=all -- $phaseDCodeScope | Where-Object {$_ -match '^\?\?'}); if($postCached.Count -gt 0 -or $postUnstagedDeletes.Count -gt 0 -or $postStagedDeletes.Count -gt 0 -or $postUnstagedRenames.Count -gt 0 -or $postStagedRenames.Count -gt 0 -or $unexpectedUntracked.Count -gt 0){$postCached;$postUnstagedDeletes;$postStagedDeletes;$postUnstagedRenames;$postStagedRenames;$unexpectedUntracked;throw 'code-simplifier must leave global index empty and proposed deletion move or untracked file requires separate approval'}; $codeFiles=@(git diff --diff-filter=ACMTUXB --name-only -- $phaseDCodeScope | Sort-Object -Unique); $allTracked=@(git diff --name-only | Sort-Object -Unique); $unexpectedTracked=@(Compare-Object -ReferenceObject $codeFiles -DifferenceObject $allTracked | Where-Object {$_.SideIndicator -eq '=>'} | ForEach-Object {$_.InputObject}); if($unexpectedTracked.Count -gt 0){$unexpectedTracked;throw 'code-simplifier changed files outside exact Phase D code scope'}; if($codeFiles.Count -eq 0){$simplifierChanged=$false; Write-Output 'SKIP: code-simplifier found no behavior-preserving simplification'}else{$simplifierChanged=$true; $codeFiles}`

Expected: 无删除、移动、untracked或scope外修改。`$simplifierChanged=false`时记录SKIP并直接进入Step 8，不创建空提交；不得把“无需修改”当失败。

仅当`$simplifierChanged=true`时，按`$codeFiles`所属Task重跑全部聚焦测试，并重新执行本Task Steps 1-4；任一失败先修复并重复本盘点。全部通过后，暂存前再次检查unstaged/staged deletion/rename，做精确diff与cached scope复核：

Run: `if($simplifierChanged){$cachedBeforeAdd=@(git diff --cached --name-only); $beforeAddDeletes=@(git diff --diff-filter=D --name-only)+@(git diff --cached --diff-filter=D --name-only); $beforeAddRenames=@(git diff --diff-filter=R --name-only)+@(git diff --cached --diff-filter=R --name-only); if($cachedBeforeAdd.Count -gt 0 -or $beforeAddDeletes.Count -gt 0 -or $beforeAddRenames.Count -gt 0){$cachedBeforeAdd;$beforeAddDeletes;$beforeAddRenames;throw 'global index pollution deletion or move appeared before staging'}; git diff --check -- $codeFiles; if($LASTEXITCODE -ne 0){throw 'simplifier diff check failed'}; git add -- $codeFiles; if($LASTEXITCODE -ne 0){throw 'failed to stage exact simplifier files'}; $cachedDeletes=@(git diff --cached --diff-filter=D --name-only); $cachedRenames=@(git diff --cached --diff-filter=R --name-only); $cachedFiles=@(git diff --cached --name-only | Sort-Object -Unique); $scopeMismatch=@(Compare-Object -ReferenceObject $codeFiles -DifferenceObject $cachedFiles); if($cachedDeletes.Count -gt 0 -or $cachedRenames.Count -gt 0 -or $scopeMismatch.Count -gt 0){$cachedDeletes;$cachedRenames;$scopeMismatch;throw 'cached deletion move or scope mismatch'}; git diff --cached --check; if($LASTEXITCODE -ne 0){throw 'cached simplifier diff check failed'}; $cachedFiles; git commit -m "refactor(native-ui): 简化原生工作区实现"; if($LASTEXITCODE -ne 0){throw 'simplifier commit failed'}}else{Write-Output 'SKIP: no simplifier commit created'}`

Expected: 有修改时只暂存打印出的精确文件，cached deletion/rename为零、cached scope与`$codeFiles`完全一致并单独commit；无修改时只打印SKIP。不得把代码修改混入文档提交，也不得执行未经授权的删除/移动。

- [ ] **Step 8: 写入脱敏验收记录并使用完成前验证**

`docs/verification/phase-d-native-workspace.md`记录Phase D base/HEAD、commits、自动化命令、CSP/capability、migration cutover、fresh/rollback、ContextBridge、single sink、keepAlive和真实CLI PASS/SKIP/FAIL，并把“自动化证据”“实际tauri dev手工动作”“获授权真实CLI”分栏；未执行项必须写明未授权/能力不支持原因，不能把Fake/fixture自动化标成手工PASS。不得记录secret、完整本机路径、模型正文、工具原文、原生session/thread ID或用户对话。

使用`@superpowers:verification-before-completion`基于最新输出逐项核对；任何门禁失败、未获必需删除授权、旧写路径仍注册或真实必需case FAIL时不得宣布Phase D完成。

```bash
git add docs/verification/phase-d-native-workspace.md
git commit -m "test(native-ui): 记录Phase D验收证据"
```

- [ ] **Step 9: 核对提交范围、Chunk行数和干净状态**

Run: `git diff --check && git status --short`

Expected: worktree干净；无raw CLI输出、smoke config、event journal、runtime outcome、secret blob、生成binary或用户原有文件被提交。

Run: `$first=git log --grep='^feat(native-ui): 增加会话事件窗口边界$' -n 1 --format='%H'; if(-not $first){throw 'Phase D first commit not found'}; $base=git rev-parse "$first^"; git diff --name-only "$base..HEAD"`

Expected: 文件逐项属于Tasks 1-16；删除项只有Task 13再次获批的`src-tauri/src/compat/legacy_dto.rs`，不含Phase E GC/installer审计或用户原有改动。

Run: `$p='docs/superpowers/plans/2026-07-10-panel-redesign-phase-d-native-workspace.md'; $lines=Get-Content -LiteralPath $p; $starts=@(for($i=0;$i -lt $lines.Count;$i++){if($lines[$i] -match '^## Chunk '){$i}}); for($i=0;$i -lt $starts.Count;$i++){ $end=if($i+1 -lt $starts.Count){$starts[$i+1]}else{$lines.Count}; $n=$end-$starts[$i]; if($n -gt 1000){throw "Chunk $($i+1) exceeds 1000 lines: $n"} }`

Expected: 三个Chunk均≤1000行；所有实施Step使用checkbox，任务均有精确Files/Run/Expected、TDD红绿、`@code-simplifier`和独立commit。

- [ ] **Step 10: 最终计划/实现评审与Phase E边界确认**

使用plan-document-reviewer按设计规格、roadmap和Phase A-C最终计划复核三个Chunk。必须明确确认：BackendClient/Tauri/Fake订阅、generation/cursor、delta/完成、virtualization/capacity、IME/cancel、审批gate、安全Markdown/CSP/capability/外链、ContextBridge事务、任意provider切换、native/terminal/legacy单sink、RuntimeActivity/QuitGate/tray/keepAlive费用、native默认/rollback、删除再授权、同model隔离和PASS/SKIP/FAIL均有源码/测试/手工证据。

Phase D完成时仍不得执行：孤儿event/checkpoint/secret/runtime目录最终GC、smoke证据目录清理、installer解包/签名/权限终审、长期性能与崩溃压力审计；这些明确留给Phase E或用户另行授权任务。
