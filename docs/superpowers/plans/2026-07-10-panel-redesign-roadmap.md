# Panel Redesign Roadmap Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持旧 PTY 路径可回退的前提下，分五个阶段交付项目/会话菜单、可保存工作区、窗口换位、多供应商隔离、原生 AI 消息工作区与最终发布加固。

**Architecture:** Rust 后端是项目、供应商、密钥、会话、布局和运行时的真相来源；React 前端只持有可公开 DTO 和渲染状态。运行时输出统一经过应用级 `RuntimeOutputRelay`，持久事件统一经过容量账本与可恢复 writer。实施通过 `CompatibilityFacade` 与功能开关渐进切换，每个阶段都必须可构建、可测试、可回退。

**Tech Stack:** React 19、TypeScript 5.8、Zustand 5、Vitest、Tauri 2、Rust 2021、serde、Windows DPAPI/Job Object、Codex app-server JSONL、Claude stream-json。

---

## Chunk 1: 路线、边界与阶段门禁

### 设计与计划索引

- 设计规格：`docs/superpowers/specs/2026-07-10-panel-redesign-design.md`
- Phase A：`docs/superpowers/plans/2026-07-10-panel-redesign-phase-a-foundation.md`
- Phase B：`docs/superpowers/plans/2026-07-10-panel-redesign-phase-b-menu-workspace.md`
- Phase C：`docs/superpowers/plans/2026-07-10-panel-redesign-phase-c-runtime-adapters.md`
- Phase D：`docs/superpowers/plans/2026-07-10-panel-redesign-phase-d-native-workspace.md`
- Phase E：`docs/superpowers/plans/2026-07-10-panel-redesign-phase-e-hardening.md`

阶段必须按 A → B → C → D → E 执行。B 依赖 A 的稳定实体和兼容命令；C 依赖 A 的供应商修订、密钥与事件存储；D 依赖 B 的稳定窗口引用和 C 的统一事件；E 只在 A-D 全部通过后执行。

### 跨阶段不变量

