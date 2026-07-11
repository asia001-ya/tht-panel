# Panel Redesign Phase C Runtime Adapters Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `nativeAiEnabled` 继续默认关闭且 legacy PTY AI 路径完整保留的前提下，交付经过版本化固定样例验证的 Codex app-server 与 Claude stream-json `RuntimeAdapter`、`ConversationManager`、统一事件、进程隔离、取消/审批/恢复和退出生命周期，为 Phase D 原生消息工作区提供稳定后端能力。

**Architecture:** Rust 后端新增独立 `runtime/` 协议与适配器层：Codec 只理解字节帧和 RPC envelope，driver adapter 只理解各自协议，`ConversationManager` 负责领域状态、运行段和事件提交，`RuntimeActivityRegistry` 统一聚合 PTY 与原生 AI 活动。每个 `ProviderRevision` 使用不可变命名空间和净化环境；Codex 按修订共享一个默认 stdio JSONL app-server，Claude 每个活动运行段独占一个 stream-json 进程；前端仅新增可注入 API、事件类型和显式可能计费的连接测试，不在 Phase C 切换工作区渲染路径。

**Tech Stack:** Rust 2021、Tauri 2、serde/serde_json、crossbeam-channel、parking_lot、Windows Job Object/匿名管道、React 19、TypeScript、Zustand、Vitest、Codex app-server JSONL、Claude stream-json、Phase A/B 的 DPAPI/Repositories/QuitGate/BackendClient/FakeBackendClient。

---

## Chunk 1: 协议契约、固定样例、事件日志与安全进程边界

### Phase C 硬边界与官方基线

- Phase C 开始前必须已通过 Phase A/B 门禁；本计划直接复用其 `ApplicationMutationGate`、`QuitGate`、`RuntimeOutcomeStore`、`ConversationEventStore`、`ProcessTreeController`、稳定 `WorkItemRef`、`ProviderRevision` 命名空间和可注入 `BackendClient`，不得复制第二套锁、事件文件或 secret store。
- `FeatureFlags.nativeAiEnabled` 在整个 Phase C 仍默认且保持 `false`；不得新增可把它设为 `true` 的设置 UI/通用 FeatureFlags 写接口。Ready 工作区继续通过 `work_item_runtime_start` 走 legacy PTY AI；旧 DTO、旧命令、CompatibilityFacade、`LegacyLaunchService`、PTY/xterm 和终端兼容模式均不得删除。
- Codex 官方协议基线固定为默认 stdio JSONL：`initialize` 请求收到成功响应后才能发送 `initialized` 通知，随后使用 `thread/start` 或 `thread/resume`、`turn/start`，取消使用 `turn/interrupt`。审批严格按 `item/*/requestApproval` server request → 客户端 response → `serverRequest/resolved` → `item/completed` 收敛；响应审批不能提前伪造 item 完成。
- Codex 依据固定为 <https://learn.chatgpt.com/docs/app-server> 与 <https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers>。自定义 `model_provider` 名称必须按 `providerRevisionId` 生成唯一 namespace，且禁止使用 `openai`、`ollama`、`lmstudio`。
- Claude 只使用本计划采集并脱敏、且 manifest 精确绑定 CLI 版本的 stream-json fixture。任何没有 fixture 证据的 `streaming/multiTurn/nativeResume/cancelTurn/toolEvents/approvals/partialMessages` 一律为 `false`；不得从 `--help` 参数、字段名称、旧版本经验或 Codex 行为类推。
- 所有原生 external session/thread ID 都继续由 `NativeSessionId` 强类型承载，但 parser 必须绑定 manifest 中的 `driver + cliVersion + protocolVersion + fixtureVersion + nativeIdGrammar`。`nativeIdGrammar` 只能取代码内闭合枚举 `CanonicalUuidV1 | AsciiOpaqueV1`；后者固定 `1..=128` bytes 且字符集仅 `[A-Za-z0-9._:-]`，不接受 manifest 自带任意 regex。若真实 fixture 出现枚举外 grammar，capture 失败且 native resume 保持 false，必须另行评审新增 grammar，不能放宽为“任意无空白字符串”。Phase A legacy Claude/Codex argv resume 仍只接受 canonical lowercase UUID；其历史 JSON plain-string 表示必须兼容读回并原样 round-trip。opaque variant 不能转换为 path/argv。Provider/Revision/Conversation/Segment ID 继续使用 canonical typed UUID；原生 request/turn/item ID 只能进入另一个有长度和字符集上限的协议 opaque ID，不得复用作路径、argv、NativeSessionId 或供应商归属。
- 真实密钥只从 `SecretStore` 取出并进入子进程 secret environment；不得进入 argv、Debug/Display、错误、日志、统一事件、fixture、Tauri payload、Zustand 或 WebView。baseUrl、cwd、配置根和原始协议 payload 也不得进入公共错误；需要诊断时只输出 driver、稳定错误码、CLI 版本和闭合 case ID。
- Phase C 固定初始容量常量并用测试锁定：运行时协议 JSONL frame 的 compact serialized line（含换行）`1 MiB`；事件存储 JSONL 的 compact serialized line（含 envelope、转义和换行）独立上限 `2 MiB`；其中非助手完成事件 serialized line `512 KiB`、`AssistantMessageCompleted` serialized line `2 MiB`、持久化工具正文原始 UTF-8 `256 KiB`；版本探测输出 `64 KiB`、单 turn 持久化 staging bytes `4 MiB`、单会话事件文件 `64 MiB`、单消息内存 delta 原始 UTF-8 `2 MiB`、单 turn 总内存 `8 MiB`、Codex pending RPC `256`、单 segment pending approval `16`、共享 Codex app-server 活动 thread `32`、恢复上下文 `200` 条且 compact serialized 总计 `256 KiB`。所有 serialized 限制都在 JSON escaping 后计算，最坏转义不得绕过；协议 frame 和事件 line 使用不同常量/decoder。越限必须在可能计费的外部请求前拒绝，或在已开始 turn 中显式截断并记录 `truncated/originalByteCount`；不得静默丢数据、无限增长或把原始超限内容写入错误。
- `AssistantDelta` 只存在进程内事件总线和 Tauri Channel，永不写 JSONL；只有规范化完成事件和状态转换进入 `conversation-events/<conversationId>.jsonl`。崩溃后允许丢失尚未完成的 delta，但必须保留已提交完成事件、收敛 segment/turn 状态，并且不能伪造一条“完整助手消息”。

### 文件职责图

- `src-tauri/src/runtime/adapter.rs`：driver 无关的 `RuntimeAdapter`、binding、turn、approval 和 event sink 接口。
- `src-tauri/src/runtime/capabilities.rs`：严格版本匹配、fixture evidence 和 resume compatibility；未知版本全 false。
- `src-tauri/src/runtime/protocol/`：增量 JSONL 与 RPC envelope，不包含 Codex/Claude 业务映射。
- `src-tauri/src/runtime/process/`：可替换 raw-stdio process host、净化环境、Job Object 和超时；不理解会话事件。
- `src-tauri/src/runtime/codex/`：Codex app-server 握手、共享修订池、thread/turn/审批/取消和恢复。
- `src-tauri/src/runtime/claude/`：Claude stream-json 版本化解析、独占进程和受限历史重建。
- `src-tauri/src/application/conversation_manager.rs`：领域状态机、RuntimeSegment、事件提交、adapter 编排。
- `src-tauri/src/application/runtime_activity_registry.rs`：PTY 与原生 AI 活动快照；托盘/退出只读此聚合边界。
- `src-tauri/src/storage/conversation_event_append.rs`：完成事件 staging+journal append、配额和崩溃恢复；adapter 不直接写文件。
- `src-tauri/runtime-fixtures/v1/`：版本化 manifest 和脱敏固定样例；runtime 只加载 manifest 明确列出的 case。

### Task 1: 固定 RuntimeAdapter、ID、能力和容量契约

**Files:**
- Create: `src-tauri/src/runtime/mod.rs`
- Create: `src-tauri/src/runtime/adapter.rs`
- Create: `src-tauri/src/runtime/ids.rs`
- Create: `src-tauri/src/runtime/limits.rs`
- Create: `src-tauri/src/runtime/capabilities.rs`
- Modify: `src-tauri/src/domain/driver.rs`
- Modify: `src-tauri/src/domain/id.rs`
- Modify: `src-tauri/src/domain/conversation.rs`
- Modify: `src-tauri/src/domain/conversation_event.rs`
- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/runtime_contracts.rs`

- [ ] **Step 1: 写失败测试固定 adapter 接口、严格 ID 和默认失败封闭能力**

新增：

- `runtime_adapter_start_send_cancel_approve_shutdown_are_driver_neutral`
- `runtime_adapter_start_does_not_accept_per_binding_sink_for_shared_service_control`
- `runtime_output_relay_binds_one_application_sink_before_any_process_start`
- `runtime_binding_never_serializes_driver_private_state`
- `runtime_sink_carries_persistable_events_and_internal_control_events_without_tauri_serialization`
- `runtime_shared_recovery_control_plan_is_driver_neutral_redacted_and_revision_scoped`
- `runtime_turn_and_approval_ids_reject_empty_whitespace_control_and_oversize`
- `runtime_native_session_schema_is_bound_to_driver_protocol_and_fixture`
- `runtime_legacy_resume_native_session_id_still_requires_canonical_uuid`
- `runtime_legacy_native_session_plain_json_string_reopens_and_round_trips_unchanged`
- `runtime_native_session_tagged_json_requires_exact_cli_protocol_fixture_and_closed_grammar`
- `runtime_fixture_proven_opaque_native_session_id_is_bounded_and_not_path_or_argv_capable`
- `runtime_native_session_id_rejects_option_response_file_whitespace_control_and_unproven_aliases`
- `runtime_unknown_driver_version_returns_all_capabilities_false`
- `runtime_capability_true_requires_fixture_case_evidence`
- `runtime_resume_compatibility_requires_explicit_matrix_edge`
- `runtime_limits_match_phase_c_constants`
- `runtime_protocol_and_event_jsonl_limits_are_distinct_and_serialized_byte_based`
- `runtime_public_debug_omits_secret_env_argv_payload_cwd_and_base_url`
- `runtime_error_codes_are_stable_and_redacted`

测试使用 `CompileOnlyAdapter` 实现 trait，确保接口不依赖 Tauri、WebView 或具体 driver。`NativeSessionId` 的 legacy UUID variant 必须复用 Phase A parser；protocol opaque variant 只能由 exact fixture schema 构造，不能在 runtime 层新增“任意单 token”fallback。

- [ ] **Step 2: 运行契约测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_contracts`

Expected: FAIL，`runtime` 模块、能力 matrix 和协议 ID 尚不存在；不得是 `0 tests`。

- [ ] **Step 3: 定义最小 adapter 与事件 sink 接口**

核心接口固定为同步提交、异步事件回调模型；方法不得返回模型正文：

```rust
pub trait RuntimeAdapter: Send + Sync {
    fn capabilities(&self) -> &RuntimeCapabilities;
    fn start_or_resume(
        &self,
        request: AdapterStartRequest,
    ) -> Result<AdapterBinding, AppError>;
    fn start_turn(
        &self,
        binding: &AdapterBinding,
        request: AdapterTurnRequest,
    ) -> Result<RuntimeTurnId, AppError>;
    fn cancel_turn(
        &self,
        binding: &AdapterBinding,
        turn_id: &RuntimeTurnId,
    ) -> Result<(), AppError>;
    fn resolve_approval(
        &self,
        binding: &AdapterBinding,
        request_id: &ApprovalRequestId,
        decision: ApprovalDecision,
    ) -> Result<(), AppError>;
    fn shutdown(
        &self,
        binding: &AdapterBinding,
        deadline: std::time::Instant,
    ) -> Result<(), AppError>;
}
```

`AdapterBinding` 是不可序列化的内部 enum，只保存 typed revision/segment/binding generation 和 driver 私有 handle；自定义 `Debug` 只显示 driver、segment ID 后四位和 generation。`ApprovalDecision` 在 Phase C 仅允许 `ApproveOnce | Deny`，不得出现永久允许。每个 adapter/factory/shared pool 在构造时注入同一个 application-scoped `RuntimeOutputRelay`；bootstrap 必须在开放任何 start/send 前把 relay 恰好一次绑定到 ConversationManager sink。`start_or_resume` 不接受 per-binding sink，避免共享 app-server crash 时 control plan 只到达某一个 Conversation。未绑定、重复绑定或 sink emit 失败都失败封闭并零 process start/拒绝该 revision 新 turn。`RuntimeEventSink` 只接收闭合 `RuntimeAdapterOutput`，不接受任意 JSON：

```rust
pub enum RuntimeAdapterOutput {
    Event(RuntimeEventEnvelope),
    Control(RuntimeControlEvent),
}

pub enum RuntimeControlEvent {
    SharedServiceRecoveryRequired(SharedServiceRecoveryPlan),
}

pub trait RuntimeEventSink: Send + Sync {
    fn emit(&self, output: RuntimeAdapterOutput) -> Result<(), AppError>;
}
```

`SharedServiceRecoveryPlan` 是 driver-neutral、revision-scoped 的内部结构，只含 driver、typed provider revision、失败 server generation 和 bounded `RuntimeRecoveryCandidate` 列表；candidate 只含 source segment、冻结 revision/model/cwd、版本化 `NativeSessionId` 和旧 adapter/protocol version。它不实现 serde、不进入事件 JSONL/Tauri/WebView，并使用脱敏 Debug。异步 reader crash、cancel timeout 和 process exit 都通过同一 sink control output 把 plan 交给 `ConversationManager`；不得依赖 `cancel_turn` 返回值传递异步恢复。control emit 失败时该 revision 保持 Draining/Failed并拒绝新 turn，不能静默丢 plan 后重启服务。

`NativeSessionId` 在本任务扩展为 versioned enum：legacy UUID variant 可被既有 PTY argv resume formatter 使用；自定义 serde 读取历史 plain JSON string 时只接受 canonical lowercase UUID并在再次写出时保持 plain string；新 protocol variant 使用 tagged object，必须携带 `driver/cliVersion/protocolVersion/fixtureVersion/nativeIdGrammar`。opaque value 只能由 CapabilityRegistry 返回的 exact manifest schema 构造，仅能序列化进经过 fixture 验证的 JSON/RPC 字段，类型层不提供 path/argv formatter。repository open、fixture load 和 adapter response 都必须重跑相同 validator。

- [ ] **Step 4: 实现能力 matrix 的 exact-match 语义**

`RuntimeCapabilities` 保留 Phase A 七个布尔字段，并增加已存在的 `driver/cliVersion/protocolVersion/fixtureVersion` 证据字段。`CapabilityRegistry::resolve(driver, cliVersion, protocolVersion)` 只接受 manifest 精确项；未知版本、未知协议、fixture hash 不匹配或 true capability 缺 case evidence 时返回全 false，并附内部 `unsupportedReasonCode`，但公共 DTO 不返回本机路径或原始输出。

resume compatibility 是有向边 `(driver, fromCliVersion, fromProtocolVersion) -> (toCliVersion, toProtocolVersion)`；没有显式边即 false。历史 `capabilitySnapshot` 只解释旧事件，永不授权新进程调用。

- [ ] **Step 5: 固定容量常量与越限错误**

