# Panel Redesign Phase E Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase A-D 已完成且不重写其业务能力的前提下，以确定性容量/性能预算、全恢复矩阵、只读引用审计、显式授权清理、可复现 NSIS 解包审计和七项证据矩阵完成最终加固。

**Architecture:** Phase E 在既有 `ConversationQueryService`、`ConversationEventStore`、runtime adapter、恢复 Journal、ContextBridge、rollout 和 native/legacy 单 sink 边界上增加窄职责的 hardening budget、观测计数与恢复面清单；自动化门禁只使用读取字节、I/O 调用次数、DOM 节点、队列深度、对象/句柄计数和 FakeClock，不用墙钟耗时判 PASS。引用清理严格分为root-reachability只读audit与用户确认后的write-ahead manifest/journal transaction；发布审计使用唯一`CARGO_TARGET_DIR`，以锁定`7zip-bin`仅bootstrap解出hash锁定的official full 7-Zip 26.02，再由支持NSIS的full 7z只list/extract且不执行任何installer/payload。真实CLI推迟到最终代码冻结后，以新隔离root、本轮明确授权、safe report和runtimeScopeCommit形成独立证据。

**Tech Stack:** React 19、TypeScript 5.8、Zustand 5、Vitest、Testing Library、Tauri 2、Rust 2021、serde/serde_json、Phase A-D 的 guarded storage/Journal/QuitGate/RuntimeActivityRegistry、Node.js `node:test`、`7zip-bin` 5.2.0 bootstrap、official full 7-Zip 26.02 win-x64、Windows NSIS。

---

## Chunk 1: 确定性容量、性能、背压与安全回归

### Phase E 硬边界

- Phase E 只在 Phase A-D 自动化门禁通过、Phase C/D 必需真实 CLI 项不存在 FAIL 后执行；不得用本阶段压力测试替代协议 fixture、ContextBridge、CSP 或 native workspace 的既有验收。
- 自动化性能门禁禁止以 `Date.now()`、真实 sleep、机器 CPU 型号或“若干毫秒内完成”作为 PASS 条件。墙钟、任务管理器和人工观感只能写入手工证据；硬门禁必须使用读取字节、调用次数、DOM 节点、队列深度、缓冲区字节、活跃对象/句柄和 FakeClock 状态转换。
- 事件查询继续使用 Phase D 的不透明 cursor、每页最多 200 个完成事件和 4 MiB public payload；本阶段只增加有界倒序读取、计数门禁和缓存背压，不改变事件 schema，也不返回 `AssistantDelta`。
- `AssistantDelta` 仍是可丢的进程内临时态；完成、审批、状态和错误事件永不静默丢弃。背压只能释放/合并 delta，并显式进入“等待后端权威终态”，不得自行伪造完成消息或 RuntimeError。
- Codex app-server 空闲释放继续沿用 Phase C 修订级共享池；只有无 attached thread、active turn、pending approval/RPC、writer queue、recovery plan 和 lifecycle callback 时才可释放。任何审批或 turn 活动都必须推迟释放并重新开始完整空闲区间。
- 本阶段对 Phase D 的 SafeMarkdown、外链服务、CSP 和 Tauri capabilities 只做对抗回归与静态审计；不得重新放宽 `raw HTML`、危险 scheme、remote script/connect wildcard 或 `*:default` 权限。
- evidence、smoke、raw capture、NSIS 解包目录和用户项目目录不属于自动清理目标；任何本阶段工具都不得在成功或失败后自动删除这些目录。
- Phase E 不预授权删除或移动任何 source/config/dependency 文件、tracked 文件、证据目录或用户数据。每次 `git add`/commit 前以及每次 `@code-simplifier` 前后都运行 `$unstagedDeleted=@(git diff --diff-filter=D --name-only); $stagedDeleted=@(git diff --cached --diff-filter=D --name-only); $unstagedRenamed=@(git diff --diff-filter=R --name-only); $stagedRenamed=@(git diff --cached --diff-filter=R --name-only); if($unstagedDeleted.Count -gt 0 -or $stagedDeleted.Count -gt 0 -or $unstagedRenamed.Count -gt 0 -or $stagedRenamed.Count -gt 0){$unstagedDeleted; $stagedDeleted; $unstagedRenamed; $stagedRenamed; throw 'tracked deletion or move requires renewed explicit user approval'}`；任何精确`git add`前还必须要求全局cached普通修改为空，暂存后再复核cached deletion/rename与精确暂存清单，避免把既有index内容带入提交。若确需删除或移动，必须重新列出每个精确目标、零引用/替代证据和影响并取得用户明确批准。`ReferenceCleanupService` 的UI确认只授权其Journal manifest内的应用自有运行artifact，不授权实施代理删除或移动源码、配置、依赖、smoke/capture/release evidence或项目目录。

### Task 1: 冻结 Phase D clean baseline 并建立版本化确定性预算

**Files:**
- Create: `src/hardening/budgets-v1.json`
- Create: `src/hardening/budgets.ts`
- Create: `src/hardening/budgets.test.ts`
- Create: `src-tauri/src/hardening/mod.rs`
- Create: `src-tauri/src/hardening/budgets.rs`
- Create: `src-tauri/tests/hardening_budgets.rs`
- Create: `src-tauri/tests/support/io_counters.rs`
- Modify: `src-tauri/tests/support/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在任何 Phase E 源码改动前捕获唯一 Phase D clean NSIS baseline**

先确认当前 HEAD 是已完成 Phase D 的验证提交，工作树干净，且 `docs/verification/phase-d-native-workspace.md` 已记录 PASS/SKIP/FAIL。若真实必需 case 为 FAIL、工作树非干净或 Phase D 验证文档缺失，停止 Phase E，不把未完成状态当 baseline。

Run:

```powershell
$dirty = @(git status --porcelain)
if ($dirty.Count -ne 0) { $dirty; throw 'Phase D baseline requires a clean worktree' }
$phaseDHead = (git rev-parse HEAD).Trim()
$originalCargoTargetDir = [Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR', 'Process')
function Assert-NoReparseChain([string]$Path, [string]$Label) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  $cursor = $root
  foreach ($part in ($full.Substring($root.Length) -split '[\\/]')) {
    if ([string]::IsNullOrWhiteSpace($part)) { continue }
    $cursor = Join-Path $cursor $part
    if (-not (Test-Path -LiteralPath $cursor)) { break }
    $item = Get-Item -Force -LiteralPath $cursor
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label contains a reparse component" }
  }
  return $full
}
function Assert-StrictChild([string]$Child, [string]$Parent, [string]$Label) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\','/')
  $childFull = [IO.Path]::GetFullPath($Child)
  $prefix = $parentFull + [IO.Path]::DirectorySeparatorChar
  if (-not $childFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label escaped its allowed root" }
}
$targetLexical = Assert-NoReparseChain 'src-tauri\target' 'target root'
if (-not (Test-Path -LiteralPath $targetLexical -PathType Container)) { throw 'src-tauri target root is missing' }
$targetRoot = (Resolve-Path -LiteralPath $targetLexical).Path
[void](Assert-NoReparseChain $targetRoot 'canonical target root')
$evidenceParent = Assert-NoReparseChain (Join-Path $targetRoot 'release-evidence') 'release evidence root'
Assert-StrictChild $evidenceParent $targetRoot 'release evidence root'
if (Test-Path -LiteralPath $evidenceParent) {
  if (-not (Test-Path -LiteralPath $evidenceParent -PathType Container)) { throw 'release evidence root is not a directory' }
} else {
  New-Item -ItemType Directory -Path $evidenceParent | Out-Null
}
$evidenceParent = (Resolve-Path -LiteralPath $evidenceParent).Path
[void](Assert-NoReparseChain $evidenceParent 'created release evidence root')
Assert-StrictChild $evidenceParent $targetRoot 'created release evidence root'
$baselineRoot = Join-Path $evidenceParent ('phase-d-' + [guid]::NewGuid())
if (Test-Path -LiteralPath $baselineRoot) { throw 'unique Phase D baseline root already exists' }
New-Item -ItemType Directory -Path $baselineRoot | Out-Null
$baselineRoot = (Resolve-Path -LiteralPath $baselineRoot).Path
[void](Assert-NoReparseChain $baselineRoot 'baseline root')
Assert-StrictChild $baselineRoot $evidenceParent 'baseline root'
try {
  $env:CARGO_TARGET_DIR = Join-Path $baselineRoot 'cargo-target'
  npm run tauri -- build
  if ($LASTEXITCODE -ne 0) { throw 'Phase D clean NSIS build failed' }
  $cargoTargetRoot = (Resolve-Path -LiteralPath $env:CARGO_TARGET_DIR).Path
  [void](Assert-NoReparseChain $cargoTargetRoot 'baseline cargo target')
  Assert-StrictChild $cargoTargetRoot $baselineRoot 'baseline cargo target'
  $installers = @(Get-ChildItem -LiteralPath $cargoTargetRoot -Recurse -Filter '*.exe' -File | Where-Object { $_.FullName -match '[\\/]bundle[\\/]nsis[\\/]' })
  if ($installers.Count -ne 1) { throw "expected one Phase D NSIS installer, got $($installers.Count)" }
  $installerPath = (Resolve-Path -LiteralPath $installers[0].FullName).Path
  [void](Assert-NoReparseChain $installerPath 'Phase D installer')
  Assert-StrictChild $installerPath $cargoTargetRoot 'Phase D installer'
  $source = [ordered]@{
    schemaVersion = 1
    phaseDCommit = $phaseDHead
    installerFileName = $installers[0].Name
    installerBytes = $installers[0].Length
    installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()
    cargoTargetRelative = 'cargo-target'
  }
  $sourcePath = Join-Path $baselineRoot 'baseline-source.json'
  $source | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $sourcePath -Encoding utf8NoBOM
  [void](Assert-NoReparseChain $sourcePath 'baseline source')
  Assert-StrictChild (Resolve-Path -LiteralPath $sourcePath).Path $baselineRoot 'baseline source'
  $baselineSourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()
  $baselinePointer = Join-Path $evidenceParent ('phase-d-baseline-pointer-' + [guid]::NewGuid() + '.json')
  if (Test-Path -LiteralPath $baselinePointer) { throw 'unique Phase D baseline pointer already exists' }
  [ordered]@{ schemaVersion = 1; phaseDCommit = $phaseDHead; baselineRoot = $baselineRoot; baselineSourceSha256 = $baselineSourceSha256 } | ConvertTo-Json | Set-Content -LiteralPath $baselinePointer -Encoding utf8NoBOM
  [void](Assert-NoReparseChain $baselinePointer 'baseline pointer')
  $baselinePointer = (Resolve-Path -LiteralPath $baselinePointer).Path
  Assert-StrictChild $baselinePointer $evidenceParent 'baseline pointer'
  Write-Output "PHASE_D_BASELINE_POINTER=$baselinePointer"
} finally {
  if ($null -eq $originalCargoTargetDir) { Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue }
  else { $env:CARGO_TARGET_DIR = $originalCargoTargetDir }
}
```

Expected: 在创建或写入任何evidence/baseline/source/pointer前先验证全部既有path component无reparse，并在每次创建后重新canonicalize；所有目标都是canonical `src-tauri/target/release-evidence/`严格子项。使用本次唯一、此前不存在的`CARGO_TARGET_DIR`构建出恰好一个NSIS，installer自身也必须是该target内无reparse regular file。命令只打印本次GUID唯一pointer的精确`PHASE_D_BASELINE_POINTER=<absolute path>`交接值；pointer闭合记录schema、Phase D commit、baseline root和`baseline-source.json` SHA-256，source记录installer SHA-256/bytes和固定relative target。无论构建成功或失败，调用前`CARGO_TARGET_DIR`都逐字恢复；不得覆盖、复用或删除任何baseline/pointer/evidence。root coordinator必须把该精确输出作为Task 12/13/15显式参数交给执行者，不写长期process env、不扫描目录、不按时间猜测“最新”证据；会话切换时由执行者粘贴该精确值并重新执行canonical/no-reparse验证。

- [ ] **Step 2: 写失败测试固定预算 schema、公式和跨语言一致性**

预算 v1 必须固定以下非墙钟指标：

- event query chunk `524288` bytes；page payload `4194304` bytes；max event line `2097152` bytes；单页最多读取 `6815744` bytes、`13` 次`readRange`、`2`次metadata/length、总计`15`次，返回 `200` events；tracked live buffer最多`8912896` bytes；cursor registry最多`1024`项。`13 = ceil(6815744 / 524288)`，`15 = 13 + 2`，三项分别断言，不能拿总调用上限放宽`readRange`。
- timeline 测试 viewport `24` rows、overscan `6`、允许最多 `40` 个 timeline row DOM 节点。
- delta 单次 coalesced dispatch `65536` UTF-8 bytes；WebView pending key `64`、pending delta bytes `2097152`。Rust/Tauri application queue另有`256`个delta event、`2097152` delta bytes上限；Phase E新增独立的application-wide admission cap `64` active turns，并为每个已准入turn预留`2`个terminal event与`65536` bytes，形成全局`128` events/`4194304` bytes terminal reserve，delta不得消费。该cap与Phase C“每个Codex app-server最多32个published threads”是两个不同边界。
- Codex idle interval `300000` ms；测试只能用 FakeClock 推进。

新增 `hardening_budget_json_is_schema_one_and_formula_consistent`、`hardening_budget_rust_and_typescript_read_same_json`、`hardening_query_read_budget_equals_page_plus_line_plus_one_chunk`、`hardening_query_call_budget_splits_thirteen_range_plus_two_metadata`、`hardening_query_live_buffer_budget_matches_page_partial_scratch_and_one_decoded_event`、`hardening_runtime_output_global_admission_cap_is_independent_of_per_codex_pool_limit`、`hardening_runtime_output_budget_reserves_terminal_credit_per_admitted_turn`、`hardening_timeline_dom_budget_covers_viewport_overscan_and_four_pinned_rows`、`hardening_budget_contains_no_wall_clock_pass_threshold`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test hardening_budgets && npm run test -- src/hardening/budgets.test.ts`

Expected: FAIL，budget JSON/Rust loader/TypeScript loader 和计数 helper 尚不存在；两个 test target 都必须实际执行，不得是 `0 tests`。

- [ ] **Step 3: 实现单一 JSON budget source 和计数测试替身**

`src/hardening/budgets-v1.json` 精确为：

```json
{
  "schemaVersion": 1,
  "eventQuery": {
    "readChunkBytes": 524288,
    "pagePayloadBytes": 4194304,
    "maxEventLineBytes": 2097152,
    "maxReadBytes": 6815744,
    "maxReadRangeCalls": 13,
    "maxMetadataCalls": 2,
    "maxReadCalls": 15,
    "maxTrackedLiveBufferBytes": 8912896,
    "maxPageEvents": 200,
    "cursorRegistryMax": 1024
  },
  "timeline": {
    "fixtureViewportRows": 24,
    "overscan": 6,
    "maxMountedRows": 40
  },
  "delta": {
    "maxDispatchBytes": 65536,
    "maxPendingKeys": 64,
    "maxPendingBytes": 2097152,
    "maxBackendDeltaEvents": 256,
    "maxBackendDeltaBytes": 2097152,
    "maxBackendActiveTurns": 64,
    "maxBackendTerminalEvents": 128,
    "maxBackendTerminalBytes": 4194304,
    "terminalReserveEventsPerTurn": 2,
    "terminalReserveBytesPerTurn": 65536
  },
  "codexIdle": {
    "releaseAfterIdleMs": 300000
  }
}
```

TypeScript 使用 `resolveJsonModule` 导入并在模块初始化时做整数/公式校验；Rust 用 `include_str!("../../../src/hardening/budgets-v1.json")` 反序列化到 `HardeningBudgetsV1`，启动/测试读取失败都返回稳定配置错误，不静默使用第二套默认值。两端必须分别断言 `maxReadRangeCalls == ceil(maxReadBytes / readChunkBytes)`、`maxMetadataCalls == 2`、`maxReadCalls == maxReadRangeCalls + maxMetadataCalls`，且`maxTrackedLiveBufferBytes == pagePayloadBytes + maxEventLineBytes + readChunkBytes + maxEventLineBytes`；还要断言`maxBackendTerminalEvents == maxBackendActiveTurns * terminalReserveEventsPerTurn`、`maxBackendTerminalBytes == maxBackendActiveTurns * terminalReserveBytesPerTurn`，并明确application cap不读取Codex单pool thread常量。registry上限只能读`cursorRegistryMax`。`CountingConfigFileStore`只包装Phase A `ConfigFileStore`，分别记录`readRange`、metadata/length及其他操作次数、读取总字节和单次峰值，不改变返回值或错误。

- [ ] **Step 4: 运行预算测试、代码简化审查并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_budgets && npm run test -- src/hardening/budgets.test.ts && npm run typecheck`

Expected: PASS；预算只有一个 JSON 真相来源，测试无真实 sleep 或毫秒耗时断言，Phase D baseline evidence 保留且未进入 Git。

使用 `@code-simplifier` 审查 budget loader、整数校验和计数 wrapper；若产生修改，重跑本步骤。

```bash
git add src/hardening/budgets-v1.json src/hardening/budgets.ts src/hardening/budgets.test.ts src-tauri/src/hardening/mod.rs src-tauri/src/hardening/budgets.rs src-tauri/src/lib.rs src-tauri/tests/hardening_budgets.rs src-tauri/tests/support/io_counters.rs src-tauri/tests/support/mod.rs
git commit -m "test(hardening): 固定确定性预算与Phase D基线"
```

### Task 2: 加固事件查询分页的读取次数、字节和内存背压

**Files:**
- Modify: `src-tauri/src/application/conversation_query_service.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Modify: `src-tauri/src/storage/config_file_store.rs`
- Create: `src-tauri/src/hardening/live_buffer_accountant.rs`
- Modify: `src-tauri/src/hardening/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Create: `src-tauri/tests/hardening_event_query.rs`
- Modify: `src-tauri/tests/conversation_query.rs`
- Modify: `src-tauri/tests/runtime_protocol.rs`
- Modify: `src-tauri/tests/runtime_event_store.rs`

- [ ] **Step 1: 写失败测试固定 64 MiB 事件文件上的确定性 I/O 预算**

新增：

- `hardening_query_tail_page_reads_at_most_budgeted_bytes_and_calls`
- `hardening_query_older_page_resumes_from_cursor_byte_boundary_not_file_start`
- `hardening_query_live_cursor_reads_only_committed_suffix`
- `hardening_query_snapshot_reuses_phase_d_capacity_snapshot_and_writer_guard`
- `hardening_query_capacity_reports_committed_reserved_and_effective_remaining_from_same_epoch`
- `hardening_query_concurrent_runtime_append_import_or_switch_is_old_or_new_complete_snapshot`
- `hardening_query_never_reads_runtime_append_import_or_switch_staging_as_committed`
- `hardening_protocol_line_exact_one_mib_after_compact_escape_and_newline_is_accepted`
- `hardening_protocol_line_one_mib_plus_one_after_escape_and_newline_is_rejected`
- `hardening_event_line_exact_two_mib_after_envelope_escape_and_newline_is_accepted`
- `hardening_event_line_two_mib_plus_one_after_escape_and_newline_is_rejected`
- `hardening_protocol_and_event_worst_case_escaping_use_distinct_limits`
- `hardening_query_four_mib_page_stops_at_event_boundary`
- `hardening_query_memory_peak_never_exceeds_read_budget_plus_one_decoded_event`
- `hardening_query_live_buffer_accountant_returns_to_zero_on_success_error_and_panic`
- `hardening_query_cursor_registry_caps_at_1024_without_unbounded_growth`
- `hardening_query_expired_cursor_cleanup_uses_fake_clock_only`
- `hardening_query_corrupt_or_unknown_suffix_returns_blocked_without_retry_scan_storm`
- `hardening_query_deleted_or_missing_conversation_still_obeys_reference_visibility_rules`

测试动态生成接近 Phase C `64 MiB` 上限的 temp event file，不把大 fixture 提交进仓库；用`CountingConfigFileStore`分别断言每次查询`readRange <= 13`、metadata/length `<= 2`、总调用`<= 15`且读取`<= 6815744` bytes，不能用总调用上限替代分类上限。边界fixture必须先做compact envelope JSON serialization，再计入JSON escaping与尾随换行：协议line精确`1 MiB`可收、`+1 byte`拒绝；事件line精确`2 MiB`可收、`+1 byte`拒绝，并覆盖最坏转义，禁止按原始正文字符数计量。测试不得断言运行时长。

- [ ] **Step 2: 运行查询压力测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test hardening_event_query`

Expected: FAIL，倒序 reader 尚未受统一 byte/call budget 约束，或 cursor 未保存内部 byte boundary/registry 背压。

- [ ] **Step 3: 实现预算化倒序窗口 reader 和有界 cursor registry**

公开 cursor 仍是 Phase D 最大 512 bytes 的 opaque token；内部 registry value 只增加 `upper_byte_offset`，继续复用 Phase D 已有的 `store_epoch`、`committed_epoch`、direction 与 `upper_sequence_exclusive`，不得另造 `writerGeneration`、第二套epoch或把 offset 编进 token。每次查询严格按 Phase D 锁序，通过 Phase C 唯一 `ConversationEventCapacityLedger` 与同一 per-conversation writer guard 取得原子 `CapacitySnapshot { ledgerEpoch, committedEpoch, committedBytes, reservedBytes, lastCommittedSequence }`；在该 guard 下只读取 `[0, committedBytes)`，并由同一snapshot投影 `committedBytes/reservedBytes/effectiveRemainingBytes`。runtime append、LegacyImporter或ContextBridge switch的stage/prefix在正式commit前既不读作event，也不算committed；并发commit只能让一次响应看到转换前或转换后的完整snapshot，不能返回旧events配新capacity、漏掉active reservation或混合两个commit epoch。

倒序 reader 每次固定读取`524288` bytes，分配前分别检查`readRangeCalls/maxReadRangeCalls`、`metadataCalls/maxMetadataCalls`、`totalCalls/maxReadCalls`与`readBytes/maxReadBytes`；完整event line解析后按compact public payload和event count两个边界停止。每个请求持有栈内`LiveBufferAccountant`，所有read scratch、跨chunk未完成line、借用解析后的单event投影和返回page payload都必须先取得不可Clone RAII byte lease，再按实际`Vec` capacity/UTF-8 bytes调整；parser使用借用raw event避免隐藏整行clone。任一reserve超过`maxTrackedLiveBufferBytes`先返回Capacity错误，成功、错误和panic unwind后current bytes都必须归零；测试报告的是这些闭合owned buffer的确定性峰值，不冒充进程RSS。