- `Conversation.id`、`Project.id`、`ProviderProfile.id`、`ModelProfile.id` 和布局中的实体引用均为稳定 UUID；运行时进程 ID 不得进入持久化布局。
- `Conversation.projectPathSnapshot` 与 `RuntimeSegment.cwdSnapshot` 在创建时冻结；编辑 Project.path 只影响后续新会话，不能重定向历史、恢复或原生会话探测。`RuntimeSegment` 同时冻结 `providerRevisionId`、模型快照、协议版本、CLI 版本和能力快照；编辑供应商不能改写历史运行段。
- runtime 协议 JSONL 与事件 JSONL 使用独立 codec/常量：前者 compact serialized line（含换行）上限 `1 MiB`，后者 compact serialized line（含 envelope、JSON escaping 和换行）上限 `2 MiB`；所有 serialized 限制都在转义后按字节计算，不能用原始正文长度代替。
- 事件追加必须使用同一 `ConversationEventCapacityLedger`、staging bytes 与 journal transaction；journal 保存真实可重放字节，崩溃恢复只能得到完整旧状态或完整新状态，不能直接 append 后补元数据。查询窗口只读 committed range，但容量摘要必须从同一原子 snapshot 同时返回 committed 与 active reserved bytes，不能虚增可用空间。
- 原生会话 ID 使用 driver/version 绑定的版本化 `NativeSessionId` 闭合 grammar；历史 canonical lowercase UUID 继续按 legacy variant 读取并保持兼容。同一 native identity 只能属于一个 Conversation，同一 Conversation 的 resume lineage 可复用，不能由前端或任意 argv token覆盖。
- JSON 只保存 `secretRef` 与配置状态；真实密钥不得进入 WebView、命令行、日志、错误或事件文件。
- `ProjectHistoryTombstone` 只保留删除状态、最后路径和 ID 占位；历史定位始终使用 Conversation/segment 冻结快照，tombstone 不得重定向旧会话或创建新运行时。
- `CurrentWorkspace` 始终存在；`SavedWorkspace` 是可命名快照，活动来源通过 `sourceSavedWorkspaceId` 表达。
- 窗口拖动只交换 `items`、kind-scoped `activeItem`、`projectId`、`locked`，不重写分屏树、位置 ID 或比例。
- Claude 与 Codex 运行时均失败封闭；未知版本或能力禁止原生发送，不静默回退或伪造审批支持。
- 所有 adapter 输出只经过应用级唯一 `RuntimeOutputRelay`；`RuntimeAdapterOutput::Control::SharedServiceRecoveryRequired` 只由 Rust 内部 coordinator 消费，不进入 Tauri/WebView。共享 Codex app-server 失败时必须覆盖全部受影响 Conversation，而不是只通知单个 binding。
- `RuntimeOutputRelay`进入Tauri前与WebView coalescer各自使用确定性的event/UTF-8 byte预算；backend delta不得消费每个active turn的terminal reserve，溢出必须先通过唯一event writer持久化`RuntimeError + StatusChanged`，不能静默丢terminal或只在前端释放内存。
- Phase D `ContextBridge` 与供应商切换事务复用 Phase C 的事件 writer、序列化边界和容量账本；不得复制第二套 append、计数器或把协议 `1 MiB` 上限套到事件行。
- Conversation 在 native/legacy 间切换时必须先冻结新入口，主动 shutdown native adapter 或 kill legacy PTY，并等待 process tree empty、pending callback/settling outcome drain 后才发布新 sink；`TerminalSession` 始终保持独立 PTY 路径。
- connection test、keepAlive 和真实 CLI 等可能计费授权必须绑定当前 provider/model/revision、execution mode 与单调 selection/config generation；provider/mode 切换、rollout/rollback、配置变化或重启都使旧授权持久失效，切走再切回原值也不能复活。
- 任一 migration/workspace/runtime/event/context-bridge Journal、start claim、settling outcome 或退出 drain 未收敛时都不能发布 Ready/Exiting；重启不得猜测仍存活的进程。
- Rust notification 依赖、plugin init 与 PTY pump 使用链必须保留；只移除未使用的前端 notification binding 和 WebView 默认权限。
- Phase D 迁移烟测完成前，旧 DTO、旧命令和 legacy PTY AI 路径不得删除。之后任何源码/配置/依赖文件删除仍须先给出全仓零引用或替代证据，并针对精确文件再次取得用户明确授权；计划批准不等于删除授权。
- Phase E 清理仅能处理用户在确认对话框中批准、由 manifest/journal 锁定的应用自有运行 artifact；物理artifact只允许同卷原子rename到`configRoot/.reference-cleanup/<planId>/quarantine/<itemId>`后按write-ahead状态purge。项目目录、tombstone、runtime fixtures、smoke/capture、NSIS 解包目录和 verification evidence 永不进入自动清理 scope。实施代理的源码删除授权不能由该 UI 授权外溢获得。
- Cleanup commit在写`Prepared`前必须取得application-wide exclusive admission，冻结并drain新的append/import/switch/outcome/start/transition/recovery/idle/keepAlive与普通metadata writer；Prepared后排他状态保持到Committed或Blocked。公开audit继续用包含全部Journal ownership edge的保护可达性；当前plan恢复只忽略自身ownership edge，其他业务根或Journal新引用仍阻断。
- Phase A 的启动时 orphan secret 差集删除在 Phase E 明确停用；已提交或历史secret只能由`ReferenceCleanup`在独立secret scope确认和Journal保护下删除。Provider保存失败时回滚本次未提交新secret仍属于原事务补偿。
- Phase E 发布审计只把锁定的 `7zip-bin@5.2.0` 用作bootstrap，create-new下载并校验official full 7-Zip 26.02后仅解出`7z.exe`/`7z.dll`；只有hash重验且`7z i`唯一列出`Nsis`的full 7z可对唯一installer做list/extract，不执行installer或payload。baseline首次创建工具链，后续verify/release只读复用、禁止网络与bootstrap，并为每次run新建extract root。必须验证外层`Type = Nsis`、Offset/generated语义、安全规范化路径和list/extract一致性；entry闭合为`mutableAppPaths`、`generatedUninstallerPaths`、`generatedMetadataEntries`、`immutableBaselineEntries`四个互斥集合，final只能在baseline path全集上新增唯一sentinel。
- 真实 CLI 结果必须逐 driver 标记 PASS/SKIP/FAIL：未安装可记 SKIP，但 SKIP 不能作为原生能力或最终需求已验收的证据；已安装却协议不兼容、隔离失败或安全门禁失败必须记 FAIL。