在 `limits.rs` 分别定义 `MAX_PROTOCOL_JSONL_FRAME_BYTES`、`MAX_EVENT_JSONL_LINE_BYTES`、`MAX_NON_ASSISTANT_EVENT_LINE_BYTES`、`MAX_ASSISTANT_EVENT_LINE_BYTES` 及本 Chunk 其余常量，不允许散落 magic number。serialized line 限制统一包含 compact envelope、JSON escaping 与尾随换行；原始正文上限不能替代 serialized 校验。新增稳定错误：

- `PROTOCOL_LIMIT/运行时协议消息超过容量上限`
- `EVENT_CAPACITY/会话事件容量已满，请先归档或新建会话`
- `UNSUPPORTED_RUNTIME_VERSION/当前 CLI 版本未通过固定样例验证`
- `NATIVE_AI_DISABLED/原生 AI 仍处于关闭状态`
- `APPROVAL_NOT_PENDING/审批请求已失效`

错误内部 source 自定义 `Debug/Display` 也不得含原始行、prompt、工具输出、密钥、cwd 或 URL。

- [ ] **Step 6: 运行测试、格式检查和代码简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_contracts && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；未知 Claude/Codex 版本能力全部 false，所有限制值与本计划一致。

使用 `@code-simplifier` 审查 ID wrapper、能力默认值和错误映射；若修改，重跑本步骤。

- [ ] **Step 7: 提交运行时契约**

```bash
git add src-tauri/src/runtime src-tauri/src/domain/driver.rs src-tauri/src/domain/id.rs src-tauri/src/domain/conversation.rs src-tauri/src/domain/conversation_event.rs src-tauri/src/error.rs src-tauri/src/lib.rs src-tauri/tests/runtime_contracts.rs
git commit -m "feat(runtime): 固定适配器与能力契约"
```

### Task 2: 建立版本化脱敏 fixture、采集器和能力矩阵

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `scripts/capture-runtime-fixtures.mjs`
- Create: `src-tauri/src/bin/tht_panel_runtime_fixture_capture.rs`
- Create: `src-tauri/src/runtime/fixture_manifest.rs`
- Create: `src-tauri/src/runtime/fixture_sanitizer.rs`
- Modify: `src-tauri/src/runtime/ids.rs`
- Modify: `src-tauri/src/runtime/capabilities.rs`
- Create: `src-tauri/runtime-fixtures/v1/manifest.json`
- Create: `src-tauri/runtime-fixtures/v1/codex/stdio-baseline.jsonl`
- Create: `src-tauri/runtime-fixtures/v1/codex/approval-flow.jsonl`
- Create: `src-tauri/runtime-fixtures/v1/codex/cancel-flow.jsonl`
- Create: `src-tauri/runtime-fixtures/v1/claude/verified-stream-json.jsonl`
- Create: `src-tauri/runtime-fixtures/v1/claude/fixture-status.json`
- Create: `src-tauri/runtime-fixtures/v1/README.md`
- Test: `src-tauri/tests/runtime_fixtures.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

- [ ] **Step 1: 写失败测试固定 manifest、证据与脱敏规则**

新增：

- `fixture_manifest_requires_exact_driver_cli_protocol_and_fixture_versions`
- `fixture_manifest_true_capability_requires_existing_case_and_sha256`
- `fixture_manifest_resume_edge_references_two_existing_entries`
- `fixture_manifest_native_id_schema_requires_closed_grammar_and_exact_version_tuple`
- `fixture_manifest_rejects_arbitrary_regex_unknown_grammar_and_opaque_over_128_bytes`
- `fixture_manifest_claude_unproven_capability_is_false`
- `fixture_manifest_codex_capability_remains_false_until_captured_case_hash_matches`
- `claude_capture_missing_target_version_hash_or_required_case_evidence_fails`
- `fixture_sanitizer_replaces_uuid_native_ids_with_canonical_fixture_uuids`
- `fixture_sanitizer_replaces_opaque_native_ids_with_schema_valid_fixture_tokens`
- `fixture_sanitizer_replaces_project_config_and_home_paths`
- `fixture_sanitizer_rejects_secret_environment_values_and_high_entropy_sentinel`
- `fixture_sanitizer_rejects_raw_prompt_model_output_and_tool_output`
- `fixture_sanitizer_preserves_method_event_order_and_json_types`
- `fixture_tree_contains_no_absolute_user_path_secret_or_real_conversation`
- `fixture_case_hashes_are_reproducible`

fixture 只保留协议结构、闭合 case label、固定占位文本和 canonical fixture UUID；用户 prompt、模型原文、命令输出、项目名、HOME、baseUrl、密钥和认证 header 均不得保留。

- [ ] **Step 2: 运行 fixture 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures`

Expected: FAIL，manifest loader/sanitizer 和 fixture 树尚不存在。

- [ ] **Step 3: 实现无费用 probe 与 raw capture 隔离**

`package.json` 增加：

```json
{
  "scripts": {
    "capture:runtime-fixtures": "node scripts/capture-runtime-fixtures.mjs"
  }
}
```

默认 `npm run capture:runtime-fixtures -- --probe-only` 只按 Phase A Windows executable resolver 运行 `--version`/必要的只读 help，最多读取 `64 KiB`、5 秒超时，不注入 provider secret、不发送模型请求，输出只有 driver、version 和 PASS/SKIP。raw capture 只能写 `src-tauri/target/runtime-fixture-capture/<uuid>/`；`.gitignore` 明确忽略该目录。采集器参数和日志不得接受/打印密钥、prompt 或 baseUrl。

- [ ] **Step 4: 实现确定性 sanitizer 和 manifest loader**

sanitizer 读取 raw bytes 后立即进入 `Zeroizing<Vec<u8>>`，逐条解析并输出规范 JSONL；UUID 按出现顺序映射为固定 canonical UUID。capture 对 native ID 只允许判定为 `CanonicalUuidV1` 或 `AsciiOpaqueV1`，并把闭合 grammar、最大 bytes 和实际 `driver/cliVersion/protocolVersion/fixtureVersion` 写入 manifest；若观测值不满足任一代码内 grammar，整次 capture 失败且不得写 manifest。opaque native ID 映射为同 grammar 的固定 token，路径映射为 `$PROJECT/$CONFIG/$HOME`，文本正文替换为 `fixture-user-message`、`fixture-assistant-message`、`fixture-tool-output`。未知可能敏感字段、无法分类的二进制/高熵值、超限行或非 UTF-8 使整次采集失败，不能“尽量保留”。

manifest 每项保存 `driver/cliVersion/protocolVersion/fixtureVersion/nativeIdSchema/caseId/fileSha256/capabilities/resumeCompatibility`。`nativeIdSchema` 使用闭合 grammar discriminator，不能携带任意 regex；`ids.rs` 只接受 CapabilityRegistry 返回的 exact schema构造 protocol NativeSessionId。runtime 用 `include_bytes!` 编译已批准 manifest/fixtures；启动不扫描用户目录猜版本样例。

- [ ] **Step 5: 先写 Codex 官方 case 断言并确认 capture 缺失时保持红灯**

依据官方 app-server 文档为三个 case 写结构/顺序断言，但 manifest 初始能力仍全 false：`stdio-baseline` 要求默认 stdio JSONL、`initialize` success response 先于客户端 `initialized`、`thread/start|resume`、`turn/start` 和 `item/completed`；`approval-flow` 要求 `item/*/requestApproval → client response → serverRequest/resolved → item/completed`；`cancel-flow` 要求 `turn/interrupt` 和明确终态。断言只能描述官方 method/order，不得手写声称来自真实 CLI 的 payload。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures codex_capture_`

Expected: FAIL，错误明确指出三个 Codex case 尚无目标 CLI 版本、sanitized file hash 和 capture evidence；不得因官方文档存在就把版本能力设为 true。

- [ ] **Step 6: 在任何可能计费的 capture 前取得用户明确同意**

先向用户说明将使用哪个非生产测试 ProviderRevision、模型、空测试目录、固定诊断 prompt、审批/取消 case、预计会发起真实模型请求并可能产生费用；未得到明确同意时只保留 probe 和全 false 能力项，停止本步骤，不能用用户全局认证或生产 provider 替代。

下列 Codex/Claude capture 命令中的尖括号 Provider ID 必须在执行前替换为本轮确认的实际非生产 Provider ID，禁止将模板字面量传给采集器。

- [ ] **Step 7: 采集 Codex baseline/审批/取消并让红测转绿**

Run: `npm run capture:runtime-fixtures -- --driver codex --capture --cases stdio-baseline,approval-flow,cancel-flow --confirm-potential-charge --provider-id '<TEST_CODEX_PROVIDER_ID>'`

Expected: raw 文件只在 `src-tauri/target/runtime-fixture-capture/`；sanitized 输出分别写入三个固定 Codex fixture，manifest 记录实际 CLI/protocol/fixture版本、hash和能力证据。capture必须实际观察initialize响应后initialized、new/resume thread、turn start/interrupt及完整审批链；任一case未触发或与官方baseline冲突即FAIL并保持对应能力false，不能修改adapter去“兼容猜测”。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures codex_capture_`

Expected: PASS；三个case hash匹配且所有Codex正向能力都能反查具体case ID。

- [ ] **Step 8: 先运行 Claude capture 证据测试并确认保持红灯**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures claude_capture_`

Expected: FAIL，明确指出目标 Claude CLI/protocol/fixture version、sanitized file hash 或最低 required case evidence 尚缺；“所有能力 false”不能让本测试通过，也不得是 `0 tests`。

- [ ] **Step 9: 采集并验证 Claude fixture，未验证能力保持 false**

Run: `npm run capture:runtime-fixtures -- --driver claude --capture --confirm-potential-charge --provider-id '<TEST_CLAUDE_PROVIDER_ID>'`

Expected: raw 文件只在 `src-tauri/target/runtime-fixture-capture/`；sanitized 输出写入 `src-tauri/runtime-fixtures/v1/claude/verified-stream-json.jsonl`，`fixture-status.json` 记录实际 CLI/protocol/fixture version、native ID schema、hash和每项能力证据。最低 required baseline 至少包含一次 input、流式或完成 assistant output、明确 terminal result；没有观察到的审批、取消、工具、partial 或多轮事件对应能力必须保持 false。采集失败/CLI缺失时不得创建伪造正向 fixture，`claude_capture_` 继续 FAIL且Phase C未完成。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures claude_capture_`

Expected: PASS；同一组 capture 证据测试由实际目标版本/hash/case 从红转绿，未观察能力仍为 false。

- [ ] **Step 10: 运行 fixture 绿测与静态扫描**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures`

Expected: PASS；每个 true capability 有存在且 hash 匹配的 case，Claude未观察能力为false，Codex三条官方case完整。

Run: `rg -n "api[_-]?key|authorization|bearer|ANTHROPIC_|OPENAI_|[A-Z]:\\\\|/Users/|/home/" src-tauri/runtime-fixtures`

Expected: 空输出；fixture README 中需要描述安全规则时使用泛化名称，不写真实环境键值或路径。

- [ ] **Step 11: 代码简化审查并提交 fixture 基础设施与样例**

使用 `@code-simplifier` 审查 sanitizer 是否存在重复字段遍历或宽松 fallback；若修改，重跑 Step 10。

```bash
git add .gitignore package.json scripts/capture-runtime-fixtures.mjs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/bin/tht_panel_runtime_fixture_capture.rs src-tauri/src/runtime/fixture_manifest.rs src-tauri/src/runtime/fixture_sanitizer.rs src-tauri/src/runtime/ids.rs src-tauri/src/runtime/capabilities.rs src-tauri/runtime-fixtures src-tauri/tests/runtime_fixtures.rs
git commit -m "test(runtime): 固定版本化协议样例"
```

### Task 3: 实现有界增量 JSONL 与 RPC codec

**Files:**
- Create: `src-tauri/src/runtime/protocol/mod.rs`
- Create: `src-tauri/src/runtime/protocol/jsonl.rs`
- Create: `src-tauri/src/runtime/protocol/rpc.rs`
- Create: `src-tauri/src/runtime/protocol/secure_summary.rs`
- Modify: `src-tauri/src/runtime/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Test: `src-tauri/tests/runtime_protocol.rs`

- [ ] **Step 1: 写失败测试覆盖任意分片、RPC 相关性和上限**

新增：

- `protocol_jsonl_decoder_handles_every_utf8_and_newline_split`
- `protocol_jsonl_decoder_handles_crlf_without_including_carriage_return`
- `protocol_jsonl_decoder_rejects_bom_invalid_utf8_and_eof_partial_line`
- `protocol_jsonl_decoder_rejects_serialized_frame_over_one_mib_before_allocation_growth`
- `protocol_jsonl_encoder_emits_exactly_one_compact_json_value_and_newline`
- `protocol_jsonl_encoder_rejects_after_escaping_when_compact_line_exceeds_one_mib`
- `protocol_jsonl_limit_does_not_reuse_event_store_two_mib_limit`
- `rpc_codec_distinguishes_request_response_notification_and_error`
- `rpc_router_correlates_out_of_order_responses`
- `rpc_router_rejects_duplicate_unknown_and_more_than_256_pending_ids`
- `rpc_server_request_response_preserves_validated_id_only`
- `rpc_unknown_noncritical_notification_has_safe_summary_only`
- `rpc_unknown_critical_message_fails_closed_without_payload_echo`
- `rpc_debug_and_errors_never_include_raw_json`

对 fixture 的每个字节边界参数化 feed；测试用 `fixture-secret`、绝对路径和 prompt sentinel 注入未知字段，断言任何 Debug/Error/summary 都无命中。

- [ ] **Step 2: 运行 codec 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_protocol`

Expected: FAIL，JSONL/RPC codec 尚不存在。

- [ ] **Step 3: 实现流式 JSONL decoder**

协议 decoder 使用单一可复用 byte buffer 和增量 UTF-8 校验；在 compact frame（含尾随换行）超过 `MAX_PROTOCOL_JSONL_FRAME_BYTES` 的第一个字节立即进入 terminal protocol error并清空敏感 buffer，不能继续扩容。只有完整换行记录交给 `serde_json`；EOF 有残片、顶层非 object 或多值行失败封闭。encoder 先向 bounded writer 做 compact serialization，在 JSON escaping 后连同 `\n` 计算字节数；超过 `1 MiB` 时零写出返回 `PROTOCOL_LIMIT`，否则原子返回一条 line。该 codec 只用于 CLI/app-server wire，不得复用事件存储的 `2 MiB` line limit。

- [ ] **Step 4: 实现 driver 无关 RPC envelope 与 bounded router**

RPC 层只识别经过 fixture 证明的 `id/method/params/result/error` envelope，不硬编码 Codex/Claude event。`RpcRequestId` 支持 fixture 证明的数字/字符串形态，但字符串长度和字符集受限，不能转换为 path/argv。router 在登记第 257 个 pending request 前返回 `PROTOCOL_LIMIT`；重复/未知 response ID、response 同时含 result/error、server request 缺 method 都是关键协议错误。

未知非关键 notification 只生成 `{ methodCase, topLevelKeys, byteCount }` 安全摘要；不得保留 raw params。driver mapper 决定哪些 method 是关键，本层不按前缀猜测。

- [ ] **Step 5: 运行 codec/fixture 回归、简化并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_protocol && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；任意分片结果一致，越限内存不继续增长，错误不回显 payload。

使用 `@code-simplifier` 审查 buffer 状态机与 RPC 分支；若修改，重跑本步骤。

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/runtime/protocol src-tauri/src/runtime/mod.rs src-tauri/tests/runtime_protocol.rs
git commit -m "feat(runtime): 实现有界 JSONL RPC 编解码"
```