live cursor 从 Phase D 已知 committed boundary 读取后缀；older cursor 从上一个页面保存的 byte boundary 继续，禁止从文件头重扫。registry 只在 FakeClock 驱动的 10 分钟 TTL 后回收；到 1024 项时只回收已过期项，仍满则返回 `RETRY_LATER`，不能逐出仍有效 token 后让前端误读。损坏行、unknown suffix 或预算耗尽都返回稳定 Blocked/Capacity error，不在同一请求内无限扩大 chunk重试。

- [ ] **Step 4: 运行查询、bootstrap 和代码简化审查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_event_query && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_query && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_protocol && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；64 MiB 文件任一合法页不突破 byte/call/peak-buffer 预算，events/capacity/reservations来自同一Phase D snapshot，旧 cursor/损坏 suffix 失败封闭且文件字节不变。

使用 `@code-simplifier` 审查 backward scan、cursor registry 和 budget guard；若修改，重跑本步骤。

```bash
git add src-tauri/src/application/conversation_query_service.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/src/storage/config_file_store.rs src-tauri/src/hardening/live_buffer_accountant.rs src-tauri/src/hardening/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/tests/hardening_event_query.rs src-tauri/tests/conversation_query.rs src-tauri/tests/runtime_protocol.rs src-tauri/tests/runtime_event_store.rs
git commit -m "perf(hardening): 限制事件分页读取预算"
```

### Task 3: 加固虚拟列表 DOM、delta coalescing 与前端内存背压

**Files:**
- Create: `src/api/nativeDeltaCoalescer.ts`
- Create: `src/api/nativeDeltaCoalescer.test.ts`
- Modify: `src/api/nativeEventHub.ts`
- Modify: `src/api/nativeEventHub.test.ts`
- Modify: `src/store/nativeConversationStore.ts`
- Modify: `src/store/nativeConversationStore.test.ts`
- Modify: `src/components/Conversation/MessageList.tsx`
- Modify: `src/components/Conversation/MessageList.test.tsx`
- Create: `src/hardening/nativeTimelineHardening.test.tsx`
- Modify: `src-tauri/src/runtime/adapter.rs`
- Modify: `src-tauri/src/runtime/limits.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src-tauri/src/commands/native_runtime_cmds.rs`
- Modify: `src-tauri/src/storage/conversation_event_append.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Create: `src-tauri/tests/hardening_runtime_backpressure.rs`
- Modify: `src-tauri/tests/native_runtime_commands.rs`
- Modify: `src-tauri/tests/conversation_manager.rs`
- Modify: `src-tauri/tests/runtime_event_store.rs`

- [ ] **Step 1: 写失败测试固定 coalescing 顺序、队列深度和 terminal 不丢失**

新增：

- `delta_coalescer_merges_only_contiguous_same_conversation_segment_turn_message`
- `delta_coalescer_splits_dispatch_at_65536_bytes_without_string_quadratic_copy`
- `delta_coalescer_flushes_matching_delta_before_completion_status_or_error`
- `delta_coalescer_never_reorders_approval_or_terminal_events`
- `delta_coalescer_caps_pending_keys_at_64_and_bytes_at_two_mib`
- `delta_coalescer_backpressure_releases_ephemeral_chunks_and_emits_internal_marker`
- `delta_coalescer_backpressure_never_invents_completed_or_runtime_error_event`
- `delta_coalescer_manual_scheduler_has_zero_wall_clock_dependency`
- `native_event_hub_dispose_releases_pending_chunks_and_scheduled_flush`
- `delta_coalescer_counts_utf8_bytes_and_never_splits_inside_code_point`

生产 scheduler 可使用 `queueMicrotask`，测试注入手动 scheduler；不得用 fake millisecond deadline 作为 PASS 条件。所有chunk/dispatch/pending上限通过`TextEncoder`按UTF-8 bytes计量，只能在完整Unicode scalar边界切分，不能按UTF-16 code unit截断。超过WebView pending budget时只释放受影响turn的delta，并向store发内部`deltaBackpressure` marker，完成/审批/状态事件仍按原顺序送达。

- [ ] **Step 2: 写失败测试固定 50,000 行 DOM、读请求和 buffer 预算**

新增：

- `hardening_timeline_fifty_thousand_events_mounts_at_most_forty_rows`
- `hardening_timeline_scroll_reuses_virtual_rows_without_dom_growth`
- `hardening_timeline_one_load_older_gesture_starts_one_inflight_read`
- `hardening_timeline_anchor_restore_adds_no_duplicate_read`
- `hardening_timeline_one_hundred_thousand_small_deltas_dispatches_by_byte_chunks`
- `hardening_timeline_turn_buffers_never_exceed_phase_c_eight_mib`
- `hardening_timeline_completion_or_dispose_releases_all_delta_chunk_references`
- `hardening_timeline_backpressure_waits_for_authoritative_completion`
- `hardening_runtime_relay_backend_delta_queue_obeys_event_and_utf8_byte_budget`
- `hardening_runtime_relay_application_admission_allows_sixty_four_turns_across_multiple_codex_pools_and_claude`
- `hardening_runtime_relay_sixty_fifth_turn_is_rejected_before_process_or_model_request`
- `hardening_runtime_relay_delta_cannot_consume_per_turn_terminal_reserve`
- `hardening_runtime_relay_overflow_stops_turn_and_persists_runtime_error_before_notifications`
- `hardening_runtime_relay_terminal_batch_reserves_serialized_runtime_error_and_status_changed`
- `hardening_event_capacity_full_data_budget_still_commits_two_event_terminal_batch_atomically`
- `hardening_terminal_batch_reservation_counts_compact_envelope_escaping_and_newlines`
- `hardening_runtime_relay_overflow_releases_only_affected_turn_delta_and_keeps_peer_order`
- `hardening_runtime_relay_delivers_runtime_error_and_status_without_dropping_terminal_event`
- `hardening_runtime_relay_unsubscribe_mid_turn_keeps_admission_and_terminal_batch_until_durable_terminal`
- `hardening_runtime_relay_subscription_dispose_releases_only_webview_queue_resources`
- `hardening_runtime_relay_turn_admission_returns_on_prestart_error_and_panic`
- `hardening_runtime_relay_poststart_panic_transfers_permit_to_outcome_recovery`
- `hardening_runtime_relay_completion_cancel_and_overflow_release_turn_resources_exactly_once`
- `hardening_runtime_relay_backend_and_webview_backpressure_end_to_end_converges_by_requery`

固定 viewport 为 24 行、overscan 为 6，允许 4 个 pinned/system row，因此 mounted timeline row 必须 `<=40`。大量 event/delta fixture 在测试内生成，DOM/Map/array 数量是门禁；不得用测试耗时。

- [ ] **Step 3: 运行前端压力测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test hardening_runtime_backpressure && cargo test --manifest-path src-tauri/Cargo.toml --test native_runtime_commands && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && npm run test -- src/api/nativeDeltaCoalescer.test.ts src/api/nativeEventHub.test.ts src/store/nativeConversationStore.test.ts src/components/Conversation/MessageList.test.tsx src/hardening/nativeTimelineHardening.test.tsx`

Expected: FAIL，Rust/Tauri relay尚未实施事件/UTF-8 byte上限与per-turn terminal reserve，或Hub尚未通过独立coalescer限制pending bytes/keys，或timeline DOM/read/buffer计数未满足budget。

- [ ] **Step 4: 实现独立 coalescer、store backpressure marker 和可计数 virtualizer 边界**

唯一`RuntimeOutputRelay`在进入Tauri/WebView前先使用application-scoped bounded queue。它最多持有`256`个delta event与`2097152` UTF-8 delta bytes；`ConversationManager`在任何process start/模型请求前先从独立Phase E application admission budget取得一个turn permit，最多`64`个，测试必须跨两个Codex ProviderRevision pool加Claude同时占用证明它不复用单pool `32`常量。每个admitted turn随permit取得且仅取得`2`个terminal slot/`65536` bytes；第65个turn在外部副作用前返回`RETRY_LATER`。delta绝不能借用terminal credit。

Phase C原有“一个RuntimeError headroom”升级为`TerminalBatchReservation`：turn permit建立时由唯一`ConversationEventCapacityLedger`按compact envelope、JSON escaping与换行后的真实staged bytes原子预留一个bounded `RuntimeError`和紧随其后的`StatusChanged(failed)`；两条事件通过同一个`conversation_event_append` staging/journal事务提交，只能旧状态或两条均存在，不能只写error。普通event/delta不得消耗该batch headroom。任一turn的backend delta先触及event或byte上限时，在同一manager transition中冻结该turn新delta、停止adapter、释放仅该turn的pending delta，先提交该terminal batch，成功后再用该turn预留Tauri credit按sequence通知；peer turn顺序与credit不变。持久提交失败则保留reservation/outcome证据并进入Failed/Blocked，不得伪造WebView terminal。

owner必须分离：application admission permit与ledger `TerminalBatchReservation`属于turn lifecycle，不属于Tauri subscription。外部请求前的setup失败/early return/panic由不可Clone RAII guard直接归还二者；一旦process/model request开始，guard显式转交`TurnLifecycle/RuntimeOutcome` owner，后续panic不能静默释放，必须等正常完成、取消或overflow terminal outcome已持久提交后exactly-once归还。subscription只拥有backend/WebView queue的delta chunk与通知credit；中途dispose只释放这些易失资源，仍在后台运行的turn继续占用admission与ledger headroom，终态持久后由下一次订阅通过事件查询补齐。无订阅时不伪造或缓存无界通知。测试分别断言active turn unsubscribe后ledger reservation仍在、terminal commit后turn资源归零，以及最终subscription dispose后queue资源归零。

`NativeDeltaCoalescer`只负责已过Rust门禁后的临时delta：以完整稳定key保存chunk array，连续sequence才合并，每次dispatch最多`65536` UTF-8 bytes且不切断码点。任何非delta event先flush同turn的pending delta，再原样交给Hub；全局pending`64` keys/`2097152` bytes任一达到上限时，最先溢出的key释放chunk并发内部marker，后续delta在权威completion/error前不再累计。若subscription被关闭或内部marker要求resync，前端只通过Phase D事件查询重读已提交terminal，不能合成完成/错误。

`nativeConversationStore` 收到 marker 后清空该 turn 临时 buffer、显示“流式内容已因背压释放，等待完成消息”，禁用基于 partial delta 的复制/Markdown，但不禁用后端继续完成。`MessageList` 暴露测试专用 mounted-row counter，不把计数写入 production store；older request复用单一 inflight Promise，anchor remeasure不能再发一次read。

- [ ] **Step 5: 运行测试、代码简化审查并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_runtime_backpressure && cargo test --manifest-path src-tauri/Cargo.toml --test native_runtime_commands && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && cargo check --manifest-path src-tauri/Cargo.toml && npm run test -- src/api/nativeDeltaCoalescer.test.ts src/api/nativeEventHub.test.ts src/store/nativeConversationStore.test.ts src/components/Conversation/MessageList.test.tsx src/hardening/nativeTimelineHardening.test.tsx && npm run typecheck && npm run build`

Expected: PASS；application-wide 64-turn admission跨多个Codex pool与Claude生效且第65个turn零外部副作用；Rust/Tauri与WebView两层队列都按UTF-8 bytes闭合，backend overflow以同一事件事务原子持久化权威RuntimeError+StatusChanged且有订阅时terminal通知零丢失、peer不乱序。中途unsubscribe只清queue资源，不释放active turn admission/ledger reservation；完成、取消、overflow、pre-start失败和post-start panic/recovery均exactly-once归还正确owner。100,000个小delta的dispatch数只由byte chunk公式决定，50,000行历史最多挂载40行，全部turn终态且subscription dispose后backend/frontend pending bytes/keys/chunks/credits与ledger batch reservations均为0。

使用 `@code-simplifier` 审查 chunk合并、scheduler取消和virtual row selector；若修改，重跑本步骤。

```bash
git add src/api/nativeDeltaCoalescer.ts src/api/nativeDeltaCoalescer.test.ts src/api/nativeEventHub.ts src/api/nativeEventHub.test.ts src/store/nativeConversationStore.ts src/store/nativeConversationStore.test.ts src/components/Conversation/MessageList.tsx src/components/Conversation/MessageList.test.tsx src/hardening/nativeTimelineHardening.test.tsx src-tauri/src/runtime/adapter.rs src-tauri/src/runtime/limits.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/commands/native_runtime_cmds.rs src-tauri/src/storage/conversation_event_append.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/tests/hardening_runtime_backpressure.rs src-tauri/tests/native_runtime_commands.rs src-tauri/tests/conversation_manager.rs src-tauri/tests/runtime_event_store.rs
git commit -m "perf(hardening): 增加消息流背压与DOM预算"
```

### Task 4: 加固 Codex idle release 与 runtime activity 生命周期

**Files:**
- Modify: `src-tauri/src/runtime/codex/pool.rs`
- Modify: `src-tauri/src/runtime/codex/app_server.rs`
- Modify: `src-tauri/src/runtime/codex/approval.rs`
- Modify: `src-tauri/src/application/conversation_execution_transition.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src-tauri/src/application/native_keep_alive_service.rs`
- Modify: `src-tauri/src/application/provider_connection_service.rs`
- Modify: `src-tauri/src/application/runtime_activity_registry.rs`
- Modify: `src-tauri/src/application/runtime_shutdown_coordinator.rs`
- Create: `src-tauri/tests/hardening_codex_idle.rs`
- Modify: `src-tauri/tests/codex_adapter.rs`
- Modify: `src-tauri/tests/codex_recovery.rs`
- Modify: `src-tauri/tests/native_keep_alive.rs`
- Modify: `src-tauri/tests/provider_connection.rs`
- Modify: `src-tauri/tests/runtime_activity.rs`

- [ ] **Step 1: 写失败测试固定 idle predicate 和 FakeClock 行为**

新增：

- `hardening_codex_idle_does_not_release_with_attached_thread`
- `hardening_codex_idle_does_not_release_with_active_turn`
- `hardening_codex_idle_does_not_release_with_pending_approval`
- `hardening_codex_idle_does_not_release_with_pending_rpc_writer_or_recovery_plan`
- `hardening_codex_idle_does_not_release_while_lifecycle_callback_is_committing`
- `hardening_codex_idle_activity_resets_full_five_minute_interval`
- `hardening_codex_idle_release_closes_job_waits_tree_empty_then_drops_generation`
- `hardening_codex_idle_release_tree_ack_failure_keeps_revision_failed_and_blocks_restart`
- `hardening_codex_idle_release_frees_router_queue_approval_and_binding_maps`
- `hardening_codex_idle_claim_uses_pool_generation_activity_epoch_and_owned_handles_not_single_conversation_token`
- `hardening_codex_idle_stale_release_callback_cannot_remove_new_pool_generation_or_owned_handles`
- `hardening_codex_idle_release_never_mutates_ready_epoch_or_native_keep_alive_consent_epoch`
- `hardening_keep_alive_tick_wins_idle_race_once_and_invalidates_drain_before_charge`
- `hardening_idle_drain_wins_keep_alive_race_preserves_same_tick_id_and_retries_once_after_drain`
- `hardening_normal_attach_wins_before_idle_claim_and_prevents_job_close`
- `hardening_idle_claim_wins_normal_attach_waits_for_new_generation_without_touching_old_handles`
- `hardening_idle_ack_failure_blocks_pending_tick_without_request_consent_or_timer_rewrite`
- `hardening_codex_idle_uses_fake_clock_without_sleep_or_elapsed_assertion`

- [ ] **Step 2: 运行 idle 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test hardening_codex_idle`

Expected: FAIL，idle predicate 尚未集中覆盖 approval/turn/RPC/writer/recovery/lifecycle 全部状态，或释放后对象计数未归零。

- [ ] **Step 3: 实现单一 `CodexIdleSnapshot` 与 generation-safe release**

在 pool 内生成只读 `CodexIdleSnapshot { attached_threads, active_turns, pending_approvals, pending_rpc, queued_writes, recovery_pending, lifecycle_callbacks }`；只有所有计数为0才设置 FakeClock deadline。任一计数从0变为非0立即清 deadline；重新归零后从当前 fake time重新等待完整 `300000ms`。

idle deadline、普通attach、keepAlive tick和`DrainingForIdle` claim只在同一pool mutex下线性化。attach/tick若先取得锁，只能在claim尚未安装时推进activity epoch、取消deadline并取得owned attach/turn claim；此时不得开始Job close。deadline路径若先在锁内安装`DrainingForIdle`，就冻结typed provider revision、pool generation、idle activity epoch、Ready epoch与本generation独占的Job/process/router/writer handle identity并拒绝后续attach/turn，然后才锁外关闭Job、确认tree empty。claim安装后，普通attach/tick绝不能再推进旧generation activity epoch或使正在关闭Job的claim失效，只能收到typed `IDLE_DRAINING`/completion waiter；drain成功并移除旧generation后，调用方才可用同一operation/tick ID在新generation重试。claim不保存“最后一次detach”的Conversation selection/lineage token：共享revision pool可能先后服务多个Conversation，而idle callback本来就没有Conversation/AppSettings写port。成功drain只在claim token、pool generation、Ready epoch和全部owned handle identity仍匹配时清reader/writer/router/approval/thread map并删除旧pool generation。迟到callback只能清理其明确拥有的旧handles，绝不能移除新runtime、恢复旧selection、回退generation或重新激活已失效keepAlive consent。ack失败保持Failed和对象证据，不能创建替代server。

keepAlive scheduler以单调`KeepAliveTickId`复用上述线性化点。tick若在idle claim安装前先取得pool attach/turn claim，则在任何模型请求前取消deadline，同一tick最多发出一次请求；此时drain尚未开始。idle claim若先安装，tick保留同一个pending tick ID与原consent/generation snapshot，零请求、零费用、零timer/consent重写，等待drain成功和新generation可用后只重试一次；普通attach遵循同一等待规则但使用自己的operation ID。成功提交outcome后才安排下一完整interval。tree-empty失败时pending tick/attach保持Blocked并要求显式恢复，不自动重试或重新计费。`RuntimeActivityRegistry`在turn/approval、execution transition、idle drain或pending keepAlive tick存在时不得报告全空闲。

- [ ] **Step 4: 运行 runtime 回归、代码简化审查并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_codex_idle && cargo test --manifest-path src-tauri/Cargo.toml --test codex_adapter && cargo test --manifest-path src-tauri/Cargo.toml --test codex_recovery && cargo test --manifest-path src-tauri/Cargo.toml --test native_keep_alive && cargo test --manifest-path src-tauri/Cargo.toml --test provider_connection && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_activity && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；active turn/approval永不触发idle kill，共享pool idle claim不依赖单一Conversation token；keepAlive tick与drain任一胜出都线性化为零重复请求/费用，释放成功后process/job/router/queue/map计数为0，全部测试使用FakeClock。

使用 `@code-simplifier` 审查idle predicate、generation CAS和cleanup重复；若修改，重跑本步骤。

```bash
git add src-tauri/src/runtime/codex/pool.rs src-tauri/src/runtime/codex/app_server.rs src-tauri/src/runtime/codex/approval.rs src-tauri/src/application/conversation_execution_transition.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/application/native_keep_alive_service.rs src-tauri/src/application/provider_connection_service.rs src-tauri/src/application/runtime_activity_registry.rs src-tauri/src/application/runtime_shutdown_coordinator.rs src-tauri/tests/hardening_codex_idle.rs src-tauri/tests/codex_adapter.rs src-tauri/tests/codex_recovery.rs src-tauri/tests/native_keep_alive.rs src-tauri/tests/provider_connection.rs src-tauri/tests/runtime_activity.rs
git commit -m "perf(hardening): 收紧Codex空闲释放条件"
```

### Task 5: 对 CSP、SafeMarkdown、外链、capability、secret 与路径脱敏做对抗回归

**Files:**
- Create: `scripts/hardening/security-audit.mjs`
- Create: `scripts/hardening/security-audit.test.mjs`
- Modify: `package.json`
- Modify: `src/components/Conversation/SafeMarkdown.tsx`
- Modify: `src/components/Conversation/SafeMarkdown.test.tsx`
- Modify: `src/components/Conversation/ExternalLinkDialog.tsx`
- Modify: `src/components/Conversation/ExternalLinkDialog.test.tsx`
- Modify: `src-tauri/src/application/external_link_service.rs`
- Modify: `src-tauri/tests/external_link.rs`
- Modify: `src-tauri/tests/webview_security.rs`
- Create: `src-tauri/tests/hardening_redaction.rs`
- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/runtime/event_redactor.rs`

- [ ] **Step 1: 写失败前端对抗测试覆盖编码、SVG/HTML 和 scheme 绕过**

新增：

- `hardening_markdown_svg_math_iframe_object_form_and_style_never_create_active_dom`
- `hardening_markdown_encoded_javascript_data_file_blob_and_backslash_urls_are_not_clickable`
- `hardening_markdown_nested_image_link_never_fetches_or_navigates`
- `hardening_markdown_entity_and_percent_encoded_controls_fail_closed`
- `hardening_markdown_two_mib_content_uses_preview_before_parse`
- `hardening_external_link_unicode_host_is_punycode_normalized_without_confusable_display`
- `hardening_external_link_userinfo_backslash_crlf_and_overlong_path_are_rejected`
- `hardening_external_link_confirmation_never_displays_query_fragment_or_credentials`
- `hardening_external_link_service_punycode_preview_and_display_are_canonical`
- `hardening_external_link_service_rejects_userinfo_backslash_crlf_control_and_overlong_path`
- `hardening_external_link_service_token_is_single_use_and_never_exposes_query_fragment`

Run: `npm run test -- src/components/Conversation/SafeMarkdown.test.tsx src/components/Conversation/ExternalLinkDialog.test.tsx`

Expected: 至少一个前端生产边界被新对抗case击穿而FAIL；该目标必须实际收集新增SafeMarkdown/Dialog tests。不得通过启用raw HTML、`window.open`或宽泛URL fallback修复。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test external_link`