### 官方协议基线

- Codex app-server 使用默认 stdio JSONL；启动顺序固定为 `initialize` 请求成功响应 → `initialized` notification → `thread/start|thread/resume` → `turn/start`，取消使用 `turn/interrupt`。
- Codex 的 `item/*`、`turn/*`、`serverRequest/resolved` 是事件来源；`item/completed` 是项目最终状态。
- Codex 自定义 `model_provider` 名称必须避开 `openai`、`ollama`、`lmstudio`，每个供应商修订生成唯一命名空间并通过环境变量注入凭据。
- 依据：<https://learn.chatgpt.com/docs/app-server>、<https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers>。
- Claude 事件结构不在本计划中猜测；只接受执行阶段由目标 CLI 版本采集并脱敏后的固定样例，未验证能力保持 `false`。

### Task 1: 建立执行工作区和基线

**Files:**
- Inspect: `AGENTS.md`
- Inspect: `package.json`
- Inspect: `src-tauri/Cargo.toml`
- Inspect: `docs/superpowers/specs/2026-07-10-panel-redesign-design.md`

- [ ] **Step 1: 确认计划基线并获得隔离 worktree 授权**

执行阶段开始前确认路线图和 Phase A-E 计划已进入一个只含 `docs/superpowers/plans/` 的提交，再说明将创建 `codex/panel-redesign` 分支和隔离 worktree；未获授权时停止，不在当前 `dev` 工作区改业务代码。当前未跟踪 `AGENTS.md` 不混入计划提交；如需在 worktree 中落盘，必须另获复制授权并核对源/目标 SHA-256，保持为未跟踪指导文件。

- [ ] **Step 2: 使用隔离工作区**

使用 `@superpowers:using-git-worktrees`，并确认 worktree 基于包含全部已批准计划的提交，而不是仅含设计规格的 `c43ed74`。

- [ ] **Step 3: 核对用户已有改动未被带入**

Run: `git status --short --branch`

Expected: 新 worktree 干净；当前主工作区中的 `package-lock.json` 与 `AGENTS.md` 用户改动不被复制、覆盖或提交。

- [ ] **Step 4: 运行现状基线**

Run: `npm ci && npm run typecheck && npm run build && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 四条命令均成功；若任一基线失败，立即暂停实施，记录完整命令/错误并等待用户决定，不把既有失败归因于本重构，也不得带病进入 Phase A。

### Task 2: 执行 Phase A—领域与安全基础

**Files:**
- Follow: `docs/superpowers/plans/2026-07-10-panel-redesign-phase-a-foundation.md`

- [ ] **Step 1: 逐任务执行 Phase A**

使用 `@superpowers:subagent-driven-development`，每个任务由新实现代理完成，并进行规格符合性和代码质量两轮评审。

- [ ] **Step 2: 每个代码任务做简化审查**

使用 `@code-simplifier` 审查该任务最近修改的代码；若产生修改，重跑该任务测试后再提交。

- [ ] **Step 3: 通过 Phase A 门禁**

Run: `npm run test && npm run typecheck && npm run build && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；旧界面和 legacy PTY AI 路径仍可启动，多供应商元数据与密钥引用测试通过。

### Task 3: 执行 Phase B—菜单与工作区

**Files:**
- Follow: `docs/superpowers/plans/2026-07-10-panel-redesign-phase-b-menu-workspace.md`

- [ ] **Step 1: 逐任务执行 Phase B，并在每个代码任务后运行 `@code-simplifier`**

- [ ] **Step 2: 通过 Phase B 自动化门禁**