### Task 4: 实现统一完成事件、内存 delta、配额和 append 崩溃恢复

**Files:**
- Create: `src-tauri/src/runtime/event.rs`
- Create: `src-tauri/src/runtime/event_assembler.rs`
- Create: `src-tauri/src/runtime/event_redactor.rs`
- Create: `src-tauri/src/storage/conversation_event_append.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Modify: `src-tauri/src/storage/config_file_store.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/domain/conversation_event.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/history/importer.rs`
- Test: `src-tauri/tests/runtime_event_store.rs`
- Test: `src-tauri/tests/bootstrap_order.rs`
- Test: `src-tauri/tests/legacy_history_importer.rs`

- [ ] **Step 1: 写失败测试固定 delta/完成事件分离和 event schema**

新增：

- `assistant_delta_is_emitted_in_memory_and_never_serialized`
- `assistant_completed_uses_authoritative_final_or_bounded_assembled_delta`
- `runtime_completed_events_have_event_conversation_segment_turn_timestamp_sequence`
- `tool_output_over_256_kib_is_explicitly_truncated_with_original_count`
- `non_assistant_completed_event_over_512_kib_fails_before_append_without_raw_echo`
- `assistant_message_over_two_mib_cancels_turn_and_persists_runtime_error_only`
- `assistant_event_compact_serialized_line_at_two_mib_round_trips`
- `assistant_event_worst_case_json_escape_over_two_mib_is_rejected_before_append`
- `event_store_reader_accepts_line_over_protocol_limit_up_to_event_limit`
- `event_store_reader_rejects_serialized_line_over_two_mib`
- `turn_memory_over_eight_mib_is_released_after_terminal_event`
- `event_redactor_removes_secret_env_values_and_sensitive_tool_fields`
- `event_unknown_payload_persists_only_safe_summary`
- `event_id_is_deterministic_across_adapter_replay`
- `event_duplicate_id_is_idempotent`
- `phase_a_legacy_transcript_block_and_existing_event_log_round_trip_without_schema_loss`

完成事件 enum 在 Phase A 既有 schema 上增量扩展：必须继续保留并兼容反序列化 `LegacyTranscriptBlock`、既有 summary/import 事件及其原字段，再增加 `UserMessage/AssistantMessageCompleted/ToolStarted/ToolOutput/ToolCompleted/ApprovalRequested/ApprovalResolved/StatusChanged/UsageReported/RuntimeError/ProviderSwitched`；不得用新闭合枚举覆盖旧 variant。`AssistantDelta` 只存在 `RuntimeEphemeralEvent`。事件 store 使用独立 `MAX_EVENT_JSONL_LINE_BYTES` reader；所有 line 上限在 compact serialization 与 JSON escaping 后、包含换行计算。

- [ ] **Step 2: 写失败测试固定 append journal、文件/turn 配额和恢复矩阵**

新增：

- `event_append_stages_exact_batch_bytes_and_syncs_before_journal`
- `event_append_crash_at_stage_journal_partial_full_and_cleanup_recovers_idempotently`
- `event_append_partial_suffix_matching_staged_prefix_truncates_then_replays`
- `event_append_missing_or_tampered_stage_fails_closed_without_event_mutation`
- `event_append_orphan_stage_without_journal_is_never_treated_as_committed_batch`
- `event_append_unknown_suffix_or_hash_fails_closed_without_mutation`
- `event_append_rejects_batch_over_four_mib`
- `event_append_reserves_turn_budget_before_external_send`
- `event_append_turn_budget_preserves_one_bounded_terminal_error_line_headroom`
- `event_file_at_64_mib_rejects_new_turn_before_model_request`
- `event_append_same_conversation_is_serialized_and_different_conversations_can_progress`
- `legacy_importer_active_turn_reservation_returns_retry_later_before_stage_or_replace`
- `turn_reservation_active_import_lease_returns_retry_later_before_external_send`
- `legacy_importer_capacity_counts_compact_serialized_lines_and_never_exceeds_64_mib`
- `legacy_importer_and_runtime_append_share_one_capacity_ledger_and_writer_order`
- `legacy_importer_and_turn_reservation_conflict_immediately_without_lock_inversion`
- `event_append_reparse_escape_is_rejected_without_touching_outside_sentinel`
- `bootstrap_recovers_runtime_event_journals_before_conversation_manager_build`

- [ ] **Step 3: 运行事件测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store`

Expected: FAIL，runtime event assembler、staging+journal append 和 quota reservation 尚不存在。

- [ ] **Step 4: 实现内存 assembler 与统一完成事件映射边界**

assembler 按 `(segmentId, turnId, messageId)` 保存 bounded delta；完成事件到达时优先使用协议中 authoritative final content，只有 fixture 明确 completion 不含正文时才使用内存组装值。进程崩溃或关键协议错误时清除 delta，追加 `RuntimeError + StatusChanged(failed/interrupted)`，不得把 partial delta 包装成 AssistantMessageCompleted。

工具输出超过上限时先在内存计算 `originalByteCount`，只持久化 UTF-8 边界内的前 `256 KiB` 和 `truncated=true`；redactor 在 eventId/hash 计算前运行，避免秘密影响持久 ID 或错误。

- [ ] **Step 5: 扩展 guarded file store 的有意图 append 能力**

新增窄接口 `write_new_sync/append_from_file_sync/read_len/read_range/truncate_sync/remove_guarded`，所有 path 仍是 typed conversation ID 与内部 transaction UUID 派生的 `SafeRelativePath`，复用 Phase A no-reparse/final-handle 校验。每批先把已完成 compact serialization、逐 line/event/turn quota 校验后的精确 JSONL bytes 写入 `conversation-events/<conversationId>.runtime-append-<transactionId>.stage` 并 file sync；再原子写 `conversation-events/<conversationId>.runtime-append-journal.json`，只记录 oldLength、staging basename、stagingLength、stagingSha256、eventIds 和 stage，不保存自由 path。随后从已重新校验 hash/length 的 staging file append 到事件文件并 file sync，最后依次删除 Journal 与 staging。staging 与正式事件文件按同等敏感数据处理，不进日志、错误或备份扫描结果。

恢复必须先验证 journal、staging basename、staging length/hash 和每条 event line 上限。只接受：事件文件长度为 old；为完整 new 且 suffix hash 等于 staging hash；或 suffix 是 staging bytes 的严格前缀。old/严格前缀状态先 truncate 回 old，再从 staging 重放；完整 new 只清理。staging 缺失/篡改、未知 suffix、更短文件、越界路径或 Journal 篡改全部使 runtime Blocked 且事件文件字节不变。没有 Journal 的 orphan staging 绝不能被当成已提交 batch；只有确认 event file 未引用且名称/transaction 完整合法时才由 guarded cleanup 隔离/删除。事件文件先恢复 runtime append，再允许 LegacyImporter/import journal 工作。

- [ ] **Step 6: 实现显式 event/turn quota reservation**

`ConversationEventStore` 为每个 conversation 维护唯一 `ConversationEventCapacityLedger`，在同一 mutex 下记录 committed bytes、active turn reservations 与 exclusive import lease。`reserve_turn(conversationId)` 在任何 `turn/start` 或 Claude 输入前按 compact staged bytes 保留最多 `4 MiB`；其中始终预留一个 `MAX_NON_ASSISTANT_EVENT_LINE_BYTES` 的 bounded terminal `RuntimeError` headroom，普通完成事件不得消耗该尾部空间。import lease 存在、文件+全部 reservation 超过 `64 MiB` 或 reader发现超限 line 时返回 `RETRY_LATER/EVENT_CAPACITY`，零外部请求。单 turn 写入达到数据预算时只允许使用预留 headroom 写一个终态 RuntimeError并停止 adapter；reservation 在完成/取消/崩溃路径 Drop。

Phase A `LegacyHistoryImporter` 必须改为先取得同一 ledger 的 exclusive import lease；任一 active turn reservation 存在时导入在 staging/replace 前立即返回 `RETRY_LATER` 且 checkpoint/event 零修改，反向地 import lease 存在时新 turn reservation 也立即失败，不允许互相等待。固定锁序为 `ApplicationMutationGate（若调用方已有） → per-conversation capacity ledger/writer → checkpoint transaction`，process/adapter/pool lock 不得进入该区间。import 在 lease 内按最终 compact event lines 预计算 file size，复用统一 line/file cap 与 guarded transaction提交事件+checkpoint；不得绕过 ledger 整文件 replace、吃掉已计费 turn 的预留空间或突破 `64 MiB`。同 conversation 的 runtime append/import 串行，不同 conversation 仍可并行。磁盘配额不自动删除或覆盖历史，归档/新会话 UI 留给 Phase D。

- [ ] **Step 7: 运行恢复矩阵、全量存储回归和代码简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_history_importer && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；每个崩溃点重复 recover 两次后 eventIds/sequence 唯一，未知状态零修改失败封闭。

使用 `@code-simplifier` 审查 append 状态机、quota guard 和 assembler buffer 生命周期；若修改，重跑本步骤。

- [ ] **Step 8: 提交事件持久化边界**

```bash
git add src-tauri/src/runtime/event.rs src-tauri/src/runtime/event_assembler.rs src-tauri/src/runtime/event_redactor.rs src-tauri/src/storage/conversation_event_append.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/src/storage/config_file_store.rs src-tauri/src/storage/mod.rs src-tauri/src/domain/conversation_event.rs src-tauri/src/application/bootstrap.rs src-tauri/src/history/importer.rs src-tauri/tests/runtime_event_store.rs src-tauri/tests/bootstrap_order.rs src-tauri/tests/legacy_history_importer.rs
git commit -m "feat(runtime): 增加统一事件与崩溃恢复"
```

### Task 5: 实现修订级配置、净化环境和 raw-stdio Job Object ProcessHost

**Files:**
- Create: `src-tauri/src/runtime/environment.rs`
- Create: `src-tauri/src/runtime/namespace.rs`
- Create: `src-tauri/src/runtime/config/mod.rs`
- Create: `src-tauri/src/runtime/config/codex.rs`
- Create: `src-tauri/src/runtime/config/claude.rs`
- Create: `src-tauri/src/runtime/process/mod.rs`
- Create: `src-tauri/src/runtime/process/host.rs`
- Create: `src-tauri/src/runtime/process/supervisor.rs`
- Create: `src-tauri/src/runtime/process/windows_stdio.rs`
- Create: `src-tauri/src/runtime/process/fake.rs`
- Modify: `src-tauri/src/runtime/mod.rs`
- Modify: `src-tauri/src/pty/job_object.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/tests/fixtures/runtime-process/parent.ps1`
- Create: `src-tauri/tests/fixtures/runtime-process/child.ps1`
- Test: `src-tauri/tests/runtime_process.rs`

- [ ] **Step 1: 写失败测试固定 namespace、argv、环境和配置不可变性**

新增：

- `runtime_namespace_is_derived_only_from_typed_provider_revision_id`
- `runtime_namespace_rejects_cross_driver_and_legacy_alias`
- `codex_provider_name_is_unique_revision_scoped_and_not_reserved`
- `codex_config_uses_custom_provider_env_key_without_secret_value`
- `codex_config_hash_mismatch_fails_closed_and_never_rewrites`
- `claude_settings_are_revision_scoped_immutable_and_contain_no_secret`
- `runtime_launch_argv_contains_no_secret_base_url_or_prompt`
- `runtime_environment_removes_all_controlled_parent_keys_before_injection`
- `runtime_environment_injects_only_selected_revision_secret`
- `runtime_environment_dynamic_codex_key_is_removed_from_other_revisions`
- `runtime_launch_debug_is_redacted_and_not_clone`
- `runtime_config_or_error_never_exposes_absolute_root_or_secret_sentinel`

Codex 配置必须验证 `model_provider` 唯一名、custom provider base URL、wire API 和 `env_key`；密钥值只在 process spawn 临界区注入。Claude settings 只含 fixture 证明安全的非敏感字段；不得写认证信息或用户 HOME。

- [ ] **Step 2: 写失败测试固定 suspended spawn、Job assign 和 raw stdio**

新增：

- `runtime_process_windows_target_cannot_run_before_job_assignment`
- `runtime_process_raw_stdio_preserves_jsonl_bytes_without_conpty_translation`
- `runtime_process_assign_failure_releases_no_target_work`
- `runtime_process_job_close_terminates_parent_and_child_tree`
- `runtime_process_stdin_write_is_serialized_and_bounded`
- `runtime_process_stdout_stderr_over_limit_is_protocol_error_not_log_dump`
- `runtime_process_wait_and_kill_have_one_owner_and_total_deadline`
- `runtime_process_drop_zeroes_unicode_environment_block`
- `runtime_process_fake_supports_split_bytes_exit_and_hang`
- `runtime_version_probe_uses_clean_env_no_secret_and_64_kib_limit`

- [ ] **Step 3: 运行 process 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_process`

Expected: FAIL，raw-stdio ProcessHost 和 runtime config builder 尚不存在。

- [ ] **Step 4: 实现集中环境净化与修订 namespace**

复用 Phase A controlled environment key 清单，至少移除 `OPENAI_API_KEY/OPENAI_BASE_URL/CODEX_HOME/ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL/CLAUDE_CONFIG_DIR/THT_PANEL_SMOKE/THT_PANEL_CONFIG_DIR` 及所有已知动态 `THT_PANEL_CODEX_KEY_*`。先 remove，再设置非敏感 public env，最后消费 `SecretValue` 注入当前 revision 的唯一 secret env；三组 map 都不可 Clone，Debug 仅输出键数量。

Codex namespace 固定 `runtime/codex/<providerRevisionId>`，`CODEX_HOME` 指向该目录；custom provider 名固定 `tht_panel_revision_<uuid-simple-lowercase>`，对应 env key 固定 `THT_PANEL_CODEX_KEY_<UUID_SIMPLE_UPPERCASE>`。Claude namespace 固定 `runtime/claude/<providerRevisionId>`，只通过 `--settings <revision-settings-path>` 使用；不得设置或读取 `CLAUDE_CONFIG_DIR`。

- [ ] **Step 5: 实现 raw-stdio Windows ProcessHost 和 Job Object**

Windows 生产实现使用匿名 stdin/stdout/stderr pipe 与 `CreateProcessW(CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT)`：只继承所需 child handles，创建成功后先加入启用 kill-on-close 的独立 Job Object，成功后才 `ResumeThread`。环境 block 使用 `Zeroizing<Vec<u16>>`，resume 后立即清零；assign/resume 任一步失败都终止 suspended process并等待 tree empty。

`RuntimeProcess` 提供 bounded `write_line/take_stdout/take_stderr/try_wait/terminate_tree/wait_tree_empty`；reader/writer thread 不持 application mutation/runtime map 锁。Process supervisor 以单调总 deadline 管理 graceful request、stdin close、Job kill 和 tree-empty ack；同一 process 只能有一个 terminate owner。

`.cmd` shim 继续复用 Phase A resolver 的 `cmd.exe /D /S /C` 受控模板，禁止 PowerShell/EncodedCommand。target program/args/cwd 通过 `CommandLineToArgvW` 对称 quoting 测试；secret、prompt 和 baseUrl 不进入 command line。

- [ ] **Step 6: 实现版本探测与不可变配置检查**

`RuntimeVersionProbe` 不读取 SecretStore，只使用清理后的环境运行 driver 版本命令，5 秒/64 KiB 上限。ProviderRevision 第一次使用时原子生成 config/settings 并保存非敏感 hash；后续 hash 不同立即 `CONFLICT/PROTOCOL`，绝不按当前 ProviderProfile 重写历史修订目录。所有目录操作走 guarded ConfigFileStore，reparse/junction 逃逸失败封闭。

- [ ] **Step 7: 运行真实 Job fixture、全量 process 回归和简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_process && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_lifecycle_ && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；parent/child 均在同一 Job，关闭后 PID 消失；raw stdout 与 fixture JSONL 字节完全一致，无 ConPTY CR/LF 改写。

使用 `@code-simplifier` 审查 Windows HANDLE RAII、环境构造和 config builder；若修改，重跑本步骤。

- [ ] **Step 8: 提交隔离进程边界**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/runtime/environment.rs src-tauri/src/runtime/namespace.rs src-tauri/src/runtime/config src-tauri/src/runtime/process src-tauri/src/runtime/mod.rs src-tauri/src/pty/job_object.rs src-tauri/src/application/bootstrap.rs src-tauri/tests/fixtures/runtime-process src-tauri/tests/runtime_process.rs
git commit -m "feat(runtime): 增加隔离配置与 Job 进程宿主"
```