Expected: 至少一个新增Rust URL parser/token case在修改`external_link_service.rs`前实际执行并FAIL；不能因上一条前端命令预期失败而跳过本命令。

- [ ] **Step 2: 写失败 Rust/静态测试固定 exact CSP、capability 和多层脱敏**

新增：

- `hardening_security_audit_requires_exact_production_csp_directives`
- `hardening_security_audit_requires_exact_three_capabilities`
- `hardening_security_audit_rejects_default_shell_opener_notification_and_remote_wildcards`
- `hardening_security_audit_rejects_rehype_raw_dangerous_inner_html_and_direct_navigation`
- `hardening_redaction_error_debug_event_tauri_and_safe_summary_hide_utf8_utf16_secret_and_user_path`
- `hardening_redaction_query_fragment_command_env_cwd_and_runtime_root_never_cross_public_boundary`
- `hardening_redaction_unknown_payload_retains_only_case_keys_and_byte_count`

Run: `node --test scripts/hardening/security-audit.test.mjs && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_redaction`

Expected: FAIL，静态审计器和跨UTF-8/UTF-16 canary测试尚不存在。

- [ ] **Step 3: 实现只读静态审计器和统一 canary 回归**

`security-audit.mjs`只读解析`tauri.conf.json`、`capabilities/default.json`、`package.json/package-lock.json`和production source；精确比较Phase D CSP directive/set与三项capability，确认无`rehype-raw`、`dangerouslySetInnerHTML`、direct `window.open/location.href/target=_blank`、`:default`、shell/opener权限。脚本不得自动改配置。

对Step 1暴露的缺口只在既有生产边界做最小修复：`SafeMarkdown.tsx`在任何Markdown parse前对接近`2 MiB`的已完成正文进入bounded plain-text preview，sanitizer闭合禁用raw HTML/SVG/MathML/iframe/object/form/style和所有图片网络加载，链接只接受后端可预览的http/https候选；`ExternalLinkDialog.tsx`只显示后端`displayOrigin/displayTarget/insecureHttp`并提交一次性token，不自行重解析、拼回query/fragment或直开URL；`external_link_service.rs`在生成token前完成Unicode host punycode规范化并拒绝userinfo、反斜杠、CRLF、控制字符和过长path。若某项现有实现已满足测试则保持no-op，不另造第二套sanitizer/URL parser。

Rust redaction测试把 secret、workspace、USERPROFILE canary分别以UTF-8/UTF-16LE注入内部 error/event/unknown payload，逐层序列化 `Debug/Display/Tauri public DTO` 后扫描；失败只输出canary label和边界名，不打印原值。修复只能集中到现有 `AppError`/`event_redactor`，不得在每个caller散落replace。

`package.json` 增加：

```json
{
  "scripts": {
    "test:hardening:security": "node --test scripts/hardening/security-audit.test.mjs && node scripts/hardening/security-audit.mjs --root ."
  }
}
```

- [ ] **Step 4: 运行 Chunk 1 完整门禁和代码简化审查**

Run: `npm run test:hardening:security && npm run test && npm run typecheck && npm run build && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_budgets && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_event_query && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_protocol && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_runtime_backpressure && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_codex_idle && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_redaction && cargo test --manifest-path src-tauri/Cargo.toml --test webview_security && cargo test --manifest-path src-tauri/Cargo.toml --test external_link && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部PASS；安全审计零写入，自动化性能结果只引用确定性计数，CSP/capability与Phase D严格值完全一致。

使用 `@code-simplifier` 审查静态扫描规则、redaction调用和测试fixture重复；若修改，重跑本步骤。

```bash
git add package.json scripts/hardening/security-audit.mjs scripts/hardening/security-audit.test.mjs src/components/Conversation/SafeMarkdown.tsx src/components/Conversation/SafeMarkdown.test.tsx src/components/Conversation/ExternalLinkDialog.tsx src/components/Conversation/ExternalLinkDialog.test.tsx src-tauri/src/application/external_link_service.rs src-tauri/tests/external_link.rs src-tauri/tests/webview_security.rs src-tauri/tests/hardening_redaction.rs src-tauri/src/error.rs src-tauri/src/runtime/event_redactor.rs
git commit -m "test(hardening): 增加WebView与脱敏对抗审计"
```

- [ ] **Step 5: 完成 Chunk 1 计划评审**

使用 plan-document-reviewer 按设计规格、Phase C 容量/adapter和最新 Phase D事件窗口/安全任务复核本Chunk。必须确认没有重复实现Phase D消息UI或CSP，只补确定性I/O/DOM/队列/对象预算、delta背压、idle release和对抗回归；Issues Found修复后重新评审，Approved后进入Chunk 2。

## Chunk 2: 全恢复矩阵、引用图与显式授权清理

### Task 6: 建立闭合 RecoverySurfaceRegistry 与 Ready/rollout/exit 总门禁

**Files:**
- Create: `src-tauri/src/application/recovery_surface_registry.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/native_ai_rollout_service.rs`
- Modify: `src-tauri/src/application/runtime_shutdown_coordinator.rs`
- Modify: `src-tauri/src/application/provider_service.rs`
- Modify: `src-tauri/src/runtime/codex/pool.rs`
- Modify: `src-tauri/src/state.rs`
- Create: `src-tauri/tests/hardening_recovery_inventory.rs`
- Modify: `src-tauri/tests/hardening_codex_idle.rs`
- Modify: `src-tauri/tests/bootstrap_order.rs`
- Modify: `src-tauri/tests/native_ai_rollout.rs`
- Modify: `src-tauri/tests/quit_gate.rs`
- Modify: `src-tauri/tests/provider_service.rs`

- [ ] **Step 1: 写失败测试固定所有持久、原子和易失恢复面**

新增：

- `recovery_inventory_contains_every_phase_a_to_e_surface_exactly_once`
- `recovery_inventory_persistent_surfaces_have_inspector_and_recover_owner`
- `recovery_inventory_atomic_surfaces_have_old_new_unknown_classifier`
- `recovery_inventory_ephemeral_surfaces_have_restart_reconcile_owner`
- `recovery_inventory_shared_service_recovery_required_is_owned_by_conversation_manager`
- `recovery_inventory_codex_idle_drain_is_owned_by_codex_pool`
- `recovery_inventory_unknown_journal_filename_or_stage_is_blocked`
- `recovery_inventory_ready_requires_every_surface_clean`
- `recovery_inventory_rollout_preflight_reuses_same_inventory`
- `recovery_inventory_exit_drain_reuses_same_inventory`
- `recovery_inventory_public_summary_contains_kind_state_count_not_path_or_payload`
- `provider_service_bootstrap_never_auto_deletes_unreferenced_committed_secret`
- `provider_service_reports_orphan_secret_read_only_for_reference_audit`
- `provider_service_rollback_still_deletes_only_current_uncommitted_secret`

闭合枚举必须覆盖：`FreshInit`、`Migration`、`CompatibilityWrite`、`WorkspaceWrite`、`RuntimeOutcome`、`LegacyImport`、`RuntimeEventAppend`、`ConversationSwitch`、`NativeAiRolloutAtomic`、`LegacyWriteCutoverAtomic`、`StartClaim`、`ConversationExecutionTransition`、`SharedServiceRecoveryRequired`、`CodexIdleDrain`、`Settling`、`ConversationCapacityLedger`、`ExitDrain`、`ReferenceCleanup`。不得以自由字符串注册，新增恢复面必须同时补 inventory 和 crash matrix case。

- [ ] **Step 2: 运行 inventory 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test hardening_recovery_inventory`

Expected: FAIL，当前 bootstrap/rollout/shutdown各自隐式枚举恢复面，尚无可核对的闭合清单。

- [ ] **Step 3: 实现只读 inventory 与统一状态分类**

核心类型固定为：

```rust
pub enum RecoverySurfaceState {
    Clean,
    Recoverable,
    Blocked,
}

pub struct RecoverySurfaceSummary {
    pub kind: RecoverySurfaceKind,
    pub state: RecoverySurfaceState,
    pub pending_count: u32,
}
```

`RecoverySurfaceRegistry` 只组合各既有 owner 的窄 `inspect()`/`recover()` port，不接管其状态机、不读取原始正文。Phase D `ConversationExecutionTransitionRegistry` 以易失surface接入：进程内claim必须在Ready操作、rollout和exit drain时可见，重启时claim本身归零，但其shutdown后/事务前窗口必须由Task 8按旧selection、零live handle和既有journal状态确定收敛，不能猜测继续新selection。Phase C内部`RuntimeControlEvent::SharedServiceRecoveryRequired(SharedServiceRecoveryPlan)`同样登记为易失surface，owner固定为`ConversationManager`的单一`(providerRevisionId, failedGeneration)` recovery coordinator；inspector只暴露claim是否存在及候选计数，reconcile继续调用既有plan校验/逐Conversation恢复，不复制plan或输出candidate/segment正文。相同进程内Ready、rollout和exit必须等待该claim收敛；重启后易失claim/plan归零，禁止从旧segment猜测或重建control event，只能由`StartClaim`/`Settling`/`RuntimeOutcome`等持久owner收敛已落盘状态。未知revision、generation或candidate归属统一`Blocked`且零写。

Phase A `ProviderService`的“启动时按引用差集自动删除secret”在本任务明确停用：bootstrap只读列出orphan SecretRef供Task 9 audit，不调用delete。已提交或历史secret的唯一物理删除owner改为Task 10 `ReferenceCleanup`，必须经过secret scope独立确认和write-ahead Journal。Provider save失败时`PendingSecretGuard`删除本次尚未被任何已提交snapshot引用的新secret仍是原事务补偿，不属于GC；其ownership、失败封闭测试继续保留。这样无需为无Journal startup GC伪造恢复面，也保证audit/确认前零删除。

Task 4 的`DrainingForIdle`以`CodexIdleDrain`易失surface接入，owner固定为Codex pool：inspector只报告claim数、Job/tree-empty阶段与owned-handle计数，不暴露revision或process标识；相同进程内claim创建后到Job关闭、tree-empty确认、generation-safe handle清理完成前，Ready、rollout preflight和exit drain都不得把inventory判为`Clean`。tree ack失败或claim token/handle归属未知为`Blocked`且保留证据；可证明的同generation drain为`Recoverable`并只由pool重试原Job/tree-empty流程。重启后claim和旧handles归零，不重建idle claim，只由既有持久owner收敛已落盘runtime outcome/segment状态。bootstrap 的既有顺序保持 Phase D 最新计划定义，但在发布 Ready 前要求 inventory 全部 `Clean`；rollout preflight 和 Sealing final drain 读取同一 registry，不能维护第二份 journal列表。未知文件名、stage、hash或跨事务ID统一为 `Blocked`，公共summary只含kind/state/count。

Task 10 的 `ReferenceCleanup` inspector 本任务先实现“journal不存在=Clean、存在但owner尚未装配=Blocked”的临时失败封闭分支；Task 10替换为真实owner，不能让未知cleanup journal被忽略。

- [ ] **Step 4: 运行 bootstrap/rollout/quit 回归、简化并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_recovery_inventory && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_codex_idle && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo test --manifest-path src-tauri/Cargo.toml --test native_ai_rollout && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate && cargo test --manifest-path src-tauri/Cargo.toml --test provider_service && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；Ready、rollout和exit对同一闭合inventory得出一致结果，未知状态不触发任何恢复写。

使用 `@code-simplifier` 审查port接口、enum匹配和重复inventory；若修改，重跑本步骤。

```bash
git add src-tauri/src/application/recovery_surface_registry.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/native_ai_rollout_service.rs src-tauri/src/application/runtime_shutdown_coordinator.rs src-tauri/src/application/provider_service.rs src-tauri/src/runtime/codex/pool.rs src-tauri/src/state.rs src-tauri/tests/hardening_recovery_inventory.rs src-tauri/tests/hardening_codex_idle.rs src-tauri/tests/bootstrap_order.rs src-tauri/tests/native_ai_rollout.rs src-tauri/tests/quit_gate.rs src-tauri/tests/provider_service.rs
git commit -m "feat(hardening): 统一恢复面清单与门禁"
```

### Task 7: 对全部持久 Journal 与 rollout/cutover 原子状态运行崩溃矩阵

**Files:**
- Create: `src-tauri/tests/support/crash_matrix.rs`
- Modify: `src-tauri/tests/support/mod.rs`
- Create: `src-tauri/tests/hardening_crash_matrix_persistent.rs`
- Modify: `src-tauri/src/migration/coordinator.rs`
- Modify: `src-tauri/src/compat/write_transaction.rs`
- Modify: `src-tauri/src/storage/workspace_transaction.rs`
- Modify: `src-tauri/src/storage/runtime_outcome_store.rs`
- Modify: `src-tauri/src/storage/conversation_event_append.rs`
- Modify: `src-tauri/src/history/importer.rs`
- Modify: `src-tauri/src/storage/conversation_switch_transaction.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/application/native_ai_rollout_service.rs`
- Modify: `src-tauri/src/application/app_settings_service.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/tests/migration_recovery.rs`
- Modify: `src-tauri/tests/workspace_store.rs`
- Modify: `src-tauri/tests/runtime_event_store.rs`
- Modify: `src-tauri/tests/conversation_switch_transaction.rs`
- Modify: `src-tauri/tests/legacy_write_cutover.rs`

- [ ] **Step 1: 写失败测试固定 matrix coverage 与三次 recover 幂等性**

`CrashMatrixCase` 必须为当前已实现的 persistent/atomic recovery owner声明 `caseId`、可注入 crash points、known old/new states、unknown states和snapshot函数。Task 7的闭合集合精确为`FreshInit/Migration/CompatibilityWrite/WorkspaceWrite/RuntimeOutcome/LegacyImport/RuntimeEventAppend/ConversationSwitch/NativeAiRolloutAtomic/LegacyWriteCutoverAtomic`；`ReferenceCleanup` owner要到Task 10才存在，本任务不得假装已覆盖，Task 10必须把它加入同一matrix，Task 11再断言最终无缺口。新增：

- `persistent_matrix_covers_exact_pre_cleanup_persistent_and_atomic_surfaces`
- `persistent_matrix_fresh_init_crashes_before_marker_after_each_repository_install_and_cleanup`
- `persistent_matrix_migration_crashes_at_prepare_secret_install_cleanup_marker_and_commit`
- `persistent_matrix_compat_and_workspace_crash_after_each_target_replace`
- `persistent_matrix_runtime_outcome_crashes_before_journal_after_repository_and_cleanup`
- `persistent_matrix_event_append_crashes_at_stage_journal_partial_full_and_cleanup`
- `persistent_matrix_legacy_import_crashes_at_lease_stage_event_checkpoint_and_cleanup`
- `persistent_matrix_context_switch_crashes_at_event_conversation_segment_and_cleanup`
- `persistent_matrix_rollout_atomic_replace_is_old_or_new_never_half_flags`
- `persistent_matrix_cutover_schema_and_command_registry_are_old_or_new_never_hybrid`
- `persistent_matrix_recover_three_times_converges_to_identical_tree_and_secret_snapshot`
- `persistent_matrix_recovery_never_restores_old_execution_selection_segment_lineage_ready_or_consent_epoch`
- `persistent_matrix_unknown_hash_stage_filename_or_cross_transaction_blocks_with_zero_mutation`
- `persistent_matrix_blocked_bootstrap_repeat_is_stable_and_never_falls_back`
- `persistent_matrix_bootstrap_without_reference_cleanup_journal_never_deletes_orphan_secret`

snapshot 必须覆盖 config tree全部bytes、SecretStore refs/values hash、event/checkpoint/journal、provider/runtime metadata、schema marker，以及 Phase D `executionSelectionGeneration`、`segmentLineageGeneration`、`readyEpoch` 与 `nativeKeepAliveConsentEpoch` 的可比较投影；错误输出只显示logical target/caseId，不打印正文或路径。

- [ ] **Step 2: 运行持久矩阵并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_persistent -- --nocapture`

Expected: FAIL，至少有恢复面未登记统一case、第三次recover结果不稳定，或unknown状态发生写入。

- [ ] **Step 3: 用最小修复补齐既有 owner，不创建第二套 Journal**

每个case继续调用原owner的真实prepare/apply/recover；`crash_matrix.rs` 只做故障注入和前后snapshot。`FreshInit` 必须调用 Phase A `Repositories`/bootstrap 的真实fresh初始化owner，覆盖marker前、每个repository安装后、marker commit和cleanup窗口；结果只能是完整未初始化或完整schema-v2，unknown/hybrid零修改Blocked。修复必须局限于：缺失的完整预检、stage枚举失败封闭、known partial分类或幂等cleanup。不得把fresh/migration/workspace/event/import/switch合并成一个巨型transaction，也不得新增通用“遇错覆盖为new”的fallback。

rollout只验证单一AppSettings原子replace及version/rollback marker；cutover只验证窄settings service、removed command registry和legacy read compatibility在同一commit/schema边界，不为源码删除虚构运行时Journal。任何hybrid状态都让bootstrap Blocked。

- [ ] **Step 4: 运行原有聚焦测试、代码简化审查并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_persistent && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery && cargo test --manifest-path src-tauri/Cargo.toml --test workspace_store && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_switch_transaction && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_write_cutover && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；所有persistent case连续recover三次结果一致，所有unknown case调用前后snapshot逐字相同且bootstrap稳定Blocked；没有ReferenceCleanup Journal时孤儿secret在三次bootstrap后仍逐字保留。

使用 `@code-simplifier` 审查matrix helper和各owner最小修复；不得抽象掉不同事务的安全语义。若修改，重跑本步骤。

```bash
git add src-tauri/tests/support/crash_matrix.rs src-tauri/tests/support/mod.rs src-tauri/tests/hardening_crash_matrix_persistent.rs src-tauri/src/migration/coordinator.rs src-tauri/src/compat/write_transaction.rs src-tauri/src/storage/workspace_transaction.rs src-tauri/src/storage/runtime_outcome_store.rs src-tauri/src/storage/conversation_event_append.rs src-tauri/src/history/importer.rs src-tauri/src/storage/conversation_switch_transaction.rs src-tauri/src/storage/repositories.rs src-tauri/src/application/native_ai_rollout_service.rs src-tauri/src/application/app_settings_service.rs src-tauri/src/application/bootstrap.rs src-tauri/tests/migration_recovery.rs src-tauri/tests/workspace_store.rs src-tauri/tests/runtime_event_store.rs src-tauri/tests/conversation_switch_transaction.rs src-tauri/tests/legacy_write_cutover.rs
git commit -m "test(hardening): 覆盖全部持久恢复矩阵"
```

### Task 8: 对 start claim、shared recovery、Codex idle drain、settling、容量 ledger 与退出 drain 做易失崩溃矩阵

**Files:**
- Create: `src-tauri/tests/hardening_crash_matrix_lifecycle.rs`
- Modify: `src-tauri/src/application/conversation_execution_transition.rs`
- Modify: `src-tauri/src/application/conversation_execution_mode_service.rs`
- Modify: `src-tauri/src/application/conversation_switch_service.rs`
- Modify: `src-tauri/src/application/work_item_runtime_service.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src-tauri/src/runtime/codex/pool.rs`
- Modify: `src-tauri/src/runtime/codex/app_server.rs`
- Modify: `src-tauri/src/compat/runtime_bindings.rs`
- Modify: `src-tauri/src/application/legacy_entity_deletion_guard.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Modify: `src-tauri/src/application/runtime_shutdown_coordinator.rs`
- Modify: `src-tauri/src/application/quit_gate.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/tests/work_item_runtime.rs`
- Modify: `src-tauri/tests/conversation_manager.rs`
- Modify: `src-tauri/tests/conversation_execution_mode.rs`
- Modify: `src-tauri/tests/conversation_switch_transaction.rs`
- Modify: `src-tauri/tests/hardening_codex_idle.rs`
- Modify: `src-tauri/tests/quit_gate.rs`

- [ ] **Step 1: 写失败测试固定 process-before-binding、settling-before-journal 和 ledger RAII**

新增：

- `lifecycle_matrix_crash_before_and_after_start_claim_process_binding_and_metadata_commit`
- `lifecycle_matrix_execution_transition_crash_before_shutdown_keeps_old_selection_and_runtime_owner`
- `lifecycle_matrix_execution_transition_crash_after_shutdown_before_journal_restarts_old_selection_with_zero_live_handle`
- `lifecycle_matrix_execution_transition_claim_blocks_send_mode_provider_cleanup_and_exit_until_drop`
- `lifecycle_matrix_mode_transition_detaches_one_shared_codex_binding_and_preserves_peer_generation`
- `lifecycle_matrix_provider_transition_detaches_one_shared_codex_binding_and_preserves_peer_generation`
- `lifecycle_matrix_shared_service_recovery_claim_blocks_ready_rollout_and_exit_until_reconcile`
- `lifecycle_matrix_shared_service_recovery_unknown_revision_generation_or_candidate_is_blocked_without_mutation`
- `lifecycle_matrix_restart_drops_ephemeral_shared_recovery_claim_and_uses_persistent_owners`
- `lifecycle_matrix_codex_idle_drain_crashes_at_claim_job_close_tree_ack_and_generation_cleanup`
- `lifecycle_matrix_codex_idle_tree_ack_failure_keeps_owned_evidence_and_blocks_ready_rollout_exit`
- `lifecycle_matrix_restart_drops_idle_claim_and_persistent_owners_converge_durable_runtime_state`
- `lifecycle_matrix_late_idle_callback_cannot_clear_new_pool_generation_or_ready_epoch`
- `lifecycle_matrix_keep_alive_tick_and_idle_drain_linearize_without_duplicate_request`
- `lifecycle_matrix_idle_winner_preserves_same_pending_tick_id_until_single_retry`
- `lifecycle_matrix_restart_never_assumes_precrash_process_is_alive`
- `lifecycle_matrix_settling_marker_precedes_outcome_and_blocks_restart_delete_switch`
- `lifecycle_matrix_crash_between_settling_outcome_repository_and_cleanup_converges`
- `lifecycle_matrix_capacity_turn_reservation_panic_releases_without_persistent_phantom`
- `lifecycle_matrix_import_lease_panic_releases_and_preserves_event_checkpoint_bytes`
- `lifecycle_matrix_turn_and_import_never_wait_on_each_other_or_invert_locks`
- `lifecycle_matrix_exit_late_callback_after_finalizing_is_caught_by_sealing_drain`
- `lifecycle_matrix_exit_drain_failure_returns_quiescing_with_same_authorized_token`
- `lifecycle_matrix_repeated_exit_drain_converges_without_duplicate_terminal_event`
- `lifecycle_matrix_stale_start_or_settling_callback_cannot_publish_old_mode_selection_generation`
- `lifecycle_matrix_unknown_outcome_or_event_append_keeps_quiescing_and_zero_mutation`
- `lifecycle_matrix_uses_fake_clock_fake_process_and_no_sleep`