Run: `npm run test && npm run typecheck && npm run build && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；布局 v2、保存/加载、自动保存、窗口换位、键盘替代和项目→会话菜单测试通过。

- [ ] **Step 3: 按 Phase B Task 14 的隔离根流程完成手工烟测**

Run: 原样执行 Phase B Task 14 Steps 5-7；首次启动前创建 canonical 位于 `src-tauri/target/` 的全新 Ready smoke 配置根与独立空项目目录，兼容回退使用另一个全新 migration fixture 根，最后只清环境变量、不删除证据目录。

Expected: 三次 Ready 启动与一次 LegacyReadOnly 启动均只接触隔离根；可保存并恢复 AI/终端混排 Tab，交换嵌套窗口后比例不变，重启后稳定引用保持，缺失引用显示占位而不阻断其余布局。不得用默认应用配置、HOME、仓库根或真实项目制造证据。

### Task 4: 执行 Phase C—运行时适配器

**Files:**
- Follow: `docs/superpowers/plans/2026-07-10-panel-redesign-phase-c-runtime-adapters.md`

- [ ] **Step 1: 逐任务执行 Phase C，并在每个代码任务后运行 `@code-simplifier`**

- [ ] **Step 2: 通过离线协议与生命周期门禁**

Run: `cargo test --manifest-path src-tauri/Cargo.toml runtime -- --nocapture && npm run test && npm run typecheck && npm run build && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 固定样例解析、事件去重、取消超时、应用级 relay 覆盖的共享 Codex app-server 恢复、Claude 进程重建、环境隔离和 Job Object 遏制测试成功；协议 `1 MiB` 与事件 `2 MiB` 转义后字节边界、committed+reserved 容量 snapshot、staging+journal 重放和 legacy UUID `NativeSessionId` 兼容测试同时通过。

- [ ] **Step 3: 在用户明确同意可能产生费用后运行显式真实 CLI 烟测**

先按 Phase C Task 17 再次列出测试 Provider、模型、case 数、可能费用、审批/取消动作和隔离目录并取得本轮明确同意；无同意时停止。无参数 `npm run test:cli-smoke` 与 `--probe-only` 都只做无费用版本探测，绝不能作为真实验收。

双Provider隔离case使用完整命令；单Provider验证时省略最后一组`--provider-id '<SECOND_TEST_PROVIDER_ID>'`，并在执行前替换全部尖括号模板。

Run: `$env:THT_PANEL_SMOKE='1'; npm run test:cli-smoke -- --runtime --confirm-potential-charge --config-root '<SMOKE_ROOT_UNDER_TARGET>' --provider-id '<TEST_PROVIDER_ID>' --provider-id '<SECOND_TEST_PROVIDER_ID>'`

Expected: 输出每个 CLI 的版本、能力矩阵和逐项 PASS/SKIP/FAIL；未安装 CLI 为 SKIP，协议不兼容为 FAIL，命令不得打印密钥、模型正文、工具输出或完整用户路径。任何必需 case FAIL 都阻止 Phase C 完成；运行后按 Phase C 计划移除当前 shell 的 `THT_PANEL_SMOKE`，但不擅自删除证据目录。

### Task 5: 执行 Phase D—原生消息工作区

**Files:**
- Follow: `docs/superpowers/plans/2026-07-10-panel-redesign-phase-d-native-workspace.md`

- [ ] **Step 1: 逐任务执行 Phase D，并在每个代码任务后运行 `@code-simplifier`**

- [ ] **Step 2: 通过 Phase D 自动化门禁**

Run: `npm run test && npm run typecheck && npm run build && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 消息状态机、复用 Phase C writer/账本 committed snapshot 的 ContextBridge、供应商切换、审批可见性、Markdown 安全、single-sink 模式切换、generation-bound keepAlive consent 和退出 flush 测试成功；mode/provider 切换只 detach 目标共享 Codex binding，peer 与 Job 保持，最后一个 binding 才允许关闭；Rust notification 链路保留，前端 binding 与默认 WebView notification 权限为零。

- [ ] **Step 3: 按 Phase D Tasks 13、15、16 的隔离根流程完成迁移与功能开关烟测**

Run: 原样执行 Phase D 指定的 cutover/security/manual smoke 命令；每个配置根都必须是 canonical 位于 `src-tauri/target/` 的全新目录，四个 smoke/provider 环境变量在成功和失败路径均由 `finally` 清除，证据目录保留。可能计费的 native workspace case必须在本轮重新列明 Provider/模型/case/费用并取得明确同意。

Expected: AI 会话默认进入原生消息界面，纯终端仍为 xterm；可显式进入终端兼容模式；切换前一模式必须完成 shutdown/kill、tree-empty 与 outcome drain；旧数据迁移后历史可读，无法确认供应商的会话禁止发送并给出修复入口。未获本轮费用同意时真实 case如实保持SKIP；旧 DTO 只有在全仓零引用证据通过并再次取得精确删除授权后才可删除。

### Task 6: 执行 Phase E—加固、发布审计与七项验收

**Files:**
- Follow: `docs/superpowers/plans/2026-07-10-panel-redesign-phase-e-hardening.md`

- [ ] **Step 1: 逐任务执行 Phase E，并在每个代码任务后运行 `@code-simplifier`**

- [ ] **Step 2: 使用完成前验证技能收集证据**

使用 `@superpowers:verification-before-completion`，不得依据旧日志或推测声明完成。

- [ ] **Step 3: 运行完整前端、Node 与 Rust 离线门禁**

Run: `npm ci && npm run test:hardening && npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build && npm run verify:acceptance && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；确定性字节/I/O/DOM/队列预算、完整恢复矩阵、只读引用图、授权清理 transaction 与安全回归均实际执行，且无密钥、绝对用户路径或真实会话内容进入 fixtures、日志和构建产物。