### Task 6: 通过 Chunk 1 完整回归与计划检查点

**Files:**
- Verify only: all files changed in Tasks 1-5

- [ ] **Step 1: 运行 Chunk 1 Rust 门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_contracts && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_protocol && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_history_importer && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_process && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；无 skipped/focused test，Claude 未验证能力仍 false。

- [ ] **Step 2: 运行 secret/路径/容量静态扫描**

Run: `rg -n "fixture-secret|apiKey|secretValue|authorization|bearer|rawPayload|prompt" src-tauri/src/runtime src-tauri/runtime-fixtures && rg -n -g 'runtime_*' "fixture-secret|apiKey|secretValue|authorization|bearer|rawPayload|prompt" src-tauri/tests`

Expected: 只命中负向测试、write-only 类型名或明确 redaction 规则；生产 Debug/Error/Event/fixture 无敏感正文。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_contracts runtime_limits_ && rg -n "MAX_PROTOCOL_JSONL_FRAME_BYTES|MAX_EVENT_JSONL_LINE_BYTES|MAX_NON_ASSISTANT_EVENT_LINE_BYTES|MAX_ASSISTANT_EVENT_LINE_BYTES|MAX_TURN_PERSISTED_BYTES|MAX_CONVERSATION_EVENT_FILE_BYTES" src-tauri/src/runtime/limits.rs src-tauri/src/runtime src-tauri/src/storage`

Expected: limits 契约测试成功；每个常量只在 `runtime/limits.rs` 定义，codec/event store/importer/append 只按命名常量引用。不得用会误命中 `Sha256`、`u32` 等标识符的裸数字正则作为门禁。

- [ ] **Step 3: 核对 Phase C 未切换功能开关或 legacy 路径**

Run: `rg -n "native_ai_enabled|nativeAiEnabled|work_item_runtime_start|LegacyLaunchService" src-tauri/src src`

Expected: 默认值仍 false；本 Chunk 未新增 true writer；legacy runtime start/launch 仍存在且测试可编译。

- [ ] **Step 4: 进行 Chunk 1 文档评审**

使用 plan-document-reviewer 按 `docs/superpowers/specs/2026-07-10-panel-redesign-design.md` 和本计划 Chunk 1 逐项核对。若发现遗漏，先修计划/实现对应任务并重跑相关门禁；评审通过后再进入 Chunk 2。

## Chunk 2: Codex/Claude RuntimeAdapter 与共享服务恢复

### Task 7: 实现 Codex 官方 app-server 协议映射和握手状态机

**Files:**
- Create: `src-tauri/src/runtime/codex/mod.rs`
- Create: `src-tauri/src/runtime/codex/protocol.rs`
- Create: `src-tauri/src/runtime/codex/handshake.rs`
- Create: `src-tauri/src/runtime/codex/mapper.rs`
- Modify: `src-tauri/src/runtime/mod.rs`
- Test: `src-tauri/tests/codex_protocol.rs`

- [ ] **Step 1: 写失败测试固定官方握手和默认 stdio JSONL**

新增：

- `codex_launch_uses_app_server_default_stdio_without_listen_or_websocket_args`
- `codex_initialize_is_first_request`
- `codex_initialized_is_sent_only_after_matching_success_response`
- `codex_initialize_error_sends_no_initialized_and_stops`
- `codex_thread_start_is_used_for_new_binding`
- `codex_thread_resume_is_used_only_with_valid_native_session_id`
- `codex_thread_response_id_uses_fixture_bound_native_session_schema`
- `codex_turn_start_is_rejected_before_thread_ready`
- `codex_turn_start_uses_current_thread_and_model_snapshot`
- `codex_turn_interrupt_uses_thread_and_turn_from_binding`
- `codex_outbound_lines_match_sanitized_fixture_exactly`

测试从 `src-tauri/runtime-fixtures/v1/codex/stdio-baseline.jsonl` 读取 case，而不是在测试中另写一套假协议。请求参数只包含官方文档与 fixture 同时证明的字段；任何未确认字段不得“为以后预留”。

- [ ] **Step 2: 写失败测试固定 item/turn/serverRequest 统一事件映射**

新增：

- `codex_item_delta_maps_to_ephemeral_assistant_delta_only`
- `codex_item_completed_maps_to_one_authoritative_completed_event`
- `codex_turn_completed_is_terminal_only_after_all_items_complete`
- `codex_turn_failed_maps_to_runtime_error_and_failed_status`
- `codex_usage_maps_without_raw_provider_payload`
- `codex_request_approval_maps_to_approval_requested_with_once_or_deny_choices`
- `codex_server_request_resolved_maps_to_approval_resolved_not_tool_completed`
- `codex_item_completed_after_resolution_is_the_only_tool_final_state`
- `codex_same_native_event_replayed_on_new_server_generation_has_same_persisted_event_id`
- `codex_server_generation_is_used_only_to_drop_stale_callbacks_not_hash_identity`
- `codex_distinct_thread_turn_or_item_cannot_collide_after_generation_is_removed`
- `codex_unknown_noncritical_item_has_safe_summary`
- `codex_unknown_critical_turn_or_thread_message_stops_protocol`

- [ ] **Step 3: 运行 Codex 协议测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test codex_protocol`

Expected: FAIL，Codex protocol/handshake/mapper 尚不存在。

- [ ] **Step 4: 实现 exact fixture-backed Codex wire 类型**

`protocol.rs` 为 manifest 当前支持的 app-server protocol 定义 `deny_unknown_fields` 的出站 request 和宽进窄出的入站 envelope：顶层 RPC 先由通用 codec 验证，再由 method-specific parser 只提取统一事件需要的字段。原始 `params/result/error` 不进入 Debug 或 event；未知字段只有 fixture manifest 标为可忽略时才能丢弃，否则关键消息失败封闭。

出站顺序固定：

1. spawn `codex app-server`，不添加 listen/websocket/transport 参数；
2. 发送 `initialize` 并登记 request ID；
3. 收到同 ID success response 后发送 `initialized` notification；
4. 新线程发送 `thread/start`，已冻结且 matrix 兼容的原生线程发送 `thread/resume`；
5. thread ready 后才允许 `turn/start`；
6. 取消只发送 `turn/interrupt`。

任何 response/error 顺序错误、重复 initialize、未 ready turn，或 thread ID 不符合当前 `driver + cliVersion + protocolVersion + fixtureVersion + nativeIdGrammar` manifest entry，都关闭当前 server generation。若 grammar 为 `CanonicalUuidV1` 则必须 canonical lowercase UUID；若为 `AsciiOpaqueV1` 则只能进入不可作 path/argv 的 tagged versioned variant；未知 grammar 不得启动或 resume。

- [ ] **Step 5: 实现 Codex 事件映射和确定性 identity**

每个 adapter callback envelope 携带 server generation，ConversationManager 先用它拒绝旧 generation callback；generation 绝不进入持久 `eventId`。mapper 的稳定 `RuntimeEventIdentity` 固定哈希 `driver + conversationId + NativeSessionId + native turn ID + item ID + method case + native sequence + redacted content hash`，不含 server generation、process ID、binding handle 或新 RuntimeSegment ID；因此同一原生事件跨 app-server generation replay 得到同一 eventId，而不同 thread/turn/item 仍不碰撞。delta 进入 ephemeral sink；`item/completed` 的 final content/tool result 才生成完成事件。审批 request 保存闭合的操作类型、理由、目标安全摘要和风险 flags；不保存 raw command environment、secret、完整 cwd 或未脱敏 patch。`serverRequest/resolved` 只更新审批状态，等待 `item/completed` 再生成 ToolCompleted。

- [ ] **Step 6: 运行协议、fixture 和 redaction 回归**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test codex_protocol && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store`

Expected: PASS；握手/审批顺序与官方 fixture 一致，错误与事件不含 raw payload。

- [ ] **Step 7: 代码简化审查并提交 Codex 协议层**

使用 `@code-simplifier` 审查 method dispatch、状态枚举和 mapper 重复；不得把 pool/process 生命周期并入 codec。若修改，重跑 Step 6。

```bash
git add src-tauri/src/runtime/codex src-tauri/src/runtime/mod.rs src-tauri/tests/codex_protocol.rs
git commit -m "feat(runtime): 实现 Codex app-server 协议"
```

### Task 8: 实现按 ProviderRevision 共享的 Codex app-server 池

**Files:**
- Create: `src-tauri/src/runtime/codex/app_server.rs`
- Create: `src-tauri/src/runtime/codex/pool.rs`
- Create: `src-tauri/src/runtime/codex/binding.rs`
- Create: `src-tauri/src/runtime/codex/adapter.rs`
- Modify: `src-tauri/src/runtime/codex/mod.rs`
- Modify: `src-tauri/src/application/clock.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Test: `src-tauri/tests/codex_adapter.rs`

- [ ] **Step 1: 写失败测试固定修订隔离、共享和容量边界**

新增：

- `codex_pool_same_revision_reuses_one_app_server_process`
- `codex_pool_different_revisions_use_distinct_process_job_home_and_secret_env`
- `codex_pool_same_model_name_across_revisions_never_shares_server`
- `codex_pool_lazy_start_probes_version_and_capabilities_each_generation`
- `codex_pool_unknown_version_creates_no_thread_or_model_request`
- `codex_pool_max_32_active_threads_rejects_before_thread_start`
- `codex_pool_max_256_pending_rpc_rejects_before_write`
- `codex_pool_concurrent_threads_correlate_out_of_order_responses`
- `codex_pool_one_thread_failure_does_not_relabel_other_threads`
- `codex_pool_idle_release_requires_no_active_turn_thread_or_approval`
- `codex_pool_fake_clock_release_closes_job_and_removes_generation`
- `codex_pool_config_hash_change_or_revision_mismatch_fails_closed`
- `codex_pool_debug_state_contains_no_secret_base_url_cwd_or_rpc_payload`

- [ ] **Step 2: 写失败测试固定 binding generation 和 start/resume**

新增：

- `codex_binding_new_thread_publishes_only_after_thread_start_response`
- `codex_binding_resume_requires_explicit_version_compatibility_edge`
- `codex_binding_resume_uses_frozen_revision_model_cwd_and_native_id`
- `codex_binding_project_or_provider_edit_cannot_retarget_existing_segment`
- `codex_binding_old_generation_events_cannot_mutate_restarted_binding`
- `codex_binding_duplicate_native_thread_in_other_conversation_is_conflict`
- `codex_binding_same_conversation_lineage_may_resume_same_native_thread`
- `codex_binding_start_failure_closes_unpublished_thread_and_job_when_empty`

- [ ] **Step 3: 运行 adapter 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test codex_adapter`

Expected: FAIL，共享 pool/app-server/adapter 尚不存在。

- [ ] **Step 4: 实现单修订单 generation app-server**

`CodexAppServerPool` key 精确为 typed `ProviderRevisionId`；pool 构造时接收 Task 1 唯一 application `RuntimeOutputRelay`，不能由 thread binding 覆盖。value 状态为 `Starting | Ready | Draining | Stopped | Failed`，并带单调 generation。每个 generation 独占 Task 5 的 raw-stdio process、Job Object、RPC router、reader/writer thread 和修订级 immutable CODEX_HOME。spawn 每次重新 probe CLI/version/matrix；历史 capability snapshot 不复用，relay 未绑定时零 spawn。

同修订多个 Conversation 共享 server process，但各自拥有独立 `CodexThreadBinding { conversationId, segmentId, generation, nativeThreadId, modelNameSnapshot, cwdSnapshot }`。pool 不写 ConversationsFile；它只在 thread/start/resume success 后返回 binding，RuntimeSegment 的创建/提交由 Chunk 3 `ConversationManager` 负责。

- [ ] **Step 5: 实现 reader/writer、pending request 和 thread 索引**

单 writer queue 串行 JSONL line，单 reader 解码后按 request ID/thread/turn/item 分派；任何 callback 在调用 application relay 前释放 pool/router lock。每个 thread 同时最多一个 active turn；每个 app-server 最多 32 个已发布 thread、256 个 pending RPC。旧 generation callback、未知 binding 或跨 conversation native identity 失败封闭，不能误投事件。

- [ ] **Step 6: 实现可测试的空闲释放**

复用 Phase B `Clock`，增加只由测试推进的 idle deadline；只有 thread 全部 detached、无 active turn、无 pending approval/RPC、writer queue 为空时才可关闭 Job。释放先阻止新 attach，再 shutdown process/tree，确认 tree empty 后从 map 删除；新 attach 与释放竞争由 generation CAS 决定，不能返回已关闭 handle。

- [ ] **Step 7: 运行共享/隔离/空闲测试和简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test codex_adapter && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_process && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；同修订恰一进程，不同修订 HOME/env/job/secret 完全分离，fake clock 无真实 sleep。

使用 `@code-simplifier` 审查 pool 锁范围、generation 检查和 idle 条件；若修改，重跑本步骤。

- [ ] **Step 8: 提交 Codex 共享池**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/runtime/codex src-tauri/src/application/clock.rs src-tauri/src/application/bootstrap.rs src-tauri/tests/codex_adapter.rs
git commit -m "feat(runtime): 增加共享 Codex app-server 池"
```

### Task 9: 实现 Codex 审批、取消超时、Job 遏制和共享恢复计划

**Files:**
- Create: `src-tauri/src/runtime/codex/approval.rs`
- Create: `src-tauri/src/runtime/codex/cancellation.rs`
- Create: `src-tauri/src/runtime/codex/recovery.rs`
- Modify: `src-tauri/src/runtime/codex/adapter.rs`
- Modify: `src-tauri/src/runtime/codex/app_server.rs`
- Modify: `src-tauri/src/runtime/codex/pool.rs`
- Modify: `src-tauri/src/runtime/codex/mod.rs`
- Test: `src-tauri/tests/codex_recovery.rs`

- [ ] **Step 1: 写失败测试固定审批完整链路和 16 项上限**

新增：

- `codex_approval_request_is_pending_before_public_event`
- `codex_approval_support_requires_capability_true_for_exact_version`
- `codex_approval_unknown_method_is_unsupported_not_guessed`
- `codex_approval_17th_pending_request_fails_closed_and_drains_server`
- `codex_approval_approve_once_and_deny_encode_fixture_exact_response`
- `codex_approval_has_no_permanent_allow_variant`
- `codex_approval_duplicate_or_stale_decision_is_rejected`
- `codex_approval_client_response_is_sent_before_server_request_resolved_with_same_rpc_id`
- `codex_approval_resolved_event_waits_for_server_request_resolved_after_client_response`
- `codex_approval_resolution_waits_for_item_completed_before_tool_completion`
- `codex_approval_process_crash_marks_request_abandoned_not_approved_or_denied`
- `codex_approval_payload_redacts_env_secret_and_unbounded_patch_content`