- [ ] **Step 2: 运行 lifecycle matrix 并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_lifecycle -- --nocapture`

Expected: FAIL，至少一个claim/settling/ledger/drain窗口尚未由统一inflight或RAII/replay覆盖。

- [ ] **Step 3: 收紧统一 inflight snapshot、RAII 和 final drain**

`runtime_inflight_state(WorkItemRef)` 必须一次观察 `startClaim/executionTransitionClaim/liveBinding/settlingGeneration/pendingOutcome`，Conversation/Terminal删除、provider/mode切换、ReferenceCleanup、restart和exit只复用该接口。execution transition在外部shutdown前崩溃时旧selection/runtime归属不变；shutdown/tree-empty/outcome已完成但尚未创建switch stage/journal或保存mode preference时，重启只允许以旧selection、零live handle重新进入Idle/Failed并由用户重试，不能猜测新selection已获授权。共享Codex的mode/provider transition只能detach目标Conversation binding并等待其callback/outcome，peer Conversation的binding、pool generation和Job必须保持；只有最后一个binding离开后才允许关闭共享server。process已创建但binding/metadata提交失败时先kill+tree-empty，再持久化Failed；应用重启始终把无live process的非终态segment收敛为Interrupted/Failed，不能猜测process仍存活。

`SharedServiceRecoveryRequired` matrix必须调用`ConversationManager`既有单一recovery coordinator：相同进程内claim进入统一inventory并阻止Ready、rollout和exit，合法immutable plan重复reconcile三次只提交一次每Conversation outcome/resume决定；在claim建立、各candidate outcome提交和claim释放窗口注入崩溃后，重启不得重放易失control event或猜测候选，只由已提交的RuntimeOutcome/Settling/StartClaim状态继续收敛。unknown revision、failed generation或candidate归属前后snapshot逐字相同并稳定`Blocked`。

`CodexIdleDrain` matrix直接调用Task 4 pool owner，在同一pool锁安装claim前后、锁外Job close返回、tree-empty ack成功/失败和generation-safe map清理前后逐点注入崩溃。claim一经创建即进入统一inventory，Job关闭或tree ack失败时不得先释放claim/handles或让Ready、rollout、exit通过；相同进程只可重试同一个owned Job，迟到callback只受provider revision、pool generation、activity epoch、Ready epoch和owned handle identity共同CAS约束，不绑定任一Conversation selection/lineage。普通attach与keepAlive tick都覆盖两种交错：它们先取得锁时deadline路径不得安装claim；claim先安装时调用方不得改变旧generation，只等待成功后以同一operation/tick ID在新generation重试。每个keepAlive交错点都验证至多一次请求，ack失败保持Blocked。进程重启后易失pool revision/claim/handles/pending tick全部归零，禁止假设旧Job仍存活或重建idle drain，只由RuntimeOutcome/StartClaim/Settling等持久owner收敛已落盘runtime/segment状态。

`ConversationEventCapacityLedger` 的turn reservation/import lease必须由不可Clone RAII guard管理，panic/early return都归零；ledger本身不落盘，重启只从committed file/journal重建。Sealing先阻止新lifecycle callback、`ConversationExecutionTransition`、`SharedServiceRecoveryRequired`与`CodexIdleDrain` claim，再通过同一`RecoverySurfaceRegistry`等待既有permit/claim归零并循环drain runtime outcome、event append、legacy import、switch和cleanup journal；未知状态保持同一quit token返回Quiescing，绝不exit。

- [ ] **Step 4: 运行生命周期、代码简化审查并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_lifecycle && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_recovery_inventory && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_codex_idle && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_execution_mode && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_switch_transaction && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；所有易失窗口重复恢复/退出收敛，mode/provider transition都只detach目标共享Codex binding并保持peer generation/Job运行；shared recovery与Codex idle drain claim在相同进程受统一门禁、重启后不被猜测重建，idle迟到callback不影响新generation，未知状态不退出且所有测试零真实sleep。

使用 `@code-simplifier` 审查inflight snapshot、RAII Drop和drain循环；若修改，重跑本步骤。

```bash
git add src-tauri/tests/hardening_crash_matrix_lifecycle.rs src-tauri/src/application/conversation_execution_transition.rs src-tauri/src/application/conversation_execution_mode_service.rs src-tauri/src/application/conversation_switch_service.rs src-tauri/src/application/work_item_runtime_service.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/runtime/codex/pool.rs src-tauri/src/runtime/codex/app_server.rs src-tauri/src/compat/runtime_bindings.rs src-tauri/src/application/legacy_entity_deletion_guard.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/src/application/runtime_shutdown_coordinator.rs src-tauri/src/application/quit_gate.rs src-tauri/src/application/bootstrap.rs src-tauri/tests/work_item_runtime.rs src-tauri/tests/conversation_manager.rs src-tauri/tests/conversation_execution_mode.rs src-tauri/tests/conversation_switch_transaction.rs src-tauri/tests/hardening_codex_idle.rs src-tauri/tests/quit_gate.rs
git commit -m "test(hardening): 覆盖运行时与退出崩溃窗口"
```

### Task 9: 新增只读 ReferenceAuditService 与完整引用图

**Files:**
- Create: `src-tauri/src/application/reference_graph.rs`
- Create: `src-tauri/src/application/reference_audit_service.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/recovery_surface_registry.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Modify: `src-tauri/src/storage/runtime_outcome_store.rs`
- Modify: `src-tauri/src/secrets/secret_store.rs`
- Create: `src-tauri/tests/reference_audit.rs`

- [ ] **Step 1: 写失败测试固定 graph node、edge、保护和零写边界**

新增：

- `reference_graph_covers_project_tombstone_conversation_segment_terminal_and_saved_workspace`
- `reference_graph_covers_provider_profile_current_revision_and_current_workspace_root`
- `reference_graph_uses_closed_root_reachability_not_incidental_in_degree`
- `reference_graph_roots_include_current_all_saved_project_conversation_terminal_provider_tombstone_preferences_app_settings_and_pending_journal`
- `reference_graph_inactive_saved_workspace_and_global_default_pair_edges_are_reachable`
- `reference_graph_app_settings_compatibility_defaults_pin_both_driver_providers`
- `reference_graph_native_keep_alive_consent_pins_provider_revision_and_model`
- `reference_graph_pending_journal_staging_and_quarantine_are_pinned_by_unique_artifact_identity`
- `reference_graph_pending_journal_reaches_every_typed_staging_and_quarantine_artifact`
- `reference_graph_same_hash_distinct_journal_artifacts_do_not_collapse`
- `reference_graph_protection_reachability_pins_every_pending_journal_ownership_edge`
- `reference_graph_external_cleanup_reachability_excludes_only_current_plan_ownership_edges`
- `reference_graph_external_cleanup_reachability_keeps_other_journal_and_business_edges`
- `reference_graph_covers_provider_revision_model_secret_and_runtime_namespace`
- `reference_graph_covers_event_checkpoint_import_append_outcome_switch_and_all_journals`
- `reference_graph_missing_workspace_or_layout_stable_id_still_pins_conversation_event_and_checkpoint_artifacts`
- `reference_graph_missing_layout_item_pins_discovered_event_and_checkpoint_by_stable_id`
- `reference_graph_missing_saved_workspace_project_terminal_provider_revision_and_model_ids_become_typed_protected_anchors`
- `reference_graph_historical_segment_pins_revision_secret_model_and_runtime_namespace`
- `reference_graph_soft_deleted_provider_and_retired_revision_remain_referenced_when_history_uses_them`
- `reference_graph_project_history_tombstone_is_permanently_protected`
- `reference_graph_project_directory_is_never_a_managed_cleanup_artifact`
- `reference_graph_runtime_fixtures_and_release_evidence_are_never_candidates`
- `reference_graph_unknown_file_is_reported_protected_not_silently_ignored`
- `reference_graph_candidates_are_only_unreachable_closed_cleanup_artifacts`
- `reference_audit_repeated_run_is_byte_deterministic_for_same_snapshot`
- `reference_audit_is_read_only_for_config_tree_secret_store_and_runtime_state`
- `reference_audit_lists_secret_refs_without_decrypting_or_exposing_secret_values`
- `reference_audit_reports_committed_orphan_secret_as_candidate_without_deleting_it`
- `reference_audit_public_report_contains_opaque_ids_counts_bytes_and_reasons_not_paths_or_secret_refs`

- [ ] **Step 2: 运行引用审计测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test reference_audit`

Expected: FAIL，统一typed graph和只读audit service尚不存在。

- [ ] **Step 3: 实现内部typed graph和公开脱敏报告**

内部node闭合为：

```rust
pub enum ReferenceNodeId {
    Project(ProjectId),
    ProjectTombstone(ProjectId),
    CurrentWorkspace,
    GlobalPreferences,
    AppSettings,
    Conversation(ConversationId),
    RuntimeSegment(RuntimeSegmentId),
    Terminal(TerminalSessionId),
    SavedWorkspace(SavedWorkspaceId),
    ProviderProfile(ProviderId),
    ProviderRevision(ProviderRevisionId),
    Model(ModelId),
    Secret(SecretRef),
    RuntimeNamespace(RuntimeNamespaceId),
    EventLog(ConversationId),
    Checkpoint(ConversationId),
    ProtectedMissing(ProtectedMissingKind, StableEntityId),
    Journal(RecoverySurfaceKind, JournalInstanceId),
    JournalArtifact(JournalArtifactId),
}
```

Journal内部ID只能来自closed parser，不能承载路径。`JournalArtifactId`由`RecoverySurfaceKind + JournalInstanceId + manifestItemStableId`组成，artifact digest作为该唯一node的校验属性，禁止仅用content hash合并不同事务/item。引用判定固定为从闭合root集合做reachability，不以“当前入边数为0”直接判candidate。roots精确包括：`CurrentWorkspace`、每个`SavedWorkspace`（含inactive）、每个`Project`、每个`Conversation`、每个`Terminal`、每个`ProviderProfile`、每个`ProjectTombstone`、唯一`GlobalPreferences`、唯一`AppSettings`，以及每个pending Journal manifest对应的`Journal` node；root重复只去重，不得因UI不可见、workspace/layout stable ID缺失或soft-delete而移除。新增root kind必须同时修改闭合enum、graph fingerprint schema与对应测试。

graph edge精确覆盖：`CurrentWorkspace`的`sourceSavedWorkspaceId`、pane `projectId`与items；每个`SavedWorkspace`的pane `projectId`与items；`Project`和`GlobalPreferences`的default provider-model pair；`AppSettings.compatibility.claudeDefaultProviderId/codexDefaultProviderId`到对应`ProviderProfile`；`Conversation`的project、current provider-model、segments、event log与checkpoint，以及`nativeKeepAliveConsent`冻结的provider/profile revision/model；`Terminal`的project；`ProviderProfile`的`currentRevisionId/modelIds`；`ProviderRevision`的provider、model snapshots与secret；`RuntimeSegment`的conversation、provider、revision、model、runtime namespace与resume lineage；pending Journal则指向manifest内全部metadata target、业务artifact，以及每个带唯一`JournalArtifactId`的staging/quarantine artifact。`AppSettings`的theme/terminal/notification/native flag等非引用字段不虚构edge。

`ProtectedMissingKind`闭合为`SavedWorkspace | Project | Conversation | Terminal | ProviderProfile | ProviderRevision | Model`。任何持久edge指向缺失metadata时都按kind+stable ID创建锚点并纳入fingerprint/node/edge计数：缺失Conversation还直接pin同ID发现到的EventLog/Checkpoint；缺失Terminal、`sourceSavedWorkspaceId`、pane Project、default/compatibility Provider或keepAlive consent revision/model至少保留typed锚点，禁止被解释成“无引用”。不得因metadata缺失把仍被布局、设置或授权记录引用的历史判为candidate。正常Conversation即使不在当前layout仍自身作为root，继续pin其segment/event/checkpoint/revision/secret/runtime namespace。`RecoverySurfaceRegistry`只向graph提供closed、path-free的journal reference snapshot；未知Journal kind、stage或artifact ID只进入Protected/Unknown。pending Journal同样在事务收敛前pin原manifest，cleanup不得把inflight staging/quarantine误判为孤儿。只有从全部roots不可达、kind可表达且不在永久保护集的typed artifact才可成为candidate。ProjectHistoryTombstone始终`ProtectedStableId`；项目目录根本不建可删artifact node。`runtime-fixtures`、release evidence、smoke/capture和未知文件只报告Protected/Unknown，不进入candidate manifest。

同一typed graph只暴露两种闭合投影。`ProtectionReachability`保留全部root与全部Journal ownership edge，供公开audit、candidate生成和新plan使用；因此任何inflight metadata/source/staging/quarantine都不能被再次选择。`ExternalCleanupReachability(CleanupPlanId)`只供已验证的当前ReferenceCleanup commit/recovery内部调用：它保留当前Journal root，但仅忽略从该精确`Journal(ReferenceCleanup, planId)`指向其冻结manifest目标的ownership edges，用于回答“除当前事务自身占有外是否出现新引用”。其他业务root、其他Journal、同kind不同plan、未知edge与ProtectedMissing全部保留，任一可达仍`Blocked`。调用方不得传自由Journal ID，也不得把external投影用于audit/candidate或修改graph fingerprint。

公开 `ReferenceAuditReport` 只含 `graphFingerprint`、node/edge/candidate/protected/unknown counts、按artifact kind汇总bytes，以及 `ReferenceAuditCandidate { candidateId, kind, byteCount, reason, requiredScope }`。`candidateId` 是绑定graph fingerprint与内部typed node/hash的opaque token，不返回绝对路径、secretRef、provider URL或event正文。两次相同snapshot排序/序列化逐字一致。

- [ ] **Step 4: 运行审计、代码简化审查并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test reference_audit && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_recovery_inventory && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；audit前后config tree/secret refs/runtime maps逐字相同，历史segment引用的revision/secret/runtime namespace绝不成为candidate。

使用 `@code-simplifier` 审查graph builder、稳定排序和public projection；若修改，重跑本步骤。

```bash
git add src-tauri/src/application/reference_graph.rs src-tauri/src/application/reference_audit_service.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/recovery_surface_registry.rs src-tauri/src/storage/repositories.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/src/storage/runtime_outcome_store.rs src-tauri/src/secrets/secret_store.rs src-tauri/tests/reference_audit.rs
git commit -m "feat(hardening): 增加只读全局引用审计"
```

### Task 10: 实现用户确认 manifest 驱动的 ReferenceCleanup transaction

**Files:**
- Create: `src-tauri/src/application/reference_cleanup_service.rs`
- Create: `src-tauri/src/application/cleanup_exclusive_admission.rs`
- Create: `src-tauri/src/storage/reference_cleanup_transaction.rs`
- Create: `src-tauri/src/commands/reference_cleanup_cmds.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/recovery_surface_registry.rs`
- Modify: `src-tauri/src/application/runtime_shutdown_coordinator.rs`
- Modify: `src-tauri/src/application/quit_gate.rs`
- Modify: `src-tauri/src/application/mutation_gate.rs`
- Modify: `src-tauri/src/application/conversation_execution_transition.rs`
- Modify: `src-tauri/src/application/conversation_manager.rs`
- Modify: `src-tauri/src/application/work_item_runtime_service.rs`
- Modify: `src-tauri/src/application/native_keep_alive_service.rs`
- Modify: `src-tauri/src/application/provider_connection_service.rs`
- Modify: `src-tauri/src/runtime/codex/pool.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/storage/config_file_store.rs`
- Modify: `src-tauri/src/storage/provider_store.rs`
- Modify: `src-tauri/src/storage/conversation_event_store.rs`
- Modify: `src-tauri/src/storage/conversation_event_append.rs`
- Modify: `src-tauri/src/storage/runtime_outcome_store.rs`
- Modify: `src-tauri/src/storage/conversation_switch_transaction.rs`
- Modify: `src-tauri/src/history/importer.rs`
- Modify: `src-tauri/src/secrets/secret_store.rs`
- Modify: `src-tauri/src/runtime/namespace.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/reference_cleanup.rs`
- Modify: `src-tauri/tests/bootstrap_order.rs`
- Modify: `src-tauri/tests/hardening_recovery_inventory.rs`
- Modify: `src-tauri/tests/hardening_crash_matrix_persistent.rs`
- Modify: `src-tauri/tests/hardening_crash_matrix_lifecycle.rs`
- Modify: `src-tauri/tests/quit_gate.rs`
- Modify: `src-tauri/tests/conversation_manager.rs`
- Modify: `src-tauri/tests/work_item_runtime.rs`
- Modify: `src-tauri/tests/native_keep_alive.rs`
- Modify: `src-tauri/tests/provider_connection.rs`
- Modify: `src-tauri/tests/hardening_codex_idle.rs`
- Modify: `src-tauri/tests/runtime_event_store.rs`
- Modify: `src-tauri/tests/conversation_switch_transaction.rs`

- [ ] **Step 1: 写失败测试固定plan、scope确认和永久禁止目标**

新增：

- `cleanup_plan_accepts_only_candidate_ids_from_same_graph_fingerprint`
- `cleanup_plan_reverse_metadata_dependency_closure_rejects_reachable_protected_or_unknown_target`
- `cleanup_plan_closes_unreachable_metadata_predecessors_before_secret_or_model`
- `cleanup_plan_dependency_closure_touching_reachable_protected_or_unknown_node_is_rejected`
- `cleanup_post_metadata_graph_revalidates_reachability_not_original_fingerprint_equality`
- `cleanup_current_journal_ownership_does_not_self_block_post_open_external_reachability`
- `cleanup_other_journal_or_business_root_new_reference_still_blocks_external_reachability`
- `cleanup_plan_manifest_never_expands_after_user_preview`
- `cleanup_plan_manifest_contains_closed_artifact_ids_hashes_and_scopes_not_paths`
- `cleanup_plan_tracked_runtime_and_secret_scopes_require_separate_explicit_confirmation`
- `cleanup_is_only_owner_allowed_to_delete_committed_orphan_secret_after_secret_scope_confirmation`
- `cleanup_plan_never_contains_project_tombstone_project_directory_runtime_fixtures_or_evidence`
- `cleanup_plan_never_contains_revision_model_secret_or_namespace_referenced_by_historical_segment`
- `cleanup_plan_unknown_artifact_is_not_selectable`
- `cleanup_commit_without_all_required_scope_confirmations_is_zero_write`
- `cleanup_commit_stale_plan_or_new_reference_is_zero_write_conflict`
- `cleanup_exclusive_admission_is_single_writer_and_normal_mutations_hold_shared_permits`
- `cleanup_recovery_surface_combines_ephemeral_admission_and_persistent_journal_state`
- `cleanup_exclusive_admission_freezes_new_start_connection_test_append_import_switch_outcome_transition_recovery_idle_and_keepalive`
- `cleanup_exclusive_admission_waits_existing_shared_permits_ledgers_and_inventory_clean_before_write`
- `cleanup_application_mutation_gate_acquire_under_cleanup_does_not_request_shared_permit`
- `cleanup_normal_operation_passes_one_shared_permit_into_mutation_gate_without_nested_admission`
- `cleanup_prepared_is_impossible_while_any_other_recovery_surface_is_nonclean`
- `cleanup_prepared_failure_before_first_write_reopens_admission`
- `cleanup_post_prepared_failure_keeps_runtime_blocked_until_recovery`
- `cleanup_crash_drops_ephemeral_admission_but_persistent_journal_blocks_bootstrap`
- `cleanup_commit_writes_authorized_plan_id_manifest_and_confirmation_to_journal_before_move`
- `cleanup_item_state_machine_is_pending_move_intent_moved_purge_intent_purged`
- `cleanup_metadata_state_is_pending_then_metadata_removed_separate_from_physical_items`
- `cleanup_stage_machine_is_prepared_metadata_install_intent_metadata_installed_moving_purging_committed`
- `cleanup_metadata_item_completes_only_after_all_new_hashes_verify`
- `cleanup_commit_syncs_prepared_journal_before_first_metadata_replace_or_artifact_move`
- `cleanup_quarantine_path_is_exact_config_root_plan_item_same_volume_without_copy_delete_fallback`
- `cleanup_cross_volume_or_copy_delete_fallback_is_rejected`
- `cleanup_remove_tree_receives_only_typed_quarantine_path`
- `cleanup_move_intent_source_exists_staging_missing_retries_same_volume_rename`
- `cleanup_move_intent_source_missing_exact_staging_promotes_moved`
- `cleanup_move_intent_both_present_both_missing_or_unknown_hash_blocks`
- `cleanup_purge_intent_missing_staging_promotes_purged`
- `cleanup_missing_without_prior_intent_is_blocked`
- `cleanup_crash_matrix_recovers_only_original_manifest_and_never_expands_candidates`
- `cleanup_matrix_completes_final_inventory_persistent_and_atomic_surface_coverage`
- `cleanup_recovery_revalidates_references_and_hashes_before_each_remaining_item`
- `cleanup_recovery_new_reference_or_unknown_hash_blocks_without_further_mutation`
- `cleanup_metadata_snapshot_preserves_latest_execution_selection_segment_lineage_ready_and_consent_epochs`
- `cleanup_recovery_stale_graph_generation_never_restores_old_consent_generation_or_runtime_binding`
- `cleanup_bootstrap_preopen_converges_metadata_before_repository_open`
- `cleanup_bootstrap_stage_to_metadata_old_new_partial_matrix_is_closed`
- `cleanup_bootstrap_rejects_cleanup_coexisting_with_each_other_persistent_or_atomic_owner_before_any_write`
- `cleanup_bootstrap_exclusivity_matrix_covers_runtime_event_outcome_import_switch_rollout_and_cutover`
- `cleanup_bootstrap_unknown_metadata_snapshot_is_zero_write_blocked`
- `cleanup_bootstrap_rebuilds_graph_and_generation_before_remaining_move_or_purge`
- `cleanup_no_journal_never_runs_automatically_at_bootstrap`
- `cleanup_never_calls_remove_tree_with_project_user_or_evidence_path`

- [ ] **Step 2: 运行cleanup测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test reference_cleanup`