- [ ] **Step 4: 只解包审计唯一 NSIS 构建**

Run: `$targetRoot=(Resolve-Path 'src-tauri\target').Path; $finalEvidence=Join-Path $targetRoot ('release-evidence\phase-e-final-'+[guid]::NewGuid()); if(Test-Path -LiteralPath $finalEvidence){throw 'unique final evidence root already exists'}; $phaseDBaselinePointer=(Read-Host '粘贴Task 1精确PHASE_D_BASELINE_POINTER绝对路径').Trim(); if([string]::IsNullOrWhiteSpace($phaseDBaselinePointer)){throw 'exact Phase D baseline pointer is required'}; npm run release:audit -- --evidence-root $finalEvidence --baseline-pointer $phaseDBaselinePointer`

Expected: 唯一`CARGO_TARGET_DIR`内恰好一个installer；baseline pointer的canonical/no-reparse/schema/source hash/Phase D parent/installer hash+bytes校验先通过。既有full 7-Zip 26.02工具链只读重验且零网络、零bootstrap、零baseline修改；外层`Type = Nsis`、physical Offset/generated metadata、`mutableAppPaths/generatedUninstallerPaths/generatedMetadataEntries/immutableBaselineEntries`、list/extract一致性、installer/unpacked bytes、sentinel、主程序与sidecar及magic策略全部PASS，敏感文件/内容扫描零命中。不得执行或自动删除installer、payload、build、extract或evidence。

- [ ] **Step 5: 最终代码冻结后再次取得真实 CLI 与潜在计费授权**

按 Phase E Task 15 Step 7，只能在最终`@code-simplifier`修改已提交或明确no-op后冻结`runtimeScopeCommit`。随后在全新canonical `src-tauri/target/`配置根准备两个非生产Provider，以lowercase canonical `D` UUID重验稳定ID，列出同一driver/model、case数、固定诊断请求、ApproveOnce/Deny/取消动作、root/consent label和可能费用，再取得本轮明确同意。Phase C/D或Task 14旧同意不能复用；未获同意不得运行`--runtime`、连接测试或keepAlive tick，矩阵保持`SKIP(PENDING_FINAL_AUTHORIZED_RUN)`且Phase E未完成。任一真实run后该root不再复用；重跑必须新建root、重新配置并重新授权。

Expected: 唯一safe report绑定`runtimeScopeCommit`、driver/model、两个不同provider ID hash、root/consent label、case IDs、raw report hash与report SHA-256，不含full UUID、绝对路径、secret、输出正文或native ID；需求5-7只能由该报告更新为PASS。

- [ ] **Step 6: 逐条填写七项验收矩阵**

在 Phase E 计划指定的验收文档中，为每项需求记录源码路径、自动化测试命令、手工/真实 CLI 证据与已知边界；任何缺失证据的条目保持未完成。

- [ ] **Step 7: 核对删除授权、提交范围与最终状态**

Run: `node scripts/hardening/repo-audit.mjs --root . && git diff --check && git status --short`

Expected: 编码、Markdown fence、占位符、生成目录与 Git 范围审计通过；任何 tracked deletion 都有精确零引用/替代证据和本轮用户授权。各 Phase 已按自己的精确文件清单提交，不再执行宽泛 `git add docs src src-tauri ...` 或创建空的汇总提交；主工作区 `AGENTS.md`、`package-lock.json`、`tsconfig.node.tsbuildinfo` 及任何用户已有改动均不进入实施分支。