- [ ] **Step 2: 写失败测试固定单 turn 取消和共享 server 遏制顺序**

新增：

- `codex_cancel_sends_turn_interrupt_once_and_marks_cancelling`
- `codex_cancel_consumes_events_during_grace_until_explicit_terminal_state`
- `codex_cancel_terminal_during_grace_keeps_other_threads_untouched`
- `codex_cancel_timeout_marks_revision_runtime_draining_before_job_close`
- `codex_cancel_draining_rejects_all_new_turns_before_job_close`
- `codex_cancel_timeout_closes_shared_job_and_confirms_tree_empty`
- `codex_cancel_timeout_never_kills_only_one_child_and_leaves_tools_running`
- `codex_cancel_tree_ack_failure_keeps_runtime_failed_and_blocks_restart`
- `codex_cancel_uses_one_monotonic_total_deadline_without_blocking_sleep`

- [ ] **Step 3: 写失败测试固定受影响线程恢复计划**

新增：

- `codex_recovery_plan_lists_every_published_binding_once`
- `codex_recovery_plan_marks_source_segments_interrupted`
- `codex_recovery_compatible_thread_requires_new_segment_and_thread_resume`
- `codex_recovery_incompatible_version_requires_context_bridge_not_resume`
- `codex_recovery_one_unrecoverable_thread_does_not_fail_recoverable_threads`
- `codex_recovery_restarted_generation_uses_new_capability_snapshot`
- `codex_recovery_replayed_events_deduplicate_by_event_turn_and_sequence`
- `codex_recovery_old_generation_callback_cannot_complete_new_segment`
- `codex_recovery_process_crash_uses_same_plan_as_cancel_timeout`
- `codex_recovery_cancel_timeout_emits_one_shared_service_control_event_after_tree_empty`
- `codex_recovery_async_process_crash_reaches_manager_through_runtime_sink_not_cancel_return`
- `codex_recovery_control_event_is_internal_nonserializable_and_redacted`
- `codex_recovery_control_sink_failure_keeps_revision_draining_and_rejects_new_turns`

- [ ] **Step 4: 运行审批/取消/恢复测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test codex_recovery`

Expected: FAIL，approval registry、cancel state machine 和 recovery plan 尚不存在。

- [ ] **Step 5: 实现审批 registry 和官方响应链路**

pending key 为 `(serverGeneration, rpcRequestId)`，value 冻结 conversation/segment/turn/item/method case 和 redacted public summary。只有 matrix.approvals=true 且 method case 在 fixture allow-list 时才公开 ApprovalRequested；其他 server approval request 返回明确 Unsupported 并进入安全停止，不构造虚假卡片或自动批准。

用户决定后立即用原 server request 的同一个 RPC ID 只写一次官方 client response；不得等待 `serverRequest/resolved` 才响应。response 成功送入 writer 后 pending 进入 `ResponseSent`，收到相同 RPC ID 的 `serverRequest/resolved` 后才追加 ApprovalResolved；收到后续同 item 的 `item/completed` 才追加 ToolCompleted。resolved 早于 response、ID不匹配或重复 resolved 都是关键协议错误。拒绝、超时、进程退出和应用退出必须区分：只有实际发送且 server resolved 的决定标记 approved/denied；失联标记 abandoned。

- [ ] **Step 6: 实现 cancel grace、draining 和 Job 级最终遏制**

cancel owner 发送一次 `turn/interrupt`，把目标 binding 状态设为 Cancelling，并在注入 `Clock/DeadlineScheduler` 下继续消费事件。grace 内明确 interrupted/completed 即正常收敛。超时后在同一 pool lock 内先改为 Draining并拒绝全部新 turn，再锁外关闭整个 Job、等待 tree empty；不得直接 kill 单个共享 child。

tree-empty 未确认时不启动替代 server，不把任何 segment 标成安全终止；返回 `RUNTIME_CONTAINMENT_FAILED`，退出也必须被阻止。确认后 recovery builder 生成 immutable plan，并在释放 pool/process lock 后通过 Task 1 的 `RuntimeEventSink.emit(RuntimeAdapterOutput::Control(RuntimeControlEvent::SharedServiceRecoveryRequired(...)))` 精确发送一次 driver-neutral `SharedServiceRecoveryPlan`。同一通道也用于异步 reader/process crash；不得依赖 `cancel_turn` 返回值、全局单例或轮询 side channel。adapter 自己不得改 ConversationsFile，control output 不持久化、不发 Tauri。

- [ ] **Step 7: 实现显式版本兼容恢复计划**

recovery builder 对每个旧 binding 记录 source segment、frozen revision/model/cwd、NativeSessionId 和旧版本，并转换成 Task 1 bounded `RuntimeRecoveryCandidate`；候选数不得超过共享 thread 上限。新 generation probe 后由上层逐项查询 exact resume edge：兼容项要求先创建新 RuntimeSegment，再调用 `thread/resume`；不兼容/缺 NativeSessionId 项返回 `ContextBridgeRequired`。新 binding 必须使用新 adapter/protocol/capability snapshot；旧 segment 一律终结为 Interrupted，不能原地改版本。

- [ ] **Step 8: 运行恢复矩阵、Job fixture和简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test codex_recovery && cargo test --manifest-path src-tauri/Cargo.toml --test codex_adapter && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_process`

Expected: PASS；取消失败会影响同修订其他线程但能确定遏制，兼容线程独立恢复，不兼容线程有明确原因。

使用 `@code-simplifier` 审查 cancel/recovery 状态转换和审批重复映射；若修改，重跑本步骤。

- [ ] **Step 9: 提交 Codex 审批与恢复**

```bash
git add src-tauri/src/runtime/codex src-tauri/tests/codex_recovery.rs
git commit -m "feat(runtime): 完成 Codex 审批取消与恢复"
```

### Task 10: 实现 fixture-gated Claude stream-json Adapter

**Files:**
- Create: `src-tauri/src/runtime/claude/mod.rs`
- Create: `src-tauri/src/runtime/claude/protocol.rs`
- Create: `src-tauri/src/runtime/claude/mapper.rs`
- Create: `src-tauri/src/runtime/claude/context.rs`
- Create: `src-tauri/src/runtime/claude/process.rs`
- Create: `src-tauri/src/runtime/claude/adapter.rs`
- Modify: `src-tauri/src/runtime/mod.rs`
- Test: `src-tauri/tests/claude_adapter.rs`

- [ ] **Step 1: 写失败测试固定版本 gate 和启动参数**

新增：

- `claude_unknown_version_returns_all_capabilities_false_and_zero_spawn`
- `claude_verified_version_capabilities_equal_manifest_not_inferred_flags`
- `claude_launch_uses_print_stream_json_input_output_partial_and_no_persistence`
- `claude_launch_uses_revision_settings_and_never_claude_config_dir`
- `claude_launch_has_no_resume_argument_in_phase_c`
- `claude_launch_requires_fixture_verified_safe_noninteractive_policy`
- `claude_each_segment_owns_distinct_process_and_job`
- `claude_same_revision_conversations_share_config_but_not_process_or_memory`
- `claude_environment_isolated_between_same_model_providers`

启动参数固定包含设计规格已批准的 `--print --input-format stream-json --output-format stream-json --include-partial-messages --no-session-persistence --settings <revision-file>`。任何额外权限/审批/cancel 参数都必须来自 exact fixture launch profile；没有证据则 native send 禁用，不能按名称猜。

- [ ] **Step 2: 写失败测试固定 stream-json 映射与能力逐项证据**

新增：

- `claude_streaming_true_requires_delta_fixture_and_maps_ephemeral_only`
- `claude_multi_turn_true_requires_two_input_two_completion_fixture`
- `claude_partial_messages_true_requires_partial_fixture`
- `claude_tool_events_true_requires_started_output_completed_fixture`
- `claude_approvals_false_emits_no_fake_approval_card`
- `claude_cancel_false_returns_unsupported_but_shutdown_can_still_kill_job`
- `claude_unverified_event_type_is_safe_summary_or_protocol_error_by_manifest`
- `claude_completion_and_usage_are_bounded_redacted_events`
- `claude_process_exit_keeps_committed_events_and_marks_segment_failed`

- [ ] **Step 3: 写失败测试固定 Panel 历史受限重建而非 Claude resume**

新增：

- `claude_restart_ends_old_segment_and_creates_new_linked_segment`
- `claude_restart_uses_panel_completed_events_not_native_history`
- `claude_restart_prefers_visible_summary_then_recent_messages`
- `claude_restart_without_summary_is_deterministic`
- `claude_context_max_200_events_and_256_kib_fails_before_spawn`
- `claude_context_omits_secret_sensitive_tool_and_ephemeral_delta`
- `claude_context_tool_output_is_capped_and_marked`
- `claude_restart_inserts_segment_rebuilt_status_event`
- `claude_external_session_id_remains_null_without_verified_native_resume`

- [ ] **Step 4: 运行 Claude adapter 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test claude_adapter`

Expected: FAIL，Claude fixture-backed protocol/adapter/context builder 尚不存在。

- [ ] **Step 5: 实现 exact-version stream-json parser 和独占 process**

adapter 启动前用 VersionProbe + CapabilityRegistry 选择唯一 manifest entry；没有 exact entry、fixture hash 失配或缺 safe launch profile 时返回 `UNSUPPORTED_RUNTIME_VERSION`，零 process/模型请求。每个 active segment 启动独立 raw-stdio process和 Job，stdin writer 串行多轮输入，stdout 按该 entry 的 fixture parser 映射；不同 segment 不共享 buffer、request ID、history 或 secret。

protocol 只实现当前 fixture 观察到的消息类型和字段。manifest 未声明的事件若被标为 noncritical，记录安全摘要；其余视为协议不兼容并终止 segment。不得把 Codex 的 thread/turn/approval shape 套用到 Claude。

- [ ] **Step 6: 实现能力驱动的 send/cancel/approval 行为**

只有 `streaming && multiTurn` 等 manager 所需最小能力为 true 时允许原生多轮 send。`approvals=false` 时不公开 ApprovalRequested；若该 exact version 没有 fixture 证明可安全禁止交互工具请求，则整个 native send 保持禁用，而不是让 CLI 卡在隐藏 prompt。`cancelTurn=false` 时用户 cancel 返回 UnsupportedCapability；应用强制退出仍可调用 adapter shutdown 关闭 Job，二者语义不得混淆。

- [ ] **Step 7: 实现确定性受限历史重建**

Claude 进程退出/应用重启后旧 RuntimeSegment 写 endedAt 并进入 Stopped/Failed。下次 send 使用相同 frozen providerRevision/model、创建新 segment并设置 `resumedFromSegmentId`，从 Panel 完成事件构造 context；不调用 `--resume`、不读取 `~/.claude/projects`、不设置 `CLAUDE_CONFIG_DIR`。builder 只消费用户/助手完成消息和明确可安全包含的截断工具摘要，优先可见 summary，再取最近事件；超过 200 条/256 KiB 返回 ContextLimit，零 spawn/费用。

- [ ] **Step 8: 运行 Claude、fixture、event 和 process 回归**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test claude_adapter && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_fixtures && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_process`

Expected: PASS；未知/未采集版本零 spawn，已验证版本只开放 manifest 有证据的能力。

- [ ] **Step 9: 代码简化审查并提交 Claude adapter**

使用 `@code-simplifier` 审查 context 选择、protocol dispatch 和 process ownership；若修改，重跑 Step 8。

```bash
git add src-tauri/src/runtime/claude src-tauri/src/runtime/mod.rs src-tauri/tests/claude_adapter.rs
git commit -m "feat(runtime): 实现 Claude stream-json 适配器"
```

### Task 11: 建立 RuntimeAdapter factory 与跨 driver 一致性测试

**Files:**
- Create: `src-tauri/src/runtime/factory.rs`
- Create: `src-tauri/src/runtime/conformance.rs`
- Modify: `src-tauri/src/runtime/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Test: `src-tauri/tests/runtime_adapter_conformance.rs`

- [ ] **Step 1: 写失败测试固定两个 adapter 的公共语义**

参数化运行 Codex fixture adapter、Claude fixture adapter 和 FakeAdapter：

- `adapter_conformance_start_publishes_binding_only_after_protocol_ready`
- `adapter_conformance_send_returns_turn_id_not_model_content`
- `adapter_conformance_delta_is_ephemeral_and_completion_is_persistable`
- `adapter_conformance_terminal_event_occurs_once`
- `adapter_conformance_cancel_respects_capability_and_shutdown_always_contains_tree`
- `adapter_conformance_approval_respects_capability_and_pending_identity`
- `adapter_conformance_process_crash_releases_memory_and_reports_failure`
- `adapter_conformance_old_generation_events_are_ignored`
- `adapter_conformance_control_output_is_internal_nonserializable_and_never_mapped_as_user_event`
- `adapter_conformance_shared_service_driver_can_emit_bounded_recovery_plan_through_sink`
- `adapter_conformance_unknown_version_makes_zero_billable_request`
- `adapter_conformance_public_objects_are_secret_path_and_payload_free`
- `adapter_factory_rejects_unknown_driver_without_claude_fallback`
- `adapter_factory_uses_frozen_revision_driver_and_namespace`
- `adapter_factory_injects_one_application_output_relay_into_codex_pool_and_claude_adapters`

- [ ] **Step 2: 运行一致性测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_adapter_conformance`

Expected: FAIL，factory/conformance harness 尚不存在。

- [ ] **Step 3: 实现只按冻结 DriverKind 分派的 factory**

`RuntimeAdapterFactory` 输入为已由 ProviderResolver 验证的 `ResolvedRuntimeRevision`，并在自身构造时接收唯一 `Arc<RuntimeOutputRelay>`；它把同一 relay 注入所有 Codex shared pool generation 与 Claude adapter。内部重新核对 profile/revision driver、config hash、secretRef 状态和 typed namespace，再构造 adapter。未知/不匹配 driver 返回 Validation，不允许 `_ => Claude`。factory 只把 `SecretStore` handle传给 process launch closure；不提前 expose/clone secret，也不允许调用者为单个 binding 替换 output sink。

- [ ] **Step 4: 实现共享 conformance harness**

conformance 通过 FakeProcessHost/fixture bytes/FakeClock 驱动，不访问真实 CLI、不产生费用。每个 adapter 用相同断言检查 binding 发布、event ordering、cancel/approval capability、generation、shutdown tree ack 和 redaction；driver 特有事件仍由各自测试覆盖。

- [ ] **Step 5: 运行全量 adapter 回归、简化并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_adapter_conformance && cargo test --manifest-path src-tauri/Cargo.toml --test codex_protocol && cargo test --manifest-path src-tauri/Cargo.toml --test codex_adapter && cargo test --manifest-path src-tauri/Cargo.toml --test codex_recovery && cargo test --manifest-path src-tauri/Cargo.toml --test claude_adapter && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；两 driver 统一事件/终态一致，协议细节仍隔离在各自目录。

使用 `@code-simplifier` 审查 factory 分支和 conformance fake；若修改，重跑本步骤。

```bash
git add src-tauri/src/runtime/factory.rs src-tauri/src/runtime/conformance.rs src-tauri/src/runtime/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/tests/runtime_adapter_conformance.rs
git commit -m "test(runtime): 增加适配器一致性门禁"
```