Expected: FAIL，cleanup plan/service/journal尚不存在；不得以ReferenceAudit candidate直接调用remove。

- [ ] **Step 3: 定义持久授权证据与闭合manifest**

Journal核心形状：

```rust
pub struct ReferenceCleanupJournal {
    pub format_version: u32,
    pub plan_id: CleanupPlanId,
    pub graph_fingerprint: String,
    pub manifest_hash: String,
    pub confirmed_tracked: bool,
    pub confirmed_runtime: bool,
    pub confirmed_secrets: bool,
    pub frozen_generations: ReferenceCleanupFrozenGenerations,
    pub items: Vec<ReferenceCleanupManifestItem>,
    pub metadata_targets: Vec<ReferenceCleanupMetadataTarget>,
    pub stage: ReferenceCleanupStage,
}

pub enum ReferenceCleanupStage {
    Prepared,
    MetadataInstallIntent,
    MetadataInstalled,
    MovingArtifacts,
    PurgingArtifacts,
    Committed,
}

pub enum ReferenceCleanupItemState {
    Pending,
    MoveIntent,
    Moved,
    PurgeIntent,
    Purged,
}

pub enum ReferenceCleanupMetadataState {
    Pending,
    MetadataRemoved,
}

pub struct ReferenceCleanupMetadataTarget {
    pub target: ReferenceCleanupMetadataTargetKind,
    pub old_sha256: String,
    pub new_sha256: String,
    pub staged_sha256: String,
    pub old_bytes: u64,
    pub new_bytes: u64,
    pub state: ReferenceCleanupMetadataState,
}

pub struct ReferenceCleanupFrozenGenerations {
    pub conversations: Vec<ReferenceCleanupConversationGeneration>,
    pub ready_epoch: u64,
    pub native_keep_alive_consent_epoch: u64,
}

pub struct ReferenceCleanupConversationGeneration {
    pub conversation_id: ConversationId,
    pub execution_selection_generation: u64,
    pub segment_lineage_generation: u64,
}
```

`ReferenceCleanupMetadataTarget`闭合记录typed repository target、old/new/staged hash与bytes及`Pending/MetadataRemoved`，不复用artifact item的Move/Purge状态机；其old/new/known-partial分类只能由`ReferenceCleanupStage`推进。`frozen_generations`闭合保存Conversation execution selection/segment lineage、Ready epoch与keepAlive consent epoch，不能以自由map扩展。`ReferenceCleanupManifestItem`只含closed artifact kind、typed stable ID/candidate digest、expected hash/bytes、由planId+itemId绑定的quarantine digest和item state；source path与quarantine path由代码纯函数派生，quarantine唯一为`configRoot/.reference-cleanup/<planId>/quarantine/<itemId>`，必须与source同volume并通过canonical/no-reparse identity校验，禁止copy-then-delete fallback、cross-volume或public path。tracked scope包括经graph证明无引用的provider revision/model metadata和孤儿event/checkpoint；runtime scope只包括应用自有`runtime/codex|claude/{providerRevisionId}`及本应用cleanup quarantine；secret scope只包括无任何历史/当前引用的secret blob。ProjectHistoryTombstone、项目目录、legacy external history、`src-tauri/runtime-fixtures`、smoke/capture/release-evidence和未知文件没有可表达manifest kind。

`reference_cleanup_status` 是唯一可在 Ready 与 Blocked runtime 都调用的只读cleanup命令；audit/create-plan/commit只允许Ready。Blocked status只读取并投影既有Journal，不触发recover、删除或新plan。

Task 6既有`RecoverySurfaceKind::ReferenceCleanup` inspector在本任务组合admission与Journal：`Open + no journal = Clean`；`Sealing + no journal`只在同进程显示Recoverable/pending且阻止Ready/rollout/exit；`JournalOwned(planId)`必须与同plan Journal精确共存；`Blocked(planId)`或admission/Journal plan不匹配统一Blocked。重启后易失admission回到Open，但存在Journal时inspector仍由持久owner报告Recoverable/Blocked，绝不能误报Clean。

- [ ] **Step 4: 实现 pre-open metadata 收敛与 write-ahead rename-to-staging transaction**

`CleanupExclusiveAdmission`是application-scoped单一读写admission，状态闭合为`Open | Sealing(CleanupAttemptId) | JournalOwned(CleanupPlanId) | Blocked(CleanupPlanId)`。所有Ready期普通mutation在最外层入口、创建claim、ledger reservation/import lease、Journal、process或外部请求前恰好取得一次不可Clone shared permit，并持有到自身owner完全收敛。已持permit的路径必须调用`ApplicationMutationGate::acquire_with_admission(&permit)`，只校验同一application/operation token而不再次申请admission；没有外层permit的窄metadata入口可调用`acquire()`，它必须原子按`shared admission → mutation mutex`取得组合guard，不能暴露两步窗口。cleanup只有持typed exclusive guard时才能调用`ApplicationMutationGate::acquire_under_cleanup(&guard)`，同样不申请shared permit。测试必须覆盖Sealing恰发生在outer permit与mutation gate之间时普通operation仍可凭原permit完成，cleanup等待其归零，不发生“持一个permit再等第二个permit”的死锁。event append、RuntimeOutcome、LegacyImport、ConversationSwitch、AI/Terminal start、connection test、settling/execution transition、shared recovery、Codex idle drain与keepAlive入口分别接入同一admission；`Sealing/JournalOwned/Blocked`期间新入口统一在任何副作用前返回`RETRY_LATER`。Quit/启动恢复只读检查不申请普通shared permit。

公开流程固定为 `audit → createPlan(selectedCandidateIds) → 展示manifest摘要 → 用户确认各required scope → commit(planId, manifestHash, confirmations)`。`createPlan`先在同一graph fingerprint内从selected candidate计算确定性的反向metadata依赖闭包；例如选择Secret时，所有仍引用它且同样不可达的ProviderRevision必须先进入tracked metadata removal。闭包若触达任一root-reachable、Protected或Unknown node则整个plan拒绝且零写；扩展后的完整manifest必须先展示给用户，随后永久冻结，commit/recovery都不得补入新target。

commit锁序固定为：只读校验plan/confirmations → ordinary Quit permit → `CleanupExclusiveAdmission::seal(attemptId)`原子阻止新shared permit → 等待既有shared permit归零 → 在exclusive guard下调用owner专用recover/drain port，直到`RecoverySurfaceRegistry`（此时尚无本cleanup Journal）全部Clean、所有`runtime_inflight_state`为空、event writer/容量reservation/import lease归零 → `ApplicationMutationGate::acquire_under_cleanup` → 按stable Conversation ID取得受影响ledger/writer cleanup lease → 再次重验inventory/inflight、graph fingerprint、candidate/closure hash、外部引用、文件hash与全部generation/epoch → 写`Prepared`。任何检查失败都必须发生在Prepared前且零写；此时drop Sealing guard才可回到Open。该顺序不能只检查`ConversationExecutionTransition/CodexIdleDrain`，也不能让不同Conversation的新append在等待期间穿入。

事务在同一exclusive guard+mutation guard内重读并冻结当前metadata hash以及Conversation `executionSelectionGeneration`、`segmentLineageGeneration`、Ready `readyEpoch` 与AppSettings `nativeKeepAliveConsentEpoch`。任何metadata replace或source move前，先以`stage=Prepared`原子持久化并sync完整授权Journal/manifest/confirmation，再把admission推进为`JournalOwned(planId)`；未完成该barrier时零mutation。Prepared后无论成功还是可恢复错误都不得重新Open：guard保持到`Committed`，或runtime进入`Blocked(planId)`并仅允许同一owner recovery/quit；进程崩溃时易失admission归零，但bootstrap必须由持久Journal恢复且在Ready前重新建立Open。随后`MetadataInstallIntent(sync)`→安装providers/conversations等tracked metadata snapshot→逐项验证所有canonical metadata都精确匹配new hash/bytes→`MetadataInstalled(sync)`，此后才允许对应metadata target从`Pending`推进为`MetadataRemoved`，使revision/model/secret/runtime namespace不再被metadata引用。metadata record只允许`Pending → MetadataRemoved`，物理artifact只允许Move/Purge状态；二者不得互用。cleanup snapshot只能处理冻结manifest目标，必须逐字保留最新execution mode/current provider-model、rollback marker、全部单调generation/epoch和已因切换失效的consent状态。

进入artifact阶段先持久化`MovingArtifacts`。每个artifact严格按write-ahead状态机执行，禁止直接删除source后补记状态：`Pending → MoveIntent(sync) → Moved(sync) → PurgeIntent(sync) → Purged(sync)`。进入`MoveIntent`前重新验证source regular/tree no-reparse、expected hash/bytes、quarantine不存在且source/quarantine同volume；先原子持久化并sync Journal/parent barrier，再把source原子rename到精确quarantine并sync两侧parent，最后持久化`Moved`。全部item至少Moved后持久化`PurgingArtifacts`；之后先持久化并sync`PurgeIntent`，才允许从quarantine物理purge并sync parent，最后持久化`Purged`。只有全部metadata target为MetadataRemoved且全部physical item为Purged才标`Committed`并清理本事务Journal；evidence本身不自动删除。

恢复判定闭合：`MoveIntent`下source存在且quarantine缺失时，重验hash/引用后重试同volume rename；source缺失且quarantine以expected hash/bytes精确存在时promote为`Moved`；source与quarantine同时存在、同时缺失、任一reparse/类型不符或hash unknown均`Blocked`。`Moved`要求source缺失且quarantine精确存在，否则Blocked。`PurgeIntent`下quarantine精确存在则继续purge，quarantine缺失可promote为`Purged`，因为purge intent已先持久化；没有相应Move/Purge intent时source或quarantine缺失一律不能当幂等成功。恢复只处理原manifest，绝不扩展candidate。

bootstrap先做closed inventory scan。`ReferenceCleanup` Journal只允许与committed schema-v2 marker共存；cleanup commit前本就要求inventory全部Clean，因此它若与`FreshInit`、`Migration`、`CompatibilityWrite`、`WorkspaceWrite`、`RuntimeEventAppend`、`RuntimeOutcome`、`LegacyImport`、`ConversationSwitch`、`NativeAiRolloutAtomic`、`LegacyWriteCutoverAtomic`或任何其他Journal/atomic owner并存，均属于不可证明状态，必须在任一owner写入前零写`Blocked`，不得猜顺序。参数化exclusivity matrix逐个owner构造并存状态，断言config tree、secret refs、event/checkpoint和所有journal bytes零变化。

唯一合法顺序由`bootstrap_order`逐项断言：`resolveConfigRoot` → `scanClosedRecoveryInventoryAndAssertCleanupExclusive`（在任何recover/write前确认cleanup缺失，或cleanup存在且除schema-v2 marker外所有persistent/atomic owner均Clean）→ 确认FreshInit/Migration/CompatibilityWrite/WorkspaceWrite均Clean → `recoverReferenceCleanupMetadataPreOpen` → open并validate repositories → `recoverRuntimeEventAppend` → `recoverRuntimeOutcome` → `recoverLegacyImport` → `recoverConversationSwitch` → reconcile legacy/terminal/native nonterminal state并validate `NativeIdentity` → 从最新repository重建root-reachability graph与generation/epoch snapshot → `recoverReferenceCleanupArtifactsPostOpen` → 要求`RecoverySurfaceRegistry`全部Clean → 构造并绑定`ConversationManager`/唯一relay → publish Ready。

pre-open阶段只用raw `ConfigFileStore`、closed cleanup Journal parser和old/new/staged hash：`Prepared`只允许全部old；`MetadataInstallIntent`允许全部old或与manifest一致的known-partial并完成new安装；`MetadataInstalled/MovingArtifacts/PurgingArtifacts/Committed`要求全部new。任何stage/hash不匹配、跨transaction staging或无法证明的hybrid在repository open和写入前零写`Blocked`；该阶段不执行artifact rename/purge。post-open阶段不要求最新graph fingerprint等于原fingerprint，而是使用Task 9的`ExternalCleanupReachability(planId)`，只排除当前plan自身Journal到冻结manifest的ownership edges，再按其余最新roots/edges重新证明每个剩余item无外部引用并验证全部generation/epoch未回退。当前Journal自身保护边不会让恢复自阻断；任何业务root、其他Journal、同kind不同plan或未知edge的新引用仍保留既有quarantine并`Blocked`，禁止自动restore旧metadata/source；scope confirmation缺失或runtime binding变化同样`Blocked`。

`ConfigFileStore` 递归purge quarantine前仍先整树no-reparse预检；只接受上述typed app-owned same-volume quarantine，绝不接收public/source项目路径。清理只降低应用可访问副本，不承诺SSD/文件系统历史物理擦除。

- [ ] **Step 5: 运行cleanup/恢复矩阵、简化并提交**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test reference_cleanup && cargo test --manifest-path src-tauri/Cargo.toml --test reference_audit && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_recovery_inventory && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_persistent && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_lifecycle && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_manager && cargo test --manifest-path src-tauri/Cargo.toml --test work_item_runtime && cargo test --manifest-path src-tauri/Cargo.toml --test native_keep_alive && cargo test --manifest-path src-tauri/Cargo.toml --test provider_connection && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_codex_idle && cargo test --manifest-path src-tauri/Cargo.toml --test runtime_event_store && cargo test --manifest-path src-tauri/Cargo.toml --test conversation_switch_transaction && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；无确认时零写，cleanup exclusive admission在Prepared前冻结并drain全部owner、Prepared后不重新Open，任何双Journal/active inflight组合都不可构造；metadata pre-open顺序固定，post-open external reachability不被当前Journal自阻断且会阻断其他新引用。所有Move/Purge crash point三次recover只处理原manifest并收敛；`hardening_crash_matrix_persistent`在加入ReferenceCleanup owner后覆盖inventory全部persistent/atomic surfaces，lifecycle matrix确认Sealing等待cleanup owner且无Task 7临时缺口；tombstone、项目目录、runtime fixtures、evidence及历史引用revision/secret始终逐字保留。

使用 `@code-simplifier` 审查plan验证、删除顺序和recovery分支；不得把audit与cleanup合并成自动GC。若修改，重跑本步骤。

```bash
git add src-tauri/src/application/reference_cleanup_service.rs src-tauri/src/application/cleanup_exclusive_admission.rs src-tauri/src/storage/reference_cleanup_transaction.rs src-tauri/src/commands/reference_cleanup_cmds.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/recovery_surface_registry.rs src-tauri/src/application/runtime_shutdown_coordinator.rs src-tauri/src/application/quit_gate.rs src-tauri/src/application/mutation_gate.rs src-tauri/src/application/conversation_execution_transition.rs src-tauri/src/application/conversation_manager.rs src-tauri/src/application/work_item_runtime_service.rs src-tauri/src/application/native_keep_alive_service.rs src-tauri/src/application/provider_connection_service.rs src-tauri/src/runtime/codex/pool.rs src-tauri/src/storage/mod.rs src-tauri/src/storage/repositories.rs src-tauri/src/storage/config_file_store.rs src-tauri/src/storage/provider_store.rs src-tauri/src/storage/conversation_event_store.rs src-tauri/src/storage/conversation_event_append.rs src-tauri/src/storage/runtime_outcome_store.rs src-tauri/src/storage/conversation_switch_transaction.rs src-tauri/src/history/importer.rs src-tauri/src/secrets/secret_store.rs src-tauri/src/runtime/namespace.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/reference_cleanup.rs src-tauri/tests/bootstrap_order.rs src-tauri/tests/hardening_recovery_inventory.rs src-tauri/tests/hardening_crash_matrix_persistent.rs src-tauri/tests/hardening_crash_matrix_lifecycle.rs src-tauri/tests/quit_gate.rs src-tauri/tests/conversation_manager.rs src-tauri/tests/work_item_runtime.rs src-tauri/tests/native_keep_alive.rs src-tauri/tests/provider_connection.rs src-tauri/tests/hardening_codex_idle.rs src-tauri/tests/runtime_event_store.rs src-tauri/tests/conversation_switch_transaction.rs
git commit -m "feat(hardening): 增加显式授权引用清理事务"
```

### Task 11: 接入 StorageCleanupDialog 并完成 Chunk 2 总门禁

**Files:**
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/v2/types.test.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Create: `src/components/dialogs/StorageCleanupDialog.tsx`
- Create: `src/components/dialogs/StorageCleanupDialog.test.tsx`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/components/dialogs/SettingsDialog.test.tsx`
- Modify: `src/components/dialogs/MigrationDialog.tsx`
- Modify: `src/components/dialogs/MigrationDialog.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles/dialogs.css`

- [ ] **Step 1: 写失败 client/UI 测试固定只读审计、二阶段确认和不显示敏感定位**

新增：

- `backendClient_reference_audit_plan_commit_status_match_tauri_and_fake`
- `reference_cleanup_public_types_contain_opaque_candidate_plan_and_manifest_ids_not_paths_or_secret_refs`
- `storageCleanupDialog_initial_open_runs_read_only_audit_only`
- `storageCleanupDialog_shows_candidate_protected_unknown_counts_and_bytes`
- `storageCleanupDialog_never_lists_project_path_tombstone_path_secret_ref_or_runtime_absolute_path`
- `storageCleanupDialog_tracked_runtime_and_secret_confirmations_are_independent`
- `storageCleanupDialog_cannot_commit_until_every_required_scope_is_checked`
- `storageCleanupDialog_stale_plan_refetches_audit_and_requires_reconfirmation`
- `storageCleanupDialog_cancel_or_close_calls_no_plan_commit_or_delete`
- `storageCleanupDialog_pending_authorized_journal_shows_recovery_status_without_expanding_manifest`
- `app_blocked_reference_cleanup_exposes_read_only_status_and_repair_guidance_without_ready_settings`
- `app_blocked_reference_cleanup_cannot_force_skip_expand_or_create_new_plan`
- `storageCleanupDialog_has_no_auto_cleanup_schedule_or_clean_on_start_option`
- `storageCleanupDialog_explains_no_physical_erase_and_evidence_directories_are_excluded`

- [ ] **Step 2: 运行UI契约测试并确认失败**

Run: `npm run test -- src/api/v2/types.test.ts src/components/dialogs/StorageCleanupDialog.test.tsx src/components/dialogs/SettingsDialog.test.tsx src/components/dialogs/MigrationDialog.test.tsx src/App.test.tsx`

Expected: FAIL，client DTO和StorageCleanupDialog尚不存在。

- [ ] **Step 3: 扩展BackendClient并实现显式三阶段UI**

增加：

```ts
referenceAuditRun(): Promise<ReferenceAuditReport>;
referenceCleanupPlanCreate(candidateIds: string[]): Promise<ReferenceCleanupPlan>;
referenceCleanupCommit(input: ReferenceCleanupCommitInput): Promise<void>;
referenceCleanupStatus(): Promise<ReferenceCleanupStatus>;
```

commit input只含`planId/manifestHash/confirmedTracked/confirmedRuntime/confirmedSecrets`，不接受path、artifact filename、revision ID、secretRef或额外candidate。Fake只记录调用/deferred/error，不复制graph或删除逻辑。

Ready Settings“存储与引用审计”入口首次只audit；用户选择后单独create plan，再对plan要求的scope逐项勾选并异步确认。commit成功后重新audit/status；失败保留原plan和脱敏错误。没有pending authorized Journal时启动/打开设置绝不自动plan/commit；pending Journal只展示其原manifest恢复状态。

若authorized cleanup Journal在bootstrap因新引用/unknown hash进入Blocked，普通Ready Settings不可达，因此`referenceCleanupStatus()`必须是Blocked壳允许的只读命令。`MigrationDialog`/App Blocked分支只显示planId缩写、已确认scope、已完成/剩余item计数、稳定reason code和“恢复被阻止，请保留证据并修复引用/文件状态”的指引；不得提供force、skip、扩大manifest、创建新plan或删除按钮。状态修复后仍由既有`migrationRecover`/bootstrap recovery重新尝试原manifest，不能绕过Ready gate。

- [ ] **Step 4: 运行 Chunk 2 完整门禁和代码简化审查**

Run: `npm run test -- src/api/v2/types.test.ts src/components/dialogs/StorageCleanupDialog.test.tsx src/components/dialogs/SettingsDialog.test.tsx src/components/dialogs/MigrationDialog.test.tsx src/App.test.tsx && npm run typecheck && npm run build && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_recovery_inventory && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_persistent && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_lifecycle && cargo test --manifest-path src-tauri/Cargo.toml --test reference_audit && cargo test --manifest-path src-tauri/Cargo.toml --test reference_cleanup && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部PASS；audit零写、cleanup只在显式确认后执行、跨重启只延续原manifest，所有未知状态稳定Blocked。

使用 `@code-simplifier` 审查dialog状态、client样板和scope确认重复；若修改，重跑本步骤。

```bash
git add src/api/v2/types.ts src/api/v2/types.test.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/test/FakeBackendClient.ts src/components/dialogs/StorageCleanupDialog.tsx src/components/dialogs/StorageCleanupDialog.test.tsx src/components/dialogs/SettingsDialog.tsx src/components/dialogs/SettingsDialog.test.tsx src/components/dialogs/MigrationDialog.tsx src/components/dialogs/MigrationDialog.test.tsx src/App.tsx src/App.test.tsx src/styles/dialogs.css
git commit -m "feat(hardening): 接入存储引用审计与清理确认"
```

- [ ] **Step 5: 完成 Chunk 2 计划评审**

使用 plan-document-reviewer 按设计规格、Phase A-D全部Journal/删除边界和本Chunk复核。必须确认migration、workspace、runtime outcome、event append、LegacyImporter ledger、ContextBridge/switch、rollout/cutover、start claim、`ConversationExecutionTransition`、`SharedServiceRecoveryRequired`、`CodexIdleDrain`、settling、capacity ledger和exit drain均进入matrix；ReferenceAudit以精确roots覆盖Project/tombstone/Conversation/RuntimeSegment/Terminal/SavedWorkspace/GlobalPreferences/ProviderRevision/Model/secretRef/runtime namespace/event/checkpoint/pending JournalArtifact；cleanup具备反向metadata闭包、Prepared先写、metadata stage闭集、same-volume quarantine Move/Purge write-ahead和pre/post-open顺序，永不删除tombstone、项目目录、runtime-fixtures、evidence或历史引用revision/secret，且无自动GC。Issues Found修复并重评，Approved后进入Chunk 3。