### Task 12: 通过 Chunk 2 完整回归与计划检查点

**Files:**
- Verify only: all files changed in Tasks 7-11

- [ ] **Step 1: 运行全部离线 runtime adapter 测试**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml codex_ -- --nocapture && cargo test --manifest-path src-tauri/Cargo.toml claude_ -- --nocapture && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_adapter_conformance && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；测试只使用 fixture/fake，不访问网络或真实 provider。

- [ ] **Step 2: 核对官方 Codex baseline 和 Claude 不猜测规则**

Run: `rg -n "initialize|initialized|thread/start|thread/resume|turn/start|turn/interrupt|requestApproval|serverRequest/resolved|item/completed" src-tauri/src/runtime/codex src-tauri/runtime-fixtures/v1/codex && rg -n -g 'codex_*' "initialize|initialized|thread/start|thread/resume|turn/start|turn/interrupt|requestApproval|serverRequest/resolved|item/completed" src-tauri/tests`

Expected: 每个官方 method 都有 fixture、实现和测试；`initialized` 测试明确在 initialize success response 之后。

Run: `rg -n "capabilities\.[a-zA-Z_]+\s*=\s*true|unwrap_or\(true\)|default.*true" src-tauri/src/runtime/claude src-tauri/src/runtime/capabilities.rs`

Expected: 无从参数/默认值推断 true 的生产代码；true 只从已验证 manifest 读取。

- [ ] **Step 3: 核对共享 Codex 故障不会遗留失控进程**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test codex_recovery codex_cancel_ -- --nocapture`

Expected: grace 超时后先 Draining、再关闭整个修订 Job、确认 tree empty，最后才生成恢复计划；ack 失败阻止重启。

- [ ] **Step 4: 进行 Chunk 2 文档评审**

使用 plan-document-reviewer 按设计规格第 9-12、14、17 节和本计划 Chunk 2 核对。评审通过前不得进入 ConversationManager/Tauri 接线；若发现 driver 行为被通用层猜测，回到对应任务拆分修复。

## Chunk 3: ConversationManager、统一活动/退出、Tauri 边界与真实联调

### Task 13: 实现 ConversationManager 状态机、运行段和统一事件编排

**Files:**
- Create: `src-tauri/src/application/conversation_lane.rs`
- Create: `src-tauri/src/application/conversation_manager.rs`
- Create: `src-tauri/src/application/runtime_recovery.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/legacy_entity_deletion_guard.rs`
- Modify: `src-tauri/src/application/conversation_catalog_service.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/storage/runtime_outcome_store.rs`
- Modify: `src-tauri/src/domain/conversation.rs`
- Modify: `src-tauri/src/state.rs`
- Test: `src-tauri/tests/conversation_manager.rs`
- Test: `src-tauri/tests/bootstrap_order.rs`

- [ ] **Step 1: 写失败测试固定 per-conversation lane 和 segment 冻结顺序**

新增：

- `conversation_manager_send_serializes_one_active_turn_per_conversation`
- `conversation_manager_different_conversations_can_run_concurrently`
- `conversation_manager_rejects_running_waiting_approval_and_cancelling_reentry`
- `conversation_manager_resolves_provider_model_revision_before_process_start`
- `conversation_manager_creates_segment_with_frozen_revision_model_cwd_version_and_capabilities`
- `conversation_manager_persists_segment_before_adapter_start`
- `conversation_manager_adapter_start_failure_marks_new_segment_failed`
- `conversation_manager_project_or_provider_edit_after_start_does_not_retarget_segment`
- `conversation_manager_disabled_provider_blocks_new_segment_but_not_inflight_turn_completion`
- `conversation_manager_unknown_runtime_version_makes_zero_model_request`
- `conversation_manager_event_quota_failure_makes_zero_model_request`
- `conversation_manager_user_message_and_running_status_commit_before_turn_start`

`ConversationLane` 只串行同一 Conversation 的 start/send/cancel/approval/terminal callback；不同 Conversation 不共享一个巨型 mutex。外部 process/RPC I/O 不得在 lane/application mutation/repository lock 内执行。

- [ ] **Step 2: 写失败测试固定 Codex/Claude 恢复语义**

新增：

- `conversation_manager_codex_new_uses_thread_start_and_persists_native_thread_id`
- `conversation_manager_codex_resume_uses_latest_frozen_compatible_segment`
- `conversation_manager_codex_incompatible_resume_returns_context_bridge_required`
- `conversation_manager_codex_shared_recovery_ends_all_old_segments_interrupted`
- `conversation_manager_codex_shared_recovery_creates_one_new_segment_per_compatible_thread`
- `conversation_manager_codex_shared_recovery_keeps_unrecoverable_conversation_failed_only`
- `conversation_manager_receives_async_shared_recovery_through_adapter_control_output`
- `conversation_manager_duplicate_shared_recovery_control_for_generation_is_idempotent`
- `conversation_manager_claude_live_process_keeps_verified_multi_turn_context`
- `conversation_manager_claude_restart_creates_linked_segment_with_panel_context`
- `conversation_manager_claude_restart_never_calls_native_resume_or_global_history`
- `conversation_manager_restart_reprobes_capabilities_and_never_reuses_old_snapshot`

- [ ] **Step 3: 写失败测试固定完成、取消、审批和崩溃状态转换**

新增：

- `conversation_manager_delta_emits_without_repository_write`
- `conversation_manager_completed_event_commits_before_idle_state`
- `conversation_manager_cancel_requires_matching_active_turn`
- `conversation_manager_cancel_unsupported_does_not_fake_success`
- `conversation_manager_waiting_approval_state_requires_pending_request`
- `conversation_manager_approval_decision_requires_capability_and_once_or_deny`
- `conversation_manager_approval_abandoned_on_process_loss`
- `conversation_manager_process_crash_keeps_completed_events_and_marks_failed`
- `conversation_manager_duplicate_adapter_event_is_idempotent`
- `conversation_manager_stale_generation_event_cannot_complete_new_turn`
- `conversation_manager_memory_delta_is_zeroized_after_terminal_event`
- `conversation_manager_delete_switch_and_project_delete_detect_native_activity`

- [ ] **Step 4: 写失败测试固定启动崩溃恢复**

新增：

- `bootstrap_recovers_event_append_before_native_segment_reconciliation`
- `bootstrap_nonterminal_native_segment_without_live_process_becomes_interrupted`
- `bootstrap_pending_native_runtime_outcome_replays_before_manager_ready`
- `bootstrap_pending_approval_becomes_abandoned_after_process_loss`
- `bootstrap_discards_ephemeral_delta_without_assistant_completion`
- `bootstrap_cross_conversation_native_identity_conflict_enters_blocked`
- `bootstrap_native_recovery_failure_enters_blocked_not_legacy_fallback`
- `bootstrap_builds_empty_codex_pool_and_no_claude_process_until_send`
- `bootstrap_binds_runtime_output_relay_once_before_ready_or_any_process_start`
- `bootstrap_runtime_output_relay_bind_failure_enters_blocked_with_zero_spawn`

- [ ] **Step 5: 运行 ConversationManager 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager`

Expected: FAIL，ConversationManager/lane/recovery 尚不存在。

- [ ] **Step 6: 实现 send 的持久化与外部副作用顺序**

`send(conversationId, input)` 固定顺序：

1. 取得普通 Quit permit和 per-conversation owner claim；
2. 短 mutation section 读取 Conversation/Project/ProviderRevision、校验状态和 frozen pair；
3. probe exact CLI/capability，取得 event turn reservation；
4. 必要时创建新的 RuntimeSegment，冻结 revision/model/cwd/adapter/protocol/capability；
5. 原子提交 UserMessage、StatusChanged(Running)、Conversation.state=Running 和 activeSegment；
6. 释放 mutation/lane 外部锁，调用 adapter start/resume + start_turn；
7. 记录 active turn/binding generation并返回不含模型正文的 `NativeTurnReceipt`。

input 使用 `Zeroizing<String>` 消费型 request；只在 UserMessage redaction/事件提交和 adapter write 临界区存活，不进入 Debug。任一外部启动失败通过 runtime outcome/短 mutation section把 segment/Conversation 收敛为 Failed；已经提交的 UserMessage 保留并追加 RuntimeError。

- [ ] **Step 7: 实现 adapter output 分流、事件 callback 和终态提交**

`RuntimeEventSink` 实现先匹配 `RuntimeAdapterOutput`：`Event` 走普通事件路径，`Control` 只能进入内部 coordinator，永不序列化/Tauri。Event callback 先验证 conversation/segment/turn/binding generation，再在无 manager map lock下调用 event assembler/store；generation 仅拒绝 stale callback，不参与 eventId。delta 只广播；完成事件经 staging+journal append提交。只有 terminal event 已持久化且 ConversationsFile 状态写成功后，才把 lane effective state改为 Idle/Failed/WaitingApproval。pending outcome/journal 期间 delete/switch/start 返回 `RETRY_LATER`。

审批 request 先登记 adapter pending，再持久化 ApprovalRequested，最后发布 WaitingApproval；resolve 先发送决定，等待 adapter 的 resolved/completed事件再持久化并回 Running。任何失败路径不把未送达决定标为 approved/denied。

- [ ] **Step 8: 接入 Codex 共享恢复与 Claude 历史重建**

Codex `RuntimeControlEvent::SharedServiceRecoveryRequired(plan)` 由 manager 在 `(providerRevisionId, failedGeneration)` 单一 recovery claim 下消费；重复 control event 幂等忽略。manager 先验证 plan driver/revision/candidate 上限和每个 source segment 归属，短 mutation section把全部 source segment标 Interrupted并落 outcome；逐 conversation查询exact resume edge，兼容者创建新segment后调用新generation `thread/resume`，不兼容者保持Failed并返回ContextBridgeRequired。一个conversation失败不回滚其他已恢复项；稳定eventId排除generation，保证旧generation replay不重复。control event 缺失、revision不匹配或候选含未知segment时失败封闭并阻止该revision继续接收turn。

Claude process 丢失时旧 segment终结；下一次 send 才用 bounded Panel context创建新 segment，不在后台产生模型请求。StatusChanged 明确记录 `segmentRebuilt`，但不声称 Claude native thread 连续。

- [ ] **Step 9: 实现 bootstrap 原生运行段收敛**

Ready 构建顺序扩为：recover migration/compat/workspace → open repositories → recover runtime event append → recover RuntimeOutcomeStore → reconcile legacy/terminal → reconcile native nonterminal segments/approvals → validate NativeIdentity registry → create unbound RuntimeOutputRelay → build adapter factory/empty pools with relay → build ConversationManager sink → bind relay exactly once → publish Ready。relay 绑定前禁止任何 process start/output；绑定失败或重复绑定进入 Blocked。旧进程因 Job kill-on-close不可能跨应用重启；任何无 live process 的 Starting/Running/WaitingApproval/Cancelling native segment收敛为 Interrupted，pending approval为 Abandoned，delta 丢弃。保存失败或 identity 冲突使 runtime Blocked，不能静默回 legacy schema。

- [ ] **Step 10: 运行 manager/adapter/bootstrap 回归和简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo test --manifest-path src-tauri/Cargo.toml --test codex_recovery && cargo test --manifest-path src-tauri/Cargo.toml --test claude_adapter && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；无进程 I/O 持 mutation/runtime guard，所有完成事件先持久化后发布终态。

使用 `@code-simplifier` 审查 lane、状态转换和 Codex recovery coordinator；若修改，重跑本步骤。

- [ ] **Step 11: 提交 ConversationManager**

```bash
git add src-tauri/src/application/conversation_lane.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/application/runtime_recovery.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/legacy_entity_deletion_guard.rs src-tauri/src/application/conversation_catalog_service.rs src-tauri/src/storage/repositories.rs src-tauri/src/storage/runtime_outcome_store.rs src-tauri/src/domain/conversation.rs src-tauri/src/state.rs src-tauri/tests/conversation_manager.rs src-tauri/tests/bootstrap_order.rs
git commit -m "feat(runtime): 增加原生会话管理器"
```

### Task 14: 实现 RuntimeActivityRegistry、QuitGate 和统一关闭顺序

**Files:**
- Create: `src-tauri/src/application/runtime_activity_registry.rs`
- Create: `src-tauri/src/application/runtime_shutdown_coordinator.rs`
- Modify: `src-tauri/src/application/quit_gate.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src-tauri/src/pty/activity.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/commands/app_cmds.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/types.ts`
- Modify: `src/api/events.ts`
- Test: `src-tauri/tests/runtime_activity.rs`
- Test: `src-tauri/tests/quit_gate.rs`
- Test: `src-tauri/tests/tray_quit.rs`
- Test: `src/App.test.tsx`

- [ ] **Step 1: 写失败测试固定统一活动快照**

新增：

- `runtime_activity_aggregates_terminal_legacy_ai_native_turn_approval_and_connection_test`
- `runtime_activity_counts_one_segment_once_across_state_changes`
- `runtime_activity_running_waiting_approval_and_cancelling_require_quit_confirmation`
- `runtime_activity_failed_is_badge_state_but_not_live_process`
- `runtime_activity_hidden_to_tray_does_not_pause_or_kill_work`
- `runtime_activity_snapshot_contains_counts_not_prompt_path_or_provider_secret`
- `runtime_activity_uses_stable_ids_and_never_exposes_pty_or_process_id`
- `runtime_activity_bootstrap_injects_one_registry_into_tray_quit_and_managers`

公开 `RuntimeActivitySummary` 只含计数和布尔状态：`terminalActive/legacyAiActive/nativeTurns/waitingApprovals/cancelling/connectionTests/failed`，不含会话标题、provider URL、模型输出、PID 或 PTY ID。

- [ ] **Step 2: 写失败测试固定 QuitGate 与 shutdown 顺序**

新增：

- `quit_prepare_blocks_new_native_send_start_cancel_and_approval_submission`
- `quit_prepare_waits_inflight_submission_but_not_entire_active_turn`
- `quit_request_requires_confirmation_for_native_turn_or_approval`
- `quit_shutdown_order_is_native_cancel_then_native_job_then_pty_then_event_outcome_drain`
- `quit_shutdown_codex_interrupts_then_drains_shared_job_on_timeout`
- `quit_shutdown_claude_closes_each_job_and_marks_pending_turn_interrupted`
- `quit_shutdown_abandons_pending_approvals_without_faking_user_decision`
- `quit_shutdown_waits_runtime_lifecycle_callbacks_before_sealing`
- `quit_shutdown_event_or_outcome_drain_failure_returns_to_quiescing_and_never_exits`
- `quit_shutdown_tree_ack_failure_never_enters_exiting`
- `quit_cancel_reopens_new_native_operations_only_after_backend_cancel_succeeds`
- `quit_keep_alive_native_requests_remain_disabled_without_explicit_reconfirmation`

- [ ] **Step 3: 运行活动/退出测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_activity runtime_activity_`

Expected: FAIL，统一 registry 尚不存在；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate quit_`

Expected: FAIL，本 Task 新增的 QuitGate/shutdown 顺序测试必须实际执行且不得是 `0 tests`；不能因前一个命令先失败而跳过。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test tray_quit`

Expected: FAIL，tray 尚未接入统一活动与 shutdown coordinator。

- [ ] **Step 4: 实现只读聚合 RuntimeActivityRegistry**

registry 组合窄 `PtyActivitySource`、`NativeActivitySource` 和 connection-test source；各 source 自己拥有状态，registry 不复制 process lifecycle。snapshot 在短锁内取得稳定计数，供 tray、quit request和 BackendClient read API使用。tray 隐藏只改变窗口可见性，不调用 pause/cancel；badge/menu同时区分 terminal、running、waitingApproval、failed。

现有 keepAlive 只继续路由 legacy/terminal 既有行为；原生 AI keepAlive在 Phase C固定禁用。不得把旧 Project.keepAlive 自动映射到 ConversationManager，也不得产生定时模型请求/费用。

- [ ] **Step 5: 扩展 QuitGate lifecycle permit 而不阻塞整个 turn**

native send/start/cancel/approval command只在“提交/登记”期间持 ordinary permit，active turn本身由 registry和 `RuntimeLifecyclePermit` 管理；否则 `app_prepare_quit` 会永久等待 turn而无法进入取消阶段。adapter reader callback 在 Running/Preparing/Quiescing/Finalizing状态取得 lifecycle permit，Sealing/Exiting拒绝新回调；permit短暂覆盖 event/outcome提交，不持到模型长运行结束。

- [ ] **Step 6: 实现 RuntimeShutdownCoordinator**

`app_quit` 在匹配 token 的 Finalizing中固定执行：

1. `ConversationManager::stop_accepting()`；
2. 对所有 native turn 请求协议取消，等待各 driver grace；
3. 关闭仍存活的 Claude Job和需要 draining的 Codex修订 Job，逐棵确认 tree empty；
4. 将未完成 turn/approval/segment收敛为 Interrupted/Abandoned并提交完成事件；
5. 调用 Phase A/B `PtyManager::finalize_all_for_shutdown()`；
6. 进入 Sealing，等待全部 runtime/PTY lifecycle permit归零；
7. drain RuntimeOutcomeStore、runtime event append和 legacy import/workspace/settings既有 journal；
8. 所有目录为空/状态提交成功后才 Exiting。

任一步失败回 Quiescing并保留 token/重试状态，绝不 exit或把未确认 tree 标 Stopped。shutdown不调用用户可见 cancel命令，避免 QuitGate ordinary permit递归。

- [ ] **Step 7: 更新 quit request payload 与托盘**

`QuitRequestPayload` 增加 `activity: RuntimeActivitySummary`，`requiresConfirmation` 由 registry live counts计算；前端确认文案只显示数量，不显示会话内容。无活动仍走统一 flush/prepare/quit，不允许 tray直接 `app.exit`。Fake/BackendClient的完整接线在 Task 15完成，本任务 Rust/类型先保持编译。

- [ ] **Step 8: 运行退出全量回归和简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_activity && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate && cargo test --manifest-path src-tauri/Cargo.toml --test tray_quit && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && npm run test -- src/App.test.tsx && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；prepare后无新模型请求，树/事件/outcome未确认时不退出。

使用 `@code-simplifier` 审查 registry聚合、QuitGate permit和shutdown阶段；若修改，重跑本步骤。

- [ ] **Step 9: 提交统一活动与退出**

```bash
git add src-tauri/src/application/runtime_activity_registry.rs src-tauri/src/application/runtime_shutdown_coordinator.rs src-tauri/src/application/quit_gate.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/pty/activity.rs src-tauri/src/pty/manager.rs src-tauri/src/tray.rs src-tauri/src/commands/app_cmds.rs src-tauri/src/state.rs src-tauri/src/lib.rs src/api/types.ts src/api/events.ts src-tauri/tests/runtime_activity.rs src-tauri/tests/quit_gate.rs src-tauri/tests/tray_quit.rs src/App.test.tsx
git commit -m "feat(runtime): 统一原生会话活动与退出"
```

### Task 15: 扩展 BackendClient、Tauri、Fake 和 nativeAiEnabled 功能门

**Files:**
- Create: `src-tauri/src/commands/native_runtime_cmds.rs`
- Create: `src-tauri/tests/native_runtime_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/v2/types.test.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/events.ts`
- Modify: `src/api/workspaceClient.test.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src/App.tsx`
- Test: `src/api/nativeRuntimeClient.test.ts`
- Test: `src/App.test.tsx`

- [ ] **Step 1: 写失败契约测试固定公开 DTO 无敏感/driver 私有字段**

新增：

- `nativeRuntimeCapabilities_contains_versions_and_booleans_not_secret_revision_or_path`
- `nativeTurnReceipt_contains_conversation_segment_turn_only`
- `nativeRuntimeEvent_delta_and_completed_are_discriminated`
- `nativeRuntimeEvent_contains_no_secret_env_raw_payload_or_runtime_namespace`
- `nativeApprovalDecision_allows_only_approveOnce_or_deny`
- `nativeSendInput_contains_conversationId_and_text_not_driver_provider_revision_or_session_id`
- `nativeCancelInput_requires_conversationSegmentAndTurnIds`
- `nativeApprovalInput_requires_conversationAndRequestIds`
- `runtimeActivitySummary_exposes_counts_only`
- `backendClient_native_methods_match_tauri_and_fake`
- `fakeBackendClient_can_emit_delta_completed_approval_and_activity_events`
- `fakeBackendClient_dispose_unsubscribes_and_ignores_late_events`

- [ ] **Step 2: 写失败 Rust command 测试固定功能门和 legacy 保留**

新增：

- `native_runtime_capabilities_may_run_bounded_version_probe_but_starts_no_adapter_or_model_request`
- `native_runtime_send_cancel_and_approval_return_native_ai_disabled_when_flag_false`
- `native_runtime_disabled_commands_make_zero_repository_process_and_event_changes`
- `native_runtime_commands_reject_legacy_read_only_recovering_and_blocked`
- `native_runtime_command_parses_all_entity_ids_before_service_call`
- `native_runtime_commands_take_quit_permit_before_short_runtime_snapshot`
- `native_runtime_event_subscription_has_bounded_channel_and_drops_no_terminal_event`
- `native_runtime_commands_are_registered_once`
- `native_ai_flag_fresh_migrated_and_compat_writes_remain_false`
- `native_ai_flag_has_no_phase_c_public_setter_or_settings_toggle`
- `legacy_work_item_runtime_start_still_routes_ai_to_legacy_launch`
- `legacy_pty_commands_dto_and_compatibility_facade_still_exist`

- [ ] **Step 3: 运行客户端/command 测试并确认失败**

Run: `npm run test -- src/api/v2/types.test.ts src/api/nativeRuntimeClient.test.ts src/api/workspaceClient.test.ts src/App.test.tsx`

Expected: FAIL，新 DTO/client/event尚不存在。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test native_runtime_commands`

Expected: FAIL，native runtime commands和feature gate尚不存在。

- [ ] **Step 4: 定义 Phase D 可复用、Phase C 不启用的 API**

`BackendClient` 增加：

```ts
nativeRuntimeCapabilities(conversationId: string): Promise<RuntimeCapabilities>;
nativeConversationSend(conversationId: string, input: string): Promise<NativeTurnReceipt>;
nativeConversationCancel(input: NativeCancelInput): Promise<void>;
nativeConversationResolveApproval(input: NativeApprovalInput): Promise<void>;
runtimeActivityGet(): Promise<RuntimeActivitySummary>;
onNativeRuntimeEvent(callback: (event: NativeRuntimeEvent) => void): Promise<() => void>;
```

mutation DTO不接受 driver/providerRevision/modelName/externalSessionId/cwd/argv/env；manager从稳定 Conversation和冻结 segment解析。Tauri client只转发camelCase；Fake保存调用记录、deferred/error和可控事件，不复制manager状态机。

Tauri Channel设置有界队列：delta可在前端落后时合并同 message连续片段并附 sequence，完成/审批/状态事件不得丢弃或越序；队列越限导致当前 turn明确失败并持久化 RuntimeError，不能无限内存或静默 drop terminal event。

- [ ] **Step 5: 实现只读能力与 mutation feature gate**

read-only capabilities可在 Ready下probe版本/matrix，但不得启动app-server/Claude或访问secret；unknown返回全 false。所有 native send/cancel/approval command在 service call和secret读取前检查持久化 `nativeAiEnabled`，Phase C固定 false，因此返回 `NATIVE_AI_DISABLED`且零状态变化。内部单元/真实smoke直接调用受控 service harness，不通过伪造前端flag绕过。

本任务不新增原生消息store/组件，不修改Ready WorkPane AI渲染；`App.tsx` 只接入扩展的quit payload类型，仍使用legacy PTY AI。任何设置writer继续只patch自己拥有字段并保留native flag false。

- [ ] **Step 6: 注册命令和事件并运行全量契约测试**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test native_runtime_commands && cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime && npm run test -- src/api/v2/types.test.ts src/api/nativeRuntimeClient.test.ts src/api/workspaceClient.test.ts src/App.test.tsx && npm run typecheck && npm run build`

Expected: PASS；native mutation全部被flag拒绝，legacy AI/terminal路径继续通过。

- [ ] **Step 7: 代码简化审查并提交 API 门禁**

使用 `@code-simplifier` 审查 Tauri/Fake方法样板、feature gate和event union；若修改，重跑 Step 6。

```bash
git add src-tauri/src/commands/native_runtime_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/state.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/conversation_manager.rs src-tauri/tests/native_runtime_commands.rs src/api/v2/types.ts src/api/v2/types.test.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/events.ts src/api/workspaceClient.test.ts src/api/nativeRuntimeClient.test.ts src/test/FakeBackendClient.ts src/App.tsx src/App.test.tsx
git commit -m "feat(runtime): 增加原生会话 API 功能门"
```

### Task 16: 增加显式可能计费的 Provider 连接测试

**Files:**
- Create: `src-tauri/src/application/provider_connection_service.rs`
- Create: `src-tauri/src/commands/provider_connection_cmds.rs`
- Create: `src-tauri/tests/provider_connection.rs`
- Modify: `src-tauri/src/application/runtime_activity_registry.rs`
- Modify: `src-tauri/src/application/runtime_shutdown_coordinator.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/nativeRuntimeClient.test.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src/components/providers/ProviderManager.tsx`
- Modify: `src/components/providers/ProviderManager.test.tsx`
- Create: `src/components/providers/ProviderConnectionDialog.tsx`
- Create: `src/components/providers/ProviderConnectionDialog.test.tsx`
- Modify: `src/styles/providers.css`

- [ ] **Step 1: 写失败后端测试区分免费 probe 与真实连接**

新增：

- `provider_probe_checks_executable_version_fixture_config_and_secret_presence_without_model_request`
- `provider_probe_never_reports_connection_success`
- `provider_connection_test_requires_confirmed_potential_charge_true`
- `provider_connection_test_rechecks_revision_model_and_secret_after_confirmation`
- `provider_connection_test_unsupported_version_makes_zero_model_request`
- `provider_connection_test_uses_ephemeral_revision_scoped_namespace_and_clean_env`
- `provider_connection_test_uses_fixed_diagnostic_input_not_user_content`
- `provider_connection_test_auto_denies_unexpected_approval_and_never_auto_approves`
- `provider_connection_test_success_requires_assistant_completion_and_terminal_turn`
- `provider_connection_test_returns_no_model_text_usage_session_thread_path_or_secret`
- `provider_connection_test_failure_is_redacted_and_always_closes_job`
- `provider_connection_test_one_per_revision_and_quit_cancels_active_test`
- `provider_connection_test_local_cleanup_does_not_claim_remote_history_deletion`

probe可读取`SecretStore.exists(secretRef)`，但不得 expose value或启动driver process。真实test发送固定内置诊断消息，结果只返回 connected/unsupported/failed、driver、CLI/protocol/fixture版本、能力和耗时区间；不返回回复正文/usage/native ID。

- [ ] **Step 2: 写失败 UI 测试固定费用确认和文案**

新增：

- `providerManager_probe_is_labeled_local_check_not_connection_success`
- `providerManager_connection_test_opens_potential_charge_confirmation`
- `providerConnectionDialog_shows_provider_model_endpoint_risk_and_no_secret`
- `providerConnectionDialog_requires_explicit_checkbox_and_confirm`
- `providerConnectionDialog_cancel_calls_no_billable_command`
- `providerConnectionDialog_rechecks_stale_revision_and_requires_reconfirm`
- `providerConnectionDialog_busy_disables_duplicate_test`
- `providerConnectionDialog_success_only_after_backend_connected_result`
- `providerConnectionDialog_failure_keeps_provider_editable_and_redacted`
- `providerConnectionDialog_unknown_claude_capabilities_shows_unsupported_not_guess`

- [ ] **Step 3: 运行连接测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test provider_connection && npm run test -- src/components/providers/ProviderManager.test.tsx src/components/providers/ProviderConnectionDialog.test.tsx src/api/nativeRuntimeClient.test.ts`

Expected: FAIL，connection service/commands/dialog尚不存在。

- [ ] **Step 4: 实现两阶段 ProviderConnectionService**

`probe(providerId, modelId)` 只做repository/provider/model/secret存在性、immutable config hash、executable/version/fixture matrix检查；返回 `localReady | missingCli | missingSecret | unsupportedVersion | invalidConfig`，永不使用“连接成功”。

`test(ProviderConnectionTestInput { providerId, modelId, expectedRevisionId, confirmedPotentialCharge })` 在 `confirmedPotentialCharge != true` 时固定返回 `CONFIRMATION_REQUIRED`，且零secret读取/进程/请求。确认后重新解析当前profile/revision/model；revision已变化返回Conflict，要求UI重新确认，不能把旧确认用于新URL/密钥/模型。

真实test使用 `runtime/connection-tests/<testId>/<providerRevisionId>` 临时本地namespace和空测试cwd，不写Conversation/RuntimeSegment/事件日志。固定诊断输入由binary内常量提供且不记录；所有approval自动Deny、绝不Approve。只有收到规范化AssistantMessageCompleted和明确turn terminal才返回connected。结束时关闭Job并通过guarded store清理本次临时目录；远端可能保留请求/线程的边界在UI明确说明。

- [ ] **Step 5: 接入 BackendClient/Tauri/Fake 和 RuntimeActivityRegistry**

增加 `providerRuntimeProbe(providerId, modelId)` 与 `providerConnectionTest(input)`；DTO不接受secret/baseUrl/prompt。active connection test登记registry计数并受QuitGate约束：prepare后拒绝新test，shutdown取消/关闭Job，未确认tree empty阻止退出。Fake记录confirmed布尔和expectedRevisionId，测试snapshot不含secret。

- [ ] **Step 6: 实现费用确认 UI**

ProviderManager显示“本地检查”和“连接测试（可能产生费用）”两个明确动作。本地检查只显示CLI/fixture/config状态；连接测试对话框说明：将向当前供应商/模型发送固定诊断请求、可能计费、可能在远端保留记录、本地不会显示/保存模型正文。用户必须勾选确认后才能执行；成功只来自backend connected结果。任何secret掩码/正文均不进入DOM。