## Chunk 3: NSIS 可复现审计、七项证据矩阵与最终门禁

### Task 12: 锁定 full 7-Zip NSIS 工具链并由 Phase D clean artifact 生成版本化预算

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/hardening/full-7z-toolchain-v1.json`
- Create: `scripts/hardening/nsis-toolchain.mjs`
- Create: `scripts/hardening/nsis-audit.mjs`
- Create: `scripts/hardening/nsis-audit.test.mjs`
- Create: `src-tauri/release/nsis-budget-v1.json`

- [ ] **Step 1: 写失败测试固定锁定工具、只解包和预算公式**

新增：

- `nsis_toolchain_requires_exact_7zip_bin_5_2_0_bootstrap_dev_dependency`
- `nsis_toolchain_requires_lock_integrity_registry_tarball_and_no_system_fallback`
- `nsis_toolchain_bootstrap_7za_is_used_only_to_extract_verified_full_7z_sfx`
- `nsis_full_7z_manifest_is_closed_26_02_win_x64_url_bytes_sha_and_required_files`
- `nsis_full_7z_download_is_create_new_https_allowlisted_redirects_and_hash_before_extract`
- `nsis_full_7z_sfx_extracts_only_regular_7z_exe_and_7z_dll_without_execution`
- `nsis_full_7z_hashes_are_recorded_and_reverified_before_every_spawn`
- `nsis_full_7z_information_requires_exact_nsis_format_row`
- `nsis_full_7z_is_the_only_tool_allowed_to_list_or_extract_application_nsis`
- `nsis_toolchain_requires_locked_tauri_cli_2_11_4_direct_file_layout_baseline`
- `nsis_audit_never_executes_downloaded_7z_installer_application_installer_or_payload`
- `nsis_baseline_create_requires_nonexisting_toolchain_budget_and_baseline_extract_roots`
- `nsis_verify_and_release_reuse_existing_toolchain_read_only_and_create_new_run_extract_roots`
- `nsis_toolchain_reuse_never_downloads_bootstraps_or_mutates_baseline_files`
- `nsis_verify_requires_explicit_nonexisting_canonical_run_evidence_root`
- `nsis_verify_rejects_missing_existing_outside_target_or_reparse_run_evidence_root`
- `nsis_verify_failure_preserves_run_evidence_and_never_falls_back_to_temp`
- `nsis_baseline_pointer_requires_absolute_canonical_child_of_target_release_evidence`
- `nsis_baseline_pointer_rejects_reparse_cross_root_extra_fields_and_unknown_schema`
- `nsis_baseline_pointer_source_hash_phase_d_parent_installer_hash_and_bytes_are_self_consistent`
- `nsis_listing_requires_one_outer_archive_record_with_type_nsis`
- `nsis_listing_rejects_absolute_parent_ads_control_character_and_case_fold_duplicate_member_paths`
- `nsis_listing_physical_files_require_unique_decimal_offset_and_directories_are_excluded`
- `nsis_generated_metadata_without_offset_is_frozen_for_present_and_absent_fixtures`
- `nsis_extract_tree_exactly_matches_preflight_normalized_entry_set`
- `nsis_baseline_mutable_app_paths_are_derived_from_main_external_binaries_and_explicit_resources`
- `nsis_baseline_generated_uninstaller_is_exactly_root_uninstall_exe`
- `nsis_baseline_remaining_entries_are_immutable_plugin_or_control`
- `nsis_magic_classifier_detects_pe_sfx_7z_zip_cab_and_ole_msi_without_extensions`
- `nsis_baseline_rejects_archive_magic_and_unapproved_mutable_app_pe`
- `nsis_budget_uses_phase_d_commit_installer_toolchain_and_unpacked_measurements`
- `nsis_budget_maxima_use_integer_ceil_baseline_times_115_over_100`
- `nsis_budget_has_no_update_or_auto_rebaseline_mode`
- `nsis_audit_never_deletes_evidence_on_success_or_failure`

Run: `node --test scripts/hardening/nsis-audit.test.mjs`

Expected: FAIL，锁定解包器、audit模块和budget尚不存在。

- [ ] **Step 2: 安装并验证唯一最小 devDependency**

Run: `npm install --save-dev --save-exact 7zip-bin@5.2.0`

Expected: `package.json`只新增`devDependencies["7zip-bin"]="5.2.0"`；`package-lock.json`中tarball固定`https://registry.npmjs.org/7zip-bin/-/7zip-bin-5.2.0.tgz`、integrity固定`sha512-ukTPVhqG4jNzMro2qA9HSCSSVJN3aN7tlb+hfqYCt3ER0yWroeA2VR38MNrOHLQ/cVj+DaIMad0kFCtWWowh/A==`、license为MIT，且没有新增生产依赖。该package导出的standalone `7za`明确不具备NSIS handler，只能作为已验证官方full 7-Zip SFX的bootstrap extractor；不得用它list/extract应用NSIS。安装前后锁定的`@tauri-apps/cli`仍必须是`2.11.4`；若npm尝试改写版本/元数据，或代码fallback到系统`7z.exe`，立即停止。

- [ ] **Step 3: 实现 bootstrap/full 7-Zip 双层锁定与 reduced NSIS entry 模型**

`scripts/hardening/full-7z-toolchain-v1.json` 必须精确为：

```json
{
  "schemaVersion": 1,
  "product": "7-Zip",
  "version": "26.02",
  "platform": "win-x64",
  "url": "https://www.7-zip.org/a/7z2602-x64.exe",
  "installerBytes": 1657896,
  "installerSha256": "6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0",
  "requiredFiles": ["7z.dll", "7z.exe"]
}
```

`nsis-toolchain.mjs`先闭合解析该manifest并拒绝额外字段。它通过`createRequire(import.meta.url)("7zip-bin").path7za`取得bootstrap binary，realpath后要求位于lock对应package内，并以package-lock tarball/integrity和binary SHA共同锁定；该`7za`只允许执行一次官方7-Zip SFX提取，绝不能接触应用NSIS。任何baseline读取前，`nsis-audit.mjs`仍要求`--baseline-pointer`为绝对canonical `src-tauri/target/release-evidence/`严格子项，对pointer/source/Phase D parent/installer path+bytes+SHA和全路径no-reparse执行Task 1闭合校验，禁止信任自由绝对路径或扫描目录。

工具链只有两种闭合模式。`baseline`创建模式在pointer派生的`baselineRoot`下要求`toolchain/`、`baseline-extract/`和budget目标均不存在，并全部使用create-new语义；下载器先确认首URL逐字等于manifest URL，使用create-new文件句柄流式写入，不覆盖/续传。redirect只允许HTTPS、最多3跳：首host固定`www.7-zip.org`，后续host闭合为`github.com`或`release-assets.githubusercontent.com`，禁止凭据转发、HTTP降级和其他host；最终内容仍只以manifest bytes+SHA-256为信任根。校验完成后才允许hash-verified bootstrap `7za`仅把`7z.exe`与`7z.dll`解到此前不存在的`toolchain/full-7z/`。随后逐级lstat/no-reparse，要求regular-file集合恰好为这两个case-insensitive唯一文件且没有额外regular file；记录二者SHA-256。下载的`7z2602-x64.exe`绝不执行。

`verify-budget`与`release:audit`复用模式则要求上述baseline toolchain和budget已经存在且闭合，只读打开manifest、下载SFX、`7z.exe`、`7z.dll`、budget与baseline记录，逐项重验bytes/SHA-256、目录全集、no-reparse和pointer绑定；该模式禁止网络、redirect、bootstrap `7za`、重下载、覆盖、修复或写入baselineRoot。每次list/extract都必须通过显式`--run-evidence-root`/`--evidence-root`接收调用方提供、此前不存在、canonical位于`src-tauri/target/release-evidence/`且全链no-reparse的严格子目录；缺参、已存在、越界或reparse在任何tool spawn前FAIL，禁止自行选temp、扫描目录或回退baselineRoot。工具只在该root内create-new独立extract/report，失败也不得回写或删除baseline证据与run evidence。此后唯一允许的audit executable是每次spawn前重新匹配记录hash的full `7z.exe`，且同目录`7z.dll`也必须重新匹配hash；禁止系统PATH/registry fallback。

先运行full `7z.exe i`，以闭合列解析器要求Formats表存在Name逐字为`Nsis`的唯一row；未列出NSIS时在读取应用installer前FAIL。只有该full 7z可参数化执行`l -slt -sccUTF-8 <app-installer>`和一次`x -bd -bb0 -o<extractDir> <app-installer>`；不得执行应用installer、main exe、sidecar或任意payload。list的唯一archive-level block必须有唯一`Type = Nsis`。payload path做Unicode NFC、`\`转`/`，拒绝控制字符、absolute/drive/UNC/device path、空/`.`/`..`segment、ADS、尾随空格/点和case-fold duplicate。directory record只验证路径后排除；正常physical file必须有唯一、可闭合解析的十进制`Offset`，无`Offset`但由full 7z报告为regular generated record的条目单独归类，其他缺失/重复/非十进制Offset均FAIL。extract后逐级lstat并要求regular-file集合与physical+generated record集合一一相等；不得递归列举或解包member。测试fixture必须同时覆盖full 7z输出存在和不存在synthetic generated metadata两种情况，不能按`[NSIS].nsi`名称硬编码。

full 7-Zip 26.02的NSIS handler对physical payload使用reduced paths，禁止假设synthetic `$INSTDIR/`前缀，也不要求或排斥任何特定generated metadata文件名。Phase D baseline entry按闭合模型分区：

- `mutableAppPaths`：从锁定`tauri.conf.json`的main binary、external binaries和无glob显式resources按Tauri 2.11.4映射规则确定性派生；至少包含`tht-panel.exe`和`tht-panel-pty-host.exe`，每项记录`path/role/magic/policy`，不锁应用内容hash。
- `generatedUninstallerPaths`：精确且唯一为`uninstall.exe`，记录`role=uninstaller`与baseline magic，不锁内容hash。
- `generatedMetadataEntries`：仅包含list中无Offset的regular generated record，冻结排序后的`path/role/magic`集合，final必须集合完全相同但不锁内容hash；空集合合法。
- `immutableBaselineEntries`：baseline其余全部entry；`$PLUGINSDIR/`前缀role为`plugin`，其余role为`control`，逐项锁定`path/role/bytes/sha256/magic`。

四类path必须排序、case-fold全局互斥且并集精确等于baseline regular-file集合；未知entry不能自动归入mutable/generated。magic classifier仍按bytes闭合为`Data/PeOrSfx/SevenZip/Zip/Cab/OleMsi`，不信任扩展名；main/external binary必须为`PeOrSfx`，resource遵守artifact policy，uninstaller与generated metadata final magic必须等于baseline，immutable final bytes/hash/magic必须逐项一致。任何不被policy允许的archive magic或未列名PE/SFX均FAIL。

- [ ] **Step 4: 显式传入 Task 1 唯一 pointer 并生成不可自动更新的 budget v1**

Run:

```powershell
$baselinePointer = (Read-Host '粘贴Task 1精确PHASE_D_BASELINE_POINTER绝对路径').Trim()
if ([string]::IsNullOrWhiteSpace($baselinePointer)) { throw 'exact Phase D baseline pointer is required' }
if (-not (Test-Path -LiteralPath $baselinePointer -PathType Leaf)) { throw 'Phase D baseline pointer is missing' }
node scripts/hardening/nsis-audit.mjs baseline --baseline-pointer $baselinePointer --toolchain-manifest scripts/hardening/full-7z-toolchain-v1.json --write-budget src-tauri/release/nsis-budget-v1.json
```

Expected: audit只接受人工粘贴的该精确GUID pointer，在网络或tool spawn前完成canonical/no-reparse/closed-schema/source-hash/Phase-D-parent/installer hash+bytes自洽校验；不写process env、不扫描`release-evidence`猜最新目录。随后仅在本次`baseline`创建模式中于baselineRoot内create-new下载并验证full 7-Zip 26.02，bootstrap只解出两个锁定tool file，full `7z i`确认`Nsis`，再生成`baseline-extract/`。budget包含`schemaVersion=1`、Phase D commit、installer/toolchain/bootstrap/full-tool hashes与bytes、`outerType="Nsis"`、排序互斥的`mutableAppPaths/generatedUninstallerPaths/generatedMetadataEntries/immutableBaselineEntries`和公式`ceil(bytes*115/100)`；实现用BigInt整数公式`(bytes*115+99)/100`。本创建模式发现toolchain、budget目标或baseline extract任一已存在即FAIL且不覆盖；没有`--update-budget`，失败保留全部证据。后续重验不得再次进入创建模式。

- [ ] **Step 5: 运行toolchain测试、代码简化审查并提交**

本Step与Step 4保持同一PowerShell会话并沿用人工核对的`$baselinePointer`；若会话中断，必须重新粘贴精确pointer并先重验canonical/no-reparse，禁止从env或目录扫描恢复。

Run:

```powershell
$targetRoot = (Resolve-Path 'src-tauri\target').Path
$verifyEvidence = Join-Path $targetRoot ('release-evidence\phase-e-budget-verify-' + [guid]::NewGuid())
if (Test-Path -LiteralPath $verifyEvidence) { throw 'unique budget verify evidence already exists' }
node --test scripts/hardening/nsis-audit.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'NSIS audit tests failed' }
node scripts/hardening/nsis-audit.mjs verify-budget --budget src-tauri/release/nsis-budget-v1.json --baseline-pointer $baselinePointer --toolchain-manifest scripts/hardening/full-7z-toolchain-v1.json --run-evidence-root $verifyEvidence
if ($LASTEXITCODE -ne 0) { throw 'NSIS budget verification failed' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'TypeScript typecheck failed after NSIS verification' }
```

Expected: PASS；`verify-budget`只读复用既有baseline toolchain/budget，零网络、零bootstrap、零baseline写入，只在显式、此前不存在的`$verifyEvidence`内create-new extract/report并保留证据；budget两项上限精确等于Phase D clean baseline的ceil×1.15。bootstrap integrity、full 7-Zip installer常量、`7z.exe`/`7z.dll` hashes、`Nsis` format、outer type、physical Offset/generated metadata语义、reduced四类entry集合、immutable hashes和magic/policy门禁均可复核，baseline/toolchain/extract evidence仍保留。

使用 `@code-simplifier` 审查BigInt公式、spawn参数和路径guard；若修改，重跑本步骤。

```bash
git add package.json package-lock.json scripts/hardening/full-7z-toolchain-v1.json scripts/hardening/nsis-toolchain.mjs scripts/hardening/nsis-audit.mjs scripts/hardening/nsis-audit.test.mjs src-tauri/release/nsis-budget-v1.json
git commit -m "build(hardening): 锁定NSIS解包与发布预算"
```

### Task 13: 加入非敏感 bundle sentinel 并审计最终 NSIS 内容

**Files:**
- Create: `src-tauri/release/bundle-sentinel.json`
- Create: `scripts/hardening/artifact-policy.json`
- Create: `scripts/hardening/release-build.mjs`
- Create: `scripts/hardening/release-build.test.mjs`
- Modify: `scripts/hardening/nsis-audit.mjs`
- Modify: `scripts/hardening/nsis-audit.test.mjs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试固定 sentinel、唯一 target 和禁止 artifact**

新增：

- `bundle_sentinel_contains_only_schema_product_and_identifier`
- `tauri_bundle_resources_contains_exact_sentinel_without_glob`
- `release_build_requires_nonexisting_evidence_root_under_src_tauri_target`
- `release_build_requires_explicit_verified_phase_d_pointer_and_never_scans_evidence`
- `release_build_sets_unique_cargo_target_dir_and_never_reads_old_bundle_output`
- `release_build_sets_path_remap_for_workspace_and_user_profile_without_logging_values`
- `release_audit_requires_exactly_one_nsis_installer_main_exe_sidecar_and_sentinel`
- `release_audit_requires_hash_verified_full_7z_with_nsis_format`
- `release_audit_requires_outer_type_nsis_and_exact_reduced_baseline_path_set_plus_sentinel`
- `release_audit_mutable_app_paths_keep_derived_role_magic_and_policy`
- `release_audit_generated_uninstaller_is_exactly_root_uninstall_exe_with_same_magic`
- `release_audit_generated_metadata_path_role_magic_set_equals_baseline_with_or_without_entries`
- `release_audit_immutable_plugin_and_control_hashes_match_phase_d_baseline`
- `release_audit_allows_pe_sfx_only_for_derived_mutable_or_baseline_roles`
- `release_audit_rejects_renamed_7z_zip_cab_ole_msi_and_unlisted_pe_payloads_by_magic`
- `release_audit_verifies_installer_sha256_size_and_unpacked_size_budget`
- `release_audit_rejects_pdb_env_jsonl_raw_capture_smoke_journal_secret_blob_and_user_path`
- `release_audit_scans_utf8_and_utf16le_workspace_user_and_known_secret_canaries`
- `release_audit_reports_labels_and_relative_payload_paths_not_forbidden_values`
- `release_audit_failure_preserves_all_build_and_extract_evidence`

Run: `node --test scripts/hardening/release-build.test.mjs scripts/hardening/nsis-audit.test.mjs`

Expected: FAIL，sentinel/resource、唯一build wrapper和artifact policy尚不存在。

- [ ] **Step 2: 创建最小 sentinel 和闭合 artifact policy**

`src-tauri/release/bundle-sentinel.json` 精确为：

```json
{
  "schemaVersion": 1,
  "productName": "tht-panel",
  "identifier": "com.tht.panel"
}
```

不得加入commit、用户、路径、时间、secret、provider、model或环境信息。`tauri.conf.json.bundle.resources` 只显式加入`release/bundle-sentinel.json`，不用目录glob。

`artifact-policy.json` 闭合禁止payload path/extension：`.pdb`、`.env`/`.env.*`、`.jsonl`、`runtime-fixture-capture`、`raw-capture`、`conversation-events`、`runtime-outcomes`、任何`*-journal*`、`phase-*-smoke`、`release-evidence`、secret blob目录。内容canary包括仓库测试使用的fixture secret标签；当前workspace/USERPROFILE由wrapper在内存生成UTF-8/UTF-16LE needle，不写policy/report。build过程不得打开SecretStore或真实应用config，因此审计边界是“已知canary+当前路径+禁止artifact”，不能声称扫描了未知生产secret值。

- [ ] **Step 3: 实现唯一 release build wrapper 和路径重映射**

`release-build.mjs --evidence-root $releaseEvidence --baseline-pointer $phaseDBaselinePointer` 要求evidence root canonical位于`src-tauri/target/release-evidence/`且此前不存在，并以Task 12的只读复用模式完成pointer/source/parent/toolchain/budget hash验证；只接受root coordinator交接或本Step `Read-Host`粘贴的精确pointer，禁止读取process env或扫描目录。该模式禁止网络、bootstrap和任何baselineRoot写入，只在新`$releaseEvidence`内create-new本轮extract/report。创建evidence后设置：

- `CARGO_TARGET_DIR=$releaseEvidence/cargo-target`
- `CARGO_ENCODED_RUSTFLAGS` 增加workspace和USERPROFILE的`--remap-path-prefix`及release `debuginfo=0`，不打印from值。
- 调用当前lock的`npm run tauri -- build`，随后只在该target内定位恰好一个`bundle/nsis/*.exe`。

wrapper不得删除旧target、搜寻默认`src-tauri/target/release`或自动重试到其他目录。构建失败保留evidence root并输出逻辑阶段。

- [ ] **Step 4: 实现 reduced NSIS 四类闭合、sentinel、预算与内容扫描**

final audit每次spawn前重验baseline budget记录的`7z.exe`/`7z.dll` hash并重新确认`7z i`的`Nsis` format；随后再次通过唯一archive-level `Type = Nsis`、同一path规范化、Offset/generated语义、no-reparse与list/extract regular-file一一映射检查。不得按名称要求或禁止synthetic metadata，只能以有无Offset和baseline `generatedMetadataEntries`闭合集合判断；physical payload不得依赖synthetic `$INSTDIR/`前缀。

final规范化path全集必须精确等于Phase D baseline全集加唯一`release/bundle-sentinel.json`。`mutableAppPaths`仍由当前锁定Tauri配置确定性派生：`tht-panel.exe`、`tht-panel-pty-host.exe`及全部显式resources保持path/role/magic/policy，唯一新增resource是sentinel且内容逐字匹配tracked文件；`generatedUninstallerPaths`仍精确为一个根级`uninstall.exe`并保持role/magic；无Offset的`generatedMetadataEntries`无论为空或非空都必须与baseline的path/role/magic集合完全相同；所有`immutableBaselineEntries`的path/role/bytes/SHA-256/magic逐项等于baseline，其中`$PLUGINSDIR/`仍是plugin，其余是control。任何新增/缺失/改类/case-fold duplicate、未列名PE/SFX或policy禁止的SevenZip/Zip/Cab/OleMsi均FAIL且不递归解包。installer和extract tree unpacked bytes分别不能超过budget；`release-report.json`至少记录`fullToolHashes/nsisFormat/outerType/pathSetClosure/mutablePolicy/generatedUninstaller/generatedMetadata/immutableHashes/magicPolicy` PASS及规范化相对path/hash，不记录本机绝对路径。

扫描installer本体和`install-tree/`全部regular files的UTF-8/UTF-16LE内容及规范化相对extract path；命中只输出policy label、相对extract path和hash前缀，不打印needle。不得执行installer或任何解包文件验证安装行为；不得自动删除任何evidence/extract目录。

- [ ] **Step 5: 运行最终唯一target发布审计、简化并提交**

`package.json` 增加：

```json
{
  "scripts": {
    "release:audit": "node scripts/hardening/release-build.mjs"
  }
}
```

Run:

```powershell
$targetRoot = (Resolve-Path 'src-tauri\target').Path
$budgetVerifyEvidence = Join-Path $targetRoot ('release-evidence\phase-e-budget-recheck-' + [guid]::NewGuid())
if (Test-Path -LiteralPath $budgetVerifyEvidence) { throw 'unique budget recheck evidence already exists' }
$releaseEvidence = Join-Path $targetRoot ('release-evidence\phase-e-' + [guid]::NewGuid())
if (Test-Path -LiteralPath $releaseEvidence) { throw 'unique Phase E release evidence already exists' }
$phaseDBaselinePointer = (Read-Host '粘贴Task 1精确PHASE_D_BASELINE_POINTER绝对路径').Trim()
if ([string]::IsNullOrWhiteSpace($phaseDBaselinePointer)) { throw 'exact Phase D baseline pointer is required' }
if (-not (Test-Path -LiteralPath $phaseDBaselinePointer -PathType Leaf)) { throw 'Phase D baseline pointer is missing' }
node --test scripts/hardening/release-build.test.mjs scripts/hardening/nsis-audit.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'NSIS closure tests failed' }
node scripts/hardening/nsis-audit.mjs verify-budget --budget src-tauri/release/nsis-budget-v1.json --baseline-pointer $phaseDBaselinePointer --toolchain-manifest scripts/hardening/full-7z-toolchain-v1.json --run-evidence-root $budgetVerifyEvidence
if ($LASTEXITCODE -ne 0) { throw 'Phase D NSIS budget closure failed' }
npm run release:audit -- --evidence-root $releaseEvidence --baseline-pointer $phaseDBaselinePointer
if ($LASTEXITCODE -ne 0) { throw 'final NSIS release audit failed' }
```

Expected: PASS；先以只读复用模式在独立`$budgetVerifyEvidence`中通过toolchain/NSIS closure tests和Phase D budget重验，过程零网络、零bootstrap、零baseline修改；该root创建后保留，`$releaseEvidence`在调用release wrapper前仍不存在。随后只使用`$releaseEvidence/cargo-target`构建并在该新evidence root内create-new extract。hash-verified full 7-Zip单次列举/解包且未执行任何installer或payload。report记录full tool hashes、`Nsis` format、`Type = Nsis`、installer/unpacked预算、physical/generated语义、reduced四类闭集、baseline path加唯一sentinel及main/sidecar/uninstaller PASS；artifact/user-path/known-secret和magic伪装扫描零命中。两份证据目录均保留。

使用 `@code-simplifier` 审查build env、单次NSIS extract、递归regular-file遍历和binary magic classifier；若修改，重跑Node tests、baseline verify-budget与本步骤完整audit。

```bash
git add src-tauri/release/bundle-sentinel.json scripts/hardening/artifact-policy.json scripts/hardening/release-build.mjs scripts/hardening/release-build.test.mjs scripts/hardening/nsis-audit.mjs scripts/hardening/nsis-audit.test.mjs src-tauri/tauri.conf.json package.json
git commit -m "build(hardening): 审计NSIS最终载荷"
```

### Task 14: 建立七项需求的源码/自动化/手工/真实 CLI 证据矩阵

**Files:**
- Create: `scripts/hardening/acceptance-matrix.mjs`
- Create: `scripts/hardening/acceptance-matrix.test.mjs`
- Create: `docs/verification/final-acceptance.json`
- Create: `docs/verification/final-acceptance.md`
- Create: `docs/verification/phase-e-real-cli.json`
- Modify: `package.json`
- Modify: `scripts/cli-smoke.mjs`
- Modify: `src-tauri/src/runtime/smoke.rs`
- Modify: `src-tauri/src/bin/tht_panel_runtime_smoke.rs`
- Modify: `src-tauri/tests/runtime_cli_smoke_contract.rs`

- [ ] **Step 1: 写失败 validator 测试固定七项、四类证据和 PASS/SKIP/FAIL**

新增：

- `acceptance_matrix_requires_exact_requirements_one_through_seven`
- `acceptance_matrix_each_row_requires_source_automation_manual_real_cli_and_boundaries`
- `acceptance_matrix_rejects_unknown_status_or_missing_command_hash`
- `acceptance_matrix_fail_in_any_mandatory_dimension_makes_row_fail`
- `acceptance_matrix_cli_skip_cannot_mark_native_requirement_pass`
- `acceptance_matrix_requirements_five_six_seven_require_authorized_real_cli_pass`
- `acceptance_matrix_requirements_one_to_four_record_cli_boundary_even_when_not_runtime_proof`
- `acceptance_matrix_real_cli_schema_requires_driver_model_two_distinct_provider_hashes_root_consent_cases_report_and_runtime_commit`
- `acceptance_matrix_two_provider_isolation_requires_same_driver_same_model_two_provider_hashes`
- `acceptance_matrix_real_cli_report_reference_must_be_repo_relative_existing_and_hash_matching`
- `phase_e_real_cli_report_pending_fixture_is_safe_tracked_skip`
- `acceptance_matrix_sanitize_real_cli_hashes_ids_and_rejects_sensitive_or_extra_fields`
- `acceptance_matrix_apply_real_cli_updates_only_requirements_five_to_seven_from_safe_report`
- `acceptance_matrix_contains_no_secret_full_path_model_output_or_native_session_id`
- `acceptance_markdown_is_deterministically_rendered_from_json`
- `cli_smoke_provider_list_requires_existing_canonical_target_descendant_and_never_reads_secret`
- `cli_smoke_runtime_rejects_root_outside_target_default_config_home_repo_or_reparse`
- `acceptance_matrix_real_cli_attempt_uses_unique_root_and_consent_labels`
- `cli_smoke_provider_setup_uses_isolated_config_env_and_clears_all_four_values`
- `cli_smoke_failure_preserves_evidence_and_wrapper_logs_no_control_env_values`

Run: `node --test scripts/hardening/acceptance-matrix.test.mjs`

Expected: FAIL，validator和证据文件尚不存在。

- [ ] **Step 2: 定义结构化矩阵和推导规则**

`final-acceptance.json` 每行按以下闭合结构校验：

```ts
type EvidenceStatus = "PASS" | "SKIP" | "FAIL";

interface AcceptanceRequirement {
  id: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  title: string;
  status: EvidenceStatus;
  sourceEvidence: Array<{ path: string; symbol: string }>;
  automationEvidence: Array<{ command: string; exitCode: number; reportSha256: string }>;
  manualEvidence: Array<{ caseId: string; status: EvidenceStatus; evidenceLabel: string }>;
  realCliEvidence: {
    status: EvidenceStatus;
    requiredForPass: boolean;
    reasonCode: string;
    driver: string | null;
    modelName: string | null;
    providerIdHashes: [] | [string, string];
    rootLabel: string | null;
    consentLabel: string | null;
    caseIds: string[];
    reportRelativePath: string | null;
    reportSha256: string | null;
    runtimeScopeCommit: string | null;
  };
  boundaries: string[];
}
```

1-7标题依次为菜单、保存/恢复工作区、窗口换位、多供应商配置、会话供应商切换、同modelName多供应商隔离、原生AI工作区+纯终端。每项都必须填写非空源码、自动化、手工、真实CLI说明与边界；1-4的CLI字段固定可`SKIP(NOT_RUNTIME_PROOF)`，其driver/model/provider hashes/root/consent/report/runtime commit为空且不作为PASS依据。Task 14创建时5-7也只能`SKIP(PENDING_FINAL_AUTHORIZED_RUN)`，不得伪造PASS；Task 15最终授权run后，5-7必须由同一safe report验证同driver、同model、两个不同providerIdHash、唯一rootLabel/consentLabel、必需case全部PASS、report hash与`runtimeScopeCommit`，才能总体PASS。

source paths必须repo-relative且存在；automation记录命令、exit code、evidence report SHA-256；manual只记录脱敏case/截图文件名。`reportRelativePath`只能是`docs/verification/phase-e-real-cli.json`，validator重算其SHA-256；safe report和矩阵均不得记录full UUID、绝对config root、secret/baseUrl、模型/工具输出、native session/thread ID或用户对话。

- [ ] **Step 3: 实现 provider-list、sanitized report contract 与初始 SKIP 证据**

Task 14只实现和测试runner，不运行任何`--runtime`、连接测试、keepAlive tick或可能计费模型请求。新增的无费用只读`--list-test-providers`复用Phase D provider repository，只输出显示名、canonical stable UUID、revision、driver和model显示名供Task 15人工选择；不得读取/输出secret或baseUrl，不启动adapter。`--report-json`实现闭合raw report；`acceptance-matrix.mjs sanitize-real-cli`负责raw→safe投影，只接受case ID、driver、modelName、两个provider UUID、root/consent label、PASS/SKIP/FAIL和runtime scope commit，写tracked safe report时把UUID转换为两个不同lowercase SHA-256 hash，拒绝full UUID、绝对路径、secret、正文、native ID和额外字段。`apply-real-cli`只从已验证safe report原子更新requirements 5-7，不得改1-4或源码/手工证据。

`docs/verification/phase-e-real-cli.json`在本任务只创建安全初始状态：

```json
{
  "schemaVersion": 1,
  "status": "SKIP",
  "reasonCode": "PENDING_FINAL_AUTHORIZED_RUN",
  "driver": null,
  "modelName": null,
  "providerIdHashes": [],
  "rootLabel": null,
  "consentLabel": null,
  "caseIds": [],
  "rawReportSha256": null,
  "runtimeScopeCommit": null
}
```

validator要求该tracked report strict UTF-8无BOM、closed schema且不自含绝对raw report path。Task 15最终真实run后才可将其原子改写为PASS/SKIP/FAIL；`final-acceptance.json`的`reportRelativePath`指向该tracked safe report并记录其外部SHA-256。Task 14所有fixture使用假UUID/FakeProcessHost，不能连接真实provider或生成费用。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_cli_smoke_contract && node --test scripts/hardening/acceptance-matrix.test.mjs`

Expected: PASS；provider-list/report sanitizer/acceptance schema离线测试执行，safe report为PENDING SKIP，未启动任何真实CLI runtime或adapter。

- [ ] **Step 4: 收集七项源码、自动化和手工证据**

逐项运行/引用最新Phase A-E离线测试和手工smoke；源码证据至少指向直接实现与直接测试，不用计划文档替代。手工矩阵覆盖：项目→会话菜单、SavedWorkspace重启恢复、同父/跨父/空pane拖动和键盘换位、Provider新增/复制/编辑/禁用、ContextBridge可见切换、NativeConversationPane/legacy compatibility/TerminalSession单sink、托盘与退出。双Provider真实并发隔离只留作Task 15待授权CLI证据，本任务不得执行。

手工故障边界只引用FakeProcessHost/故障注入自动化，不通过破坏真实配置、修改权限、杀真实进程或删除文件制造。所有evidence log计算SHA-256并保留在ignored evidence root，文档只记录标签/hash。

- [ ] **Step 5: 生成/校验矩阵、代码简化审查并提交**

`package.json` 增加：

```json
{
  "scripts": {
    "verify:acceptance": "node scripts/hardening/acceptance-matrix.mjs --input docs/verification/final-acceptance.json --output docs/verification/final-acceptance.md"
  }
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_cli_smoke_contract && node --test scripts/hardening/acceptance-matrix.test.mjs && npm run verify:acceptance`

Expected: PASS；JSON恰好7项，Markdown由JSON确定性生成；1-4记录`NOT_RUNTIME_PROOF`，5-7固定`PENDING_FINAL_AUTHORIZED_RUN` SKIP且对应row非PASS，Phase E明确未完成。本任务没有真实CLI费用或runtime证据。

使用 `@code-simplifier` 审查runner report、validator和Markdown renderer；若修改，重跑本步骤。

```bash
git add scripts/hardening/acceptance-matrix.mjs scripts/hardening/acceptance-matrix.test.mjs docs/verification/final-acceptance.json docs/verification/final-acceptance.md docs/verification/phase-e-real-cli.json package.json scripts/cli-smoke.mjs src-tauri/src/runtime/smoke.rs src-tauri/src/bin/tht_panel_runtime_smoke.rs src-tauri/tests/runtime_cli_smoke_contract.rs
git commit -m "test(hardening): 建立七项最终验收矩阵"
```

### Task 15: 运行完整 npm/cargo/Tauri/NSIS 门禁并完成 Phase E 证据

**Files:**
- Create: `scripts/hardening/repo-audit.mjs`
- Create: `scripts/hardening/repo-audit.test.mjs`
- Modify: `package.json`
- Create: `docs/verification/phase-e-hardening.md`
- Modify: `docs/verification/final-acceptance.json`
- Modify: `docs/verification/final-acceptance.md`
- Modify: `docs/verification/phase-e-real-cli.json`
- Verify only: all Phase E files and Phase A-D regression surfaces

- [ ] **Step 1: 写失败测试固定UTF-8无BOM、Markdown fence、未完成标记和Git范围审计**

新增：

- `repo_audit_accepts_only_strict_utf8_without_bom_for_changed_text_files`
- `repo_audit_rejects_unclosed_or_mismatched_markdown_fences`
- `repo_audit_rejects_unfinished_markers_in_phase_e_and_final_verification_docs`
- `repo_audit_rejects_generated_target_dist_node_modules_capture_smoke_and_evidence_files`
- `repo_audit_reports_relative_path_and_rule_not_file_content`
- `repo_audit_uses_phase_e_first_commit_parent_as_scope_base`
- `repo_audit_rejects_committed_range_deletion_and_rename_from_name_status`

Run: `node --test scripts/hardening/repo-audit.test.mjs`

Expected: FAIL，repo audit尚不存在。

- [ ] **Step 2: 实现只读repo audit并运行最终代码简化**

`repo-audit.mjs` 从首个Phase E commit `test(hardening): 固定确定性预算与Phase D基线` 的父提交计算范围；用`git diff --name-status --find-renames "$phaseEBase..HEAD"`解析committed range并显式拒绝任何`D`或`R*`，不能用name-only推断。随后只检查range及尚未提交最终verification中的文本扩展名为strict UTF-8无BOM，解析Markdown fence stack，扫描未完成标记词（脚本用分段字符串组成规则，避免规则文本自命中），拒绝生成/证据目录进入Git。错误只输出relative path/rule/line，不打印敏感行内容；脚本零写入。

本步骤同时把Step 3所需的`test:hardening` script写入`package.json`。先运行focused test，再使用`@code-simplifier`只审查repo-audit parser/rule/fixture复用；若修改，重跑focused test。随后在删除/移动检查与精确cached scope复核后先提交该独立代码任务：

```powershell
node --test scripts/hardening/repo-audit.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'repo audit focused test failed' }
$repoAuditFiles = @('scripts/hardening/repo-audit.mjs','scripts/hardening/repo-audit.test.mjs','package.json')
$preRepoAuditStaged = @(git diff --cached --name-only)
if ($preRepoAuditStaged.Count -gt 0) { $preRepoAuditStaged; throw 'index must be empty before staging repo audit task' }
$deleted = @(git diff --diff-filter=D --name-only) + @(git diff --cached --diff-filter=D --name-only)
$renamed = @(git diff --diff-filter=R --name-only) + @(git diff --cached --diff-filter=R --name-only)
if ($deleted.Count -gt 0 -or $renamed.Count -gt 0) { $deleted; $renamed; throw 'repo audit task contains unauthorized deletion or move' }
git diff --check -- $repoAuditFiles
if ($LASTEXITCODE -ne 0) { throw 'repo audit diff check failed' }
git add -- $repoAuditFiles
if ($LASTEXITCODE -ne 0) { throw 'failed to stage exact repo audit files' }
$cachedDeleted = @(git diff --cached --diff-filter=D --name-only)
$cachedRenamed = @(git diff --cached --diff-filter=R --name-only)
$cachedFiles = @(git diff --cached --name-only | Sort-Object -Unique)
$scopeMismatch = @(Compare-Object -ReferenceObject ($repoAuditFiles | Sort-Object -Unique) -DifferenceObject $cachedFiles)
if ($cachedDeleted.Count -gt 0 -or $cachedRenamed.Count -gt 0 -or $scopeMismatch.Count -gt 0) { $cachedDeleted; $cachedRenamed; $scopeMismatch; throw 'repo audit cached scope mismatch' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'repo audit cached diff check failed' }
git commit -m "test(hardening): 增加仓库范围审计"
if ($LASTEXITCODE -ne 0) { throw 'repo audit commit failed' }
```

完成该提交后，最终全Phase E simplifier必须从干净代码scope开始。以下命令与最终`@code-simplifier`在同一PowerShell会话执行：

```powershell
$phaseECodeScope = @('src','src-tauri/src','src-tauri/tests','scripts','package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','src-tauri/capabilities')
$preDeleted = @(git diff --diff-filter=D --name-only) + @(git diff --cached --diff-filter=D --name-only)
$preRenamed = @(git diff --diff-filter=R --name-only) + @(git diff --cached --diff-filter=R --name-only)
$preStaged = @(git diff --cached --name-only)
$preScopeStatus = @(git status --porcelain --untracked-files=all -- $phaseECodeScope)
if ($preDeleted.Count -gt 0 -or $preRenamed.Count -gt 0 -or $preStaged.Count -gt 0 -or $preScopeStatus.Count -gt 0) {
  $preDeleted
  $preRenamed
  $preStaged
  $preScopeStatus
  throw 'final code-simplifier requires a clean Phase E code scope'
}
```

使用 `@code-simplifier` 对Phase E最近修改的Rust/TypeScript/Node代码做最终行为保持审查；不得修改verification结论、生成证据或提议删除。完成后立即执行：

```powershell
$postDeleted = @(git diff --diff-filter=D --name-only) + @(git diff --cached --diff-filter=D --name-only)
$postRenamed = @(git diff --diff-filter=R --name-only) + @(git diff --cached --diff-filter=R --name-only)
$postUntracked = @(git ls-files --others --exclude-standard -- $phaseECodeScope)
$postStaged = @(git diff --cached --name-only)
if ($postDeleted.Count -gt 0 -or $postRenamed.Count -gt 0 -or $postUntracked.Count -gt 0 -or $postStaged.Count -gt 0) {
  $postDeleted
  $postRenamed
  $postUntracked
  $postStaged
  throw 'code-simplifier proposed deletion move untracked or staged file; stop for explicit user approval'
}
$phaseECodeFiles = @(git diff --diff-filter=ACMTUXB --name-only -- $phaseECodeScope | Sort-Object -Unique)
$allTrackedChanges = @(git diff --name-only | Sort-Object -Unique)
$unexpectedTracked = @(Compare-Object -ReferenceObject $phaseECodeFiles -DifferenceObject $allTrackedChanges | Where-Object { $_.SideIndicator -eq '=>' } | ForEach-Object { $_.InputObject })
if ($unexpectedTracked.Count -gt 0) { $unexpectedTracked; throw 'code-simplifier changed files outside exact Phase E code scope' }
if ($phaseECodeFiles.Count -eq 0) {
  Write-Output 'SKIP refactor commit: code-simplifier changed no code/config/dependency files'
} else {
  $phaseECodeFiles
}
```

Expected: repo-audit独立任务已在focused test和自身simplifier后按三文件精确提交；最终simplifier开始前Phase E代码scope干净。最终审查后无tracked deletion、rename、untracked或scope外修改；若`$phaseECodeFiles`为空，明确SKIP独立refactor提交并继续Steps 3-11，不报错、不创建空提交；若非空，先记录精确清单，Steps 3-5必须同时作为聚焦+完整门禁，Step 6再精确暂存/提交。

- [ ] **Step 3: 运行完整前端与Node门禁**

Step 2 已在`package.json`增加：

```json
{
  "scripts": {
    "test:hardening": "npm run test:hardening:security && node --test scripts/hardening/nsis-audit.test.mjs scripts/hardening/release-build.test.mjs scripts/hardening/acceptance-matrix.test.mjs scripts/hardening/repo-audit.test.mjs"
  }
}
```

Run: `npm ci && npm run test:hardening && npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部PASS；无skipped/focused test、act warning、unhandled rejection或DOM/队列/I/O budget超限。本步骤不把Task 14较早生成的acceptance Markdown当最终证据；最终矩阵必须等Steps 4-5产生最新Rust/恢复/NSIS证据且Step 7完成最终授权CLI后，在Step 8更新并重新验证。

- [ ] **Step 4: 运行完整Rust与恢复/安全聚焦门禁**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部PASS；Windows DPAPI/Job/NSIS相关非目标平台skip规则保持既有边界，在目标Windows上hardening、journal matrix、reference audit/cleanup、CSP/capability和runtime测试全部实际执行。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_persistent -- --nocapture && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_crash_matrix_lifecycle -- --nocapture && cargo test --manifest-path src-tauri/Cargo.toml --test reference_cleanup -- --nocapture && cargo test --manifest-path src-tauri/Cargo.toml --test hardening_redaction -- --nocapture`

Expected: 聚焦门禁PASS；输出只含caseId/logical kind/stable error，不含路径、secret、event正文或模型输出。

- [ ] **Step 5: 用新唯一 target 重跑 Tauri build 与 NSIS audit**

Run:

```powershell
$targetRoot = (Resolve-Path 'src-tauri\target').Path
$finalEvidence = Join-Path $targetRoot ('release-evidence\phase-e-final-' + [guid]::NewGuid())
if (Test-Path -LiteralPath $finalEvidence) { throw 'unique final evidence root already exists' }
$phaseDBaselinePointer = (Read-Host '粘贴Task 1精确PHASE_D_BASELINE_POINTER绝对路径').Trim()
if ([string]::IsNullOrWhiteSpace($phaseDBaselinePointer)) { throw 'exact Phase D baseline pointer is required' }
if (-not (Test-Path -LiteralPath $phaseDBaselinePointer -PathType Leaf)) { throw 'Phase D baseline pointer is missing' }
npm run release:audit -- --evidence-root $finalEvidence --baseline-pointer $phaseDBaselinePointer
```

Expected: Tauri/NSIS build PASS；Task 12 baseline toolchain/budget仅只读复用且逐项重验，零网络、零bootstrap、零baseline修改，本轮extract只在新`$finalEvidence`内create-new。唯一`CARGO_TARGET_DIR`内恰好一个installer，hash-verified full 7-Zip报告`Nsis`与外层`Type = Nsis`；physical Offset/generated metadata语义、`mutableAppPaths/generatedUninstallerPaths/generatedMetadataEntries/immutableBaselineEntries`等于Phase D baseline加唯一sentinel，immutable hashes与magic/policy一致，installer/unpacked预算PASS；magic扫描无未列名PE/SFX或7z/ZIP/CAB/OLE-MSI嵌套payload，`.pdb/.env/.jsonl/raw capture/secret canary/user path`扫描零命中。不得执行installer、payload或删除evidence。

执行者必须在Steps 5、7-10保持同一PowerShell会话并保留本次精确`$finalEvidence`与`$phaseDBaselinePointer`；禁止写长期env、扫描`release-evidence`目录、按时间选择或猜测“最新”report。若会话中断，必须从已打印并人工核对的精确值重新绑定local变量，先重验canonical/no-reparse/hash，不能自动挑选其他目录。

- [ ] **Step 6: 精确暂存并提交code-simplifier修改，或明确跳过空提交**

Run:

```powershell
$phaseECodeScope = @('src','src-tauri/src','src-tauri/tests','scripts','package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','src-tauri/capabilities')
$phaseECodeFiles = @(git diff --diff-filter=ACMTUXB --name-only -- $phaseECodeScope | Sort-Object -Unique)
$deleted = @(git diff --diff-filter=D --name-only) + @(git diff --cached --diff-filter=D --name-only)
$renamed = @(git diff --diff-filter=R --name-only) + @(git diff --cached --diff-filter=R --name-only)
$stagedBeforeAdd = @(git diff --cached --name-only)
if ($deleted.Count -gt 0 -or $renamed.Count -gt 0 -or $stagedBeforeAdd.Count -gt 0) {
  $deleted
  $renamed
  $stagedBeforeAdd
  throw 'tracked deletion move or pre-existing staged change detected before refactor staging'
}
if ($phaseECodeFiles.Count -eq 0) {
  Write-Output 'SKIP refactor commit: no code/config/dependency changes'
} else {
  git diff --check -- $phaseECodeFiles
  if ($LASTEXITCODE -ne 0) { throw 'code-simplifier diff check failed' }
  git add -- $phaseECodeFiles
  if ($LASTEXITCODE -ne 0) { throw 'failed to stage exact code-simplifier file list' }
  $cachedDeleted = @(git diff --cached --diff-filter=D --name-only)
  $cachedRenamed = @(git diff --cached --diff-filter=R --name-only)
  $cachedFiles = @(git diff --cached --name-only | Sort-Object -Unique)
  $scopeMismatch = @(Compare-Object -ReferenceObject $phaseECodeFiles -DifferenceObject $cachedFiles)
  if ($cachedDeleted.Count -gt 0 -or $cachedRenamed.Count -gt 0 -or $scopeMismatch.Count -gt 0) { $cachedDeleted; $cachedRenamed; $scopeMismatch; throw 'cached deletion move or scope mismatch requires explicit user approval' }
  git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw 'cached code-simplifier diff check failed' }
  $cachedFiles
  git commit -m "refactor(hardening): 简化最终加固实现"
  if ($LASTEXITCODE -ne 0) { throw 'code-simplifier commit failed' }
}
```

Expected: 无修改时只打印SKIP并继续；有修改时cached清单与精确`$phaseECodeFiles`一致、无删除/移动项且commit成功。不得用`git add .`或目录级宽泛暂存。

- [ ] **Step 7: 在最终代码冻结后创建新隔离根、重新授权并运行唯一真实 CLI**

本步骤只能在Step 6 commit成功或明确no-op后开始。先冻结当前`HEAD`为`runtimeScopeCommit`，精确runtime/runner scope固定为：`scripts/cli-smoke.mjs`、`src-tauri/src/runtime/`、`src-tauri/src/bin/tht_panel_runtime_smoke.rs`、`src-tauri/src/application/conversation_manager.rs`、`src-tauri/src/application/context_bridge.rs`、`src-tauri/src/application/conversation_switch_service.rs`、`src-tauri/src/application/conversation_execution_mode_service.rs`、`src-tauri/src/application/work_item_runtime_service.rs`、`src-tauri/src/compat/runtime_bindings.rs`和`src-tauri/tests/runtime_cli_smoke_contract.rs`。开始前这些path不得有tracked/untracked/cached修改。

Run:

```powershell
$runtimeScopeCommit = (git rev-parse HEAD).Trim()
if ($runtimeScopeCommit -notmatch '^[0-9a-f]{40}$') { throw 'runtime scope commit must be a full lowercase SHA' }
$runtimeRunnerScope = @('scripts/cli-smoke.mjs','src-tauri/src/runtime','src-tauri/src/bin/tht_panel_runtime_smoke.rs','src-tauri/src/application/conversation_manager.rs','src-tauri/src/application/context_bridge.rs','src-tauri/src/application/conversation_switch_service.rs','src-tauri/src/application/conversation_execution_mode_service.rs','src-tauri/src/application/work_item_runtime_service.rs','src-tauri/src/compat/runtime_bindings.rs','src-tauri/tests/runtime_cli_smoke_contract.rs')
$runtimeScopeDirty = @(git status --porcelain --untracked-files=all -- $runtimeRunnerScope)
$runtimeScopeStaged = @(git diff --cached --name-only -- $runtimeRunnerScope)
if ($runtimeScopeDirty.Count -gt 0 -or $runtimeScopeStaged.Count -gt 0) { $runtimeScopeDirty; $runtimeScopeStaged; throw 'runtime/runner scope must be clean before final real CLI' }
Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue
$targetRoot = (Resolve-Path 'src-tauri\target').Path
$targetPrefix = $targetRoot.TrimEnd('\', '/') + '\'
$rootLabel = 'phase-e-real-cli-' + [guid]::NewGuid().ToString('D')
$consentLabel = 'phase-e-consent-' + [guid]::NewGuid().ToString('D')
$smokeRoot = [IO.Path]::GetFullPath((Join-Path $targetRoot $rootLabel))
if (-not $smokeRoot.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Phase E smoke root escaped target' }
if (Test-Path -LiteralPath $smokeRoot) { throw 'Phase E smoke root must not exist before setup' }
$setupExit = 0
try {
  $env:THT_PANEL_SMOKE = '1'
  $env:THT_PANEL_CONFIG_DIR = $smokeRoot
  npm run tauri -- dev
  $setupExit = $LASTEXITCODE
} finally {
  Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue
}
if ($setupExit -ne 0) { throw "isolated Phase E provider setup failed: $setupExit" }
$smokeRoot = (Resolve-Path -LiteralPath $smokeRoot).Path
if (-not $smokeRoot.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'canonical smoke root escaped target' }
npm run test:cli-smoke -- --list-test-providers --config-root $smokeRoot
if ($LASTEXITCODE -ne 0) { throw 'isolated provider listing failed' }
npm run test:cli-smoke -- --probe-only
if ($LASTEXITCODE -ne 0) { throw 'no-cost CLI version probe failed' }
$providerAId = (Read-Host '输入本隔离根中的非生产 Provider A canonical UUID').Trim()
$providerBId = (Read-Host '输入本隔离根中的非生产 Provider B canonical UUID').Trim()
$providerAGuid = [guid]::ParseExact($providerAId, 'D')
$providerBGuid = [guid]::ParseExact($providerBId, 'D')
if (-not [string]::Equals($providerAId,$providerAGuid.ToString('D'),[StringComparison]::Ordinal) -or -not [string]::Equals($providerBId,$providerBGuid.ToString('D'),[StringComparison]::Ordinal)) { throw 'provider IDs must be canonical lowercase UUIDs' }
if ($providerAId -eq $providerBId) { throw 'two distinct provider IDs are required' }
```

此时必须暂停并向用户列出两个Provider显示名与stable UUID、相同driver/modelName、固定case数与诊断请求、ApproveOnce/Deny/取消动作、`$rootLabel`、`$consentLabel`及可能费用，取得本轮明确同意；Phase C/D或Task 14旧同意不能复用。未授权时不得继续，safe report保持SKIP，Phase E未完成。

获授权后对该root只运行一次：

```powershell
$rawCliReport = Join-Path $smokeRoot 'phase-e-real-cli-raw.json'
if (Test-Path -LiteralPath $rawCliReport) { throw 'single-use raw CLI report already exists' }
$runtimeExit = 0
Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue
try {
  $env:THT_PANEL_SMOKE = '1'
  $env:THT_PANEL_CONFIG_DIR = $smokeRoot
  $env:THT_PANEL_TEST_PROVIDER_A_ID = $providerAId
  $env:THT_PANEL_TEST_PROVIDER_B_ID = $providerBId
  npm run test:cli-smoke -- --runtime --native-workspace --confirm-potential-charge --config-root $smokeRoot --provider-id $providerAId --provider-id $providerBId --report-json $rawCliReport
  $runtimeExit = $LASTEXITCODE
} finally {
  Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue
}
node scripts/hardening/acceptance-matrix.mjs sanitize-real-cli --raw-report $rawCliReport --safe-output docs/verification/phase-e-real-cli.json --provider-id $providerAId --provider-id $providerBId --root-label $rootLabel --consent-label $consentLabel --runtime-scope-commit $runtimeScopeCommit
if ($LASTEXITCODE -ne 0) { throw 'safe real CLI report generation failed' }
node scripts/hardening/acceptance-matrix.mjs apply-real-cli --input docs/verification/final-acceptance.json --safe-report docs/verification/phase-e-real-cli.json
if ($LASTEXITCODE -ne 0) { throw 'final acceptance real CLI update failed' }
npm run verify:acceptance
if ($LASTEXITCODE -ne 0) { throw 'acceptance generation after real CLI failed' }
git diff --quiet "$runtimeScopeCommit..HEAD" -- $runtimeRunnerScope
if ($LASTEXITCODE -ne 0) { throw 'runtime/runner scope changed after final real CLI; use a new root and obtain new consent' }
git diff --quiet -- $runtimeRunnerScope
if ($LASTEXITCODE -ne 0) { throw 'uncommitted runtime/runner change detected after final real CLI' }
if ($runtimeExit -ne 0) { throw "final real CLI failed: $runtimeExit" }
```

Expected: safe report只含driver/modelName、两个不同providerIdHash、root/consent label、caseIds、raw report SHA和`runtimeScopeCommit`，不含full UUID/path/secret/output/native ID；矩阵5-7由该report更新。root/raw evidence保留不删除。任何重跑、SKIP/FAIL、scope变化或授权变化都必须创建全新root、重新配置、重新列明费用并取得新同意。

- [ ] **Step 8: 使用 verification-before-completion 更新最终矩阵与Phase E证据**

使用 `@superpowers:verification-before-completion` 基于Steps 3-5和7本轮命令输出，而不是Task 14旧日志，核对七项矩阵、全部journal matrix、安全审计、reference cleanup、Tauri/NSIS report和最终真实CLI授权状态。先计算`$finalEvidence/release-report.json`与`docs/verification/phase-e-real-cli.json`最新SHA-256，再更新`docs/verification/final-acceptance.json`：每个引用release audit的`automationEvidence.command`统一写为不含绝对路径的`npm run release:audit -- --evidence-root <phase-e-final-evidence> --baseline-pointer <phase-d-baseline-pointer>`，`exitCode=0`且`reportSha256`为该最新report SHA；5-7的realCliEvidence必须引用safe report相对路径/hash与`runtimeScopeCommit`，旧report或命令标签不得残留。随后更新`docs/verification/phase-e-hardening.md`，记录Phase E base/HEAD、commit清单、预算v1摘要、full 7-Zip 26.02 manifest/SFX/bootstrap/7z.exe/7z.dll hashes与`Nsis` PASS、确定性计数结果、恢复面覆盖、引用审计/清理边界、最新NSIS/safe CLI report hash、七项状态和已知边界；不得记录pointer/本机完整路径、secret、模型/工具正文、native ID或用户对话。

Run:

```powershell
$finalReportPath = Join-Path $finalEvidence 'release-report.json'
if (-not (Test-Path -LiteralPath $finalReportPath -PathType Leaf)) { throw 'latest final release report is missing' }
$finalReportSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $finalReportPath).Hash.ToLowerInvariant()
$safeCliReportPath = (Resolve-Path 'docs/verification/phase-e-real-cli.json').Path
$safeCliReportSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $safeCliReportPath).Hash.ToLowerInvariant()
npm run verify:acceptance
if ($LASTEXITCODE -ne 0) { throw 'latest final acceptance generation failed' }
```

Expected: `final-acceptance.json`恰好7项并同时引用本轮最终NSIS report SHA、safe CLI report相对路径/hash和runtime scope commit，`final-acceptance.md`由更新后的JSON重新生成；`phase-e-hardening.md`记录相同hash和真实PASS/SKIP/FAIL。任何证据仍指向早期report、早期门禁输出或不可复核路径均FAIL。

任何必需真实CLI未获同意/为SKIP、任一FAIL、cleanup保护规则失败、budget超限或NSIS扫描命中时，Phase E保持未完成，文档必须如实标记，不能上调budget、删除证据或把SKIP改写为PASS。

- [ ] **Step 9: 确定性复验最终矩阵并运行Git/编码终审**

Run:

```powershell
$latestReportSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $finalEvidence 'release-report.json')).Hash.ToLowerInvariant()
$latestSafeCliSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath 'docs/verification/phase-e-real-cli.json').Hash.ToLowerInvariant()
$matrixJsonPath = (Resolve-Path 'docs/verification/final-acceptance.json').Path
$matrixJson = [IO.File]::ReadAllText($matrixJsonPath)
$matrix = $matrixJson | ConvertFrom-Json
$releaseAuditCommand = 'npm run release:audit -- --evidence-root <phase-e-final-evidence> --baseline-pointer <phase-d-baseline-pointer>'
$releaseAuditEvidence = @($matrix | ForEach-Object { $_.automationEvidence } | Where-Object { $_.command -like 'npm run release:audit*' })
$staleReleaseAuditEvidence = @($releaseAuditEvidence | Where-Object { $_.command -ne $releaseAuditCommand -or $_.exitCode -ne 0 -or $_.reportSha256 -ne $latestReportSha256 })
if ($releaseAuditEvidence.Count -eq 0 -or $staleReleaseAuditEvidence.Count -gt 0) { $staleReleaseAuditEvidence; throw 'final matrix release audit evidence is missing or stale' }
$requiredCliEvidence = @($matrix | Where-Object { $_.id -in 5,6,7 } | ForEach-Object { $_.realCliEvidence })
$staleCliEvidence = @($requiredCliEvidence | Where-Object { $_.status -ne 'PASS' -or $_.reportRelativePath -ne 'docs/verification/phase-e-real-cli.json' -or $_.reportSha256 -ne $latestSafeCliSha256 -or $_.runtimeScopeCommit -ne $runtimeScopeCommit })
if ($requiredCliEvidence.Count -ne 3 -or $staleCliEvidence.Count -gt 0) { $staleCliEvidence; throw 'final matrix real CLI evidence is missing or stale' }
git diff --quiet "$runtimeScopeCommit..HEAD" -- $runtimeRunnerScope
if ($LASTEXITCODE -ne 0) { throw 'runtime/runner scope changed after report; create a new root and rerun with new consent' }
git diff --quiet -- $runtimeRunnerScope
if ($LASTEXITCODE -ne 0) { throw 'uncommitted runtime/runner scope changed after report' }
$matrixMarkdownPath = (Resolve-Path 'docs/verification/final-acceptance.md').Path
$phaseEVerification = [IO.File]::ReadAllText((Resolve-Path 'docs/verification/phase-e-hardening.md'))
if (-not $matrixJson.Contains($latestReportSha256) -or -not $matrixJson.Contains($latestSafeCliSha256) -or -not $phaseEVerification.Contains($latestReportSha256) -or -not $phaseEVerification.Contains($latestSafeCliSha256)) { throw 'final evidence does not reference latest NSIS and CLI report SHAs' }
npm run verify:acceptance
if ($LASTEXITCODE -ne 0) { throw 'final acceptance revalidation failed' }
$firstMarkdownSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $matrixMarkdownPath).Hash.ToLowerInvariant()
$renderedMarkdown = [IO.File]::ReadAllText($matrixMarkdownPath)
if (-not $renderedMarkdown.Contains($latestReportSha256) -or -not $renderedMarkdown.Contains($latestSafeCliSha256)) { throw 'rendered final matrix omits latest report SHA' }
npm run verify:acceptance
if ($LASTEXITCODE -ne 0) { throw 'deterministic final acceptance regeneration failed' }
$secondMarkdownSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $matrixMarkdownPath).Hash.ToLowerInvariant()
if ($firstMarkdownSha256 -ne $secondMarkdownSha256) { throw 'final acceptance Markdown generation is not deterministic' }
node scripts/hardening/repo-audit.mjs --root .
if ($LASTEXITCODE -ne 0) { throw 'final repo audit failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'final worktree diff check failed' }
git status --short
```

Expected: 两次最终生成得到相同Markdown SHA，JSON、生成Markdown和Phase E验证文档均引用Step 5最新NSIS report与Step 7 safe CLI report SHA，runtime/runner scope相对report commit无变化；repo audit与diff check PASS。`git status --short`只允许尚未提交的`docs/verification/phase-e-hardening.md`、`docs/verification/final-acceptance.json`、`docs/verification/final-acceptance.md`和`docs/verification/phase-e-real-cli.json`，不得出现target/dist/node_modules/raw capture/smoke/evidence、BOM、未闭合fence、未完成标记或用户原有文件。

Run:

```powershell
$first = (git log --grep='^test(hardening): 固定确定性预算与Phase D基线$' -n 1 --format='%H').Trim()
if ([string]::IsNullOrWhiteSpace($first)) { throw 'Phase E first commit not found' }
$phaseEBase = (git rev-parse "$first^").Trim()
$phaseENameStatus = @(git diff --name-status --find-renames "$phaseEBase..HEAD")
$historicalDeleteOrRename = @($phaseENameStatus | Where-Object { $_ -match '^D\s' -or $_ -match '^R[0-9]*\s' })
if ($historicalDeleteOrRename.Count -gt 0) { $historicalDeleteOrRename; throw 'Phase E committed range contains unauthorized deletion or rename' }
$phaseENameStatus
```

Expected: name-status清单逐项属于Tasks 1-15，不含roadmap、Phase A-D计划、AGENTS.md、旧用户改动或证据目录；任何`D`或`R*`显式FAIL，不能由Step 10当前worktree检查掩盖历史提交中的删除/移动。

- [ ] **Step 10: 按精确范围提交验证文档、清理环境变量但保留证据**

```powershell
$verificationFiles = @('docs/verification/phase-e-hardening.md','docs/verification/final-acceptance.json','docs/verification/final-acceptance.md','docs/verification/phase-e-real-cli.json')
$stagedBeforeVerification = @(git diff --cached --name-only)
if ($stagedBeforeVerification.Count -gt 0) { $stagedBeforeVerification; throw 'index must be empty before staging final verification documents' }
$deletedBeforeVerification = @(git diff --diff-filter=D --name-only) + @(git diff --cached --diff-filter=D --name-only)
$renamedBeforeVerification = @(git diff --diff-filter=R --name-only) + @(git diff --cached --diff-filter=R --name-only)
if ($deletedBeforeVerification.Count -gt 0 -or $renamedBeforeVerification.Count -gt 0) { $deletedBeforeVerification; $renamedBeforeVerification; throw 'final verification contains unauthorized deletion or move' }
$workingFiles = @(@(git diff --name-only) + @(git ls-files --others --exclude-standard)) | Sort-Object -Unique
$workingScopeMismatch = @(Compare-Object -ReferenceObject ($verificationFiles | Sort-Object -Unique) -DifferenceObject $workingFiles)
if ($workingScopeMismatch.Count -gt 0) { $workingFiles; $workingScopeMismatch; throw 'final worktree scope is not the exact verification file list' }
git diff --check -- $verificationFiles
if ($LASTEXITCODE -ne 0) { throw 'final verification diff check failed' }
git add -- $verificationFiles
if ($LASTEXITCODE -ne 0) { throw 'failed to stage exact final verification files' }
$cachedDeleted = @(git diff --cached --diff-filter=D --name-only)
$cachedRenamed = @(git diff --cached --diff-filter=R --name-only)
$cachedFiles = @(git diff --cached --name-only | Sort-Object -Unique)
$cachedScopeMismatch = @(Compare-Object -ReferenceObject ($verificationFiles | Sort-Object -Unique) -DifferenceObject $cachedFiles)
if ($cachedDeleted.Count -gt 0 -or $cachedRenamed.Count -gt 0 -or $cachedScopeMismatch.Count -gt 0) { $cachedDeleted; $cachedRenamed; $cachedScopeMismatch; throw 'final verification cached scope mismatch' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'final verification cached diff check failed' }
git commit -m "test(hardening): 记录Phase E最终验收证据"
if ($LASTEXITCODE -ne 0) { throw 'final verification commit failed' }
```

Run: `Remove-Variable baselinePointer,phaseDBaselinePointer -ErrorAction SilentlyContinue; Remove-Item Env:THT_PANEL_SMOKE,Env:THT_PANEL_CONFIG_DIR,Env:THT_PANEL_TEST_PROVIDER_A_ID,Env:THT_PANEL_TEST_PROVIDER_B_ID -ErrorAction SilentlyContinue; git status --short`

Expected: baseline pointer从未写入process env，只清除local变量与四个smoke/provider控制变量；worktree干净。不得删除Phase D/Phase E baseline、full 7-Zip toolchain、build、unpacked、smoke、capture或CLI report evidence；后续清理仍需用户对每个目录明确授权，且不属于ReferenceCleanupService。

- [ ] **Step 11: 完成 Chunk 3 与全计划最终评审**

使用 plan-document-reviewer 按设计规格、roadmap、Phase A-D最终计划和本计划三个Chunk复核。必须明确确认：确定性非墙钟预算、Phase D原子`CapacitySnapshot`复用、事件分页/DOM/队列/内存背压、generation-bound Codex idle/keepAlive、`ConversationExecutionTransition`/`CodexIdleDrain`统一门禁、CSP/Markdown/外链/capability/redaction、root-reachability与write-ahead cleanup全恢复矩阵、显式ReferenceAudit/cleanup授权、唯一target+锁定`7zip-bin` bootstrap与official full 7-Zip 26.02、`Nsis`/Offset-generated/reduced四类entry闭集/immutable hash/magic预算与scan、显式baseline pointer、最终代码冻结后的单次授权CLI与runtimeScopeCommit、七项四类证据、verification-before-completion、Git committed D/R与cached scope、UTF-8/BOM/fence/未完成标记均闭环；否则不得宣布Panel重构最终完成。