- [ ] **Step 7: 运行连接、活动、前端回归和简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test provider_connection && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_activity && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate && npm run test -- src/components/providers/ProviderManager.test.tsx src/components/providers/ProviderConnectionDialog.test.tsx src/api/nativeRuntimeClient.test.ts && npm run typecheck && npm run build`

Expected: PASS；未确认、未知版本、stale revision均零模型请求；结果/DOM无模型正文或secret。

使用 `@code-simplifier` 审查probe/test共享校验和对话框状态；若修改，重跑本步骤。

- [ ] **Step 8: 提交连接测试**

```bash
git add src-tauri/src/application/provider_connection_service.rs src-tauri/src/application/runtime_activity_registry.rs src-tauri/src/application/runtime_shutdown_coordinator.rs src-tauri/src/application/bootstrap.rs src-tauri/src/commands/provider_connection_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/provider_connection.rs src/api/v2/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/nativeRuntimeClient.test.ts src/test/FakeBackendClient.ts src/components/providers/ProviderManager.tsx src/components/providers/ProviderManager.test.tsx src/components/providers/ProviderConnectionDialog.tsx src/components/providers/ProviderConnectionDialog.test.tsx src/styles/providers.css
git commit -m "feat(runtime): 增加显式供应商连接测试"
```

### Task 17: 扩展显式 opt-in CLI smoke 与双供应商隔离联调

**Files:**
- Modify: `package.json`
- Modify: `scripts/cli-smoke.mjs`
- Create: `src-tauri/src/bin/tht_panel_runtime_smoke.rs`
- Create: `src-tauri/src/runtime/smoke.rs`
- Create: `src-tauri/tests/runtime_cli_smoke_contract.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

- [ ] **Step 1: 写失败 contract 测试固定默认无费用行为**

新增：

- `cli_smoke_default_and_probe_only_never_open_secret_or_send_model_request`
- `cli_smoke_runtime_requires_confirm_potential_charge_flag`
- `cli_smoke_runtime_requires_debug_smoke_config_root_under_target`
- `cli_smoke_accepts_provider_ids_not_secret_url_prompt_or_native_session_id`
- `cli_smoke_output_is_pass_skip_fail_with_version_and_capability_only`
- `cli_smoke_output_never_contains_model_text_tool_output_path_secret_or_environment`
- `cli_smoke_missing_cli_is_skip_and_protocol_mismatch_is_fail`
- `cli_smoke_unknown_claude_version_reports_unsupported_without_guessing`
- `cli_smoke_every_started_process_is_job_contained_and_closed`

- [ ] **Step 2: 写失败 case 测试固定真实联调矩阵**

在FakeProcessHost/fixture下验证runner会编排：

- Codex：initialize/initialized、新thread、同thread下一turn、版本兼容resume、stream完成、turn/interrupt、requestApproval→Deny→resolved→item completed；
- Claude：只执行manifest为true的stream/multiTurn/partial/tool/cancel/approval项，false项明确SKIP(unsupported capability)，不得补测猜测协议；
- 同modelName两个不同ProviderRevision并发：process/job/config/secret env/native thread/event归属完全分离；
- 任一case超时/关键协议不兼容为FAIL，CLI缺失为SKIP，未提供第二provider为SKIP而不是伪PASS。

- [ ] **Step 3: 运行 smoke contract 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_cli_smoke_contract`

Expected: FAIL，runtime smoke runner尚不存在。

- [ ] **Step 4: 实现安全 Node wrapper 和 Rust runner**

`npm run test:cli-smoke` 默认等价 `--probe-only`，维持Phase A无费用语义。真实模式固定：

```powershell
npm run test:cli-smoke -- --runtime --confirm-potential-charge --config-root '<SMOKE_ROOT_UNDER_TARGET>' --provider-id '<ID>' --provider-id '<SECOND_ID>'
```

只验证单一Provider时省略最后一组`--provider-id '<SECOND_ID>'`；尖括号内容必须在执行前替换为本轮已核对的实际值，不能把模板字面量传给runner。

Node只校验flags/provider UUID/config root后调用Rust binary；argv不允许secret/baseUrl/prompt/model output/native ID。Rust runner通过ConfigRoot/Repositories/SecretStore按provider ID解析secret，在进程内使用与生产相同adapter/Job/fixture matrix；结果只输出case ID、driver/version/capabilities、PASS/SKIP/FAIL和脱敏reason code。固定诊断prompt与安全审批fixture编译在binary，不打印。

真实smoke配置根必须是执行者新建且位于 `src-tauri/target/` 下的隔离v2配置，provider必须明确标记为非生产测试。runner拒绝默认应用配置、用户HOME/仓库目录、release build和`THT_PANEL_SMOKE!=1`。

- [ ] **Step 5: 运行离线 smoke orchestration 测试**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_cli_smoke_contract && npm run test:cli-smoke -- --probe-only`

Expected: contract PASS；probe对每个driver输出PASS(version)或SKIP(not installed)，退出0，无模型请求/费用/环境值。

- [ ] **Step 6: 在真实 CLI smoke 前再次取得用户明确同意**

向用户列出将测试的Provider ID/显示名、模型、case数量、可能费用、将执行的安全审批/取消动作和隔离目录；不得展示secret/baseUrl完整值。没有明确同意时停止，Phase C真实联调项保持未完成，不能用生产密钥或用户全局认证替代。

- [ ] **Step 7: 运行真实 runtime smoke 并保存脱敏结果**

双Provider隔离case使用以下完整命令；单Provider验证时省略最后一组`--provider-id '<SECOND_TEST_PROVIDER_ID>'`。所有尖括号模板都必须先替换为本轮核对的实际值。

Run: `$env:THT_PANEL_SMOKE='1'; npm run test:cli-smoke -- --runtime --confirm-potential-charge --config-root '<SMOKE_ROOT_UNDER_TARGET>' --provider-id '<TEST_PROVIDER_ID>' --provider-id '<SECOND_TEST_PROVIDER_ID>'`

Expected: 每项输出PASS/SKIP/FAIL。CLI未安装为SKIP；manifest不支持的Claude能力为SKIP(unsupported)且保持false；已配置且版本应支持却协议不兼容为FAIL；Codex官方baseline、取消、审批和兼容resume均需PASS；传入两个同modelName provider时隔离并发需PASS。任何FAIL阻止Phase C完成。

- [ ] **Step 8: 恢复环境并保留证据目录**

Run: `Remove-Item Env:THT_PANEL_SMOKE -ErrorAction SilentlyContinue`

Expected: 当前shell不再设置smoke标志；不得自动删除smoke config/capture目录，保留至用户明确批准清理。日志不得含真实模型正文、工具输出、secret或完整用户路径。

- [ ] **Step 9: 代码简化审查并提交 smoke runner**

使用 `@code-simplifier` 审查case编排、结果redaction和Node/Rust重复参数校验；若修改，重跑Step 5。

```bash
git add package.json scripts/cli-smoke.mjs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/bin/tht_panel_runtime_smoke.rs src-tauri/src/runtime/smoke.rs src-tauri/tests/runtime_cli_smoke_contract.rs
git commit -m "test(runtime): 增加显式 CLI 联调"
```

### Task 18: 通过 Phase C 自动化、安全和兼容验收

**Files:**
- Create: `docs/verification/phase-c-runtime-adapters.md`
- Verify only: all Phase C files

- [ ] **Step 1: 运行完整前端门禁**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部成功；Ready/Legacy工作区仍渲染legacy PTY AI，Provider连接测试费用确认测试通过，无skipped/focused test。

- [ ] **Step 2: 运行完整 Rust 门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；固定样例、任意分片、事件append恢复、Job tree、Codex共享恢复、Claude未知能力、ConversationManager、QuitGate和legacy回归均执行。

- [ ] **Step 3: 运行 runtime 聚焦门禁**

Run: `cargo test --manifest-path src-tauri/Cargo.toml runtime -- --nocapture`

Expected: 所有runtime测试PASS；输出只含case/稳定错误码，不含raw JSON、prompt、模型回复、工具输出、URL、cwd、secret或环境值。

- [ ] **Step 4: 静态扫描密钥、argv、事件和WebView边界**

Run: `rg -n "apiKey|secretValue|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|authorization|bearer" src src-tauri/src src-tauri/runtime-fixtures scripts`

Expected: 只命中write-only输入、集中环境key清单、redaction/负向测试；公开DTO、event、fixture、UI和日志实现无secret值。

Run: `rg -n "Command::arg|args\(|argv|command_line" src-tauri/src/runtime`

Expected: 每个argv构造逐项可解释且不含secret/baseUrl/prompt/native未验证ID；Codex仅app-server和官方方法JSON，Claude仅固定machine-mode/settings参数。

Run: `rg -n "AssistantDelta" src-tauri/src/storage src-tauri/src/domain src-tauri/src/runtime`

Expected: storage/domain可序列化完成事件中无AssistantDelta；只在runtime ephemeral event/assembler/Tauri event边界命中。

- [ ] **Step 5: 核对容量和崩溃恢复证据**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store event_append_ -- --nocapture && cargo test --manifest-path src-tauri/Cargo.toml --test codex_recovery codex_recovery_ -- --nocapture && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager bootstrap_ -- --nocapture`

Expected: event append每个崩溃点幂等；共享Codex每个线程独立恢复/失败；重启丢弃delta但不丢完成事件，不复用旧capability snapshot。

- [ ] **Step 6: 核对 nativeAiEnabled 默认 false 和 legacy 路径未删除**

Run: `rg -n "native_ai_enabled:\s*false|nativeAiEnabled.*false" src-tauri/src src`

Expected: fresh/migration/default测试及实现明确false，无Phase C true setter。

Run: `rg -n "LegacyLaunchService|work_item_runtime_start|pty_spawn|CompatibilityFacade|PaneGrid|TerminalPane" src-tauri/src src`

Expected: legacy后端/命令/组件仍存在并由回归测试覆盖；Phase C没有删除旧配置/DTO/PTY路径。

- [ ] **Step 7: 运行默认无费用 CLI probe**

Run: `npm run test:cli-smoke -- --probe-only`

Expected: 每个driver PASS(version)或SKIP(not installed)，零模型请求、零费用、无环境值。

- [ ] **Step 8: 仅在已有明确费用同意时引用真实联调结果**

若Task 17已获同意并运行，记录各case PASS/SKIP/FAIL、CLI/protocol/fixture版本、测试Provider显示名和脱敏配置根标签；不得复制命令原始输出中的模型正文/工具输出。若未获同意，文档必须明确“真实可能计费联调未执行”，Phase C保持未完成，不得以fake/fixture冒充真实证据。

- [ ] **Step 9: 手工验证连接测试和退出**

Run: `$env:THT_PANEL_SMOKE='1'; $phaseCSmoke = Join-Path (Resolve-Path 'src-tauri\target') ('phase-c-smoke-' + [guid]::NewGuid()); $env:THT_PANEL_CONFIG_DIR=$phaseCSmoke; npm run tauri -- dev`

Expected: 应用仍进入Phase B壳和legacy AI路径；ProviderManager本地检查不声称连接成功；真实连接测试必须先显示可能计费确认。只有使用明确非生产测试provider且用户本轮再次同意时才执行真实test。托盘隐藏不停止现有PTY；退出摘要能统计native connection test/turn/approval（真实native turn可由受控smoke harness触发），关闭顺序确认Job树和event/outcome均收敛。不得切换`nativeAiEnabled`或手工破坏配置制造失败。

- [ ] **Step 10: 恢复 smoke 环境变量**

Run: `Remove-Item Env:THT_PANEL_CONFIG_DIR -ErrorAction SilentlyContinue; Remove-Item Env:THT_PANEL_SMOKE -ErrorAction SilentlyContinue`

Expected: 当前shell不再设置调试配置目录/smoke标志；不得删除证据目录，等待用户明确批准。

- [ ] **Step 11: 执行最终代码简化并重跑受影响门禁**

使用 `@code-simplifier` 对Phase C最近修改代码进行行为保持审查，重点检查codec状态机、adapter mapper、pool锁、manager lane、QuitGate和Tauri/Fake样板。若产生修改，按文件归属重跑Steps 1-6，并单独提交：

```powershell
$unexpected = @(git status --porcelain | Where-Object { $_ -match '^\?\?' })
if ($unexpected.Count -gt 0) { throw "code-simplifier created unexpected untracked files: $($unexpected -join ', ')" }
$deletedFiles = @(git diff --diff-filter=D --name-only -- src src-tauri/src src-tauri/tests scripts package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock)
if ($deletedFiles.Count -gt 0) { throw "code-simplifier proposed deletions requiring separate explicit user approval: $($deletedFiles -join ', ')" }
$simplifiedFiles = @(git diff --diff-filter=ACMRTUXB --name-only -- src src-tauri/src src-tauri/tests scripts package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock)
if ($simplifiedFiles.Count -gt 0) {
  $simplifiedFiles
  git diff --check -- $simplifiedFiles
  if ($LASTEXITCODE -ne 0) { throw 'code-simplifier diff check failed' }
  git add -- $simplifiedFiles
  if ($LASTEXITCODE -ne 0) { throw 'failed to stage exact simplified file list' }
  git diff --cached --name-only
  git commit -m "refactor(runtime): 简化运行时适配器实现"
}
```

输出的 `$simplifiedFiles` 就是本次精确清单；若为空则不创建空提交。不得把代码简化改动、未跟踪文件或验收文档混入同一提交。

- [ ] **Step 12: 写入脱敏验收文档并使用完成前验证**

`docs/verification/phase-c-runtime-adapters.md` 记录Phase C base/HEAD、commits、fixture manifest/hash摘要、自动化命令、容量/崩溃恢复证据、Codex官方baseline、Claude逐项能力true/false证据、连接测试费用确认和真实smoke状态。不得记录secret、完整本机路径、模型正文、工具输出、原生session/thread ID或用户对话。

使用 `@superpowers:verification-before-completion` 重新运行并核对最新命令输出；任何门禁/真实必需case失败时Phase C保持未完成。

```bash
git add docs/verification/phase-c-runtime-adapters.md
git commit -m "test(runtime): 记录 Phase C 验收证据"
```

- [ ] **Step 13: 核对提交范围、Chunk 行数和干净状态**

Run: `git diff --check && git status --short`

Expected: worktree干净，无raw capture、临时event journal、runtime outcome、secret blob或生成binary被提交。

Run: `$first = git log --grep='^feat(runtime): 固定适配器与能力契约$' -n 1 --format='%H'; if (-not $first) { throw 'Phase C first commit not found' }; $phaseCBase = git rev-parse "$first^"; git diff --name-only "$phaseCBase..HEAD"`

Expected: 文件逐项属于本计划Tasks 1-18，不含主工作区已有`package-lock.json`、`AGENTS.md`、`tsconfig.node.tsbuildinfo`、raw fixture capture或未授权删除。

Run: `$chunks = Select-String -Path 'docs/superpowers/plans/2026-07-10-panel-redesign-phase-c-runtime-adapters.md' -Pattern '^## Chunk '; $lines = Get-Content 'docs/superpowers/plans/2026-07-10-panel-redesign-phase-c-runtime-adapters.md'; for ($i=0; $i -lt $chunks.Count; $i++) { $start=$chunks[$i].LineNumber; $end=if ($i+1 -lt $chunks.Count) {$chunks[$i+1].LineNumber-1} else {$lines.Count}; if (($end-$start+1) -gt 1000) { throw "Chunk $($i+1) exceeds 1000 lines" } }`

Expected: 每个Chunk不超过1000行；所有实施步骤使用checkbox语法，header、精确Files/Run/Expected、TDD、`@code-simplifier`和频繁commit均保留。

- [ ] **Step 14: 进行最终计划/实现评审**

使用plan-document-reviewer按设计规格、roadmap和本计划三个Chunk做最终核对。必须明确确认：Codex官方顺序、Claude未验证=false、NativeSessionId、revision namespace、secret不进argv/log/event/WebView、容量上限、append/进程/共享server崩溃恢复、统一活动/退出、费用确认、CLI smoke、`nativeAiEnabled=false`和legacy保留均有源码与测试证据；否则不得宣布Phase C完成或进入Phase D。
