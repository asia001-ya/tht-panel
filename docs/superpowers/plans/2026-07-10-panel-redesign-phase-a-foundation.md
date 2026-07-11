# Panel Redesign Phase A Foundation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可测试的领域模型、安全密钥存储、幂等迁移和兼容层，使旧界面/PTY 路径继续工作，同时提供多供应商稳定数据与新前端 DTO。

**Architecture:** 新领域代码放在 `domain/`、`storage/`、`secrets/`、`migration/` 和 `compat/`，旧 `config/` DTO 只保留为兼容输入输出。所有副作用通过可替换接口注入；启动先处理迁移 Journal，再构造仓库与兼容门面，避免旧加载逻辑对含明文密钥的文件创建 `.bak`。

**Tech Stack:** React 19、TypeScript、Zustand、Vitest、Testing Library、Tauri 2、Rust、serde、sha2、Windows DPAPI、tempfile。

---

## Chunk 1: 测试边界、领域模型与安全文件存储

### Task 1: 建立前端测试脚手架和可注入后端边界

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vite.config.ts`
- Modify: `tsconfig.node.json`
- Create: `src/test/setup.ts`
- Create: `src/test/FakeBackendClient.ts`
- Create: `src/api/backendClient.ts`
- Create: `src/api/tauriBackendClient.ts`
- Create: `src/api/client.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/events.ts`
- Test: `src/api/client.test.ts`

- [ ] **Step 1: 写失败测试，证明测试可替换后端且不会调用 Tauri**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { backendClient, resetBackendClientForTests, setBackendClientForTests } from "./client";
import { FakeBackendClient } from "../test/FakeBackendClient";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class<T> { onmessage?: (message: T) => void; },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

describe("backendClient", () => {
  afterEach(resetBackendClientForTests);

  it("测试实例只调用 FakeBackendClient", async () => {
    const fake = new FakeBackendClient();
    fake.ptySessions = [{ sessionId: "s1", workspaceId: null, kind: "shell",
      cwd: "D:\\AI\\demo", title: "PowerShell", state: "running",
      createdAt: "2026-07-10T00:00:00Z" }];
    const spy = vi.spyOn(fake, "ptyList");
    setBackendClientForTests(fake);

    await expect(backendClient().ptyList()).resolves.toHaveLength(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试并确认因 Vitest/BackendClient 不存在而失败**

Run: `npm run test -- src/api/client.test.ts`

Expected: FAIL，错误包含 `Missing script: test` 或无法解析 `./client`。

- [ ] **Step 3: 添加测试依赖、脚本和 jsdom 配置**

`package.json` 增加：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "jsdom": "^26.1.0",
    "vitest": "^3.2.4"
  }
}
```

Run: `npm install --save-dev vitest@^3.2.4 jsdom@^26.1.0 @testing-library/react@^16.3.0 @testing-library/jest-dom@^6.6.3 @testing-library/user-event@^14.6.1`

Expected: `package.json` 与 `package-lock.json` 同步更新，且不改动生产依赖。

把 `vite.config.ts` 的导入改为 `import { defineConfig } from "vitest/config";`，再在现有配置中增加：

```ts
test: {
  environment: "jsdom",
  setupFiles: ["./src/test/setup.ts"],
  clearMocks: true,
  restoreMocks: true,
},
```

在 `tsconfig.node.json.compilerOptions` 增加：

```json
"tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo"
```

避免 `composite` 检查把 `.tsbuildinfo` 写入仓库根目录。

`src/test/setup.ts`：

```ts
import "@testing-library/jest-dom/vitest";
```

需要固定 UUID 的测试在单个用例内使用 `vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(...)`；不得展开或替换整个 `crypto` 对象，以免丢失原型上的 `getRandomValues`/`subtle`。

- [ ] **Step 4: 定义唯一的后端接口和运行时实现**

`BackendClient` 在本任务先完整覆盖 `commands.ts` 的全部现有命令，方法签名使用 `src/api/types.ts` 的兼容 DTO；Task 2 再扩展 Phase A 新命令。核心形状：

```ts
export interface BackendClient {
  ptySpawn(req: SpawnRequest): Promise<PtySessionInfo>;
  ptyWrite(sessionId: string, data: string): Promise<void>;
  ptyResize(sessionId: string, cols: number, rows: number): Promise<void>;
  ptyKill(sessionId: string): Promise<void>;
  ptyList(): Promise<PtySessionInfo[]>;
  ptyAttach(sessionId: string, onMessage: (msg: PtyOutputMsg) => void): unknown;
  ptyDetach(sessionId: string): Promise<void>;
  configGet(): Promise<GlobalConfig>;
  configSet(value: GlobalConfig): Promise<void>;
  workspaceList(): Promise<Workspace[]>;
  workspaceSave(value: Workspace): Promise<void>;
  workspaceDelete(id: string): Promise<void>;
  layoutGet(): Promise<PersistedLayout>;
  layoutSave(value: PersistedLayout): Promise<void>;
  historyList(workspaceId: string, managedSessionId?: string): Promise<SessionHistoryEntry[]>;
  managedSessionList(workspaceId: string): Promise<ManagedSession[]>;
  managedSessionCreate(value: ManagedSession): Promise<void>;
  managedSessionUpdate(value: ManagedSession): Promise<void>;
  managedSessionDelete(id: string): Promise<void>;
  aiSessionDetect(args: { workspaceId: string; managedSessionId?: string; kind: string; spawnedAt: string; exclude: string[] }): Promise<string | null>;
  onSessionState(callback: (payload: SessionStatePayload) => void): Promise<() => void>;
  onSessionExit(callback: (payload: SessionExitPayload) => void): Promise<() => void>;
  onQuitRequest(callback: () => void): Promise<() => void>;
  appQuit(force: boolean): Promise<void>;
}
```

`tauriBackendClient.ts` 是唯一 import `invoke`/`Channel`/`listen` 的模块；`commands.ts` 和 `events.ts` 都只委托此接口。`client.ts` 暴露生产单例和测试替换：

Task 1 必须保持所有当前调用点可编译，因此这里的 `aiSessionDetect` 暂时保留 legacy request 形状。Task 14 先在新 service/binding 内实现 managedSessionId-only 探测；Task 15 才在同一个提交中原子替换 BackendClient、Tauri/Fake、Rust command 和 App 调用为 `aiSessionDetect(managedSessionId: string)`，禁止提前形成半切换提交。

```ts
let current: BackendClient = new TauriBackendClient();

export const backendClient = (): BackendClient => current;
export const setBackendClientForTests = (next: BackendClient): void => { current = next; };
export const resetBackendClientForTests = (): void => { current = new TauriBackendClient(); };
```

`commands.ts` 暂保留原导出名，但全部委托 `backendClient()`，不得再 import `@tauri-apps/api/core`。

- [ ] **Step 5: 实现可配置 Fake，并运行测试**

`FakeBackendClient` 使用公开数组/Map 存储测试数据；本测试至少实现 `ptySessions`/`ptyList()`。它还保存三组回调并提供 `emitSessionState`、`emitSessionExit`、`emitQuitRequest`，作为可控事件/Channel 边界。其余未配置方法抛出 `Error("FakeBackendClient.<method> 未配置")`，防止测试静默通过。

Run: `npm run test -- src/api/client.test.ts`

Expected: PASS，1 test passed。

- [ ] **Step 6: 运行静态检查并做代码简化审查**

Run: `npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 三条命令成功，且仓库根目录不产生 `tsconfig.node.tsbuildinfo`。随后使用 `@code-simplifier` 审查本任务文件；若有修改，重跑本步骤和测试。

- [ ] **Step 7: 提交测试边界**

```bash
git diff -- package-lock.json
git add package.json package-lock.json vite.config.ts tsconfig.node.json src/test src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/client.ts src/api/client.test.ts src/api/commands.ts src/api/events.ts
git commit -m "test: 建立前端后端注入边界"
```

Expected: 仅在路线图创建的干净 worktree 中暂存；`package-lock.json` 差异只包含本任务新增测试依赖，否则停止并拆分/排除非本任务改动。

### Task 2: 新增稳定领域模型、公开 DTO 与错误码

**Files:**
- Create: `src-tauri/src/domain/mod.rs`
- Create: `src-tauri/src/domain/driver.rs`
- Create: `src-tauri/src/domain/id.rs`
- Create: `src-tauri/src/domain/provider.rs`
- Create: `src-tauri/src/domain/path.rs`
- Create: `src-tauri/src/domain/project.rs`
- Create: `src-tauri/src/domain/conversation.rs`
- Create: `src-tauri/src/domain/terminal.rs`
- Create: `src-tauri/src/domain/workspace.rs`
- Create: `src-tauri/src/domain/settings.rs`
- Create: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/error.rs`
- Test: inline `#[cfg(test)]` modules in the new Rust files
- Test: `src/api/v2/types.test.ts`

- [ ] **Step 1: 注册领域模块并写失败测试，固定序列化名称与敏感字段边界**

先创建 `domain/mod.rs`、`domain/id.rs`、`domain/provider.rs`、`domain/path.rs`、`domain/conversation.rs` 测试骨架，并在 `lib.rs` 增加 `pub mod domain;`，确保测试会被编译而不是得到 `0 tests`。

Rust 测试必须断言 `ProviderRevision` 只序列化 `secretRef`，且 driver 是小写字符串：

```rust
#[test]
fn provider_revision_never_serializes_secret_value() {
    let revision = ProviderRevision::fixture(
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
        DriverKind::Codex,
    );
    let json = serde_json::to_value(revision).unwrap();
    assert_eq!(json["driver"], "codex");
    assert_eq!(json["secretRef"], "dpapi:00000000-0000-4000-8000-000000000001");
    assert!(json.get("apiKey").is_none());
    assert!(json.get("secretValue").is_none());
}
```

TypeScript 测试固定公开 DTO 不含 `apiKey`；Rust 同一轮再增加 `terminal_session_serialization_omits_runtime_pty_id`、`work_pane_same_uuid_cross_kind_active_ref_round_trips`、`entity_id_accepts_only_canonical_lowercase_hyphenated_uuid`、`entity_id_rejects_braced_simple_uppercase_and_path_like_values_before_io`、`native_session_id_accepts_only_locked_driver_canonical_uuid`、`native_session_id_rejects_option_response_file_whitespace_uppercase_braced_and_simple_aliases`、`safe_relative_path_rejects_absolute_prefix_dot_parent_and_empty_component`、`safe_relative_path_rejects_ads_device_names_illegal_chars_trailing_dot_or_space`、`legacy_history_source_round_trip_preserves_codex_locator`、`legacy_history_source_needs_selection_without_segment_round_trips`，断言易失 PTY 绑定不进入 `terminal-sessions.json`、活动 Tab 使用完整 kind-scoped 引用、locator 只含受控相对路径且归属 Conversation：

```ts
import { expectTypeOf, it } from "vitest";
import type { ProviderDetail } from "./types";

it("ProviderDetail 仅暴露 secretConfigured", () => {
  expectTypeOf<ProviderDetail>().toHaveProperty("secretConfigured");
  expectTypeOf<ProviderDetail>().not.toHaveProperty("apiKey");
});
```

- [ ] **Step 2: 运行测试并确认模型不存在**

Run: `cargo test --manifest-path src-tauri/Cargo.toml provider_revision_never_serializes_secret_value`

Expected: FAIL，ProviderRevision/DriverKind 尚未实现；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml safe_relative_path_`

Expected: FAIL，SafeRelativePath 尚未实现；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml entity_id_`

Expected: FAIL，EntityId canonical parser 尚未实现；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml native_session_id_`

Expected: FAIL，NativeSessionId driver-specific canonical parser 尚未实现；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml legacy_history_source_`

Expected: FAIL，LegacyHistorySource 尚未实现；不得是 `0 tests`。

Run: `npm run test -- src/api/v2/types.test.ts`

Expected: FAIL，TypeScript 无 `api/v2/types`。

- [ ] **Step 3: 创建 Rust 领域结构与明确状态默认值**

字段必须逐项与设计规格第 4 节一致：

- `driver.rs`：`DriverKind::{Claude,Codex}`、后端拥有的闭合 `DriverDefaults`、`RuntimeCapabilities`。`DriverDefaults` 不接受 UI/provider save 写入：executable 只能是 `Auto` 或通过第 11 节 Windows 规则验证的绝对普通文件，commonArgs 在 Phase A 固定为空（未来只能扩成锁定 driver+CLI version 的结构化枚举），settingsSources 使用 driver-specific 闭合枚举且只能映射到代码 allow-list 的环境键，禁止任意字符串/PATH 覆盖。Repositories open 与 launch 前都重新做语义校验。能力结构固定包含 `driver`、`cli_version`、`protocol_version`、`fixture_version` 以及 `streaming`、`multi_turn`、`native_resume`、`cancel_turn`、`tool_events`、`approvals`、`partial_messages` 七个布尔值，所有能力默认 `false`。
- `provider.rs`：`SecretRef`、`ProviderProfile`、不可变 `ProviderRevision`、`ModelProfile`、`ModelSnapshot`、`ProviderOverrides`。`SecretRef` 从一开始就是强类型，只接受 `dpapi:<uuid>`，手写 Deserialize 调用校验；测试 fixture 使用合法 UUID。
- `id.rs`：`EntityId(Uuid)` 及 Project/Conversation/RuntimeSegment/Terminal/SavedWorkspace 等语义 newtype；手写 Deserialize/parse 只接受与 `Uuid::to_string()` 完全相等的 lowercase hyphenated canonical 字符串，拒绝 braced/simple/uppercase/path-like alias。另定义 `NativeSessionId`，通过 `parse_for_driver(driver, value)` 使用锁定 CLI 版本的闭合 grammar；Phase A 锁定的 Claude/Codex 均只接受 canonical lowercase hyphenated UUID，因此天然拒绝前导 `-`、`@`、空白、控制字符、uppercase/braced/simple alias。migration、detect、repository open 与 resume 必须复用该类型；未来某 driver 若改变语法，必须新增版本化 parser/fixture，不能放宽为任意单 token。Rust 持久领域字段使用 typed ID，TypeScript/Tauri public DTO 仍是 string但在 service 入口立即解析；任何动态文件名只从 typed ID 的 canonical formatter 派生。
- `path.rs`：通用 `SafeRelativePath`，只接受非空普通相对组件，拒绝 absolute、Windows prefix、`.`、`..` 和空组件；另在所有平台一致拒绝 `:`/NTFS ADS、控制字符、`< > " | ? *`、尾点/尾空格，以及大小写不敏感的 `CON/PRN/AUX/NUL/COM1..9/LPT1..9`（含扩展名前缀），避免 Windows 归一化碰撞。只能通过 `join_under(base)` 解析到调用方提供的受控根，不保存或返回用户绝对路径。
- `project.rs`：`Project`，只引用默认供应商/模型，不内嵌连接配置；`path` 表示项目当前可编辑路径。另定义仅后端持久化的 `ProjectHistoryTombstone { id, path, deleted_at }`，用于保留删除时的最后项目位置和稳定 ID 占位，不进入公开 DTO、不能创建新运行时。
- `conversation.rs`：`Conversation`、`ConversationState::{Idle,Running,WaitingApproval,Failed}`、`RuntimeSegment`、`RuntimeSegmentState::{Starting,Running,Cancelling,Stopped,Interrupted,Failed}`、`CapabilitySnapshot`、强类型 `RuntimeNamespaceId` 与归属 Conversation 的可选 `LegacyHistorySource`；默认状态分别为 `Idle` 与 `Stopped`。Conversation 额外持久化创建/迁移时冻结的内部 `project_path_snapshot`，每个 RuntimeSegment 持久化本次启动的 `cwd_snapshot`，其可选 `external_session_id` 使用 `NativeSessionId`；两者均不进入公开 summary，也绝不随之后的 `Project.path` 编辑回写。恢复、历史过滤和原生会话探测只使用对应冻结快照，不能重新读取当前 Project path 改写旧会话归属。`LegacyHistorySource` 是持久化枚举：`CodexManaged { relativeHome: SafeRelativePath, ownerProjectId, ownerMarker, configSha256 }` 或 `ClaudeOpaque { projectId, externalSessionId: NativeSessionId }`，不得含绝对 HOME；即使 `needsProviderSelection=true` 且没有可靠 RuntimeSegment 也保留 source，并结合 Conversation 的 `project_path_snapshot` 供只读投影。`RuntimeNamespaceId` 只接受 `codex-revision:<uuid>`、`codex-legacy-workspace:<uuid>`、`claude-panel:<uuid>` 等已知前缀，不能承载任意绝对路径。
- `terminal.rs`：`TerminalSession`、`TerminalState::{Running,Stopped,Failed}`、`ShellDescriptor { executable, args }`；默认状态为 `Stopped`，参数默认空数组。`runtime_pty_session_id` 只表示当前进程绑定，字段使用 `#[serde(skip, default)]`，repository 序列化测试必须证明 JSON 中不存在 `runtimePtySessionId`。前端持久化 DTO 不声明该字段，运行态另由进程内 binding/public `runtimeAttached` 派生。
- `workspace.rs`：`PaneNode`、`SplitNode`、`WorkPane`、`WorkItemRef`、`CurrentWorkspace`、`SavedWorkspace`；叶子只引用稳定 Conversation/TerminalSession ID。为避免两种实体拥有同一裸 UUID 时活动 Tab 歧义，`WorkPane.active_item` 从一开始就是 `Option<WorkItemRef>`，JSON/TypeScript 字段为 `activeItem`，不得实现设计草案中的裸 `activeItemId`。
- `settings.rs`：`GlobalPreferences`、不含供应商密钥的 `AppSettings`、`CompatibilitySettings { claude_default_provider_id, codex_default_provider_id }`、`FeatureFlags { native_ai_enabled, workspace_v2_enabled }`。两个 compatibility ID 均可空且默认 null；`AppSettings::default()` 沿用当前主题/字体/滚动/通知默认值，两个功能开关默认均为 `false`。

所有落盘结构使用 `#[serde(rename_all = "camelCase")]`；需要向后兼容的文件顶层才使用 `#[serde(default)]`。`DriverKind` 未知值必须反序列化失败，不允许默认 Claude。`projectPathSnapshot/cwdSnapshot` 只由后端从已验证 Project/legacy source 派生，公开 create/update DTO 不接受覆盖值。Conversation event/outcome/runtime namespace 等路径不得 `format!` 任意 public string；必须先得到 typed ID 再由闭合 path builder 生成，非 canonical ID 在任何 read/list/write/remove 前失败。

- [ ] **Step 4: 创建完整 TypeScript 公开 DTO 并扩展 BackendClient**

`src/api/v2/types.ts` 镜像公开字段，并显式区分：

```ts
export type DriverKind = "claude" | "codex";
export type WorkItemRef =
  | { kind: "conversation"; conversationId: string }
  | { kind: "terminal"; terminalSessionId: string };

export interface ProviderDetail {
  id: string;
  name: string;
  driver: DriverKind;
  enabled: boolean;
  deletedAt: string | null;
  currentRevisionId: string;
  models: ModelProfile[];
  currentRevision: ProviderRevisionPublic;
  secretConfigured: boolean;
}

export interface ProviderSummary {
  id: string;
  name: string;
  driver: DriverKind;
  enabled: boolean;
  deletedAt: string | null;
  currentRevisionId: string;
  modelIds: string[];
  secretConfigured: boolean;
}

export interface ProviderRevisionPublic {
  id: string;
  providerId: string;
  driver: DriverKind;
  baseUrl: string | null;
  modelSnapshots: ModelSnapshot[];
  overrides: DriverOverrides;
  configHash: string;
  createdAt: string;
  retiredAt: string | null;
}

export interface ProviderSaveInput {
  id?: string;
  name: string;
  driver: DriverKind;
  baseUrl: string | null;
  secret: string | null; // 仅写入请求；响应类型不得包含此字段
  keepExistingSecret: boolean;
  models: Array<{ id?: string; displayName: string; modelName: string; extraOptions: string[] }>;
  overrides: DriverOverrides;
}

export type DriverOverrides =
  | { driver: "codex"; wireApi: "responses" | "chat" | null }
  | { driver: "claude" };

export type MigrationState =
  | "notRequired"
  | "confirmationRequired"
  | "recovering"
  | "complete"
  | "failed";

export interface MigrationStatus {
  state: MigrationState;
  schemaVersion: number;
  message: string | null;
}

export interface MigrationPreview {
  transactionId: string;
  sourceLabels: string[];
  knownSecretCount: number;
  projectCount: number;
  conversationCount: number;
  terminalCount: number;
  encryptedBackupRequired: boolean;
}
```

`Project` 固定为 `{ id,name,path,defaultProviderId,defaultModelId,sortOrder,createdAt,updatedAt,keepAlive }`；`GlobalPreferences` 固定为 `{ defaultProviderId,defaultModelId }`；`RuntimeCapabilities` 镜像 Step 3 的版本字段和七个能力布尔值。

随后把以下签名加入 `BackendClient`、`TauriBackendClient` 和 `FakeBackendClient`：

```ts
projectList(): Promise<Project[]>;
projectSave(project: Project): Promise<void>;
projectDelete(id: string, deleteConversations: boolean): Promise<void>;
providerList(): Promise<ProviderSummary[]>;
providerGet(id: string): Promise<ProviderDetail>;
providerSave(input: ProviderSaveInput): Promise<ProviderDetail>;
providerSetEnabled(id: string, enabled: boolean): Promise<void>;
providerDelete(id: string): Promise<void>;
globalPreferencesGet(): Promise<GlobalPreferences>;
globalPreferencesSet(value: GlobalPreferences): Promise<void>;
migrationStatus(): Promise<MigrationStatus>;
migrationPreview(): Promise<MigrationPreview>;
migrationApply(transactionId: string): Promise<void>;
```

生产实现只传送 `ProviderSaveInput.secret` 写请求；任何读取方法的返回类型都不得包含密钥正文。

- [ ] **Step 5: 写失败测试固定错误码与脱敏序列化**

在 `error.rs` 增加测试 `app_error_serializes_stable_public_shape` 与 `secret_error_hides_source_detail`，分别断言：

```rust
assert_eq!(serde_json::to_value(AppError::Validation("名称为空".into())).unwrap(),
           serde_json::json!({"code":"VALIDATION","message":"名称为空"}));
assert_eq!(serde_json::to_value(AppError::secret("token=fixture-secret")).unwrap(),
           serde_json::json!({"code":"SECRET","message":"凭据操作失败"}));
assert_eq!(serde_json::to_value(AppError::PathEscape).unwrap(),
           serde_json::json!({"code":"PATH_ESCAPE","message":"路径超出受控目录"}));
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml error_`

Expected: FAIL，新错误变体和安全构造器尚不存在。

- [ ] **Step 6: 扩展稳定错误码并禁止敏感详情进入序列化**

在 `AppError` 增加 `Validation`、`Conflict`、`ModelSelectionRequired`、`MigrationRequired`、`Migration`、`Secret`、`PathEscape`、`Protocol`、`UnsupportedCapability`、`Runtime`。序列化只返回 `{ code, message }`；`PathEscape` 固定返回 `PATH_ESCAPE/路径超出受控目录`，不能携带受控根或目标路径；`Secret` 的内部源错误只写固定消息“凭据操作失败”，不拼接密钥、环境变量值或 DPAPI 输入。

- [ ] **Step 7: 运行领域、错误与 DTO 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && npm run test -- src/api/v2/types.test.ts && npm run typecheck`

Expected: 全部成功；测试快照中不存在 `apiKey`、`secretValue`。

- [ ] **Step 8: 使用代码简化审查并提交**

使用 `@code-simplifier` 审查新领域文件，重点消除跨文件重复枚举或通用字符串状态；若修改，重跑 Step 7。

```bash
git add src-tauri/src/domain src-tauri/src/lib.rs src-tauri/src/error.rs src/api/v2 src/api/backendClient.ts src/api/tauriBackendClient.ts src/test/FakeBackendClient.ts
git commit -m "feat: 新增 Panel 稳定领域模型"
```

### Task 3: 实现供应商解析与不可变修订规则

**Files:**
- Create: `src-tauri/src/domain/provider_registry.rs`
- Create: `src-tauri/src/domain/provider_resolution.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Test: inline tests in both new modules

- [ ] **Step 1: 写失败测试覆盖解析优先级和同名模型隔离**

```rust
#[test]
fn new_segment_prefers_conversation_then_project_then_global() {
    let fixture = ResolutionFixture::with_three_providers();
    assert_eq!(fixture.resolve(Some("conversation-provider"), Some("project-provider"), Some("global-provider")).provider.id, "conversation-provider");
    assert_eq!(fixture.resolve(None, Some("project-provider"), Some("global-provider")).provider.id, "project-provider");
    assert_eq!(fixture.resolve(None, None, Some("global-provider")).provider.id, "global-provider");
}

#[test]
fn same_model_name_in_two_providers_keeps_distinct_model_ids() {
    let registry = ProviderRegistry::fixture_with_duplicate_model_names("gpt-x");
    let a = registry.resolve_model("provider-a", "model-a").unwrap();
    let b = registry.resolve_model("provider-b", "model-b").unwrap();
    assert_eq!(a.model_name, b.model_name);
    assert_ne!(a.model_id, b.model_id);
    assert_ne!(a.provider_revision_id, b.provider_revision_id);
}
```

同一测试模块还必须先写出以下失败用例，每个用例只断言一个规则：

- `disabled_explicit_provider_is_error_not_fallback`
- `deleted_explicit_provider_is_error_not_fallback`
- `model_must_belong_to_selected_provider`
- `missing_model_selection_is_explicit_error`
- `same_profile_reuses_only_matching_hash_and_secret_ref`
- `different_profiles_never_reuse_revision`
- `referenced_revision_can_retire_but_not_delete`
- `normalized_config_hash_is_order_stable`
- `reserved_argument_rejects_split_and_equals_forms`
- `reserved_argument_rejects_driver_short_alias_cluster_and_config_override_forms`
- `base_url_accepts_only_http_or_https`
- `base_url_rejects_userinfo_query_and_fragment_without_echo`
- `driver_overrides_reject_unknown_or_cross_driver_keys`
- `extra_options_reject_credential_base_url_and_env_injection_forms`
- `extra_options_reject_end_of_options_positional_prompt_response_file_and_driver_subcommands`
- `extra_options_domain_validator_rejects_every_nonempty_array`
- `provider_public_revision_never_contains_secret_sentinel`
- `unknown_driver_deserialization_fails`

- [ ] **Step 2: 运行测试并确认服务不存在**

Run: `cargo test --manifest-path src-tauri/Cargo.toml provider_resolution`

Expected: FAIL，无法解析 `ProviderRegistry`/`ProviderResolver`。

- [ ] **Step 3: 实现可重复的配置规范化与哈希**

增加 `sha2 = "0.10"`。`configHash` 只哈希规范化的 driver、baseUrl、模型快照和 closed `DriverOverrides`；密钥不进入哈希。规范化固定为：`url::Url` 解析后的 scheme/host 小写和标准字符串、模型快照按稳定 `modelId` 排序、Codex `wireApi` 枚举稳定序列化、每个模型的 `extraOptions` 保持原顺序。对规范化结构执行 `serde_json::to_vec` 后计算小写十六进制 SHA-256。Phase A 不接受任意 key/value overrides；Claude overrides 是空结构，Codex 仅允许 nullable `wireApi=responses|chat`，新增字段必须另做安全评审和 schema 迁移。

- [ ] **Step 4: 实现不可变 ProviderRegistry**

保存逻辑必须：

1. `ProviderRegistry` 只接收已经解析好的 `secretRef`，不接触密钥正文或 SecretStore。
2. 新 Provider 创建稳定 profile、model IDs 和初始 revision。
3. 编辑时由上层传入当前或新建的 `secretRef`；Registry 只按引用做不可变修订决策。
4. 仅在同一 profile 内，`configHash` 与 `secretRef` 都相同时复用旧 revision。
5. 不同 profile 永不因同配置或同模型名合并。
6. Registry 对被 RuntimeSegment 引用的 revision 只允许退役；Phase A 的 ProviderStore 对未引用 revision 也不执行物理删除，统一延后到全局引用审计阶段。

Chunk 2 的 ProviderService 负责“留空沿用旧引用 / 输入新密钥先写 SecretStore / JSON 写失败回滚新引用”的副作用顺序；本任务测试只使用固定假 `secretRef`。

- [ ] **Step 5: 实现失败封闭的 ProviderResolver**

`ProviderResolver::resolve_new_segment` 接收会话/项目/全局候选 ID，并逐层校验：provider 存在、未删除、enabled、driver 匹配、revision 存在、modelId 属于该 provider 且在当前 revision 中仍有快照。失败返回具体 `Validation`/`NotFound`，不得降级到下一层掩盖显式错误。

每一层传入供应商与模型这一对选择，禁止把高优先级供应商和低优先级模型混合。选中层没有 `modelId` 时返回 `MODEL_SELECTION_REQUIRED`，由界面要求用户选择，不能猜测第一个模型。

- [ ] **Step 6: 添加保留参数、URL 和 driver 校验**

增加 `url = "2"`。非空 `baseUrl` 必须是 `http`/`https`，且 username/password 为空、query/fragment 不存在；错误只返回稳定 code/message，不回显 URL。官方 host allow-list 只用于 UI 风险提示，非官方域名可保存但必须显示“自定义端点”警告，不能声称已验证连接。

`extraOptions` 不能使用 deny-list 猜测安全。Phase A 在 domain 层定义唯一 `validate_extra_options(&[String])`，闭合 grammar 固定为空：任何非空 token 都返回 Validation；尤其显式拒绝 `--`、裸 positional/prompt、`@response-file`、Codex `exec/resume/app-server`、Claude 子命令，以及 `-m/-c/-C/-p` 等 split/attached/`=`/short-cluster 形式。ProviderRegistry 保存只是第一个调用点；Task 7 Repositories open_existing 语义校验、Task 8 MigrationPlanner、Task 11 compat config/workspace 输入和 Task 14 LegacyLaunchService 最终 argv 构造前都必须复用同一函数，不能各自实现弱化规则。这样旧字段仍可稳定反序列化用于错误提示，但不会进入已提交 revision/argv或触发模型费用；legacy/migrated nonempty extraArgs 使 preview/apply 失败封闭并要求人工修复，原文件零修改。若后续确需开放，必须按锁定 driver+CLI version 新增结构化 enum 选项与固定 arity/值域 fixture，不得恢复任意 `Vec<String>` 透传；未知版本保持零允许项并禁止原生 launch。保留参数、credential/base-url/env 名称和 NUL/换行仍作为纵深负向测试，错误不得回显 token。未知 driver/override 字段在 serde 层直接失败。相同安全边界也覆盖 backend-owned `DriverDefaults`：commonArgs 必须为空、settingsSources 只能使用闭合映射、executable 重新按 Windows 规则解析；持久化篡改不能借此注入 positional/subcommand、PATH 或任意环境键。本任务用 secret sentinel 扫描 public revision JSON、validation Debug 与错误均无命中；Task 14 还必须断言最终 `ResolvedLaunch.argv` 只有后端生成的受控参数，零用户提供的 positional prompt/子命令。锁定版本的后端模板可以为 Codex 恢复生成唯一的 `resume <externalSessionId>`，Claude 恢复可以生成 `--resume <externalSessionId>`；该 ID 必须从冻结 segment 的 `NativeSessionId` 派生并使用 canonical formatter；前导 `-`/`@`、空白、控制字符及 uppercase/braced/simple alias 均在任何 argv 构造前拒绝，绝不来自 `extraOptions`、DriverDefaults 或前端。

- [ ] **Step 7: 运行供应商规则测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml provider_`

Expected: 优先级、禁用/软删除、模型归属、修订复用、跨 profile 不复用和保留参数测试全部 PASS。

- [ ] **Step 8: 代码简化审查并提交**

使用 `@code-simplifier` 检查解析分支是否可由小型校验函数复用；若修改，重跑 Step 7。

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/domain
git commit -m "feat: 实现供应商修订与解析规则"
```

### Task 4: 建立可故障注入的原子 JSON 文件层

**Files:**
- Create: `src-tauri/src/storage/mod.rs`
- Create: `src-tauri/src/storage/config_file_store.rs`
- Create: `src-tauri/src/storage/path_guard.rs`
- Create: `src-tauri/src/storage/atomic_file.rs`
- Create: `src-tauri/src/storage/json_repository.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/tests/support/mod.rs`
- Test: `src-tauri/tests/atomic_file_store.rs`

- [ ] **Step 1: 写失败测试覆盖 flush、替换失败和内存一致性**

```rust
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct FixtureFile { name: String }

#[test]
fn failed_atomic_replace_keeps_old_file_and_repository_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let files = std::sync::Arc::new(FailingConfigFileStore::new(dir.path()));
    let path = SafeRelativePath::parse("fixture.json").unwrap();
    let repo = JsonRepository::new(files.clone(), path.clone(), FixtureFile::default()).unwrap();
    repo.save(FixtureFile { name: "old".into() }).unwrap();
    files.fail_next(WriteStage::Replace);

    assert!(repo.save(FixtureFile { name: "new".into() }).is_err());
    assert_eq!(repo.snapshot().name, "old");
    let disk: FixtureFile = serde_json::from_slice(&files.read(&path).unwrap().unwrap()).unwrap();
    assert_eq!(disk.name, "old");
}
```

再写 `successful_write_orders_sync_before_replace`，用 `RecordingAtomicFileOps` 断言阶段严格为 `CreateTemp → Write → SyncFile → Replace → SyncParent`；并写 `config_store_rejects_intermediate_symlink_or_junction_escape`、`config_store_rejects_final_handle_outside_root_after_create`、`config_store_rejects_reparse_escape_without_touching_outside_sentinel`、`config_store_list_dir_returns_only_safe_relative_direct_children`、`config_store_list_missing_directory_returns_empty`、`config_store_list_and_remove_tree_reject_reparse_descendant`、`config_store_remove_tree_rejects_root_and_file_target`、`config_store_remove_tree_missing_is_idempotent`、`config_store_remove_empty_dir_requires_empty_directory`、`config_store_remove_empty_dir_missing_is_idempotent`、`failing_config_store_injects_list_and_remove_failures`。

- [ ] **Step 2: 运行测试并确认存储抽象不存在**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test atomic_file_store`

Expected: FAIL，无法解析 `storage` 模块。

- [ ] **Step 3: 定义文件接口、故障阶段和测试替身**

```rust
pub enum ConfigEntryKind { File, Directory }

pub struct ConfigDirEntry {
    pub relative_path: SafeRelativePath,
    pub kind: ConfigEntryKind,
}

pub trait ConfigFileStore: Send + Sync {
    fn read(&self, path: &SafeRelativePath) -> Result<Option<Vec<u8>>, AppError>;
    fn write_atomic(&self, path: &SafeRelativePath, bytes: &[u8]) -> Result<(), AppError>;
    fn remove_if_exists(&self, path: &SafeRelativePath) -> Result<(), AppError>;
    fn sha256(&self, path: &SafeRelativePath) -> Result<Option<String>, AppError>;
    fn ensure_dir(&self, path: &SafeRelativePath) -> Result<(), AppError>;
    fn list_dir(&self, path: &SafeRelativePath) -> Result<Vec<ConfigDirEntry>, AppError>;
    fn remove_empty_dir(&self, path: &SafeRelativePath) -> Result<(), AppError>;
    fn remove_tree(&self, path: &SafeRelativePath) -> Result<(), AppError>;
}
```

`FsConfigFileStore::new(root)` 先固定 canonical root，之后所有 API 只接受 Task 2 `SafeRelativePath`；`list_dir` 只返回指定目录的直接子项、按相对路径排序，目标目录不存在固定返回 `Ok([])`，遇到 symlink/junction/reparse 或无法确认类型的 entry 整体失败，不跟随、不跳过。`remove_empty_dir` 只接受空目录、目标不存在返回 `Ok(())`；`remove_tree` 拒绝 config root、普通文件和任何含 reparse descendant 的树，目标不存在同样返回 `Ok(())`，存在时必须先完成整棵树只读预检，再自底向上删除，不能边枚举边删除。它只用于事务拥有的 `.migration/<transactionId>` 等精确子树；业务调用方不得用它清理任意用户目录。`tests/support/mod.rs` 提供线程安全的 `FailingConfigFileStore::fail_next(stage)`，故障阶段包含 `EnsureDir/ListDir/Remove/RemoveTree`；`atomic_file.rs` 内部定义更窄的 `AtomicFileOps`，以便测试记录 `CreateTemp/Write/SyncFile/Replace/SyncParent`，生产 `FsAtomicFileOps` 只封装系统调用。

- [ ] **Step 4: 实现平台原子写入顺序**

每次 read/write/remove/hash/create-dir/list/remove-tree 前都通过 `path_guard` 从固定 root 逐组件验证：拒绝 symlink/junction/reparse point；Windows 用 `FILE_FLAG_OPEN_REPARSE_POINT` 检查属性，并用最终 handle path 证明现有目标/最近父目录仍在 canonical root 内；创建 temp/目标后再次按 handle 复核再 replace。目录枚举和递归删除对每个 descendant 重复同一 handle 校验，预检完成后若文件身份变化则失败封闭。其他平台用 `symlink_metadata` + canonical existing ancestor/final path 实现同一不变量。任何逃逸返回 Task 2 的脱敏 `PATH_ESCAPE`，外部哨兵字节不变；不能只做 lexical join。

生产实现写同目录唯一 `.tmp`，顺序必须是 `write_all` → `File::sync_all` → 原子替换 → 父目录可用时同步。Windows 替换使用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`；失败时删除临时文件并保留旧目标。增加：

```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_Foundation", "Win32_Storage_FileSystem"] }

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 5: 明确替换后同步的提交语义**

在原子替换成功前的任何错误都返回 `Err` 且旧文件保持；替换一旦成功即视为 committed。Windows 的 `MOVEFILE_WRITE_THROUGH` 提供替换写穿；其他平台若后续父目录同步不可用，只记录不含路径内容/数据内容的 warning 并返回 `Ok`，避免磁盘已是新值却让 repository 保留旧内存快照。

- [ ] **Step 6: 实现写后更新内存的 `JsonRepository<T>`**

`save(next)` 必须先序列化并成功落盘，再替换 Mutex 内快照。通用 `JsonRepository` 读取损坏时只返回无路径的内部 `RepositoryLoadError::Corrupt`；它不能依赖 Task 7 才定义的 v2 文件枚举，也不能把动态 event 文件误标成固定配置。Task 7 `Repositories::open_existing` 在逐个已知 `V2TargetName` 打开时捕获该错误，再显式调用 `SecureBackupService.backup(BackupSourceId::V2(target))`；原文件保持原位。该错误自定义 `Debug`/`Display`，只输出“配置文件损坏”，不输出路径、原始字节或 JSON 片段；不得直接序列化给前端，也不得自动移动、覆盖或创建明文 `.bak`。

增加 `corrupt_load_error_redacts_content_and_creates_no_plaintext_backup`：写入包含 `fixture-secret` 的损坏 JSON，断言 `Debug`/`Display` 不含该文本，且目录中没有 `.bak`。

- [ ] **Step 7: 运行存储和现有后端检查**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test atomic_file_store && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 测试 PASS；写入阶段顺序正确；替换失败后旧文件与内存快照一致；symlink/junction/reparse 不能逃逸 root；无 `.bak` 文件产生。

- [ ] **Step 8: 代码简化审查并提交**

使用 `@code-simplifier` 检查平台分支与 repository 锁范围；若修改，重跑 Step 7。

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/storage src-tauri/src/lib.rs src-tauri/tests/atomic_file_store.rs src-tauri/tests/support/mod.rs
git commit -m "feat: 新增安全原子配置存储"
```

### Task 5: 通过 Chunk 1 完整回归

**Files:**
- Verify only: all files changed in Tasks 1-4

- [ ] **Step 1: 运行完整前端回归**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: 全部成功，无跳过或未处理 Promise 警告。

- [ ] **Step 2: 运行完整 Rust 回归**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；测试至少包含 Backend 错误脱敏、供应商解析、原子写阶段和失败注入用例。

- [ ] **Step 3: 核对敏感字段和提交范围**

Run: `rg -n "apiKey|secretValue|fixture-secret" src/api/v2 src-tauri/src/domain src-tauri/src/storage src-tauri/tests`

Expected: `apiKey`/`secretValue` 只出现在负向断言或写入请求 DTO；`fixture-secret` 只出现在脱敏测试输入，绝不出现在序列化期望值。

Run: `git status --short`

Expected: 仅显示本 Chunk 预期文件；若出现执行前已有文件，停止并报告，不继续 Chunk 2。

Run: `$base = git merge-base HEAD dev; git diff --name-only "$base..HEAD"`

Expected: 已提交差异只包含 Tasks 1-4 列出的文件；若 `dev` 已移动导致基线不再唯一，停止并记录执行开始时的基线提交后重跑精确 diff。

## Chunk 2: 密钥、版本化仓库与事务迁移

### Task 6: 实现 DPAPI 密钥与加密备份边界

**Files:**
- Create: `src-tauri/src/secrets/mod.rs`
- Create: `src-tauri/src/secrets/model.rs`
- Create: `src-tauri/src/secrets/secret_store.rs`
- Create: `src-tauri/src/secrets/dpapi.rs`
- Modify: `src-tauri/src/domain/provider.rs`
- Modify: `src-tauri/src/domain/provider_registry.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Test: `src-tauri/tests/secret_store.rs`

- [ ] **Step 1: 写失败测试固定 SecretValue、SecretRef 与 FakeSecretStore**

```rust
#[test]
fn secret_value_and_reference_never_debug_plaintext() {
    let value = SecretValue::new(b"fixture-secret".to_vec());
    let reference = SecretRef::parse("dpapi:00000000-0000-4000-8000-000000000001").unwrap();
    assert_eq!(format!("{value:?}"), "SecretValue([REDACTED])");
    assert_eq!(format!("{reference:?}"), "SecretRef(dpapi:…0001)");
}

#[test]
fn secret_fake_store_round_trips_and_deletes_by_reference() {
    let store = FakeSecretStore::default();
    let reference = store.put(SecretValue::from("fixture-secret")).unwrap();
    assert_eq!(store.get(&reference).unwrap().expose_for_runtime(), b"fixture-secret");
    store.delete(&reference).unwrap();
    assert!(!store.exists(&reference).unwrap());
}
```

再写：

- `secret_ref_deserialize_rejects_path_traversal`：JSON 字符串 `"dpapi:..\\settings.json"` 反序列化失败。

- [ ] **Step 2: 运行基础密钥测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test secret_store`

Expected: FAIL，无法解析 `secrets` 模块。

- [ ] **Step 3: 实现最小密钥值、引用、接口和 Fake**

增加 `zeroize = "1"`，并把现有 `uuid` features 扩为 `v4,v5`。核心接口固定为：

```rust
pub struct SecretValue(zeroize::Zeroizing<Vec<u8>>);

pub trait DataProtector: Send + Sync {
    fn protect(&self, plaintext: &[u8], purpose: &str) -> Result<Vec<u8>, AppError>;
    fn unprotect(&self, ciphertext: &[u8], purpose: &str) -> Result<SecretValue, AppError>;
}

pub trait SecretStore: Send + Sync {
    fn put(&self, value: SecretValue) -> Result<SecretRef, AppError>;
    fn put_at(&self, reference: &SecretRef, value: SecretValue) -> Result<(), AppError>;
    fn get(&self, reference: &SecretRef) -> Result<SecretValue, AppError>;
    fn exists(&self, reference: &SecretRef) -> Result<bool, AppError>;
    fn list_refs(&self) -> Result<Vec<SecretRef>, AppError>;
    fn delete(&self, reference: &SecretRef) -> Result<(), AppError>;
}
```

复用 Task 2 的 `domain::provider::SecretRef`；本任务为其增加随机 v4 的 `random()` 和 UUID v5 的 `for_migration(transaction_id, slot_id)`，并更新 ProviderRevision/ProviderRegistry 测试为强类型输入。`SecretValue` 不实现 `Display`，`Debug` 永远脱敏；只有 `expose_for_runtime()` 返回临时字节切片。

- [ ] **Step 4: 运行基础测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test secret_store`

Expected: SecretValue/SecretRef/Fake 测试 PASS。

- [ ] **Step 5: 写失败测试固定 DPAPI round-trip、envelope 和内存边界**

新增 `dpapi_round_trip_uses_current_user_scope`、`dpapi_truncated_or_unknown_envelope_is_rejected`、`dpapi_protected_backup_does_not_contain_plaintext`、`dpapi_local_blob_zeroes_before_free`、`dpapi_native_error_releases_allocations`、`dpapi_rejects_oversized_or_invalid_native_blob`、`dpapi_passes_ui_forbidden_without_local_machine_flag`。后四个使用 FakeDpapiNative/FakeLocalMemory 记录 flags、清零和释放顺序；测试输入只用 `fixture-secret`，并断言 Debug/Error 不含该值。

- [ ] **Step 6: 运行 DPAPI 测试并确认实现缺失**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test secret_store dpapi_`

Expected: FAIL，`DpapiProtector` 尚未实现。

- [ ] **Step 7: 实现当前用户范围的 Windows DPAPI 包装**

在 `dpapi.rs` 先定义可注入 `DpapiNative`/`LocalMemory` 边界；生产 `WindowsDpapiNative` 是唯一 unsafe FFI 区域，测试 fake 可返回 null/异常长度并记录 flags/free。为现有 `windows-sys` 依赖增加 `Win32_Security_Cryptography`；`LocalFree/HLOCAL` 继续使用已有 `Win32_Foundation`。使用 `CryptProtectData`/`CryptUnprotectData`、UTF-8 entropy `com.tht.panel:v2:<purpose>`、`CRYPTPROTECT_UI_FORBIDDEN`，显式断言 flags 不含 `CRYPTPROTECT_LOCAL_MACHINE`。description、reserved、prompt 和 `ppszDataDescr` 均传 null，避免额外分配描述字符串。所有输入长度先 `u32::try_from`，超长返回 Validation；成功后校验 `pbData != null` 且长度有效。返回 envelope 固定为 ASCII `THTDPAPI\0` + `VERSION=1u16` 小端 + DPAPI 数据；用可单测 RAII `LocalBlob` 保证所有成功/错误路径调用 `LocalFree`，敏感解密输出在释放前用 volatile 写零，复制出的明文字节进入 `Zeroizing`。

- [ ] **Step 8: 运行 DPAPI 测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test secret_store dpapi_`

Expected: PASS；密文不含明文，未知版本失败封闭。

- [ ] **Step 9: 写失败测试固定 DpapiSecretStore 的引用绑定与幂等语义**

新增 `secret_store_put_at_same_reference_and_value_is_idempotent`、`secret_store_put_at_same_reference_with_different_value_conflicts`、`secret_store_delete_missing_reference_is_success`、`secret_store_list_refs_returns_only_valid_blob_names`、`secret_store_swapped_ciphertext_files_fail_to_decrypt`、`secret_store_concurrent_different_values_conflict_without_overwrite`、`secret_store_directory_creation_failure_is_reported`、`secret_store_rejects_secrets_directory_symlink_or_junction_escape`。

- [ ] **Step 10: 运行 store 测试并确认实现缺失**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test secret_store secret_store_`

Expected: FAIL，`DpapiSecretStore` 尚未实现。

- [ ] **Step 11: 实现文件型 DpapiSecretStore**

复用 Task 4 已交付的 `ensure_dir/list_dir`。密文保存到 `secrets/<uuid>.bin`，`put_at` 首次写入前懒创建 `secrets/`，并继承每次 I/O 的 no-reparse descendant/最终 handle 校验，再用 `write_atomic` 落盘；预存 symlink/junction 必须在读取或写入外部目标前失败。`list_refs` 只枚举 `secrets/` 的直接普通文件，把严格匹配 `<uuid>.bin` 的名称转为 `SecretRef`，未知文件名只产生脱敏 warning 且不作为引用返回，目录/reparse entry 则失败封闭；空目录判定不得因预创建 secrets 目录失真。`DpapiSecretStore` 内用 Mutex 串行同一实例的 `put_at/delete` 读-比-写临界区，避免并发异值覆盖。`put` 生成随机 UUID 后委托 `put_at`；`put_at/get` 都以规范化完整 SecretRef 作为 purpose（`provider-secret:<secretRef>`），因此密文文件互换不能解密。`put_at` 同 ref+同值幂等成功，同 ref+异值保留 `AppError::Conflict`；`delete` 对缺失引用也成功。只有 DPAPI、文件和 envelope 格式错误统一映射为 `AppError::Secret`，不得包含 Win32 输入数据或密文正文。

- [ ] **Step 12: 运行全部密钥测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test secret_store`

Expected: 全部 PASS；失败输出不含 `fixture-secret`。

- [ ] **Step 13: 代码简化审查并提交**

使用 `@code-simplifier` 审查 FFI 清理和密钥暴露范围；若修改，重跑 Step 12。

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/secrets src-tauri/src/domain/provider.rs src-tauri/src/domain/provider_registry.rs src-tauri/src/lib.rs src-tauri/tests/secret_store.rs
git commit -m "feat: 新增 DPAPI 密钥存储"
```

### Task 7: 建立版本化领域仓库和 ProviderService

**Files:**
- Create: `src-tauri/src/storage/schema.rs`
- Create: `src-tauri/src/storage/repositories.rs`
- Create: `src-tauri/src/storage/provider_store.rs`
- Create: `src-tauri/src/storage/secure_backup.rs`
- Create: `src-tauri/src/application/mod.rs`
- Create: `src-tauri/src/application/mutation_gate.rs`
- Create: `src-tauri/src/application/provider_service.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/provider_service.rs`
- Test: `src-tauri/tests/secure_backup.rs`

- [ ] **Step 1: 写失败测试固定 fresh/existing 仓库启动语义**

新增 `repository_fresh_writes_marker_and_reopens`、`repository_fresh_crash_after_each_default_file_recovers`、`repository_fresh_marker_written_before_intent_delete_recovers`、`repository_tampered_fresh_intent_cannot_delete_legacy_secret_or_runtime_files`、`repository_fresh_intent_unknown_target_id_fails_with_zero_mutation`、`repository_marker_with_missing_required_file_fails`、`repository_nonempty_extra_options_semantic_validation_blocks_open_and_backs_up`、`repository_noncanonical_native_session_id_blocks_open_and_backs_up`、`repository_cross_conversation_native_identity_duplicate_blocks_open_and_backs_up`、`repository_driver_defaults_common_args_or_unknown_settings_source_blocks_open_and_backs_up`、`repository_driver_defaults_invalid_executable_blocks_open_and_backs_up`、`repository_corrupt_v2_file_creates_dpapi_backup_without_plaintext`、`repository_corrupt_backup_is_idempotent`、`repository_corrupt_backup_failure_keeps_source_and_blocks_open`、`repository_corrupt_backup_reparse_escape_keeps_source_and_outside_sentinel`、`repository_legacy_without_marker_requires_migration`、`repository_pending_journal_blocks_open`。

- [ ] **Step 2: 运行仓库启动测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test provider_service repository_`

Expected: FAIL，`Repositories` 与 v2 schema 尚不存在。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test secure_backup`

Expected: FAIL，通用 DPAPI corrupt backup service 尚不存在；不得是 `0 tests`。

- [ ] **Step 3: 定义所有 v2 顶层文件 schema**

`schema.rs` 创建 `Versioned<T> { version, data }`，并定义版本 2 文件：`AppSettingsFile`、`GlobalPreferencesFile`、`ProjectsFile`、`ProvidersFile`、`ConversationsFile`、`TerminalSessionsFile`、`CurrentWorkspaceFile`、`WorkspaceLayoutsFile`。`ProjectsFile` 保持 `{"version":2,"data":[Project...]}` 兼容外形，并增加 `#[serde(default, skip_serializing_if="Vec::is_empty")] historyTombstones: Vec<ProjectHistoryTombstone>`；active Project 与 tombstone ID 集合必须互斥，所有 Project writer 都保留未知于自身的 tombstones。每份文件默认空集合/默认设置；`CurrentWorkspaceFile` 默认包含一个空 leaf 且 `sourceSavedWorkspaceId=null`；`ProvidersFile` 可含 `DriverDefaults`、profiles、revisions、models，但不得含密钥正文。

- [ ] **Step 4: 实现只在迁移完成后打开的 Repositories**

拆成 `Repositories::initialize_fresh` 与 `Repositories::open_existing`：

- fresh 仅在无 marker、无 migration journal、无已知 legacy/v2 文件时允许（可忽略受控的空 `secrets/`）；生成随机 fresh transactionId，先在内存生成 8 个默认文件 bytes/hash，再原子写 `fresh-init.json` intent，之后才逐个安装目标，最后写统一 schema `schema-version.json { version:2, transactionId }`，intent 始终最后删除。`V2TargetName` 必须在本 Task 的 `schema.rs` 定义，Task 9 只能复用，不能反向依赖后续任务。intent schema 只含 `formatVersion`、canonical transactionId 和闭合 `targets: Vec<{ target: V2TargetName, expectedSha256, installed }>`，不持久化任何 relative path；install path 由代码纯函数派生。load 时拒绝未知/重复/缺失 target、bad hash、额外 path 字段和非 canonical transactionId，并在任何 remove/write 前完整预检 8 个目标：每项只允许 missing 或 expected hash；即使崩溃发生在 target 写成功但 installed bit 尚未更新，expected hash 仍能证明归属并幂等继续/清理；任一 unknown hash 立即 Blocked、全树零修改。启动发现合法 intent 且没有 marker 时，只处理由闭合 target 派生且 bytes 等于 expected hash 的默认目标；损坏 intent 绝不能删除 `secrets/`、runtime、legacy 文件或其他根内路径。intent 与完整 marker/8 文件同时存在且 transactionId 匹配时，只删除 intent 后 open_existing；没有 intent 的未知/非默认 v2 文件必须报错，不能当 fresh。
- existing 必须看到合法 marker version=2，且 8 个必需文件全部存在、各自 version=2、JSON 完整；还要对 ProviderRevision/model extraOptions、SecretRef、RuntimeNamespace、RuntimeSegment/LegacyHistorySource 中的 NativeSessionId 和 backend-owned DriverDefaults 调用 domain 语义 validator，并验证 native identity 只在同一 Conversation lineage 内重复、跨 Conversation 必须失败。DriverDefaults.commonArgs 必须为空、settingsSources 必须来自 driver-specific 闭合枚举、executable 必须为 Auto 或符合 Windows 可执行文件规则的绝对普通文件；JSON 合法但违反任一不变量同样按损坏配置处理。缺失/未知版本都报错，绝不静默 default。损坏/语义非法 JSON 先调用通用 `SecureBackupService` 生成 DPAPI 加密副本，再返回错误由 bootstrap 发布 Blocked；备份失败同样 Blocked，原文件始终不移动、不覆盖。
- legacy/no marker 返回 MigrationRequired；pending journal 返回 MigrationRequired/Recovering，不能打开普通仓库。

每个领域使用独立 `JsonRepository<T>`，不在单个巨型 store 中混合职责。

`storage/secure_backup.rs` 定义闭合 `BackupSourceId::{SchemaMarker,V2(V2TargetName)}`，source path 只由 enum 派生；备份路径固定为 `corrupt-backups/<source-id>/<source-sha256>.dpapi`，purpose 固定为 `corrupt-v2:<source-id>:<sha256>`。服务用 Task 4 ConfigFileStore 与 Task 6 DataProtector，读取原始损坏 bytes 后立即放入 Zeroizing，hash 再确认未发生 TOCTOU，encrypt/write 成功后读回解密比对。已存在同名 backup 时，只有解密内容与当前 source 完全相同才幂等成功，否则失败封闭；任何失败都保持 source 与外部哨兵不变。backup 目录枚举/创建/写入继续遵循 no-reparse guard，日志/错误只含闭合 source ID/hash 前缀，不含路径或正文。

- [ ] **Step 5: 运行仓库启动测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test provider_service repository_ && cargo test --manifest-path src-tauri/Cargo.toml --test secure_backup`

Expected: PASS；fresh marker/intention 的每个崩溃点均可再次打开。

- [ ] **Step 6: 写失败测试固定 ProviderStore 引用保护**

新增 `provider_store_referenced_revision_retires_instead_of_delete`、`provider_store_phase_a_never_physically_deletes_revision`、`provider_store_snapshot_write_is_atomic`。

- [ ] **Step 7: 运行 ProviderStore 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test provider_service provider_store_`

Expected: FAIL，ProviderStore 尚不存在。

- [ ] **Step 8: 实现 ProviderStore 的引用保护**

`ProviderStore` 提供 profile/revision/model 查询与一次性 `save_snapshot`。Phase A 无论当前是否发现 RuntimeSegment 引用，都不物理删除任何已提交 revision/secret，只设置 `retiredAt` 或 profile `deletedAt`，从根本上消除与后续 ConversationManager 创建运行段之间的 TOCTOU；物理 GC 留到全局事务/引用审计完成后的后续加固阶段。

- [ ] **Step 9: 运行 ProviderStore 测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test provider_service provider_store_`

Expected: PASS；引用中的 revision 不被物理删除。

- [ ] **Step 10: 写失败测试固定 ProviderService 补偿与并发**

```rust
#[test]
fn provider_service_rolls_back_new_secret_when_json_write_fails() {
    let fixture = ProviderServiceFixture::new();
    let original = fixture.create_provider("provider-1", "old-secret");
    fixture.files.fail_next(WriteStage::Replace);

    let result = fixture.service.save(ProviderSaveRequest::editing_with_new_secret(
        original.id.clone(), "new-secret"));

    assert!(result.is_err());
    assert_eq!(fixture.provider_snapshot(), original.registry_snapshot);
    assert_eq!(fixture.secrets.live_values(), vec!["old-secret"]);
}
```

再写 `provider_service_blank_secret_reuses_current_reference`、`provider_service_changed_config_keeps_old_revision`、`provider_service_public_detail_hides_secret`、`provider_service_secret_configured_reflects_store_state`、`provider_service_request_debug_redacts_secret`、`provider_service_errors_hide_secret_sentinel`、`provider_service_registry_error_happens_before_secret_write`、`provider_service_public_save_acquires_gate_once`、`provider_service_prepare_change_locked_reuses_existing_guard_without_deadlock`、`provider_service_concurrent_saves_are_serialized_without_orphan_secret`、`provider_service_rollback_delete_failure_returns_redacted_secret_error_and_keeps_provider_snapshot`、`provider_service_startup_retries_unreferenced_secret_cleanup`、`provider_service_cleanup_reference_source_failure_deletes_nothing`。

- [ ] **Step 11: 运行 ProviderService 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test provider_service provider_service_`

Expected: FAIL，ProviderService 尚不存在。

- [ ] **Step 12: 实现 ProviderService 的副作用顺序**

`ProviderSaveRequest.secret` 使用自定义 `IncomingSecret(Zeroizing<String>)` 反序列化，Debug 永远脱敏且不实现 Clone；service 消费请求所有权并把底层字节直接移动进 SecretValue，不复制普通 String。新增可共享的 `ApplicationMutationGate(Arc<Mutex<()>>)`，只通过 `acquire() -> MutationGuard` 暴露私有构造的类型化 guard；`ProviderService`、Task 11 的跨文件 coordinator、Task 15 的 project/preferences 写必须注入同一个 gate，不能各建私有 Mutex。公开 `ProviderService::save()` 自行且只取得一次 guard，再调用内部 `save_locked(&MutationGuard, ...)`；供 coordinator 使用的 `prepare_change_locked(&MutationGuard, ...)` 只做纯校验/快照准备，绝不再次取锁。禁止已持 guard 的代码调用公开 `save()`，超时测试必须证明该路径不会发生非重入死锁。

公开保存路径固定顺序：取得 `MutationGuard` → 校验 → 生成尚未落盘的随机 SecretRef（或沿用旧 ref）→ 调用纯 `ProviderRegistry` 生成新快照并预构造公开 DTO → `put_at` 新密钥 → 原子保存 providers.json；coordinator 路径从调用方传入同一 guard 并从校验步骤开始。已有 provider 的 `secretConfigured` 由 `SecretStore.exists(currentRef)` 决定，不能只看 revision 有 ref；新密钥成功返回固定为 true。`save_snapshot` 一返回 Ok，第一条语句就 disarm `PendingSecretGuard`，因为 JSON 已提交，此后绝不能删除新 ref；随后只返回已预构造、无失败转换的 DTO。显式 Err 路径调用可返回结果的 `rollback()`，删除失败升级为脱敏 Secret 错误并保持旧 provider snapshot；加密 blob 可暂留但不得被引用。启动清理严格按“migration recover 成功且无 pending Journal → providers 全量加载/校验成功 → active migration refs 读取成功 → SecretStore.list_refs 成功 → 集合差删除”顺序执行；任一引用源/枚举失败时零删除并报 warning。Drop 只作为 panic 展开时的 best-effort。已提交历史 secretRef 在 Phase A 永不 GC。空密钥且 `keepExistingSecret=false` 返回 Validation。

- [ ] **Step 13: 运行 ProviderService 与全量 Rust 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test provider_service && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS；JSON 快照不含 `old-secret`/`new-secret`，失败写入后 registry 与 secret 集合均回到旧状态。

- [ ] **Step 14: 代码简化审查并提交**

使用 `@code-simplifier` 检查仓库职责和补偿逻辑；若修改，重跑 Step 13。

```bash
git add src-tauri/src/storage src-tauri/src/application src-tauri/src/lib.rs src-tauri/tests/provider_service.rs src-tauri/tests/secure_backup.rs
git commit -m "feat: 新增版本化仓库与供应商服务"
```

### Task 8: 实现无副作用迁移预览与确定性 v1 映射

**Files:**
- Create: `src-tauri/src/migration/mod.rs`
- Create: `src-tauri/src/migration/model.rs`
- Create: `src-tauri/src/migration/legacy_reader.rs`
- Create: `src-tauri/src/migration/planner.rs`
- Create: `src-tauri/tests/fixtures/migration/v1/settings.json`
- Create: `src-tauri/tests/fixtures/migration/v1/workspaces.json`
- Create: `src-tauri/tests/fixtures/migration/v1/sessions.json`
- Create: `src-tauri/tests/fixtures/migration/v1/layout.json`
- Create: `src-tauri/tests/fixtures/migration/v1/settings.json.bak`
- Create: `src-tauri/tests/fixtures/migration/v1/settings.json.tmp`
- Create: `src-tauri/tests/fixtures/migration/v1/workspaces.json.bak`
- Create: `src-tauri/tests/fixtures/migration/v1/workspaces.json.tmp`
- Create: `src-tauri/tests/fixtures/migration/v1/sessions.json.bak`
- Create: `src-tauri/tests/fixtures/migration/v1/sessions.json.tmp`
- Create: `src-tauri/tests/fixtures/migration/v1/layout.json.bak`
- Create: `src-tauri/tests/fixtures/migration/v1/layout.json.tmp`
- Create: `src-tauri/tests/fixtures/migration/v1/codex-homes/workspace-codex/sessions/fixture.jsonl`
- Create: `src-tauri/tests/migration_planner.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

- [ ] **Step 1: 写失败测试固定 LegacyReader 的只读与内存脱敏边界**

新增 `legacy_reader_reads_only_known_files`、`legacy_reader_inventories_known_bak_and_tmp_without_parsing_them_as_authoritative`、`legacy_reader_unknown_similar_artifact_is_rejected_not_silently_ignored`、`legacy_reader_missing_file_is_empty`、`legacy_reader_corrupt_file_creates_no_bak`、`legacy_reader_dto_debug_and_errors_redact_secret_values`、`migration_model_transaction_id_requires_canonical_uuid`。

- [ ] **Step 2: 运行 LegacyReader 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner legacy_reader_`

Expected: FAIL，LegacyReader 尚不存在；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner migration_model_`

Expected: FAIL，迁移安全标识尚不存在；不得是 `0 tests`。

- [ ] **Step 3: 创建只读 LegacyReader 与安全迁移标识**

LegacyReader 只把 `settings.json`、`workspaces.json`、`sessions.json`、`layout.json` 解析为权威 legacy DTO；同时在 `legacy_reader.rs` 的单一 `LEGACY_ARTIFACT_ALLOWLIST: [&str; 8]` 中精确列出它们各自的 `.bak`/`.tmp` 共 8 个历史 artifact，其他生产模块只能消费该清单/manifest，禁止重复散落字面量。这些 bytes 可能含明文密钥但绝不参与配置解析。canonical/artifact 整份 bytes 立即放入 `Zeroizing<Vec<u8>>`，不得 `read_to_string`；使用迁移专用 DTO，`apiKey` 自定义反序列化到 `SecretValue`/可清零容器，不能复用含普通 `String` 的旧 `AgentConfig`。缺失文件/允许的 artifact 视为 absent，canonical 损坏返回脱敏错误，不移动、不覆盖、不再生成 `.bak`。发现相似但不在 allow-list 的 legacy temp/backup 名称时失败封闭并要求人工检查，不能在 committed tree 留下未盘点候选。只把明确名为 `apiKey` 的字段标记为密钥，未知字符串不得自动迁移。

`migration/model.rs` 定义本 Chunk 立即需要的 `TransactionId`，手写反序列化且只接受 canonical hyphenated UUID；路径直接复用 Task 2 `domain::path::SafeRelativePath`。MigrationPlan/Journal 和持久化 LegacyHistorySource 使用同一个低层值对象，不在 migration 层重复定义。

- [ ] **Step 4: 运行 LegacyReader 测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner legacy_reader_ && cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner migration_model_`

Expected: PASS；4 个 canonical 与 8 个 allow-listed artifact 的数量/hash 逐字节不变，未生成 allow-list 之外的新 `.bak`/`.tmp`，Debug/Error 不含三个 fixture key。

- [ ] **Step 5: 写失败测试固定 Project/Provider 确定性映射**

新增 `planner_global_defaults_create_two_profiles`、`planner_global_defaults_record_reserved_compatibility_mapping`、`planner_missing_driver_default_leaves_only_that_compatibility_mapping_null`、`planner_local_workspace_config_creates_project_profile`、`planner_same_sources_produce_same_entity_ids`、`planner_same_sources_with_different_wall_clocks_produce_identical_target_bytes`、`planner_migrated_conversation_freezes_project_path_snapshot`、`planner_migrated_segment_freezes_cwd_snapshot`、`planner_cross_conversation_native_identity_duplicate_blocks_preview_without_mutation`、`planner_same_config_never_merges_across_profiles`、`planner_nonempty_legacy_extra_args_blocks_without_mutation_or_echo`。

- [ ] **Step 6: 运行实体映射测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner planner_`

Expected: FAIL，Planner 实体映射尚不存在。

- [ ] **Step 7: 实现确定性 ID 与配置映射**

使用 Task 6 已启用的 UUID v5，以固定 namespace 加源类型和旧稳定 ID/path 哈希生成 Project/Provider/Conversation/Terminal ID；同一输入重复规划得到相同结果。MigrationPlanner 不接收 RNG 或 wall clock：所有生成 ID 使用 UUID v5，合法 legacy 时间戳规范化后原样保留，源缺少时间戳时统一使用公开常量 `MIGRATION_EPOCH = 1970-01-01T00:00:00Z`，禁止 `Utc::now()`/随机 UUID 进入任一 target JSON。映射任何旧 AgentConfig 前先调用 domain `validate_extra_options`；非空 extraArgs 使 preview/apply 返回不回显 token 的人工修复错误，所有 source hash/bytes 不变，不生成部分目标。全局 Claude/Codex defaults 各建确定性 reserved profile/revision，并把对应 provider ID 写入目标 AppSettings.CompatibilitySettings；某 driver 源确实缺失时只让该字段为 null，不能误指向另一 driver。`useGlobalConfig=false` 每项目建专属 profile；同一旧配置也不得跨 profile 合并。每个迁移 Conversation 从旧 Project.path 写入不可变 `projectPathSnapshot`，每个迁移 RuntimeSegment 从对应旧会话/项目工作目录写入不可变 `cwdSnapshot`。 Planner 同时按 `(driver, runtimeNamespaceId, NativeSessionId)` 建立 owner Conversation 映射；同一 Conversation lineage 可重复，跨 Conversation 重复在 preview/apply 前返回脱敏 Conflict，源与任何 target 均零修改，绝不能提交后再让 bootstrap Blocked。

- [ ] **Step 8: 运行实体映射测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner planner_`

Expected: PASS；实体 ID、profile 边界和 legacy runtime locator 均确定；目标 JSON 不含用户 HOME/原生配置绝对路径，只允许内部保存已验证的 `projectPathSnapshot/cwdSnapshot`，且公开 DTO 不返回这些快照。

- [ ] **Step 9: 写失败测试固定会话和布局映射**

新增 `mapping_ai_session_binds_or_needs_selection`、`mapping_native_session_id_rejects_option_response_file_and_noncanonical_aliases_without_mutation`、`mapping_shell_session_becomes_terminal_session`、`mapping_layout_v1_keeps_skeleton_without_fake_tabs`、`mapping_codex_session_records_legacy_workspace_namespace`、`mapping_codex_locator_is_embedded_in_conversation_target`、`mapping_needs_selection_preserves_conversation_legacy_locator_without_segment`、`mapping_project_edit_cannot_retarget_existing_conversation_snapshot`、`mapping_missing_legacy_home_is_explicit_not_guessed`、`mapping_claude_source_records_locator_without_claiming_provider_ownership`。

- [ ] **Step 10: 运行会话/布局测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner mapping_`

Expected: FAIL，会话/布局映射尚不存在。

- [ ] **Step 11: 实现会话和布局映射**

AI ManagedSession 转 Conversation，并把当时的 Project.path 冻结为 `projectPathSnapshot`；任何旧 `aiSessionId/externalSessionId` 必须先经 `NativeSessionId::parse_for_driver`，非法值使 preview/apply 在源零修改下失败，不能作为 argv token或 locator 保留；只有项目 agent/config 能唯一定位 provider revision 时才绑定，否则 `needsProviderSelection=true`。Shell 转 TerminalSession，稳定 `cwd` 字段就是创建时快照。旧 Codex 会话若来自应用自管 `codex-homes/<workspaceId>`，RuntimeSegment 使用 `codex-legacy-workspace:<projectUuid>` 命名空间并冻结 `cwdSnapshot`；同时把目录相对 config root 的 `SafeRelativePath`、owner project/marker 和不可变 `config.toml` hash 写进目标 Conversation.legacyHistorySource，因此安装后的 conversations.json 自身即可重启解析，不依赖临时 MigrationPlan/Journal。会话 JSONL 允许后续追加，由 importer 的 file identity/checkpoint 管理，不能纳入整个目录不可变 hash；迁移不移动、不重写该 HOME。旧 Claude 把 projectId/externalSessionId opaque locator 同样写入 Conversation，不能据此声称某个多供应商 profile 拥有原生历史。源缺失或身份不唯一时仍保留 Conversation/source/外部 ID 和 `projectPathSnapshot`，并标记可解释的 history unavailable/needs selection；即使没有 RuntimeSegment 也可按冻结路径只读投影，禁止回退扫描当前 Project.path、父进程环境或用户全局 HOME 猜测。布局 v1 只保留分屏方向、比例、leaf ID/locked/project context，旧格式没有稳定 Tab 引用时 `items=[]`、`activeItem=null`，不得猜测。

- [ ] **Step 12: 运行会话/布局测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner mapping_`

Expected: PASS。

- [ ] **Step 13: 写失败测试固定无副作用 Preview 与 transactionId**

```rust
#[test]
fn preview_reports_counts_without_secret_values_or_mutation() {
    let fixture = MigrationFixture::copy_v1();
    let before = fixture.file_hashes();
    let preview = fixture.planner.preview().unwrap();
    let json = serde_json::to_string(&preview).unwrap();

    assert_eq!(preview.known_secret_count, 3);
    for sentinel in ["fixture-claude-key", "fixture-codex-key", "fixture-workspace-key"] {
        assert!(!json.contains(sentinel));
    }
    assert_eq!(fixture.file_hashes(), before);
    assert!(!fixture.path("migration-journal.json").exists());
}
```

再写 `preview_same_source_states_produce_same_transaction_id`、`preview_same_sources_produce_byte_identical_targets_across_clock_and_rng_fixtures`、`preview_missing_source_changes_transaction_id`、`preview_known_backup_or_temp_change_changes_transaction_id`、`preview_plan_and_errors_hide_all_secret_sentinels`。

- [ ] **Step 14: 运行 Preview 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner preview_`

Expected: FAIL，MigrationPlan/Preview 尚未实现。

- [ ] **Step 15: 生成不含密钥的 MigrationPlan/Preview**

`MigrationPlan` 保存 byte-identical 的 canonical target JSON、4 个 canonical source 与 8 个 allow-listed artifact 的状态、确定性实体映射，以及每个密钥槽位由 `SecretRef::for_migration(transactionId, slotId)` 生成的确定性引用，但不保存密钥正文；目标 ProjectsFile 初始化 `historyTombstones=[]`。target serializer 固定字段顺序/集合排序，并复用 Step 7 的 UUID v5 与 `MIGRATION_EPOCH` 规则，禁止当前时钟、随机 UUID、HashMap 迭代顺序或临时路径进入 target bytes；同一 source manifest 的 preview、apply 和 recovery reprepare 必须得到完全相同的 bytes/hash。目标 JSON 因而可在 Prepared 前完整校验。密钥值只存在 LegacyReader 的短生命周期 `SecretValue` 中。`transactionId` 的 UUID v5 输入固定为目标 schema 版本加按 `logical_name` 排序的 `(logical_name, Present(sha256)|Absent)`，artifact 使用独立 logical name，防止缺失文件出现或相同 hash 换逻辑位置时误复用事务。前端 Preview 只含来源标签和计数。

- [ ] **Step 16: 运行 planner 测试并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；重复运行 ID/transactionId 相同，fixture 原文件 hash 不变，输出 JSON 不含 fixture key。

使用 `@code-simplifier` 审查映射分支；若修改，重跑本步骤。

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/migration src-tauri/src/lib.rs src-tauri/tests/fixtures/migration src-tauri/tests/migration_planner.rs
git commit -m "feat: 新增旧数据迁移预览"
```

### Task 9: 实现可注入的四阶段 Migration Journal 核心与幂等恢复

**Files:**
- Create: `src-tauri/src/migration/journal.rs`
- Create: `src-tauri/src/migration/coordinator.rs`
- Create: `src-tauri/src/migration/secure_backup.rs`
- Modify: `src-tauri/src/migration/mod.rs`
- Test: `src-tauri/tests/migration_recovery.rs`

- [ ] **Step 1: 写失败测试固定 Journal schema 与路径安全**

新增 `journal_round_trip_preserves_all_manifests`、`journal_rejects_unknown_versions_duplicate_names_and_bad_hashes`、`journal_missing_or_extra_backup_manifest_is_rejected_with_zero_mutation`、`journal_missing_or_extra_cleanup_manifest_is_rejected_with_zero_mutation`、`journal_missing_or_extra_secret_slot_is_rejected_with_zero_mutation`、`journal_tampered_paths_or_transaction_id_are_rejected_without_touching_outside_config`、`journal_valid_but_unauthorized_in_root_target_is_rejected_with_zero_mutation`、`journal_cross_transaction_staging_or_backup_is_rejected_with_zero_mutation`、`journal_transaction_id_must_recompute_from_source_manifests`、`journal_project_slot_rejects_uppercase_braced_and_simple_uuid_aliases`、`journal_migration_secret_ref_must_match_deterministic_slot`、`journal_existing_migration_or_backup_junction_escape_is_rejected_without_touching_outside_sentinel`。路径测试覆盖 absolute、`..`、Windows prefix、`../evil` transactionId、另一个合法 UUID、指向 `secrets/`/runtime/其他 v2 文件的合法根内路径，以及 config root 内 `.migration`/`migration-backups` 的 symlink/junction；调用前后逐字节比较整个 config tree、Journal 与 SecretStore snapshot，全部复用 Task 4 guarded ConfigFileStore，不得直接 `std::fs` join 后 I/O。

- [ ] **Step 2: 运行 Journal 模型测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery journal_`

Expected: FAIL，Journal 模型/校验尚不存在。

- [ ] **Step 3: 定义 Journal 的完整可恢复字段**

```rust
pub enum MigrationStage { Prepared, SecretsVerified, FilesInstalled, Committed }

pub enum LegacySourceName {
    Settings, Workspaces, Sessions, Layout,
    SettingsBak, SettingsTmp, WorkspacesBak, WorkspacesTmp,
    SessionsBak, SessionsTmp, LayoutBak, LayoutTmp,
}

use crate::storage::schema::V2TargetName; // Task 7 的唯一闭合定义

pub enum MigrationSecretSlotId {
    Global { driver: DriverKind },
    Project { project_id: ProjectId, driver: DriverKind },
}

pub struct MigrationJournal {
    pub format_version: u32,
    pub transaction_id: TransactionId,
    pub target_schema_version: u32,
    pub stage: MigrationStage,
    pub source_files: Vec<SourceManifest>,
    pub target_files: Vec<TargetManifest>,
    pub encrypted_backups: Vec<BackupManifest>,
    pub secret_slots: Vec<SecretSlotManifest>,
    pub legacy_cleanup: Vec<LegacyCleanupManifest>,
}

pub struct SourceManifest {
    pub source: LegacySourceName,
    pub original_sha256: Option<String>,
}

pub struct TargetManifest {
    pub target: V2TargetName,
    pub original_sha256: Option<String>,
    pub sha256: String,
}

pub struct BackupManifest {
    pub source: LegacySourceName,
    pub ciphertext_sha256: String,
}

pub struct SecretSlotManifest {
    pub slot: MigrationSecretSlotId,
    pub reference: SecretRef,
    pub source: LegacySourceName,
    pub location: LegacySecretLocation,
}

pub struct LegacyCleanupManifest {
    pub source: LegacySourceName,
    pub action: LegacyCleanupAction,
}

pub enum LegacyCleanupAction {
    Remove,
    ReplaceWithSanitized {
        sanitized_sha256: String,
    },
}
```

复用 Task 8 已验证的 `TransactionId`；Journal 不再持久化任何可写路径或自由 logical-name 字符串。`LegacySourceName/V2TargetName/MigrationSecretSlotId` 均使用 `deny_unknown_fields`/未知枚举失败；代码通过纯函数 `source_path(source)`、`target_install_path(target)`、`staged_target_path(transactionId,target)`、`backup_path(transactionId,source)`、`sanitized_source_path(transactionId,source)` 派生唯一 `SafeRelativePath`。Coordinator 在任何外部 I/O/secret mutation 前验证：`format_version==1`、`target_schema_version==2`；Source 集合精确包含 4 canonical+8 artifact 且无重复；Target 集合精确包含 8 个 v2 文件；encryptedBackups 必须与所有 Present source 一一对应且恰一条；legacyCleanup 必须与确定性 MigrationPlan 要求处理的 canonical/artifact 精确一致；secretSlots 必须从 canonical target providers 与 deterministic plan 双向重算为完全相同的集合，禁止缺失、额外或重复，且每个 target SecretRef 必须有且仅有一个 slot 反向对应；所有 SHA-256 为 64 位小写十六进制；从 target schema+按 enum 固定顺序的 source Present(hash)/Absent 重新计算的 deterministic transactionId 必须等于 Journal；每个 `SecretRef` 必须精确等于 `SecretRef::for_migration(transactionId, slot.canonical_label())`，source/location 必须与 slot 推导一致。另一个合法 UUID、跨 transaction staging/backup、根内其他安全路径都没有可表达字段，若旧/篡改 JSON带这些字段则反序列化失败。`LegacySecretLocation` 是已知 `settings.claudeDefaults.apiKey` 等位置的封闭枚举，不执行 Journal 提供的任意 JSON path。Journal 本身不含密钥、旧文件正文或目标临时 JSON 正文；Prepared 时登记全部确定性 secret slot，恢复可从派生 backup/location 重新提取并清理 refs。每次阶段变化都用 Task 4 原子写。

本期派生的 v2 install path 在 legacy 迁移前必须不存在，因此所有 `TargetManifest.original_sha256` 必须为 `None`；发现预存 target 直接在 Prepared 前中止，避免没有其 backup 却尝试覆盖。字段保留用于显式校验，不支持覆盖未知 v2 文件。

- [ ] **Step 4: 运行 Journal 模型测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery journal_`

Expected: PASS；外部哨兵未修改。

- [ ] **Step 5: 写失败测试固定 Prepared 与安全 backup**

新增 `prepared_writes_validated_targets_and_encrypted_backups_before_journal`、`prepared_encrypts_every_present_known_bak_and_tmp_artifact`、`encrypted_backup_never_contains_plaintext`、`prepared_preexisting_v2_target_aborts_before_prepare`、`unjournaled_staging_is_removed_without_touching_sources`。

- [ ] **Step 6: 运行 Prepared 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery prepared_`

Expected: FAIL，Coordinator.prepare 尚不存在。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery encrypted_backup_`

Expected: FAIL，安全 backup 尚不存在。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery unjournaled_`

Expected: FAIL，staging 清理尚不存在。

- [ ] **Step 7: 实现 Prepared 与 encrypted backup**

确认 transactionId/source hash 未变化后，把每个 present canonical source 和 allow-listed `.bak`/`.tmp` artifact 整体用 `DataProtector.protect(..., "migration-backup:<transactionId>:<logicalName>")` 写为独立 `migration-backups/<transactionId>/<logicalName>.dpapi`；每个 manifest 记录原 hash。目标 JSON 写 `.migration/<transactionId>/` temp 并校验 hash；然后原子写 `migration-journal.json` 为 Prepared。此阶段旧文件/artifact 完全不变。若在根 Journal 写入前崩溃，启动只通过 Task 4 `list_dir/remove_tree` 删除无 marker 引用且 transactionId/目录身份均已验证的 staging；已加密 backup 可按保留策略清理，不触碰源。Coordinator、SecretStore 和 RuntimeOutcomeStore 后续所有目录盘点/清理同样只能走该受守卫接口，禁止直接 `std::fs::read_dir/remove_dir_all`。

- [ ] **Step 8: 运行 Prepared 测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery prepared_ && cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery encrypted_backup_ && cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery unjournaled_`

Expected: PASS。

- [ ] **Step 9: 写失败测试固定 SecretsVerified 与引用补偿**

新增 `secrets_verified_puts_and_reads_each_slot`、`secrets_verified_failure_deletes_only_successfully_written_matching_refs`、`conflicting_preexisting_planned_ref_is_not_deleted`。

- [ ] **Step 10: 运行 SecretsVerified 测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery secrets_verified_`

Expected: FAIL，SecretsVerified 转换尚不存在；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery conflicting_preexisting_`

Expected: FAIL，冲突引用补偿尚不存在；不得是 `0 tests`。

- [ ] **Step 11: 实现 SecretsVerified 与补偿**

重新从加密备份读取已知密钥槽位，逐个调用 `SecretStore.put_at(plan 中的确定性引用, value)` 并立即 `get` 比对；目标 JSON 和 target hash 在 Prepared 阶段已经包含这些 refs，此阶段不重写目标文件。任一步失败，只删除本进程内已成功写入且再次 `get` 与有效 backup 期望值一致的 refs；异值/不可解密 ref 不删。保留目标 temp、加密备份和 Prepared Journal，使同一事务可安全重试；若选择完全回滚，则连同 Journal/staging 一起删除，不能留下指向已删 temp 的 Journal。全部读回后写 `SecretsVerified`。

- [ ] **Step 12: 运行 SecretsVerified 测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery secrets_verified_ && cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery conflicting_preexisting_`

Expected: PASS。

- [ ] **Step 13: 写失败测试固定安装、legacy cleanup 与 marker 顺序**

新增 `install_targets_then_cleans_legacy_before_marker`、`install_crash_after_each_target_or_cleanup_is_detectable`、`committed_tree_contains_no_legacy_plaintext`、`committed_tree_removes_preexisting_plaintext_backup_and_temp`、`committed_tree_reopen_preserves_codex_and_claude_history_locators_with_or_without_segment`、`marker_written_before_committed_journal_is_detectable`。

- [ ] **Step 14: 运行安装/提交测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery install_`

Expected: FAIL，install/cleanup 阶段尚不存在；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery committed_tree_`

Expected: FAIL，committed tree 校验尚不存在；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery marker_written_`

Expected: FAIL，marker 恢复尚不存在；不得是 `0 tests`。

- [ ] **Step 15: 实现 FilesInstalled 与 Committed 前向路径**

在 Journal 仍为 SecretsVerified 时，逐个把 staged target 原子安装到受控 destination；每个安装后可安全崩溃。全部 target hash 验证通过后，按 `legacy_cleanup` 原子替换/删除 4 个 canonical legacy 文件，并删除所有 present allow-listed `.bak`/`.tmp` artifact；每一步都由各自 encrypted backup/hash 覆盖恢复矩阵。随后写 `FilesInstalled`，再单独原子写 `schema-version.json { "version": 2, "transactionId": ... }` 并把 Journal 标记 `Committed`。普通 Repositories 只有看到 marker 才能打开 v2 文件；Committed 后递归扫描 config dir（排除 DPAPI 密文）不得找到 fixture key、allow-listed plaintext backup/temp 或未盘点相似 artifact。

- [ ] **Step 16: 运行安装/提交前向测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery install_ && cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery committed_tree_ && cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery marker_written_`

Expected: PASS。

- [ ] **Step 17: 写失败测试覆盖恢复矩阵和幂等性**

参数化测试 `recovery_crash_matrix_converges_idempotently` 在第 N 个 secret `put_at`、第 N 个 target install、第 N 个 canonical/artifact cleanup、FilesInstalled、schema marker 写成功但 Journal 尚未 Committed 时崩溃。源未变且 staging/backup 完整时，两次 `recover()` 必须收敛到 v2；另写 `recovery_source_or_known_artifact_hash_change_aborts_transaction`、`recovery_missing_staged_target_is_reprepared`、`recovery_reprepare_ignores_wall_clock_and_preserves_manifest_hash`、`recovery_missing_backup_fails_closed_without_source_mutation`、`recovery_missing_secret_blob_is_rebuilt_before_marker`、`recovery_conflicting_secret_blob_fails_closed`、`recovery_unknown_target_hash_blocks_without_any_mutation_even_with_backup`、`recovery_unknown_cleanup_hash_blocks_without_any_mutation_even_with_backup`、`recovery_files_installed_hash_mismatch_blocks_without_any_mutation`、`recovery_marker_written_before_committed_journal_recovers`、`recovery_committed_only_cleans_temporary_artifacts`、`migration_backup_list_exposes_only_committed_transaction_and_count`、`migration_backup_delete_requires_explicit_confirmation_and_matching_marker`、`migration_backup_delete_rejects_pending_journal_or_cross_transaction_id`、`migration_backup_delete_is_guarded_and_idempotent`。unknown/hash mismatch 与 backup delete 拒绝测试在调用前保存全部 source/artifact/target/cleanup/staging/Journal/backup bytes 与 secret slot 快照，调用后逐项断言完全不变。

- [ ] **Step 18: 运行恢复矩阵并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery recovery_`

Expected: FAIL，`recover()` 尚未实现完整阶段分派。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery migration_backup_`

Expected: FAIL，committed backup list/delete service 尚不存在；不得是 `0 tests`。

- [ ] **Step 19: 实现启动恢复决策**

- Prepared：先校验全部 source、target temp 和 backup manifest。backup 损坏时不写 secret、不碰源并失败封闭；target temp 损坏但源/backup 完整时重新 prepare。源外部变化时，仅删除能从有效 backup 提取并确认与本事务期望值相同的 planned ref；异值/不可解密 ref 保留并失败封闭，禁止误删既有凭据。安全回滚完成后删除 staging 和根 Journal并保持 v1。
- SecretsVerified（含部分安装/部分 legacy cleanup）：先只读重验每个 secret slot、全部 destination、cleanup、staging 与 backup manifest，再决定是否允许任何修复；secret 异值/不可解密、destination 非 original/目标 hash、cleanup 非原始/已删除/sanitized hash 中任一 unknown 都立即进入 Blocked，保持全部文件、secret slot、staging 和根 Journal 字节不变，即使 backup 完整也禁止自动覆盖或删除，因为 unknown 可能是外部修改。只有整组预检均为已知状态后，才可用 `put_at` 重建缺失且可由有效 backup 唯一证明的 planned ref，并按已知状态幂等继续。
- FilesInstalled：在写 marker 前先只读重验全部 secret slots、目标 hash、legacy cleanup 状态、staging 和 backup；任何异值、不可解密或 unknown hash 都失败封闭并保持全状态字节不变，完整 backup 也不授权自动回滚。只有全部状态可证明为本事务 original/目标结果时，才可重建缺失 secret 或继续写 marker。若 marker 已存在，transactionId 必须匹配当前 Journal。
- Committed：校验 marker transactionId 后先清理 target temp/staging，最后删除根 Journal；保留 `migration-backups/<transactionId>/` 供用户后续显式删除。清理中崩溃时 marker 仍能驱动下一次继续。
- 根 Journal 不存在但 `.migration/<transactionId>/` 存在：视为 Prepared 写入前崩溃；确认 schema marker 未引用该 transaction 后只删除该 staging 目录，源文件保持不变。
- 每条恢复路径重复执行两次结果相同。

本任务只交付可注入、可单测的 Coordinator 核心；Chunk 3 的启动装配任务必须在 `ConfigStore`/Repositories 构造前调用 `recover()`，并一次注册 `migration_status/preview/apply/recover` 与 backup list/delete 六个命令。Chunk 2 不宣称迁移已经对 UI 可用。

同文件实现 `MigrationBackupService`：list 只读取 schema marker 的 committed transactionId，返回 `{ transactionId, fileCount, present }`，不返回路径/文件名；delete 只接受同一 transactionId、`confirmed=true`、marker committed 且根 migration Journal 不存在，路径由 `migration-backups/<transactionId>` 纯函数派生并通过 Task 4 guarded `remove_tree` 删除，missing 幂等成功。任何其他合法 UUID、pending/Blocked migration、reparse tree 或未确认请求均零修改拒绝；它绝不删除通用 `corrupt-backups/`。物理删除只能降低应用可访问副本，不能承诺已从 SSD/文件系统历史物理擦除，该边界必须由 Task 17 UI 明示并二次确认。

- [ ] **Step 20: 运行迁移恢复与全量 Rust 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test migration_recovery && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS；目录扫描确认无明文 `.bak`、无未引用 secretRef、无半安装 JSON。

- [ ] **Step 21: 代码简化审查并提交**

使用 `@code-simplifier` 检查阶段转换和补偿重复；若修改，重跑 Step 20。

```bash
git add src-tauri/src/migration src-tauri/tests/migration_recovery.rs
git commit -m "feat: 实现幂等迁移事务恢复"
```

### Task 10: 通过 Chunk 2 完整回归

**Files:**
- Verify only: files changed in Tasks 6-9

- [ ] **Step 1: 运行 Rust 格式、测试和检查**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功，Windows DPAPI 测试执行而非跳过。

- [ ] **Step 2: 搜索明文密钥与不安全备份路径**

Run: `rg -n "apiKey|fixture-(claude|codex|workspace)-key|\.bak|secretValue" src-tauri/src src-tauri/tests`

Expected: 只命中 legacy 输入字段、负向断言或明确禁止 `.bak` 的测试；生产 v2 schema、Journal、公开 DTO 均不含密钥正文。

- [ ] **Step 3: 核对迁移文件状态**

Run: `git status --short`

Expected: 工作树干净；若出现未跟踪备份、临时 JSON、secret blob 或 journal，视为测试清理失败并修复后重跑。

## Chunk 3: 兼容门面、启动装配与 Phase A 可用界面

### Task 11: 实现旧配置、项目和会话 CompatibilityFacade

**Files:**
- Create: `src-tauri/src/compat/mod.rs`
- Create: `src-tauri/src/compat/legacy_dto.rs`
- Create: `src-tauri/src/compat/facade.rs`
- Create: `src-tauri/src/compat/config_facade.rs`
- Create: `src-tauri/src/compat/project_facade.rs`
- Create: `src-tauri/src/compat/session_facade.rs`
- Create: `src-tauri/src/compat/runtime_bindings.rs`
- Create: `src-tauri/src/compat/write_transaction.rs`
- Modify: `src-tauri/src/application/provider_service.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/compatibility_facade.rs`

- [ ] **Step 1: 写失败测试固定旧 config DTO 不回传密钥**

新增 `compat_config_get_returns_configured_flag_without_secret`、`compat_config_get_after_migration_uses_persisted_reserved_mapping`、`compat_config_get_keeps_disabled_or_soft_deleted_reserved_profile_readable`、`compat_config_set_blank_secret_reuses_reference`、`compat_config_set_new_secret_creates_revision`、`compat_config_set_nonempty_extra_args_is_rejected_with_zero_write`、`compat_config_same_driver_profiles_update_only_reserved_mapping`、`compat_config_set_updates_selected_reserved_global_pair_atomically`、`compat_config_set_preserves_unrelated_user_selection`、`compat_config_set_updates_non_provider_runtime_settings`、`compat_write_config_set_crash_matrix_is_atomic`、`compat_write_workspace_save_crash_matrix_is_atomic`、`compat_write_coordinator_reuses_existing_mutation_guard_without_deadlock`、`compat_write_concurrent_operations_are_serialized`、`compat_write_concurrent_provider_service_and_config_set_share_gate`、`compat_write_concurrent_project_save_and_workspace_save_share_gate`、`compat_write_recovery_is_idempotent`、`compat_write_unknown_hash_fails_closed`、`compat_write_valid_in_root_wrong_target_path_is_rejected_with_zero_mutation`、`compat_write_cross_operation_staging_path_is_rejected`、`compat_write_rollback_removes_only_new_unreferenced_secrets`、`compat_legacy_read_only_reads_without_mutation`、`compat_legacy_read_only_rejects_every_write_with_migration_required`、`compat_ready_writes_leave_all_legacy_file_hashes_unchanged`。

- [ ] **Step 2: 运行 config 兼容测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade compat_config_`

Expected: FAIL，config facade 尚不存在；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade compat_write_`

Expected: FAIL，compat write coordinator 尚不存在；不得是 `0 tests`。

- [ ] **Step 3: 实现读写分离的 legacy config DTO**

`facade.rs` 在本任务只组合 config/project/session 三个已实现的专责 facade，不承载转换逻辑；Task 12、后续 legacy launch 任务再分别加入 layout/launch facade，任一任务结束时都必须是可编译的完整组合。`LegacyAgentConfigPublic` 只含 `baseUrl/model/extraArgs/apiKeyConfigured`；`LegacyAgentConfigInput.secret` 使用 Chunk 2 的 `IncomingSecret` 且留空表示沿用。所有 config/workspace 写在 staging/secret 创建前调用同一 domain `validate_extra_options`，非空 extraArgs 零写拒绝；public read 可显示历史非法状态供修复但绝不透传到 launch。直接使用 Task 2 已持久化在 AppSettings 的 `CompatibilitySettings { claudeDefaultProviderId, codexDefaultProviderId }`；Task 8 迁移已写确定性 reserved profile ID，首次 fresh legacy config_set 才补齐缺失的对应 ID，同 driver 的其他 profiles 不参与旧 defaults。`config_get` 只按该映射读取，并直接读取历史 profile/revision，不调用“enabled 才可新建运行段”的 resolver；禁用/软删除 reserved profile 仍可查看公开字段，只有 config_set/新 launch 才按规则拒绝。`config_set` 在同一应用操作中写主题/终端/通知设置、两个 reserved revisions 和 GlobalPreferences：当前默认指向某个 reserved profile 时同步该 provider/model 对；为 null 或指向用户显式选择的其他 profile 时保持选择不变，因为旧 DTO 同时携带两套 driver defaults，不能无依据替用户选其中一个。这里“更新 GlobalPreferences”固定为读取、校验并与 reserved revision 变更原子提交，而不是覆盖无关用户选择。禁止把掩码字符串当新密钥。

`CompatibilityFacade` 不持有 AppState 或尚未定义的 `StorageRuntime`。本任务定义只供纯读命令在 read guard 内使用的 `CompatRuntimeReadRef<'a> { LegacyReadOnly(&'a LegacyCompatServices), Ready(&'a ReadyCompatServices) }`，并让两个 service graph 以 `Arc` 聚合各 facade 当前实际需要的 LegacyReader、v2 repositories、ProviderService、CompatibilityWriteCoordinator 和进程内 bindings，不反向引用 facade。Task 15 的 mutation command 必须先取得全局 `ApplicationMutationGate`，再用短 `StorageRuntime` read guard clone 对应 `Arc` 为 owned `CompatMutationHandle`，释放 read guard后调用显式 `_locked(&MutationGuard, ...)`；不得持 runtime read guard等待 mutation mutex。LegacyReadOnly 只通过 LegacyReader 返回公开快照，所有写统一 `MigrationRequired`；Ready 的每项写只落 v2 repository。参数化测试在每个旧写后比较 legacy `settings/workspaces/sessions/layout` 四个 hash 不变。

`CompatibilityWriteCoordinator` 是 config_set 与含本地 provider 变更的 workspace_save 的唯一多文件写入口，并复用 Task 7 的同一个 `ApplicationMutationGate` 串行 `prepare snapshot → secret create/verify → staging → Journal → install → repository snapshot refresh → cleanup` 以及 recover 全临界区；第二个命令必须在 gate 内重新读取最新 snapshots，不能复用等待前的计划。Coordinator 入口只取得一次 `MutationGuard`，随后必须调用 `ProviderService::prepare_change_locked(&guard, ...)` 及其他显式 `_locked` 协作者，禁止调用会自行取锁的公开 `ProviderService::save()`；对应测试用超时失败固定非重入约束。ProviderService.save、v2 provider_save、ProjectFacade/v2 project_save、preferences 写与 coordinator 都共享该 gate；涉及 WorkspaceStore 的操作固定锁序为 `ApplicationMutationGate → WorkspaceStore mutex`，任何代码不得反向获取。它先得到 next registry 与新建 secret refs，再为 providers/app-settings/global-preferences/projects 等本次实际目标生成 staging bytes；`compat-write-journal.json` 只保存 canonical UUID operationId、闭合 `CompatWriteTarget::{Providers,AppSettings,GlobalPreferences,Projects}`、old/new hash、createdSecretRefs 和 stage，不保存任意路径。install path 固定由 target enum 派生，staging 固定为 `.compat-write/<operationId>/<target>.json`；load 时拒绝未知/重复 target、额外 path 字段、跨 operationId staging 和 target 集合与 operation kind 不匹配，并在外部 I/O 前完成整份预检。阶段为 Prepared→FilesInstalled→Committed；所有 replace 完成并验证后才刷新 repository snapshots。失败/恢复按 old/new/unknown hash 决定继续或回滚，回滚只删除本 operation 新建且未被任何已安装 providers/Journal 引用的 secret。启动 Task 15 必须在打开 repositories 前 recover；任何 facade/repository 不得绕过 gate/coordinator 直接完成相关写。

- [ ] **Step 4: 运行 config 兼容测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade compat_config_ && cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade compat_write_`

Expected: PASS；序列化结果没有 `apiKey`/fixture secret。

- [ ] **Step 5: 写失败测试固定 Workspace→Project 映射与删除边界**

新增 `compat_workspace_list_derives_driver_from_project_provider`、`compat_workspace_list_keeps_disabled_or_soft_deleted_provider_readable`、`compat_workspace_save_local_config_updates_only_bound_profile`、`compat_workspace_save_never_deduplicates_across_profiles`、`compat_workspace_save_preserves_history_tombstones`、`compat_workspace_path_edit_preserves_existing_conversation_and_segment_snapshots`、`compat_workspace_cannot_recreate_project_id_reserved_by_tombstone`、`compat_workspace_delete_never_touches_project_directory`、`compat_workspace_delete_keeps_conversations_without_explicit_flag`、`compat_workspace_delete_keep_moves_project_to_history_tombstone`、`compat_workspace_delete_with_conversations_creates_no_tombstone`、`compat_workspace_list_never_exposes_history_tombstones`。Task 11 只验证 snapshot/tombstone 不变量；删除后重启的真实 importer 集成留到 Task 13。

- [ ] **Step 6: 运行项目兼容测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade compat_workspace_`

Expected: FAIL，workspace 兼容方法尚不存在。

- [ ] **Step 7: 实现 Workspace 兼容方法**

旧 `Workspace` 输出由 active Project + 当前/历史 ProviderProfile 派生，绝不把 tombstone 暴露成可编辑 Project；禁用或软删除 profile 仍保留 driver/name，项目和历史保持可读，但写入/新启动返回修复提示。只有 profile/revision 结构性缺失才返回脱敏数据错误，绝不默认 Claude。保存旧本地配置时只在项目当前绑定的同一 profile 内按 `configHash+secretRef` 复用，否则新建 revision；不同 profile 永不合并；每次 project/workspace save 在同一 guard 下重读 ProjectsFile、逐字保留 tombstones，并拒绝复用 tombstone ID。Project.path 更新只影响之后创建的新 Conversation/Terminal，禁止改写已有 Conversation.projectPathSnapshot、RuntimeSegment.cwdSnapshot 或 TerminalSession.cwd。新命令契约固定为 `project_delete(id, deleteConversations)`；false 在同一 ProjectsFile 原子 snapshot 中把 active Project 移入 `ProjectHistoryTombstone` 后保留 Conversation，true 才同时删关联 Conversation且不创建 tombstone。LegacyHistoryImporter 始终使用 Conversation/segment 冻结快照定位；tombstone 仅保留 projectStatus、最后路径和 ID 占位，不得覆盖旧会话快照，也不能用于新建 Conversation/Terminal/launch。两种情况都不调用文件系统删除项目目录；布局引用清理由 Task 12 在 WorkspaceStore 可用后补入 ProjectFacade。

- [ ] **Step 8: 运行项目兼容测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade compat_workspace_`

Expected: PASS；测试目录哨兵文件仍存在。

- [ ] **Step 9: 写失败测试固定 ManagedSession 兼容映射**

新增 `compat_managed_ai_session_writes_conversation_without_guessing_segment`、`compat_managed_ai_session_freezes_project_path_snapshot`、`compat_managed_ai_rename_never_changes_project_path_snapshot`、`compat_managed_shell_writes_terminal_session`、`compat_runtime_pty_binding_is_process_local`、`compat_ai_session_detect_accepts_only_managed_session_id_and_updates_bound_segment`、`compat_delete_removes_only_selected_panel_entity`。

- [ ] **Step 10: 运行会话兼容测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade compat_`

Expected: 新增会话兼容测试 FAIL，已实现的 config/workspace 测试继续 PASS。

- [ ] **Step 11: 实现稳定实体与易失绑定分离**

AI ManagedSession 创建稳定 Conversation 时必须验证 Project 存在，并在同一次 snapshot 中把当时已验证的 Project.path 写入不可变 `projectPathSnapshot`；后续 rename/update 只能改标题/时间，不根据“当前项目默认”事后猜测 RuntimeSegment，也不能刷新路径快照。实际 legacy launch 任务必须在 spawn 前冻结选择与 `cwdSnapshot` 并创建 segment。Shell 写 TerminalSession，并在创建时冻结稳定 cwd。`LegacyRuntimeBindings` 只在内存保存 stable entity ID↔PTY ID 及已冻结的 launch binding，重启为空；`aiSessionDetect(managedSessionId)` 不接收 workspace/kind/spawnedAt/exclude，后端从该 ID 的 live binding 派生全部探测范围，`aiSessionId` 只能写到该 binding 指向的 RuntimeSegment.externalSessionId。list/update/delete 通过稳定 ID 映射，不把 PTY ID 持久化进布局或领域 JSON。

- [ ] **Step 12: 运行 CompatibilityFacade 全部测试并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade`

Expected: PASS，输出/错误不含 fixture secret。

使用 `@code-simplifier` 审查 DTO 转换重复；若修改，重跑本步骤。

```bash
git add src-tauri/src/compat src-tauri/src/application/provider_service.rs src-tauri/src/lib.rs src-tauri/tests/compatibility_facade.rs
git commit -m "feat: 新增旧界面兼容门面"
```

### Task 12: 实现 CurrentWorkspace/SavedWorkspace 双文件事务与 v1 兼容

**Files:**
- Create: `src-tauri/src/storage/workspace_store.rs`
- Create: `src-tauri/src/storage/workspace_transaction.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/compat/facade.rs`
- Modify: `src-tauri/src/compat/mod.rs`
- Create: `src-tauri/src/compat/layout_facade.rs`
- Modify: `src-tauri/src/compat/project_facade.rs`
- Test: `src-tauri/tests/workspace_store.rs`

- [ ] **Step 1: 写失败测试固定 v1→v2 骨架和稳定引用**

新增 `workspace_store_v1_layout_keeps_tree_without_fake_items`、`workspace_store_current_always_exists`、`workspace_store_missing_entity_refs_are_preserved_for_placeholder`、`workspace_store_project_delete_false_clears_project_context_but_preserves_all_kind_scoped_items`、`workspace_store_project_delete_true_removes_only_conversation_items_and_preserves_terminals`、`workspace_store_deleted_active_item_selects_next_previous_or_null`。

- [ ] **Step 2: 运行布局映射测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_store workspace_store_`

Expected: FAIL，WorkspaceStore 尚不存在。

- [ ] **Step 3: 实现 v2 CurrentWorkspace 读写与 v1 兼容骨架**

`layout_get` 把 CurrentWorkspace 转为旧 PersistedLayout 骨架；`layout_save` 校验 v1 tree 后写回 v2，旧 leaf 无稳定 Tab 时保持现有稳定 items，不凭 PTY ID新增引用。CurrentWorkspace 默认一个空 leaf，`sourceSavedWorkspaceId=null`。ProjectFacade 的删除布局编排使用 kind-scoped WorkItemRef：`deleteConversations=false` 只把所有匹配 `WorkPane.projectId` 清为 null，完整保留 Conversation/Terminal items；true 才移除该 Project 的 Conversation refs，Terminal refs 始终保留供按自身 cwd 修复。若移除的完整 ref 正是 `activeItem`，按原顺序选择下一项、否则前一项、否则 null；同 UUID 的另一 kind 不受影响。current 与 active SavedWorkspace 的同步仍走本任务事务，不能直接写两个 repository。

- [ ] **Step 4: 运行布局映射测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_store workspace_store_`

Expected: 基础映射 PASS。

- [ ] **Step 5: 写失败测试固定来源模板自动保存与故障恢复**

新增 `workspace_transaction_null_source_writes_only_current`、`workspace_transaction_active_source_updates_current_and_saved`、`workspace_transaction_active_source_changes_only_matching_saved_record`、`workspace_transaction_missing_source_id_fails_closed_without_writes`、`workspace_transaction_delete_source_removes_saved_and_clears_pointer_atomically`、`workspace_transaction_concurrent_writes_are_serialized`、`workspace_transaction_crash_matrix_recovers_idempotently`、`workspace_transaction_unknown_hash_fails_closed`、`workspace_transaction_valid_in_root_wrong_target_path_is_rejected_with_zero_mutation`、`workspace_transaction_cross_operation_staging_is_rejected`、`workspace_repositories_expose_no_direct_current_or_saved_writer`。多 SavedWorkspace 测试对非 source 记录保存写前规范化 bytes/hash 并断言写后逐字一致；崩溃矩阵覆盖 Journal 写前、Journal 写后、每个 replace 后、全部 replace 后但 cleanup 前，并对每点调用两次 recover。

- [ ] **Step 6: 运行事务测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_store workspace_transaction_`

Expected: FAIL，双文件事务尚不存在。

- [ ] **Step 7: 实现 workspace-write-journal 事务**

WorkspaceStore 用单一 Mutex 串行所有 current/saved 读改写和 recover，并私有拥有两个底层 `JsonRepository`；`Repositories` 只公开 `Arc<WorkspaceStore>`，current/saved 原始 writer 字段为 private，其他 service/command 无法绕过事务层。Journal 只含 canonical operationId、闭合 `WorkspaceTxnTarget::{CurrentWorkspace,WorkspaceLayouts}`、各 target 的旧/新 hash、sourceSavedWorkspaceId 和 stage，不保存 staging/install 路径；install path 固定由 target enum 派生，staging 固定为 `.workspace-write/<operationId>/<target>.json`。load 时先拒绝未知/重复 target、额外 path 字段、跨 operation staging、source/action 与 target 集合不匹配，再做任何 read/replace/remove；合法根内但非固定 current/layouts 目标没有可表达路径。source=null 只写 current；source!=null 时先确认该 ID 存在，再只替换 current 与 layouts 中对应记录，其他记录序列化 bytes 保持；缺失 source 在写 Journal 前返回 Conflict。之后先写派生的 staging，再逐文件替换，恢复按旧/新/未知 hash 分类，未知失败封闭。删除活动 SavedWorkspace 在同一事务中从 layouts 文件移除记录、清空 current.source 指针并保留当前树。后续启动任务必须在 open_existing 前调用此 recover。

- [ ] **Step 8: 运行事务与全量 Rust 测试并提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test workspace_store && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS；无半写 current/saved 文件。

使用 `@code-simplifier` 审查事务状态机；若修改，重跑本步骤。

```bash
git add src-tauri/src/storage src-tauri/src/compat/mod.rs src-tauri/src/compat/facade.rs src-tauri/src/compat/layout_facade.rs src-tauri/src/compat/project_facade.rs src-tauri/tests/workspace_store.rs
git commit -m "feat: 新增工作区兼容事务存储"
```

### Task 13: 保留旧运行命名空间并实现幂等 LegacyHistoryImporter

**Files:**
- Create: `src-tauri/src/domain/conversation_event.rs`
- Create: `src-tauri/src/storage/conversation_event_store.rs`
- Create: `src-tauri/src/history/importer.rs`
- Create: `src-tauri/src/history/import_registry.rs`
- Create: `src-tauri/tests/fixtures/history/codex-managed.jsonl`
- Create: `src-tauri/tests/fixtures/history/claude-known.jsonl`
- Create: `src-tauri/tests/legacy_history_importer.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/history/mod.rs`
- Modify: `src-tauri/src/history/codex.rs`
- Modify: `src-tauri/src/history/claude.rs`
- Modify: `src-tauri/src/compat/session_facade.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败测试固定事件 ID、checkpoint 与原子导入**

新增：

- `legacy_import_event_id_is_deterministic_and_content_sensitive`
- `legacy_import_same_batch_twice_appends_no_duplicate`
- `legacy_import_event_append_and_checkpoint_commit_together`
- `legacy_import_crash_matrix_recovers_idempotently`
- `legacy_import_concurrent_same_conversation_is_serialized`
- `legacy_import_concurrent_different_conversations_use_distinct_journals`
- `legacy_import_delete_claim_waits_existing_import_and_blocks_new_import`
- `legacy_import_delete_wins_then_new_import_is_not_found_with_zero_write`
- `legacy_import_error_redacts_source_path_and_content`
- `legacy_transcript_block_never_claims_structured_message_semantics`

事件 ID 输入严格为 `driver + normalizedSourceId + externalSessionId + nativeRecordOrdinal + eventType + redactedContentHash`。崩溃矩阵覆盖 import Journal 写前、event staging 后、event replace 后、checkpoint replace 后和 cleanup 前；每个点连续 recover 两次。

- [ ] **Step 2: 运行 importer 核心测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_history_importer legacy_import_`

Expected: FAIL，ConversationEvent/EventStore/Importer 尚不存在。

- [ ] **Step 3: 实现最小完成事件与导入 Journal**

`conversation_event.rs` 先定义 Phase A 需要的完成事件：`UserMessage`、`AssistantMessageCompleted`、`ToolOutput`、`LegacyTranscriptBlock`、`StatusChanged`，以及 `LegacyImportCheckpoint`；增量 delta 留给 Phase C 内存态。所有事件严格包含 eventId/conversationId/segmentId/timestamp/sequence。只有已迁移出可靠 RuntimeSegment 的来源才写统一事件；`needsProviderSelection` 且无法绑定 segment 的旧来源继续通过只读 legacy 投影展示并标明“选择供应商后导入”，不得写 null/伪造 segmentId。已绑定 segment 内的未知原生记录只允许形成带 driver、record type 和脱敏摘要的 LegacyTranscriptBlock，不能伪造成用户/助手消息。

`ConversationEventStore` 私有拥有 `conversation-events/<conversationId>.jsonl`、checkpoint writer 和按 conversationId 管理的 mutex；同一 Conversation 从读取 checkpoint、解析增量、分配 sequence 到提交/恢复全程串行。每个会话使用独立 `conversation-events/<conversationId>.import-journal.json`，不同会话可并发但绝不共享/覆盖 journal。导入批次先生成完整 event staging 和 checkpoint staging，再记录旧/新 hash 并按固定顺序替换。恢复只接受 old/new hash，未知状态失败封闭。按 eventId 去重，sequence 由已提交尾部继续；不得使用普通 append 后再单独写 checkpoint。

新增共享 `ConversationImportRegistry`：`LegacyHistoryImporter` 在读取 source/恢复 import journal 前取得 `ImportLease(conversationId)`，lease 持到 event+checkpoint 原子提交结束；若该 ID 已进入 deleting/deleted 状态，返回 NotFound/Conflict且外部 I/O 零写。删除单会话或 project_delete(true) 在全局 MutationGuard 下按 conversationId 排序取得一组 `DeleteClaim`：先原子标记 deleting 阻止新 import，再通过 Condvar 等待已有 ImportLease=0，等待时不持 event-store/per-conversation mutex；随后确认无未知 pending import journal，才继续 lifecycle/outcome/metadata预检。删除失败时 claim drop 恢复可导入；元数据删除成功后标记 deleted，本进程后续 import 永久拒绝。既有已提交 event/checkpoint 文件本期作为不可寻址审计残留保留，公开 list 在 Conversation 不存在时绝不返回，Phase E 经全局引用审计和用户删除授权后清理；关键是删除后不能再生成新 event/journal。

- [ ] **Step 4: 运行 Journal/去重测试并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_history_importer legacy_import_`

Expected: PASS；任一崩溃点重试后事件与 checkpoint 要么都旧、要么都新，无重复 eventId。

- [ ] **Step 5: 写失败测试固定旧 Codex/Claude 来源定位**

新增：

- `codex_import_reads_recorded_legacy_workspace_home_not_parent_env`
- `codex_import_filters_recorded_home_by_project_cwd`
- `codex_legacy_namespace_config_hash_mismatch_fails_closed_without_rewrite`
- `claude_import_requires_unique_project_and_external_session_match`
- `claude_ambiguous_provider_history_becomes_unavailable_not_guessed`
- `legacy_import_source_append_continues_from_complete_record`
- `legacy_import_source_truncate_resets_offset_and_deduplicates`
- `legacy_history_list_uses_stable_managed_session_id_locator`
- `legacy_history_after_project_tombstone_restart_uses_conversation_project_path_snapshot_without_public_project`
- `legacy_history_project_path_edit_does_not_retarget_existing_conversation`
- `legacy_history_segment_filter_uses_each_frozen_cwd_snapshot`

- [ ] **Step 6: 运行来源定位测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_history_importer codex_import_`

Expected: FAIL，Codex importer 尚未实现；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_history_importer claude_import_`

Expected: FAIL，Claude importer 尚未实现；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_history_importer legacy_history_`

Expected: FAIL，旧 history 仍从父进程环境或全局目录推测；不得是 `0 tests`。

- [ ] **Step 7: 实现惰性可靠导入和旧命名空间解析**

每次通过 stable Conversation 读取历史时都先调用 `import_incremental`：checkpoint identity/长度/完整记录位置未变化则无写入快速返回，源追加时继续导入，截断/替换时重扫并去重。项目归属过滤只使用该 Conversation 持久化的 `projectPathSnapshot` 和各 RuntimeSegment 的 `cwdSnapshot`；active Project 与内部 `ProjectHistoryTombstone` 只用于判定 projectStatus/保留 ID，不得把后来编辑或删除时的 path 回灌到旧会话。缺少合法冻结快照时返回 history unavailable，禁止猜测。Codex 的 `codex-legacy-workspace:<projectUuid>` 解析到 migration 已记录的应用自管相对目录，校验归属标记与不可变 config hash；会话文件自身按 checkpoint identity 允许追加。读取时始终按对应 segment 的冻结 cwd 过滤，不读取父进程 CODEX_HOME，且绝不重写旧 config/rollout。Claude 用 Conversation 的冻结 project path + externalSessionId 解析现有索引；来源或 provider 归属不唯一时保留 Panel Conversation，返回 `historyUnavailableReason`，不扫描后取“最近一个”猜测。

checkpoint 保存 opaque normalized source ID、文件 identity、最后完整换行/记录序号、offset、lastEventId 和 completedAt，不保存用户 HOME 绝对路径。源追加从 checkpoint 继续；截断/替换时从头重读并依靠确定性 eventId 去重。Compatibility session/history facade 接收 `managedSessionId` 后查 locator，再返回已导入公开事件投影；没有 stable ID 的旧全局历史列表保持只读 legacy 行为，但不得用于恢复或绑定供应商。

- [ ] **Step 8: 运行 importer、迁移和 history 回归**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_history_importer && cargo test --manifest-path src-tauri/Cargo.toml --test migration_planner && cargo test --manifest-path src-tauri/Cargo.toml history`

Expected: PASS；旧 Codex 自管 HOME 可读且 config hash 未改，追加会话记录可继续导入；Claude 歧义失败封闭，fixture 内容/路径不进入错误。

- [ ] **Step 9: 代码简化审查并提交**

使用 `@code-simplifier` 审查 importer/parser 与 Journal 职责；不得把 driver 专属解析并入通用事件存储。若修改，重跑 Step 8。

```bash
git add src-tauri/src/domain src-tauri/src/storage src-tauri/src/history src-tauri/src/compat/session_facade.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/history src-tauri/tests/legacy_history_importer.rs
git commit -m "feat: 新增旧会话历史幂等导入"
```

### Task 14: 分步实现可独立测试的 LegacyLaunchService

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `scripts/build-pty-host.mjs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/bin/tht_panel_pty_host.rs`
- Create: `src-tauri/src/compat/launch_facade.rs`
- Create: `src-tauri/src/application/legacy_entity_deletion_guard.rs`
- Create: `src-tauri/tests/legacy_launch.rs`
- Modify: `src-tauri/src/compat/runtime_bindings.rs`
- Modify: `src-tauri/src/compat/session_facade.rs`
- Modify: `src-tauri/src/compat/project_facade.rs`
- Modify: `src-tauri/src/compat/mod.rs`
- Modify: `src-tauri/src/config/model.rs`
- Modify: `src-tauri/src/domain/conversation.rs`
- Create: `src-tauri/src/storage/runtime_outcome_store.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/pty/spawn.rs`
- Create: `src-tauri/src/pty/job_object.rs`
- Create: `src-tauri/src/pty/job_launcher.rs`
- Create: `src-tauri/src/pty/host.rs`
- Create: `src-tauri/src/pty/lifecycle.rs`
- Create: `src-tauri/src/pty/runtime_port.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Create: `src-tauri/tests/fixtures/process-tree/parent.ps1`
- Modify: `src-tauri/src/history/mod.rs`
- Modify: `src-tauri/src/history/claude.rs`
- Modify: `src-tauri/src/history/codex.rs`
- Modify: `src-tauri/src/application/mutation_gate.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/lib.rs`

本任务先新增独立 `LegacyLaunchService`，并扩展现有已接收 `ResolvedLaunch` 的 `PtyManager::spawn` 以支持 env_remove/public_env/secret_env；旧 resolver 同步适配新构造器，所以现有命令仍可通过原入口编译运行。Task 15 再原子切换命令并删除 ConfigStore，中间提交不造成 legacy PTY 断档。

- [ ] **Step 1: 写失败测试固定 stable Conversation 与 revision 冻结**

新增 `legacy_revision_unknown_kind_is_validation_error`、`legacy_revision_driver_must_match_provider`、`legacy_revision_ai_spawn_requires_managed_session_id`、`legacy_revision_persisted_nonempty_extra_options_is_rejected_before_zero_spawn`、`legacy_revision_driver_defaults_common_args_or_unknown_env_mapping_is_rejected_before_zero_spawn`、`legacy_revision_driver_defaults_executable_must_pass_windows_resolution`、`legacy_revision_user_options_cannot_add_positional_prompt_or_subcommand`、`legacy_revision_codex_resume_argv_exactly_matches_backend_template`、`legacy_revision_claude_resume_argv_exactly_matches_backend_template`、`legacy_revision_new_spawn_freezes_selection_and_cwd_before_process_start`、`legacy_revision_concurrent_spawn_same_managed_id_allows_one_process_and_segment`、`legacy_revision_failed_launch_releases_claim_and_allows_retry`、`legacy_revision_provider_or_project_edit_after_spawn_before_first_input_keeps_actual_revision_and_cwd`、`legacy_revision_resume_uses_frozen_segment_after_provider_or_project_edit`、`legacy_revision_resume_creates_new_segment_linked_to_completed_source_segment`、`legacy_revision_repeated_resume_inherits_same_external_id_for_same_conversation`、`legacy_revision_resume_rejects_external_id_claimed_by_other_conversation`、`legacy_revision_resume_rejects_option_response_file_whitespace_and_noncanonical_native_id_before_zero_spawn`、`legacy_revision_spawn_failure_marks_created_segment_failed`、`legacy_revision_ai_detect_baseline_is_captured_before_process_release`、`legacy_revision_codex_detect_scope_uses_canonical_home_identity_and_cwd`、`legacy_revision_same_physical_scope_fresh_launch_is_serialized_until_identity_bound`、`legacy_revision_different_private_physical_scopes_may_run_concurrently`、`legacy_revision_claude_fresh_detect_is_unsupported_without_private_history_scope`、`legacy_revision_scope_claim_releases_on_failed_or_exited_unbound_process`。

- [ ] **Step 2: 运行 revision 子集并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_revision_`

Expected: FAIL，LegacyLaunchService 尚不存在。

- [ ] **Step 3: 实现消费型冻结 launch**

AI launch 必须接收 stable managedSessionId。`LegacyLaunchService` 依赖最小 `LegacyPtyRuntime: Send + Sync` trait，测试使用只记录请求的 fake。先以 stable ID 取得 per-managed `LaunchClaim`，再解析 provider/model、冻结 Conversation.projectPathSnapshot/source segment.cwdSnapshot、验证 revision/DriverDefaults，并由 driver locator 计算 `NativeDetectPolicy`；之后才允许创建 segment。fresh Codex 仅在受 guarded ConfigFileStore 管理、owner marker/config hash 已验证的 HOME 中启用探测，`NativeDetectScopeId` 由 canonical HOME 文件身份（只存 hash/opaque file ID，不公开绝对路径）+ canonical cwd 派生；取得该物理 scope 的 `FreshScopeClaim` 后才创建不含 externalSessionId 的 segment、枚举 baseline并放行进程。同一物理 scope 已有 unresolved fresh process 时第二个请求返回 `RETRY_LATER` 且零 segment/零 spawn；不同私有物理 scope可并发，claim 持到 ID 绑定或进程确认退出/清树。Claude revision settings 并不隔离其共享原生历史源，因此 Phase A fresh Claude 固定 `NativeDetectPolicy::UnsupportedSharedSource`：可以启动当前 legacy PTY segment，但不枚举 `~/.claude`、不创建 AiDetectBaseline、不调用 aiSessionDetect、不声称可原生恢复；进程退出后的连续上下文留给 Phase C/D Panel events/ContextBridge。最终 argv 只由锁定 driver+CLI version 的后端模板生成；Codex/可靠 legacy Claude resume 仅使用 source 持久化且通过 `NativeSessionId` canonical formatter 的 ID，拒绝任意用户 positional、选项或 response file。fresh Codex baseline 精确为 `AiDetectBaseline { bindingGeneration, managedSessionId, conversationId, segmentId, detectScopeId, backendStartedAt, preexistingExternalSessionIds: BTreeSet<NativeSessionId> }`，只存在 live binding。resume 要求 source 已有合法 ID，并用 `NativeIdentityClaim { driver, runtimeNamespaceId, externalSessionId } -> conversationId` 允许同 Conversation lineage 复用、拒绝跨 Conversation，占用检查在 spawn 前完成；新 segment 直接继承 externalSessionId/resumedFromSegmentId，不走 fresh detect。port 返回成功前登记单调 generation binding。验证/resolve 错误发生在 segment 前并零状态；segment 创建后的 spawn 失败标 Failed/ended，进程已创建后的失败必须清树并收敛 outcome；所有失败释放 per-managed/scope claim。旧 source segment 永不改写。Shell 绕过 provider。

Phase A 明确只为 AI legacy launch 提供“稳定实体/segment 先于 spawn”的原子顺序。现有兼容 Shell UI 仍允许先创建易失 PTY、用户首次保存/命名时再经 ManagedSession facade 建立 TerminalSession；因此 Phase A 不宣称每个 live Shell 都已有稳定元数据。若 TerminalSession 已存在，则 binding/outcome/bootstrap 必须按本文收敛；“TerminalSession create → layout open → runtime start、metadata 失败零 spawn、spawn 后提交失败清树并标 Failed”的完整稳定桥由 Phase B Task 7/9 交付，Phase A 测试和验收不得提前声称该保证。

- [ ] **Step 4: 运行 revision 子集并确认通过**

Step 1 已建立的 resume 红测在此一并断言 source/new segment ID 不同、`resumedFromSegmentId` 正确、externalSessionId 在同一 Conversation lineage 中继承且旧终态字节不变；不得到绿灯阶段才新增测试。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_revision_`

Expected: PASS；“spawn 后、首次输入前编辑供应商”仍使用实际 revision A。

- [ ] **Step 5: 写失败测试固定进程树、终止仲裁与终态恢复**

新增 `legacy_lifecycle_immediate_process_exit_cannot_beat_binding_registration`、`legacy_lifecycle_windows_launcher_never_releases_target_before_job_assignment`、`legacy_lifecycle_windows_launcher_forwards_terminal_io_and_exit_code`、`legacy_lifecycle_external_bin_debug_then_release_materialization`、`legacy_lifecycle_release_evidence_builds_in_unique_temp_root`、`legacy_lifecycle_release_helper_pe_subsystem_is_console`、`legacy_lifecycle_release_helper_conpty_forwards_stdin_stdout_and_exit_code`、`legacy_lifecycle_bundle_resolver_rejects_missing_or_reparse_helper`、`legacy_lifecycle_tauri_external_bin_name_matches_runtime_resolver`、`legacy_lifecycle_windows_job_object_terminates_fixture_tree`、`legacy_lifecycle_normal_process_exit_marks_segment_stopped_with_ended_at`、`legacy_lifecycle_nonzero_process_exit_marks_segment_failed_with_ended_at`、`legacy_lifecycle_explicit_kill_intent_overrides_nonzero_exit_to_stopped`、`legacy_lifecycle_shutdown_intent_overrides_nonzero_exit_to_stopped`、`legacy_lifecycle_kill_signal_success_waits_for_tree_empty_ack`、`legacy_lifecycle_kill_error_but_tree_empty_is_success`、`legacy_lifecycle_tree_timeout_keeps_binding_and_running_state`、`legacy_lifecycle_binding_registration_failure_waits_cleanup_ack_before_failed`、`legacy_lifecycle_concurrent_explicit_kill_has_single_owner`、`legacy_lifecycle_explicit_kill_synchronous_exit_callback_does_not_deadlock`、`legacy_lifecycle_shutdown_batch_publishes_terminal_snapshot_only_after_all_trees_exit`、`legacy_lifecycle_shutdown_tree_timeout_does_not_publish_all_stopped_snapshot`、`legacy_lifecycle_shutdown_synchronous_exit_callback_does_not_deadlock`、`legacy_lifecycle_natural_process_exit_save_failure_keeps_pending_outcome_and_binding`、`legacy_lifecycle_nonzero_exit_save_failure_retries_as_failed`、`legacy_lifecycle_outcome_retry_worker_converges_after_transient_failure`、`legacy_lifecycle_outcome_journal_crash_matrix_recovers_idempotently`、`legacy_lifecycle_outcome_directory_reparse_escape_is_rejected`、`legacy_lifecycle_pending_outcome_restart_reconciles_exact_terminal_state`、`legacy_lifecycle_missing_outcome_restart_marks_unbound_segment_interrupted`、`legacy_lifecycle_callback_is_idempotent`、`legacy_delete_rejects_live_binding_nonterminal_segment_or_pending_outcome`、`legacy_delete_project_false_may_keep_live_conversation`、`legacy_delete_project_true_rejects_any_active_or_pending_conversation_before_write`、`legacy_delete_race_with_exit_serializes_and_never_creates_unknown_outcome`。

同组 deletion 红测再增加 `legacy_delete_waits_existing_import_then_removes_metadata`、`legacy_delete_first_makes_late_import_not_found_with_zero_event_write`。

- [ ] **Step 6: 运行 lifecycle 子集并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_lifecycle_`

Expected: FAIL，测试必须被 Rust harness 收集；失败来自 helper 构建脚手架/受控 Job/exit ack/outcome recovery 尚未实现，不能被尚不存在的 npm script 在 Cargo 启动前短路。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_delete_`

Expected: FAIL，删除 guard 尚不能识别 live/nonterminal/pending outcome；所有 project 删除测试统一使用 `legacy_delete_project_` 前缀并由本过滤器命中。

- [ ] **Step 7: 实现可确认的进程树与终态恢复**

`PtyLifecycleObserver: Send + Sync` 在 waiter 线程工作。新增 `ProcessTreeController: Send + Sync`、Windows `JobObjectProcessTree` 与独立 console-subsystem helper binary `tht-panel-pty-host.exe`；禁止复用带 `windows_subsystem="windows"` 的 Tauri GUI executable。`Cargo.toml` 增加显式 `[[bin]]`，`src/bin/tht_panel_pty_host.rs` 不声明 windows GUI subsystem，只调用 `pty/host.rs` 中最小 host entry。为已有 `windows-sys` 增加 `Win32_System_JobObjects`、`Win32_System_Threading`、`Win32_System_Pipes`、`Win32_System_IO`（`ConnectNamedPipe` 在 0.59 受 IO feature 门控）。

`scripts/build-pty-host.mjs` 通过 `rustc -vV` 取得 host triple，按 debug/release 构建该 bin；两种 profile 都把对应产物原子复制为 Tauri 2 `externalBin` 需要的 `src-tauri/binaries/tht-panel-pty-host-<target-triple>.exe`，保证 `tauri dev` 在读取 bundle 配置时输入已存在。release `beforeBuild` 必须在 bundler 前覆盖任何 debug 副本，并由 PE/profile sentinel 证明打包输入来自 release；`.gitignore` 排除生成 exe。脚本另支持仅测试使用的 `--output-root <target/test-artifacts/...>`，真实 build/PE/ConPTY 测试各自在唯一临时根生成 helper，避免并行覆盖生产 externalBin。只有一个串行的 `legacy_lifecycle_external_bin_debug_then_release_materialization` 测试操作默认 `src-tauri/binaries`，在同一测试内依次验证 debug 存在、release 原子覆盖并恢复为 release；其他测试只读配置或使用临时根，不能依赖外层预构建。`tauri.conf.json` 的 `bundle.externalBin` 只声明 `binaries/tht-panel-pty-host`；beforeDev/beforeBuild npm 脚本分别先构建并复制 debug/release helper，再启动 Vite/前端 build。runtime `PtyHostResolver` 在 dev 仍解析当前 exe 同目录 debug helper，在 bundled release 解析安装目录同名 sidecar；两者都要求普通非 reparse 文件、canonical sibling，缺失或逃逸失败封闭。静态测试核对 externalBin basename 与 resolver 一致；每个 release 证据自行在临时根构建 release helper，禁止测试只覆盖 debug GUI binary或读到其他测试 profile。

Windows 下 portable-pty 先启动只等待本机 named-pipe envelope 的 CUI helper，而不是直接启动目标 CLI：父进程用随机 nonce 创建 first-instance、reject-remote-client pipe，helper 参数只含 nonce并阻塞连接；父进程取得 helper PID 后先加入独立 Job Object、设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，并用 `GetNamedPipeClientProcessId` 核对连接方就是该 helper，成功后才通过 pipe 发送 program/args/cwd。envelope 不落盘、不含环境变量，缓冲使用 Zeroizing；helper 继承 ResolvedLaunch env，读取后清除内部 launcher 环境键、启动目标并等待，Step 11 再固定完整受控环境清理。assign/客户端 PID 校验失败时 helper 尚未派生目标，可安全终止确认；父进程崩溃时 pipe/Job handle 关闭会杀死等待中的 helper/整棵树。release 测试读取 PE Optional Header 断言 Subsystem=`IMAGE_SUBSYSTEM_WINDOWS_CUI`，并用实际 release helper+ConPTY 往返 stdin/stdout/exit code；`legacy_lifecycle_windows_job_object_terminates_fixture_tree` 也必须调用同一 release helper（非 fake/debug），断言 helper、fixture parent、child 全部属于该 Job，关闭后 `ActiveProcesses=0` 且三 PID 均消失。debug `cargo test` 不能替代该证据。

controller 将“请求终止”和“等待 job ActiveProcesses=0”分开，所有会话共享单调总 deadline（默认 5 秒），等待期间不持 application mutation、PTY map 或 session lock。kill 返回 Err 但 job 已为空视为已确认退出并记录 warning；kill 返回 Ok 但 tree 未空则超时失败。Windows fixture 证明 release 在 assign 之后、目标继承同一 Job、terminal I/O/exit code 不变，并断言关闭 Job 后 helper/parent/child PID 均消失。Phase C 原生 adapter 可复用 controller 或使用创建时 job-list，不得退回无握手赋值。

binding 在发终止信号前登记 `TerminationIntent::{ExplicitKill,Shutdown}`；waiter 等 root `wait()` 与 tree-empty ack 后再分类：匹配 intent 一律 Stopped，自然 exit 0 且未强制清树为 Stopped，自然非零/wait error/超时强制清树为 Failed。tree 未确认时不得写 endedAt；终止失败且 tree 仍活时清除 intent、保留 binding/Running。Task 14 给 ApplicationMutationGate 增加分段 `MutationLease`；lease 不持 Mutex，只有 `lock() -> MutationSection` 短暂加锁，严禁锁内调用可能同步回调的 terminate/wait。

`PtyManager` 以 `kill_inflight` + RAII `KillClaim` 分配单一终止所有权。显式 kill/全量 shutdown 都固定为短锁 claim/intent/取 handles → 完全锁外 terminate+tree ack → 短锁重读并幂等收敛；全量 shutdown 只有所有树确认退出后才一次保存剩余 segment 并 clear，Shell 无 segment 但也必须 tree-empty。新增 `RuntimeOutcomeStore`：通过 Task 4 rooted/guarded ConfigFileStore 按 `runtime-outcomes/<segmentId>.json` 原子保存 `TerminalOutcome`，reparse/junction 逃逸在外部 I/O 前失败；再幂等应用 ConversationsFile，成功后删除，失败保留 binding/journal。`OutcomeRetryWorker` 用 Condvar 和 100ms→5s 有上限退避重试，每次 attempt 单独取得并释放 lifecycle/mutation guard，退避等待期间绝不持 permit 或锁；lifecycle/app_quit 也立即 drain。Task 15 bootstrap replay outcome；无 outcome/无 binding 的遗留非终态 legacy segment 标记 Interrupted，绝不猜测。

Phase A 的 `RuntimeOutcomeStore` 只覆盖 AI `RuntimeSegment` 终态；plain Shell 仍要求 Job tree-empty 才完成退出，并在正常 lifecycle callback 中 best-effort 原子更新稳定 `TerminalSession` 为 Stopped/Failed，但完整 failure journal/retry 延后到 Phase B WorkItem runtime bridge。为避免崩溃后永久残留 Running，Task 15 bootstrap 在 Job kill-on-close 已保证旧进程不可存活、runtime outcomes replay 完成后，扫描 `TerminalSession::Running && no live binding` 并原子收敛为 Failed；保存失败则 Ready 构造失败并进入 Blocked。Phase A 保持 `workspaceV2Enabled=false`，旧 compatibility UI 只能依赖进程内 shell binding，不得宣称重启可恢复 shell 进程。

同任务新增 `LegacyEntityDeletionGuard`，由 managed-session delete 与 `project_delete(deleteConversations=true)` 共用。公开删除入口只取得一次 `MutationGuard`，先通过 Task 13 同一个 `ConversationImportRegistry` 按稳定 ID 排序取得 DeleteClaim、阻止新 import并等待已有 import 原子提交/退出，再在同一 mutation mutex 下检查 `LegacyRuntimeBindings`、Conversation 全部非终态 RuntimeSegment、未知 pending import journal 和 `RuntimeOutcomeStore` pending journal；任一存在即 `CONFLICT`，零布局/metadata 写并释放 claim。project delete false 不删 Conversation，因此不取得 delete claim。metadata 删除成功后 claim 标记 deleted；已有 event/checkpoint 文件按 Task 13 明确保留为不可寻址审计残留，绝不允许 importer 在删除后继续写。lifecycle callback 应用 outcome 也使用同一 mutation mutex，delete-vs-exit/import 只能形成“import/outcome 先收敛后删除”或“删除先完成、后续 import NotFound且零写”，绝不在 Conversation 已删后生成 unknown segment/import journal。commands/facades 只能调用 `_locked(&MutationGuard, ...)`，禁止二次 acquire。

- [ ] **Step 8: 运行 lifecycle 子集并确认通过**

Run: `npm run build:pty-host -- --release && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_lifecycle_`

Expected: PASS；未收到 tree-empty ack 时不写终态，outcome 重试/重启后确定收敛。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_delete_`

Expected: PASS；删除与 exit 串行，pending outcome 不会指向已删除实体。

- [ ] **Step 9: 写失败测试固定环境清理与脱敏对象**

新增 `legacy_env_removes_all_controlled_parent_values`、`legacy_env_removes_smoke_config_control_variables`、`legacy_env_settings_sources_extend_removal_set`、`legacy_env_injects_only_selected_revision_secret`、`legacy_env_resolved_argv_debug_error_and_public_revision_hide_secret_sentinel`、`legacy_env_resolved_launch_debug_is_redacted`、`legacy_env_resolved_launch_is_not_clone`。

- [ ] **Step 10: 运行环境子集并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_env_`

Expected: FAIL，旧 Command 构造仍会继承受控环境。

- [ ] **Step 11: 实现集中式受控环境清理**

`ResolvedLaunch` 无 Clone、自定义脱敏 Debug，并拆 `env_remove/public_env/secret_env`。PtyManager 先移除集中维护的 driver/internal keys（至少 OPENAI_API_KEY/OPENAI_BASE_URL/CODEX_HOME/ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL/CLAUDE_CONFIG_DIR、`THT_PANEL_SMOKE`、`THT_PANEL_CONFIG_DIR` 及 settingsSources 声明键），再注入当前 revision；helper 只通过 nonce 参数识别，不继承 smoke 控制变量。secret 只在 spawn 临界区以 `SecretValue` 存活，不进入 args、错误或 binding。

- [ ] **Step 12: 运行环境子集并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_env_`

Expected: PASS；父进程 sentinel 全部消失且 fake host 只观察到选中 revision。

- [ ] **Step 13: 写失败测试固定新旧 runtime namespace**

新增 `legacy_namespace_new_codex_home_is_revision_scoped_and_immutable`、`legacy_namespace_codex_config_hash_mismatch_fails_closed`、`legacy_namespace_runtime_directory_reparse_escape_is_rejected`、`legacy_namespace_codex_config_parent_reparse_escape_is_rejected`、`legacy_namespace_migrated_codex_resume_uses_recorded_legacy_home_read_only`、`legacy_namespace_migrated_config_hash_mismatch_never_rewrites`、`legacy_namespace_migrated_session_append_does_not_invalidate_namespace`、`legacy_namespace_claude_settings_are_revision_scoped`、`legacy_namespace_shell_remains_plain_pty`。

- [ ] **Step 14: 运行 namespace 子集并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_namespace_`

Expected: FAIL，新/迁移 namespace 尚未分路。

- [ ] **Step 15: 实现不可变 revision 目录与只读 legacy config**

新 Codex segment 固定 `runtime/codex/<revisionId>`，Claude settings 固定 `runtime/claude/<revisionId>/settings.json`；二者的创建/读写全部通过 rooted guarded ConfigFileStore，任何中间目录 reparse/junction 逃逸失败封闭。config 首次原子生成后 hash 不符报错；迁移 segment 解析 Task 8 记录、经 Task 13 校验/导入的 legacy locator，验证旧 HOME 归属标记/config hash，不复制、不重写 config，会话日志允许追加。Shell 完全绕过 namespace。

- [ ] **Step 16: 运行 namespace 子集并确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_namespace_`

Expected: PASS；新 revision 隔离，旧 config hash/归属标记不变。

- [ ] **Step 17: 写失败测试固定 history/探测只走 stable locator**

新增 `legacy_history_filters_shared_revision_home_by_project_cwd`、`legacy_history_uses_every_frozen_segment_namespace`、`legacy_history_uses_imported_events_after_restart`、`legacy_history_claude_ambiguous_native_source_fails_closed`、`legacy_history_never_reads_parent_codex_home`、`legacy_detect_accepts_only_bound_managed_session_id`、`legacy_detect_derives_driver_scope_and_exclusions_from_binding`、`legacy_detect_zero_candidate_returns_none_and_remains_retryable`、`legacy_detect_multiple_candidates_never_binds`、`legacy_detect_physical_scope_claim_guarantees_single_unresolved_fresh_binding`、`legacy_detect_after_first_identity_bound_allows_next_physical_scope_launch_with_new_baseline`、`legacy_detect_cross_revision_same_physical_codex_home_is_serialized`、`legacy_detect_claude_shared_source_is_unsupported_without_scan`、`legacy_detect_external_claude_candidate_can_never_bind_panel_segment`、`legacy_detect_candidate_claimed_by_other_conversation_is_conflict`、`legacy_detect_duplicate_callback_is_idempotent_for_same_generation`、`legacy_detect_late_callback_cannot_overwrite_new_binding_generation`。

- [ ] **Step 18: 运行 history/detect 子集并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_history_`

Expected: FAIL，history/detect 尚未委托 stable locator/importer。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch legacy_detect_`

Expected: FAIL，fresh detect 的 baseline、唯一候选、identity claim 与 generation 重验尚未实现；不得是 `0 tests`。

- [ ] **Step 19: 接入 LegacyHistoryImporter 与稳定探测**

history 先读取 Conversation.legacyHistorySource，再结合冻结 segments 的 namespace 去重；没有 segment 的 needsProviderSelection 会话仍可按 Conversation.projectPathSnapshot 返回只读 legacy 投影，但不能发送。revision HOME 被多个 Project 共用时，逐个按对应 `RuntimeSegment.cwdSnapshot` 与原生 `session_meta.cwd` 精确过滤，Project.path 后续编辑不影响结果。重启后优先返回 Task 13 完成事件；Claude 归属不唯一时只保留 Panel 历史并返回 Unsupported/needs selection。`aiSessionDetect(managedSessionId)` 仅用于 `NativeDetectPolicy::PrivateCodex` fresh launch，并只读该 live binding 的 `AiDetectBaseline`；resume 已继承 ID，Claude `UnsupportedSharedSource` 永不进入此 API。调用时必须仍持有匹配 bindingGeneration/detectScopeId 的 FreshScopeClaim，保证同一物理 HOME+cwd 只有一个 Panel 未解析进程；claim 缺失即 stale Conflict。fresh detect 仅在 baseline 的受控物理 HOME/cwd 中枚举 `backendStartedAt` 之后的 raw IDs，每项先经 `NativeSessionId::parse_for_driver`，任一新候选语法非法都脱敏失败封闭；再减去 baseline.preexisting 与已有 NativeIdentityClaim：0 个候选返回 `Ok(None)` 且零修改，前端继续定时重试；多于 1 个返回 Conflict 且零修改；恰好 1 个才进入提交。提交前在同一个 mutation section 内原子重验 bindingGeneration、conversationId/segmentId、launch binding 仍匹配，且 `(driver, runtimeNamespaceId, externalSessionId)` 尚未被任何 Conversation claim；随后登记 owner=当前 conversationId 并写 segment.externalSessionId。registry 在 Ready 构建时从所有历史 segment 重建；同一 Conversation lineage 的重复 identity 合法，不同 Conversation 的重复 identity 使 Ready 构建 Blocked。相同 generation 的重复回调若 segment 已绑定同值则幂等返回 `Some(id)`；迟到 generation、异值覆盖或跨 Conversation claim 失败封闭。physical HOME identity/cwd/driver/spawnedAt/exclude 全部从 baseline/binding 派生，前端没有覆盖入口。

- [ ] **Step 20: 运行 LegacyLaunchService 全量测试并提交**

Run: `npm run build:pty-host -- --release && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch && cargo test --manifest-path src-tauri/Cargo.toml history && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；现有旧命令仍可编译运行，新 service 尚未被命令层半切换。

使用 `@code-simplifier` 分别审查冻结 selection、Job Object HANDLE/timeout RAII、PTY lifecycle/outcome journal 幂等终态、环境构造、namespace 解析和 history 路由；若修改，重跑对应子集和本步骤。

```bash
git add .gitignore package.json scripts/build-pty-host.mjs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/src/bin/tht_panel_pty_host.rs src-tauri/src/compat/mod.rs src-tauri/src/compat/launch_facade.rs src-tauri/src/compat/runtime_bindings.rs src-tauri/src/compat/session_facade.rs src-tauri/src/compat/project_facade.rs src-tauri/src/config/model.rs src-tauri/src/domain/conversation.rs src-tauri/src/storage/runtime_outcome_store.rs src-tauri/src/storage/mod.rs src-tauri/src/pty src-tauri/src/history src-tauri/src/application/legacy_entity_deletion_guard.rs src-tauri/src/application/mutation_gate.rs src-tauri/src/application/mod.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/process-tree/parent.ps1 src-tauri/tests/legacy_launch.rs
git commit -m "feat: 实现隔离的 legacy 启动服务"
```

### Task 15: 装配 AppState、兼容命令与 legacy launch

**Files:**
- Create: `src-tauri/src/application/bootstrap.rs`
- Create: `src-tauri/src/application/config_root.rs`
- Create: `src-tauri/src/commands/project_cmds.rs`
- Create: `src-tauri/src/commands/provider_cmds.rs`
- Create: `src-tauri/src/commands/migration_cmds.rs`
- Create: `src-tauri/src/commands/preferences_cmds.rs`
- Create: `scripts/cli-smoke.mjs`
- Create: `src/App.legacyLaunch.test.tsx`
- Modify: `package.json`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/compat/facade.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/config_cmds.rs`
- Modify: `src-tauri/src/commands/pty_cmds.rs`
- Modify: `src-tauri/src/commands/session_cmds.rs`
- Modify: `src-tauri/src/commands/history_cmds.rs`
- Modify: `src-tauri/src/config/mod.rs`
- Modify: `src-tauri/src/config/model.rs`
- Modify: `src-tauri/src/storage/config_file_store.rs`
- Modify: `src-tauri/src/storage/mod.rs`
- Modify: `src-tauri/src/storage/repositories.rs`
- Modify: `src-tauri/src/storage/workspace_store.rs`
- Modify: `src-tauri/src/storage/runtime_outcome_store.rs`
- Modify: `src-tauri/src/secrets/secret_store.rs`
- Modify: `src-tauri/src/migration/legacy_reader.rs`
- Modify: `src-tauri/src/migration/coordinator.rs`
- Modify: `src-tauri/src/history/importer.rs`
- Modify: `src-tauri/src/compat/launch_facade.rs`
- Modify: `src-tauri/src/pty/spawn.rs`
- Delete: `src-tauri/src/config/store.rs`
- Modify: `src/api/types.ts`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src/App.tsx`
- Modify: `src/store/settingsStore.ts`
- Create: `src/store/settingsStore.test.ts`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Test: `src/components/dialogs/SettingsDialog.test.tsx`
- Test: `src-tauri/tests/bootstrap_order.rs`
- Test: `src-tauri/tests/config_root.rs`

- [ ] **Step 1: 写失败测试固定完整启动/切换矩阵与前端 spawn 顺序**

新增 `bootstrap_recovers_before_repository_open`（顺序固定 `resolveConfigRoot → recoverMigration → recoverCompatibilityWrites → recoverWorkspaceTransaction → openRepositories → recoverRuntimeOutcomes → reconcileUnboundLegacySegments → reconcileUnboundTerminalSessions → buildReady`）、`bootstrap_pending_migration_never_calls_config_store_new`、`bootstrap_pending_compat_write_never_opens_repositories_first`、`bootstrap_unknown_compat_write_hash_enters_blocked`、`bootstrap_fresh_install_enters_ready`、`bootstrap_pure_legacy_enters_legacy_read_only`、`bootstrap_schema_v2_recovers_both_application_journals_then_ready`、`bootstrap_runtime_outcome_replays_exact_stopped_or_failed_state_before_ready`、`bootstrap_unbound_running_legacy_segment_becomes_interrupted`、`bootstrap_unknown_runtime_outcome_fails_closed`、`bootstrap_migration_recovery_clean_rollback_returns_legacy_read_only`、`bootstrap_unknown_journal_state_enters_blocked`、`bootstrap_migration_apply_builds_ready_before_swap`、`bootstrap_migration_apply_clean_rollback_republishes_legacy`、`bootstrap_committed_workspace_recovery_failure_enters_blocked`、`bootstrap_committed_repository_open_failure_enters_blocked`、`bootstrap_committed_ready_graph_failure_enters_blocked`、`bootstrap_native_identity_same_conversation_lineage_is_valid`、`bootstrap_native_identity_cross_conversation_duplicate_enters_blocked`、`bootstrap_migration_apply_only_accepts_legacy_read_only_confirmation_state`、`bootstrap_ready_apply_during_inflight_spawn_or_kill_is_rejected_without_runtime_change`、`bootstrap_migration_recover_only_accepts_blocked_and_publishes_recovering_first`、`bootstrap_migration_recover_success_publishes_ready_or_legacy`、`bootstrap_migration_recover_failure_republishes_redacted_blocked`、`bootstrap_mutation_command_acquires_gate_before_runtime_snapshot`、`bootstrap_migration_transition_never_holds_runtime_read_while_waiting_mutation`、`bootstrap_commands_use_one_runtime_guard`、`bootstrap_feature_flag_false_routes_ai_to_legacy_service`、`bootstrap_feature_flag_true_is_unsupported_before_phase_c`、`spawn_request_ai_rejects_resume_session_id_and_unknown_fields`、`frontend_resume_id_cannot_override_frozen_segment`、`ai_session_detect_rejects_unbound_managed_session_without_mutation`、`ai_session_detect_derives_workspace_driver_spawn_time_and_exclusions_from_binding`、`ai_session_detect_zero_candidate_returns_none_without_write`、`ai_session_detect_two_candidates_is_zero_write_conflict`、`ai_session_detect_stale_binding_generation_is_zero_write_conflict`、`ai_session_detect_concurrent_bindings_cannot_claim_same_external_id`、`backend_client_migration_recover_is_void_then_status_refresh`。`config_root.rs` 新增 `config_root_default_uses_app_config_dir`、`config_root_override_requires_debug_and_explicit_smoke_flag`、`config_root_rejects_relative_empty_root_and_existing_file`、`config_root_rejects_parent_escape_and_symlink_or_reparse_escape`、`config_root_accepts_fresh_descendant_of_manifest_target`、`bootstrap_injects_one_resolved_config_root_into_every_storage_and_runtime_component`、`production_modules_do_not_call_app_config_dir_directly`。前端新增 `app_legacy_ai_creates_managed_session_before_pty_spawn`、`app_legacy_resume_always_passes_managed_session_id`、`app_ai_detect_null_schedules_next_attempt`、`app_ai_detect_conflict_surfaces_error_and_stops_guessing`、`pty_session_info_native_detect_union_exposes_no_scope_or_path`、`app_ai_detect_unsupported_never_polls_and_shows_rebuild_notice`、`spawnRequest_ai_type_has_no_resume_session_id`、`settingsDialog_never_prefills_secret_during_command_cutover`、`settingsDialog_blank_secret_preserves_existing_during_command_cutover`、`settingsStore_persists_non_provider_settings_only_during_command_cutover`。

抽取唯一 `buildReadyAfterRecovery()`，内部顺序固定为 `recoverRuntimeOutcomes → reconcileUnboundLegacySegments → reconcileUnboundTerminalSessions → buildReady`；marker=2 启动、migration apply 与 migration recover 三条 Ready 构建路径只能调用该函数，禁止复制子序列。另新增 `bootstrap_unbound_running_terminal_becomes_failed` 与 `bootstrap_unbound_running_terminal_save_failure_enters_blocked`，证明无 binding/outcome 的遗留 Running Terminal 不会进入 Ready。BackendClient/Tauri/Fake 契约再增加 `migration_backup_list_returns_only_transaction_and_count`、`migration_backup_delete_forwards_confirmation_without_path`、`migration_backup_commands_are_registered_once`。

- [ ] **Step 2: 运行装配测试并确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test config_root`

Expected: FAIL，ConfigRoot resolver/injection 尚未实现；不得是 `0 tests`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order`

Expected: FAIL，StorageRuntime/恢复顺序尚未装配；不得是 `0 tests`。

Run: `npm run test -- src/App.legacyLaunch.test.tsx src/components/dialogs/SettingsDialog.test.tsx src/store/settingsStore.test.ts`

Expected: FAIL，前端 stable-ID spawn 与安全 config cutover 尚未装配；两个文件都必须被 Vitest 收集。

- [ ] **Step 3: 核对旧 ConfigStore 唯一删除范围并取得明确授权**

先规划完成所有替代调用，再运行：`rg -n "ConfigStore|config::store|mod store" src-tauri/src src-tauri/tests`。预期待改生产命中仅为 state/commands/config module。执行删除前向用户说明唯一目标 `src-tauri/src/config/store.rs` 及原因并取得授权；未授权时停止，不以空文件或未编译死代码绕过。

- [ ] **Step 4: 一次装配完整 StorageRuntime 与所有兼容命令**

`ConfigRootResolver` 是配置根的唯一入口。默认使用 Tauri `app_config_dir`；仅 debug/test build 且 `THT_PANEL_SMOKE=1` 时读取 `THT_PANEL_CONFIG_DIR`。override 必须是绝对、非根路径，并位于 canonicalized `env!("CARGO_MANIFEST_DIR")/target` 下；解析最近已存在父目录并拒绝 `..`、symlink/reparse-point 逃逸、existing file 和空值，验证后才创建 leaf，再 canonicalize 复核仍在 target 内。release 中设置任一 smoke 变量必须返回稳定配置错误而不是静默改根。解析一次得到的 `Arc<ConfigRoot>` 注入 LegacyReader、migration/coordinator、Repositories、WorkspaceStore、SecretStore、runtime namespace、history importer、RuntimeOutcomeStore 和所有 recovery；除 resolver 外生产模块不得再次调用 `app.path().app_config_dir()` 或读取 override 环境变量。

兼容 config command 切换在本任务同时前移安全 DTO：`LegacyGlobalConfigPublic` 只返回主题/终端/通知、公开 provider 字段和 `apiKeyConfigured`，`LegacyGlobalConfigInput` 的两个 provider secret 使用 write-only `IncomingSecret`。SettingsDialog 密钥草稿只在组件局部 state，get 永不回填，空提交表示复用，提交后立即清空；settingsStore 只持非供应商设置。Tauri adapter 显式完成 camelCase→IncomingSecret 映射，不保留旧 nested `apiKey: string` serde alias，因此 Task 15 command cutover 后不存在“前端旧 DTO / Rust 新 DTO”的中间状态。

AppState 持有无状态 `CompatibilityFacade`、全局 `Arc<ApplicationMutationGate>`、transition mutex、`Arc<dyn RuntimeTransitionAdmission>` 和 `RwLock<StorageRuntime>`；Task 15 的 admission 实现返回覆盖整次 transition 的 always-open lease，Task 17 再替换为 QuitGate ordinary permit，调用结构不变。runtime 为 LegacyReadOnly/Recovering/Blocked/Ready，Legacy/Ready 各携 `Arc` service graph，Ready 额外持有 Task 14 LegacyLaunchService。纯读命令可在一个 runtime read guard 内借用 read ref；mutation command 固定 `ApplicationMutationGate → 短 runtime read/clone Arc → 释放 runtime guard → _locked service`，不得反向获取。启动结果：fresh→Ready；纯 legacy→LegacyReadOnly；marker=2→recover compat-write/workspace journals、open repositories，再调用唯一 `buildReadyAfterRecovery()`：replay `runtime-outcomes`、把无 outcome/无 live binding 的遗留非终态 legacy segment 标记 Interrupted、把遗留 Running Terminal 标记 Failed，最后从全部 RuntimeSegment 重建 NativeIdentityClaim registry（同 Conversation lineage 可重复、跨 Conversation 重复即 Blocked）并构造 Ready；迁移尚未 committed 且可证明完整回滚→LegacyReadOnly；未知/回滚失败→Blocked。marker 已 committed 后，compat/workspace recover、repository open/校验、`buildReadyAfterRecovery()` 的 runtime outcome 校验/应用、legacy/terminal reconcile、Ready service graph 构造或孤儿引用枚举任一步失败都必须发布 Blocked，因为此时不能再回退 legacy；`migration_recover` 从相同步骤重试。未知 segmentId、非法状态转换或 outcome hash 冲突失败封闭，不能删除 journal；孤儿 secret 清理任一引用枚举失败即零删除。

注册 project/provider/preferences 与 `migration_status`、`migration_preview`、`migration_apply`、`migration_recover`、`migration_backup_list`、`migration_backup_delete`；六个迁移命令在唯一 `generate_handler!` 中各出现一次。`migration_apply` 只接受当前 `LegacyReadOnly` 且 transactionId 与最新 confirmationRequired preview 完全一致；`migration_recover` 只接受当前 `Blocked`。源状态检查、取得 transition mutex/ApplicationMutationGate 与发布 Recovering 必须在同一临界协议内完成，Ready/Recovering/其他状态的伪造 apply 在 runtime/metadata/process 零修改下返回 Conflict，不能先发布 Recovering；因此 Ready 的 spawn/kill/后续 Phase B 长操作与合法 migration transition 永不并存。通过前置后，apply/recover 固定 `transition mutex → RuntimeTransitionAdmission.acquire()（lease 持到最终 publish）→ ApplicationMutationGate短锁 → runtime write 再校验源状态并发布 Recovering → 释放 mutation mutex但保留 transition lease → 执行恢复/构图 → 短 runtime write swap → 释放 lease`；命令不得先派生/持有 `CompatRuntimeReadRef`。发布 Recovering 后，新的 mutation command 即使取得 gate也在短 runtime read 时稳定拒绝，旧 mutation 已在首次 gate 前串行完成。Committed 后依次 recover compat-write/workspace journals、open/校验 repositories、调用唯一 `buildReadyAfterRecovery()`（recover runtime outcomes → reconcile unbound legacy segments → reconcile unbound terminal sessions → 构造完整 Ready graph），全部成功才一次 swap，任何 post-commit 失败都发布 Blocked；RolledBackLegacy 只适用于 marker 未 committed 且四个 legacy hash 已验证恢复的结果；Uncertain 同样 Blocked。旧 config/workspace/layout/session/history/pty commands 全部委托专责 facade/service；删除 ConfigStore module/file 后不得存在直接旧文件 writer。`nativeAiEnabled=false` 路由 Task 14，true 在 Phase C 前明确 Unsupported。

Task 2 的前端迁移契约在本任务补全为 `migrationRecover(): Promise<void>`、`migrationBackupList(): Promise<MigrationBackupSummary>`、`migrationBackupDelete(transactionId: string, confirmed: boolean): Promise<void>`，Tauri/Fake/commands 同名；调用者必须在 recover resolve 后重新调用 `migrationStatus()`，不得把返回值当 Ready runtime。backup delete 不能接受路径，只转发 canonical transactionId 与显式确认布尔值。Fake 记录调用并支持 deferred/error，覆盖 Blocked→Recovering→Ready/Legacy/Blocked 三种结果及 backup marker/pending-journal 拒绝。

Task 1 暂存的 legacy detect 契约在本提交原子切换：`BackendClient`、`TauriBackendClient`、`FakeBackendClient`、`commands.ts`、Rust `session_cmds` 与 App 全部改为 `aiSessionDetect(managedSessionId: string)`，删除旧 request DTO；任一层仍接受 workspace/kind/spawnedAt/exclude 时类型/注册测试失败。前端与 Rust `SpawnRequest` 同时改为 `deny_unknown_fields` 的 discriminated union：AI 分支精确只含运行所需字段与 `managedSessionId: string`，shell 分支不带；两者都删除旧公开 `resumeSessionId`/原生 session/thread ID 输入，未知字段直接反序列化失败。新建与恢复均只传 stable managedSessionId，后端根据 Conversation 最新冻结 source segment 派生 externalSessionId/provider/model/namespace/cwdSnapshot，前端无法覆盖。`aiSessionDetect` 同样只接受 stable managedSessionId；后端必须先找到该 ID 的 live launch binding/AiDetectBaseline，再从 binding/segment 派生 workspace、driver、spawnedAt 和 exclude，unbound/stale ID 零修改拒绝。spawn 响应只暴露 `nativeDetect: "poll" | "unsupported"`，不暴露 scope/path；App 仅在 `poll` 时调用 detect，Claude shared-source 为 `unsupported` 并显示“本次会话退出后需由 Panel 历史重建”。返回 `null` 表示正常“尚未出现唯一 native ID”，前端保留 generation 并安排下一次有上限轮询；Conflict 表示候选歧义，停止猜测并显示脱敏错误，不能吞错后静默结束。App 新建 AI 时先创建标题“新会话”的 ManagedSession/Conversation并冻结当时 Project.path，再 ptySpawn；首次输入只重命名。恢复总是传已有 stable ID。

本任务不改变兼容 Shell 的旧 UI 创建时序，也不为 shell 分支伪造 managedSessionId/terminalSessionId；它只保证已通过 ManagedSession facade 落盘的 TerminalSession 不含易失 PTY ID并可在启动时收敛。Phase B 的稳定 WorkItem runtime bridge 才切换 Shell 为 metadata-first。

- [ ] **Step 5: 运行装配、兼容和 legacy 全量测试**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml --test config_root && cargo test --manifest-path src-tauri/Cargo.toml --test bootstrap_order && cargo test --manifest-path src-tauri/Cargo.toml --test compatibility_facade && cargo test --manifest-path src-tauri/Cargo.toml --test legacy_launch && npm run test -- src/App.legacyLaunch.test.tsx src/components/dialogs/SettingsDialog.test.tsx src/store/settingsStore.test.ts && npm run typecheck && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；迁移切换只发布完整 runtime，legacy PTY 无断档，生产代码不再引用 ConfigStore 或创建明文 `.bak`。

- [ ] **Step 6: 增加显式 opt-in CLI probe**

`package.json` 增加 `"test:cli-smoke": "node scripts/cli-smoke.mjs"`。`--probe-only` 只按 Windows 可执行文件解析规则运行 Claude/Codex `--version`，输出脱敏 PASS/SKIP，不发送模型请求。

Run: `npm run test:cli-smoke -- --probe-only`

Expected: 每个 driver 输出 PASS(version) 或 SKIP(not installed)，退出 0 且不打印环境变量值。

- [ ] **Step 7: 代码简化审查并提交**

使用 `@code-simplifier` 审查 runtime 变体转换、命令 guard、前端 spawn 编排和重复 DTO；若修改，重跑 Step 5/6。

```bash
git add package.json scripts/cli-smoke.mjs src-tauri/src/application src-tauri/src/compat/facade.rs src-tauri/src/compat/launch_facade.rs src-tauri/src/commands src-tauri/src/state.rs src-tauri/src/lib.rs src-tauri/src/config/mod.rs src-tauri/src/config/model.rs src-tauri/src/storage/config_file_store.rs src-tauri/src/storage/mod.rs src-tauri/src/storage/repositories.rs src-tauri/src/storage/workspace_store.rs src-tauri/src/storage/runtime_outcome_store.rs src-tauri/src/secrets/secret_store.rs src-tauri/src/migration/legacy_reader.rs src-tauri/src/migration/coordinator.rs src-tauri/src/history/importer.rs src-tauri/src/pty/spawn.rs src-tauri/tests/config_root.rs src-tauri/tests/bootstrap_order.rs src/api/types.ts src/api/v2/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/test/FakeBackendClient.ts src/App.tsx src/App.legacyLaunch.test.tsx src/store/settingsStore.ts src/store/settingsStore.test.ts src/components/dialogs/SettingsDialog.tsx src/components/dialogs/SettingsDialog.test.tsx
git rm src-tauri/src/config/store.rs
git commit -m "feat: 装配安全迁移与 legacy 启动"
```

### Task 16: 新增前端 v2 stores 与供应商管理界面

**Files:**
- Create: `src/store/projectStore.ts`
- Create: `src/store/providerStore.ts`
- Create: `src/store/globalPreferencesStore.ts`
- Create: `src/store/migrationStore.ts`
- Create: `src/components/providers/ProviderManager.tsx`
- Create: `src/components/providers/ProviderForm.tsx`
- Create: `src/styles/providers.css`
- Modify: `src/api/v2/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src/store/uiStore.ts`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/styles/main.css`
- Test: `src/store/providerStore.test.ts`
- Test: `src/store/projectStore.test.ts`
- Test: `src/store/globalPreferencesStore.test.ts`
- Test: `src/store/migrationStore.test.ts`
- Test: `src/components/providers/ProviderManager.test.tsx`

- [ ] **Step 1: 写失败测试固定 store 工厂注入和同名模型隔离**

新增 `providerStore_loads_public_details_without_secret`、`providerStore_same_model_name_keeps_provider_scoped_ids`、`providerStore_save_parameter_never_enters_zustand_before_during_or_after_request`、`providerStore_disabled_provider_remains_visible`；另写 `projectStore_delete_forwards_deleteConversations`、`globalPreferencesStore_round_trips_stable_ids`、`migrationStore_tracks_status_preview_and_blocked_error`、`migrationStore_recover_refreshes_runtime_status`。

- [ ] **Step 2: 运行 store 测试并确认失败**

Run: `npm run test -- src/store/providerStore.test.ts src/store/projectStore.test.ts src/store/globalPreferencesStore.test.ts src/store/migrationStore.test.ts`

Expected: FAIL，providerStore 尚不存在。

- [ ] **Step 3: 实现接收 BackendClient 的 store 工厂**

四个 v2 store 导出 `createXxxStore(client)` 供测试及生产单例；不 import `invoke`。Provider store 的 `save(input)` 只把一次性参数直接转交 client，不把它写入 pending action/state；测试在 promise pending、resolve、reject 三个时点序列化 Zustand snapshot，均不得含 sentinel。表单 secret 放组件局部 state，完成/失败后清空，不写 localStorage/Zustand。

- [ ] **Step 4: 运行 store 测试并确认通过**

Run: `npm run test -- src/store/providerStore.test.ts src/store/projectStore.test.ts src/store/globalPreferencesStore.test.ts src/store/migrationStore.test.ts`

Expected: PASS。

- [ ] **Step 5: 写失败 UI 测试固定新增/编辑/禁用与密钥留空语义**

新增 `providerManager_groups_claude_and_codex`、`providerManager_blank_secret_keeps_existing`、`providerManager_new_secret_is_not_rendered_after_save`、`providerManager_soft_delete_keeps_history_warning`、`providerManager_custom_non_official_base_url_shows_risk_without_echoing_credentials`、`providerManager_save_surfaces_format_validation_without_separate_validation_action`、`providerManager_phase_a_renders_no_validation_or_connection_test_action`。

- [ ] **Step 6: 运行供应商 UI 测试并确认失败**

Run: `npm run test -- src/components/providers/ProviderManager.test.tsx`

Expected: FAIL，组件尚不存在。

- [ ] **Step 7: 实现供应商管理器并从 Settings 打开**

按 Claude/Codex 分组，支持新增、复制、编辑、启禁用、软删除；表单显示“密钥已配置”，留空沿用。baseUrl host 不在内置官方 allow-list 时显示“自定义端点可能接收提示词、工具输入和文件内容”的明确风险；提示和错误不得回显 userinfo/query（后端已拒绝）或完整 URL。Phase A 不提供独立“验证配置”或“连接测试”按钮：用户保存时由同一个后端 validator 一次校验 URL、模型、闭合 extraOptions 和 DriverOverrides，失败保留表单并显示稳定字段错误，成功只表示“已保存”，绝不显示“连接成功”。真实连接测试依赖 Phase C 的已验证 RuntimeAdapter，必须在 `docs/superpowers/plans/2026-07-10-panel-redesign-phase-c-runtime-adapters.md` 中以 BackendClient/Tauri 命令、费用确认和真实协议结果完整交付。

- [ ] **Step 8: 运行 UI、类型和构建测试并提交**

Run: `npm run test -- src/store/providerStore.test.ts src/store/projectStore.test.ts src/store/globalPreferencesStore.test.ts src/store/migrationStore.test.ts src/components/providers/ProviderManager.test.tsx && npm run typecheck && npm run build`

Expected: PASS；DOM/测试输出不含 fixture secret。

使用 `@code-simplifier` 审查 store 状态重复；若修改，重跑本步骤。

```bash
git add src/api/v2/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/test/FakeBackendClient.ts src/store/projectStore.ts src/store/projectStore.test.ts src/store/providerStore.ts src/store/providerStore.test.ts src/store/globalPreferencesStore.ts src/store/globalPreferencesStore.test.ts src/store/migrationStore.ts src/store/migrationStore.test.ts src/store/uiStore.ts src/components/providers src/components/dialogs/SettingsDialog.tsx src/styles/providers.css src/styles/main.css
git commit -m "feat: 新增多供应商管理界面"
```

### Task 17: 增加迁移确认、项目默认供应商和安全旧设置表单

**Files:**
- Create: `src/components/dialogs/MigrationDialog.tsx`
- Modify: `src/components/dialogs/WorkspaceDialog.tsx`
- Create: `src/components/dialogs/ProjectDeleteDialog.tsx`
- Test: `src/components/dialogs/ProjectDeleteDialog.test.tsx`
- Modify: `src/components/Sidebar/WorkspaceItem.tsx`
- Create: `src/components/Sidebar/WorkspaceItem.test.tsx`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/store/settingsStore.ts`
- Test: `src/store/settingsStore.test.ts`
- Modify: `src/store/workspaceStore.ts`
- Modify: `src/store/uiStore.ts`
- Modify: `src/App.tsx`
- Modify: `src/keepAliveManager.ts`
- Create: `src/keepAliveManager.test.ts`
- Modify: `src/hooks/useHotkeys.ts`
- Create: `src/hooks/useHotkeys.test.ts`
- Modify: `src/terminal/TerminalPane.tsx`
- Create: `src/terminal/TerminalPane.test.tsx`
- Modify: `src/api/types.ts`
- Modify: `src/api/backendClient.ts`
- Modify: `src/api/tauriBackendClient.ts`
- Modify: `src/api/commands.ts`
- Modify: `src/api/events.ts`
- Modify: `src/test/FakeBackendClient.ts`
- Modify: `src/store/layoutStore.ts`
- Modify: `src/components/dialogs/ConfirmDialog.tsx`
- Modify: `src/styles/dialogs.css`
- Modify: `src-tauri/src/tray.rs`
- Create: `src-tauri/src/application/quit_gate.rs`
- Modify: `src-tauri/src/application/mod.rs`
- Modify: `src-tauri/src/application/bootstrap.rs`
- Modify: `src-tauri/src/application/mutation_gate.rs`
- Modify: `src-tauri/src/application/provider_service.rs`
- Modify: `src-tauri/src/state.rs`
- Create: `src-tauri/src/commands/app_cmds.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/config_cmds.rs`
- Modify: `src-tauri/src/commands/project_cmds.rs`
- Modify: `src-tauri/src/commands/provider_cmds.rs`
- Modify: `src-tauri/src/commands/preferences_cmds.rs`
- Modify: `src-tauri/src/commands/migration_cmds.rs`
- Modify: `src-tauri/src/commands/session_cmds.rs`
- Modify: `src-tauri/src/commands/history_cmds.rs`
- Modify: `src-tauri/src/commands/pty_cmds.rs`
- Modify: `src-tauri/src/compat/facade.rs`
- Modify: `src-tauri/src/compat/write_transaction.rs`
- Modify: `src-tauri/src/compat/project_facade.rs`
- Modify: `src-tauri/src/compat/session_facade.rs`
- Modify: `src-tauri/src/compat/layout_facade.rs`
- Modify: `src-tauri/src/history/importer.rs`
- Modify: `src-tauri/src/pty/lifecycle.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src/App.test.tsx`
- Test: `src-tauri/tests/bootstrap_order.rs`
- Test: `src-tauri/tests/provider_service.rs`
- Test: `src-tauri/tests/compatibility_facade.rs`
- Test: `src-tauri/tests/legacy_history_importer.rs`
- Test: `src-tauri/tests/legacy_launch.rs`
- Test: `src-tauri/tests/quit_gate.rs`
- Test: `src-tauri/tests/tray_quit.rs`
- Test: `src/components/dialogs/MigrationDialog.test.tsx`
- Test: `src/components/dialogs/WorkspaceDialog.test.tsx`
- Test: `src/components/dialogs/SettingsDialog.test.tsx`
- Test: `src/components/dialogs/ConfirmDialog.test.tsx`
- Test: `src/store/layoutStore.test.ts`

- [ ] **Step 1: 写失败测试固定迁移确认与失败封闭**

新增 `migrationDialog_shows_preview_counts_not_values`、`migrationDialog_requires_explicit_confirm`、`migrationDialog_explains_encrypted_backup_and_no_physical_erase_guarantee`、`migrationDialog_recovering_and_failed_block_business_ui`、`migrationDialog_blocked_retry_calls_recover_then_refreshes_status`、`migrationDialog_stale_transaction_refreshes_preview_and_requires_reconfirm`、`migrationDialog_apply_void_then_status_must_be_complete`、`settings_migration_backup_lists_count_without_path`、`settings_migration_backup_delete_requires_second_confirmation`、`settings_migration_backup_delete_failure_keeps_entry`、`app_loads_v2_stores_only_after_ready_runtime`。

- [ ] **Step 2: 运行迁移 UI 测试并确认失败**

Run: `npm run test -- src/components/dialogs/MigrationDialog.test.tsx`

Expected: FAIL，MigrationDialog 尚不存在。

Run: `npm run test -- src/components/dialogs/SettingsDialog.test.tsx`

Expected: FAIL，迁移加密备份列表/二次确认删除入口尚未实现；不得是 `0 tests`。

Run: `npm run test -- src/App.test.tsx`

Expected: FAIL，Ready/LegacyReadOnly/Recovering/Blocked 的业务 store 加载 gate 尚未实现；该 App 级测试必须被收集。

- [ ] **Step 3: 实现启动迁移 gate**

流程固定为 `migrationStatus → confirmationRequired 时 migrationPreview → 展示来源/计数及“原文件会被替换/删除，但无法承诺 SSD、文件系统快照或历史块的物理擦除；将保留 DPAPI 加密备份” → 用户确认 → migrationApply(transactionId)（void）→ 再取 migrationStatus`；只有 status.complete/ReadyRuntime 才加载 v2 stores。recovering 显示阻断进度；failed/Blocked 只显示脱敏错误和“重试恢复”，点击后调用 Task 15 的 `migrationRecover()`，再取 status，仍 blocked 时保持 gate，恢复为 LegacyReadOnly/Ready 时再走对应分支。transactionId Conflict 时刷新 preview 并要求用户重新确认，禁止自动重试旧计划。

App/Sidebar 的数据路由固定：LegacyReadOnly 只使用只读 `workspaceStore` 兼容列表，并禁用所有会产生持久化的项目、会话、布局、主题、终端设置和 keepAlive 控件；允许的折叠、选中、滚动等瞬态视图状态不得进入 `layoutStore/settingsStore` 的 dirty generation，也不得启动防抖保存。两个 store 在 LegacyReadOnly 下的 `flushPersist()` 若无 dirty 必须本地 no-op 成功，绝不调用普通或 quit-token 写命令；因此用户取消迁移后仍可通过统一 QuitGate 正常退出且 4 个 legacy canonical hash 不变。Ready 一次性加载 project/provider stores，`workspaceStore` 仅作为现有 Sidebar 的 Project view adapter，所有写转发 projectStore。Recovering/Blocked 不加载任一业务列表。Phase B 再删除该适配层。

- [ ] **Step 4: 运行迁移 UI 测试并确认通过**

Run: `npm run test -- src/components/dialogs/MigrationDialog.test.tsx src/App.test.tsx`

Expected: PASS；App 只在 Ready 加载 v2 stores，LegacyReadOnly/Recovering/Blocked 均不加载可写业务 stores。LegacyReadOnly 的退出/no-op flush 证据留到 Step 13-16。

- [ ] **Step 5: 写失败测试固定新项目必须选择有效供应商**

新增 `workspaceDialog_requires_enabled_provider`、`workspaceDialog_model_belongs_to_provider`、`workspaceDialog_uses_global_default_only_as_prefill`、`workspaceDialog_never_submits_api_key_in_project`、`workspaceItem_delete_opens_explicit_project_delete_dialog`、`projectDeleteDialog_requires_keep_or_delete_conversations_choice`、`projectDeleteDialog_always_states_terminal_metadata_and_directory_are_kept`、`projectDeleteDialog_active_conversation_conflict_stays_open_and_shows_error`。

- [ ] **Step 6: 运行项目表单测试并确认失败**

Run: `npm run test -- src/components/dialogs/WorkspaceDialog.test.tsx src/components/dialogs/ProjectDeleteDialog.test.tsx src/components/Sidebar/WorkspaceItem.test.tsx`

Expected: FAIL，旧表单仍提交 Workspace/AgentConfig。

- [ ] **Step 7: 更新旧 WorkspaceDialog 为 Project 输入适配器**

术语先改“新建项目”；表单提交 Project，不内嵌 AgentConfig。应用默认只预填，用户可改；无有效 provider 时禁用保存并打开 ProviderManager。WorkspaceItem 的旧“删除工作空间”入口改为打开 `ProjectDeleteDialog`，必须显式选择“保留 Conversation”或“同时删除 Conversation”，两项都说明 TerminalSession 元数据与磁盘目录保留；确认后调用 `projectDelete(id, deleteConversations)`。后端 active/pending outcome Conflict 时对话框保持打开并展示脱敏错误。LegacyReadOnly/Recovering/Blocked 时表单和删除对话框不可打开。完整菜单改造留给 Phase B。

- [ ] **Step 8: 运行项目表单测试并确认通过**

Run: `npm run test -- src/components/dialogs/WorkspaceDialog.test.tsx src/components/dialogs/ProjectDeleteDialog.test.tsx src/components/Sidebar/WorkspaceItem.test.tsx`

Expected: PASS。

- [ ] **Step 9: 扩展 Settings 安全边界回归**

在 Task 15 已通过的 `settingsDialog_never_prefills_secret`、`settingsDialog_blank_secret_preserves_existing`、`settingsStore_persists_non_provider_settings_only` 基础上增加 LegacyReadOnly/Ready/Recovering 分路测试，确认迁移 gate 与项目表单改造没有重新把 secret 放入 store/DOM。Ready 的“数据与迁移”区调用 `migrationBackupList`，只展示 transactionId 缩写与加密文件数量；删除入口必须先再次展示“不保证物理擦除、删除后无法由应用回滚”的说明并要求用户明确确认，随后调用 `migrationBackupDelete(id,true)`。取消/失败不移除 UI 条目、不构造路径；成功后重新 list。该入口只删除当前 committed migration backup，不触碰 corrupt backups。

- [ ] **Step 10: 运行 Settings 回归**

Run: `npm run test -- src/components/dialogs/SettingsDialog.test.tsx`

Expected: PASS；Task 15 的安全 command cutover 保持有效。

- [ ] **Step 11: 核对项目表单未引入旧配置 DTO**

运行静态检查确认 `WorkspaceDialog`、workspace/project stores 与新删除对话框不构造旧 `GlobalConfig`、不读取 `apiKey`，且继续复用 Task 15 的 `LegacyGlobalConfigPublic/Input`。若发现回归，只做最小修复，不再引入第二套 adapter。

- [ ] **Step 12: 运行项目与 Settings 测试并确认通过**

Run: `npm run test -- src/components/dialogs/WorkspaceDialog.test.tsx src/components/dialogs/SettingsDialog.test.tsx`

Expected: PASS；测试 DOM 不含任何 secret sentinel。

- [ ] **Step 13: 写失败测试固定布局 flush 与退出等待**

新增前端测试：`layoutStore_flushPersist_runs_pending_save_once`、`layoutStore_flushPersist_waits_for_inflight_save_before_sending_latest_snapshot`、`layoutStore_quit_flush_retries_inflight_quiescing_rejection_with_token`、`layoutStore_new_dirty_generation_during_flush_is_saved_before_resolve`、`layoutStore_older_request_can_never_complete_after_newer_request`、`layoutStore_flushPersist_surfaces_failure_and_keeps_dirty`、`layoutStore_background_persist_failure_sets_public_error_without_unhandled_rejection`、`settingsStore_flushPersist_cancels_timer_and_waits_inflight_before_prepare`、`settingsStore_flush_failure_never_enters_quiescing_and_resumes_producers`、`legacy_read_only_layout_and_settings_actions_never_mark_dirty`、`legacy_read_only_flushes_are_noop_and_quit_calls_no_layout_or_settings_write`、`keepAlive_pause_blocks_new_tick_and_waits_started_write`、`keepAlive_tick_catches_quiescing_without_unhandled_rejection`、`keepAlive_resume_after_cancel_restores_single_schedule`、`terminalPane_isQuitting_blocks_new_input_and_catches_late_write_error`、`useHotkeys_isQuitting_ignores_spawn_and_mutation_shortcuts`、`app_quit_cancels_detect_and_history_timers_before_prepare`、`app_quit_resumes_all_producers_after_successful_cancel`、`app_renders_background_persist_failure_and_allows_retry`、`app_quit_flushes_settings_before_preparing_backend`、`app_quit_prepares_backend_before_layout_token_flush_and_quit`、`app_quit_blocks_new_spawn_while_flush_pending`、`app_quit_flush_failure_cancels_quiescing_and_keeps_process_alive`、`app_quit_command_failure_cancels_quiescing_and_keeps_process_alive`、`app_quit_request_payload_false_skips_confirm_but_still_flushes`、`app_quit_request_payload_true_requires_confirm_then_flushes`、`confirmDialog_disables_while_async_confirm_runs`。

新增后端测试：`quit_gate_prepare_waits_for_inflight_mutation`、`quit_gate_prepare_waits_for_split_pty_kill_lease`、`quit_gate_concurrent_prepare_has_single_winner_and_preserves_first_token`、`quit_gate_prepare_while_quiescing_is_conflict`、`quit_gate_bootstrap_injects_same_instance_into_all_services`、`quit_gate_rejects_pty_spawn_write_kill_and_business_mutations`、`quit_gate_migration_transition_permit_blocks_prepare_until_final_runtime_publish`、`quit_gate_migration_and_waiting_mutation_command_barrier_has_no_lock_cycle`、`quit_gate_prepare_race_before_transition_publish_never_leaves_recovering`、`quit_gate_recovering_runtime_rejects_new_mutation_before_service_call`、`quit_gate_history_import_holds_permit_until_checkpoint_commit`、`quit_gate_history_list_rejects_new_import_and_keeps_event_hashes`、`quit_gate_history_imports_for_different_conversations_remain_concurrent`、`quit_gate_matching_token_allows_only_layout_flush`、`quit_gate_stale_token_cannot_flush_cancel_or_quit`、`quit_gate_cancel_reopens_normal_mutations`、`quit_gate_matching_token_kills_finalizes_and_exits_once`、`quit_gate_shutdown_synchronous_lifecycle_callback_does_not_deadlock`、`quit_gate_shutdown_tree_ack_timeout_does_not_enter_exiting`、`quit_gate_late_callback_journal_is_caught_by_sealed_final_drain`、`quit_gate_sealed_final_drain_failure_returns_to_quiescing`、`quit_gate_pending_runtime_outcome_failure_blocks_exit`、`quit_gate_shutdown_snapshot_failure_does_not_exit_and_returns_to_quiescing`、`quit_gate_exiting_rejects_new_work`、`quit_gate_app_commands_are_registered_in_generate_handler`、`tray_exit_without_active_session_emits_quit_request_instead_of_direct_exit`。

- [ ] **Step 14: 运行布局退出测试并确认失败**

Run: `npm run test -- src/store/layoutStore.test.ts src/store/settingsStore.test.ts src/keepAliveManager.test.ts src/hooks/useHotkeys.test.ts src/terminal/TerminalPane.test.tsx src/components/dialogs/ConfirmDialog.test.tsx src/App.test.tsx`

Expected: FAIL，producer pause/settings flush/layout flush/异步确认尚不存在；命令必须实际收集全部列出的测试文件，不能在首个失败后跳过其余文件。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test quit_gate`

Expected: FAIL，QuitGate/transition lease/退出专用布局命令尚不存在。

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test tray_quit`

Expected: FAIL，tray 仍可能直接退出或缺少统一 quit request。

- [ ] **Step 15: 实现 flushPersist 和真正退出顺序**

layoutStore 使用单一串行 persist pump，跟踪 `dirtyGeneration`、`persistedGeneration`、pending timer、唯一 inflight Promise 和公开 `persistError`。pump 绝不并发发出 layoutSave：先等待当前写完成，再捕获此刻最新快照/generation 并发送；完成后若 dirtyGeneration 又前进则循环。`flushPersist()` 取消 timer，启动或加入同一个 pump，并只在 `persistedGeneration === dirtyGeneration` 时 resolve；失败传播且 dirty 保留供显式重试。若退出开始前已创建普通 layoutSave Promise、但后端尚未取得 permit，prepare 可能先进入 Quiescing；此时普通请求必须以稳定 `QUIESCING` 且底层零写失败。`flushPersist({ quitToken })` 加入该 inflight 后把这一特定错误视为“该 generation 仍 dirty”，切换到 `layoutFlushForQuit(snapshot, token)` 重试；其他错误仍传播，禁止因调度竞态直接取消退出。timer 启动的后台 pump 必须 catch rejection、写入脱敏 persistError 并通知 App 显示持久错误/重试入口，不能产生 unhandled rejection 或静默丢失。可控 deferred 测试必须证明旧写永远不会在新写之后完成并覆盖。

ConfirmDialog 支持 `() => Promise<void>`，执行时禁用按钮。`QuitRequestPayload { requiresConfirmation: boolean }` 与 branded opaque `QuitToken` 同步加入 `api/types.ts`、`api/events.ts`、BackendClient/Tauri/Fake，并明确替换 Task 1 临时签名：`onQuitRequest(callback: (payload: QuitRequestPayload) => void): Promise<() => void>`、`appPrepareQuit(): Promise<QuitToken>`、`appCancelQuit(token: QuitToken): Promise<void>`、`layoutFlushForQuit(value: PersistedLayout, token: QuitToken): Promise<void>`、`appQuit(force: boolean, token: QuitToken): Promise<void>`。普通 `layoutSave`/其他 mutation 参数类型不得携带 token。Fake 分别发 true/false、记录 token 并支持 deferred/error；契约测试断言旧 `appQuit(force)` 和无 payload callback 不再可调用。tray 的“退出”无论当前 PTY 数量都只发送该 `app://quit-request`，不得直接 `app.exit(0)`；App 对 true 显示确认，对 false 直接进入同一异步退出函数。

新增后端签名 `app_prepare_quit() -> Result<QuitToken, AppError>`、`app_cancel_quit(token: QuitToken) -> Result<(), AppError>`、`layout_flush_for_quit(value: PersistedLayout, token: QuitToken) -> Result<(), AppError>`、`app_quit(force: bool, token: QuitToken) -> Result<(), AppError>`，并把全部实现放入 `commands/app_cmds.rs`；四个命令必须在 `lib.rs::generate_handler!` 注册，`quit_gate_app_commands_are_registered_in_generate_handler` 直接读取 `lib.rs` 并断言各出现一次。bootstrap 只构造一个 `Arc<QuitGate>`，注入 AppState、ApplicationMutationGate、LegacyHistoryImporter 和 PtyLifecycleObserver；pointer-identity 测试固定所有 mutation/service 使用同一实例。

`QuitGate` 使用 `parking_lot::Mutex<QuitGateInner> + Condvar`，而不是把 RwLock guard 持有整个外部操作。Inner 管理 `Running | Preparing | Quiescing { token } | Finalizing { token } | Sealing { token } | Exiting` 及 `ordinaryInflight/lifecycleInflight/quitFlushInflight` 计数；各 permit 创建时在短锁内加一，Drop 时减一并 notify，不把状态锁带入 repository/process 调用，从而允许 kill 同步触发嵌套 lifecycle callback。`app_prepare_quit()` 只允许 Running：先原子置 Preparing 阻止新普通操作，再通过 Condvar 等待 ordinaryInflight=0，最后生成随机 token 并置 Quiescing；并发/重复 prepare 看到 Preparing/Quiescing 即 Conflict，绝不替换首个 token。

Task 7 的 `ApplicationMutationGate` 固定先向 QuitGate 登记普通 permit（短状态锁已释放），再取得内部 mutation Mutex，并封装为 `MutationGuard`；`acquire()` 改为 `Result<MutationGuard, AppError>`，provider service、compat coordinator/facades、project/preferences/session 与 migration apply/recover 的全部既有调用点必须传播稳定 `Quiescing`，不能另建 gate 或在持 guard 时重入公开方法。Task 14 的 `MutationLease` 在本任务扩展为持有一个普通 permit，并可多次短暂 `lock()` 同一 mutation Mutex；用户 `pty_kill` 用该 lease 覆盖“取 handle→锁外 kill→重读/持久化”，所以 prepare 会等待整个 kill，而同步 waiter 只需另取 lifecycle permit/MutationSection，不会非重入。`pty_spawn` 从 provider/namespace 解析开始、`pty_write` 从写入开始分别显式持有普通 permit；高频写不进入全局文件 mutation Mutex。退出内部不调用用户 kill 路径。只读 list/status/preview 仍可调用，resize/attach/detach 只改易失显示连接，不创建任务或持久化。

迁移 apply/recover 使用专用 `MigrationTransitionLease`：先取得 transition mutex，再取得一个覆盖完整 transition 的 ordinary `QuitOperationPermit`，之后通过 `ApplicationMutationGate::lock_with_existing_permit(&permit)` 短暂取得 mutation mutex、发布 Recovering并释放 mutex；长恢复期间只保留 transition mutex/permit，按需短锁 mutation，最终发布 Ready/LegacyReadOnly/Blocked 后才释放 permit。prepare 若先进入 Preparing，则 transition 在发布 Recovering 前失败；transition 若先取得 permit，prepare 等到最终 runtime 已发布。普通 mutation command 继续固定 gate/permit → 短 runtime read clone Arc → 释放 read → `_locked`，因此不存在“持 runtime read 等 mutation”或“持 mutation 等被同命令占用的 runtime read”的环。

`LegacyHistoryImporter::import_incremental` 自己取得普通 `QuitOperationPermit` 并持有到 event/checkpoint 原子提交结束，history command/facade 不得再嵌套取得第二个 permit；因此 prepare 会等待已开始导入，Quiescing 后的新 `history_list` 导入在读源前失败且 event/checkpoint hash 不变。permit 是共享读许可，不取 ApplicationMutationGate，保留 Task 13 不同 Conversation 并行导入；同 Conversation 仍由原有 per-conversation mutex 串行。

Quiescing 状态唯一允许的用户业务写是 `layout_flush_for_quit(snapshot, token)`：它在短状态锁内校验 token/递增 quitFlushInflight，再取得独立类型 `QuitMutationGuard` 和同一 mutation Mutex，经 `CompatibilityFacade → LayoutFacade::save_for_quit_locked` 提交；Drop 先释放 mutation section 再递减计数。不得复用会被拒绝的普通 `layout_save`，也不能用 token 调用 provider/project 等其他写。`app_cancel_quit(token)` 只允许匹配且 quitFlushInflight=0 的 `Quiescing → Running`；`begin_exit(token)` 同样要求计数为 0 后才置 Finalizing。过期/伪造 token 失败封闭，旧 token 在 cancel 后立即失效。

PTY waiter/显式 kill 的 RuntimeSegment 终态写不是用户业务 mutation。Task 14 的 `PtyLifecycleObserver` 只在 Running/Preparing/Quiescing/Finalizing 下登记 `PtyLifecyclePermit`，再通过 ApplicationMutationGate 取得短 `LifecycleMutationGuard`；Sealing/Exiting 拒绝新登记。`app_quit(force, token)` 先执行 `Quiescing(token) → Finalizing(token)`，再调用 Task 14 的三段 `PtyManager::finalize_all_for_shutdown()`：短锁快照/termination intent 并释放 → 完全锁外请求 job 终止并等待所有 tree-empty ack（允许同步 callback）→ 短锁重读最新 snapshot 并一次收敛/clear。成功后不能直接 Exiting：先原子执行 `Finalizing(token) → Sealing(token)` 封闭新 lifecycle permit，通过 Condvar 等待 lifecycleInflight=0；然后使用只在匹配 Sealing token 下可取得的 `ExitDrainGuard`（同一 mutation Mutex，但不重新开放 lifecycle）调用 `RuntimeOutcomeStore::drain_all()`，捕获首轮 finalize 后才落下的 journal。最终 drain 成功且目录为空才 `Sealing(token) → Exiting → app.exit(0)`。任一 tree ack、snapshot 或 final drain 失败都不得 exit；Finalizing 失败回 Quiescing，Sealing drain 失败也执行 `Sealing(token) → Quiescing(token)`，保留可重试 journal/binding。Exiting 是终态，prepare/cancel/flush/mutation 全部拒绝。

前端退出函数固定为：同步设置 `isQuitting=true` → 暂停 keepAlive 并保存可恢复调度快照 → 取消尚未触发的 AI detect/history timers → 禁用 TerminalPane 原始输入、菜单、快捷键、Composer 和新建/恢复动作 → 取消布局防抖 timer但保留 dirty generation → 在 QuitGate 仍为 Running 时 `await settingsStore.flushPersist()` → `const token = await appPrepareQuit()` → `await layoutStore.flushPersist({ quitToken: token })` → `appQuit(true, token)`。Ready/compat 可写模式沿用上述 flush；LegacyReadOnly 因所有持久 action 从未置 dirty，两个 flush 均在前端 no-op，不调用被禁止的 settings/layout mutation，也不需要 `layout_flush_for_quit`。settings flush 失败时尚未 prepare，直接恢复所有 producer、清除 isQuitting并留在 Running。prepare 会等待已开始的 settings/layout/history/ptyWrite/keepAlive ordinary operation；所有 fire-and-forget `ptyWrite`/timer Promise 必须 catch 稳定 `QUIESCING` 与其他错误，不能产生 unhandled rejection。

layout flush 或 appQuit 失败使用同一 token 调用 `appCancelQuit(token)`；后端 finalization 失败会先回到 Quiescing。cancel 成功后按快照恢复唯一 keepAlive schedule、settings/layout 防抖、快捷键与终端输入，重新允许 detect/history，并清除 isQuitting；不得补发退出期间被抑制的输入/tick。cancel 失败则保持阻断状态并显示脱敏错误。普通隐藏到托盘不触发退出 gate/flush。

- [ ] **Step 16: 运行布局退出测试并确认通过**

Run: `npm run test -- src/store/layoutStore.test.ts src/store/settingsStore.test.ts src/keepAliveManager.test.ts src/hooks/useHotkeys.test.ts src/terminal/TerminalPane.test.tsx src/components/dialogs/ConfirmDialog.test.tsx src/App.test.tsx`

Expected: PASS；全部 producer/退出前端测试实际执行。

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: PASS。

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS；QuitGate、transition、lifecycle 和 tray 测试全部执行。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS；fake timers/deferred promises 下写请求严格串行，最终落盘为最新 generation；prepare 返回后普通 mutation/spawn/write/import 均被拒绝，匹配 token 的布局 flush 成功；真正退出顺序固定为 setQuitting→pause producers/cancel timers→settings flush→prepareQuit→quit-token layout flush→Finalizing→tree-empty ack/segment settle→Sealing→wait lifecycle zero→final outcome drain→Exiting→exit，任一 producer flush、ack、journal 或 save 失败均不静默退出或把仍存活进程标成 Stopped。

- [ ] **Step 17: 运行前端全量回归和代码简化审查**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build`

Expected: PASS。

使用 `@code-simplifier` 审查 App 启动分支、表单状态、flush 生命周期、QuitState 转换、import/lifecycle permit 和重复 gate 传播；若修改前端则重跑 Step 17，若修改 Rust 则重跑 Step 16。

- [ ] **Step 18: 提交迁移与项目表单**

```bash
git add src/App.tsx src/App.test.tsx src/api/types.ts src/api/backendClient.ts src/api/tauriBackendClient.ts src/api/commands.ts src/api/events.ts src/test/FakeBackendClient.ts src/store/settingsStore.ts src/store/settingsStore.test.ts src/store/workspaceStore.ts src/store/layoutStore.ts src/store/layoutStore.test.ts src/store/uiStore.ts src/keepAliveManager.ts src/keepAliveManager.test.ts src/hooks/useHotkeys.ts src/hooks/useHotkeys.test.ts src/terminal/TerminalPane.tsx src/terminal/TerminalPane.test.tsx src/components/Sidebar/WorkspaceItem.tsx src/components/Sidebar/WorkspaceItem.test.tsx src/components/dialogs/MigrationDialog.tsx src/components/dialogs/WorkspaceDialog.tsx src/components/dialogs/ProjectDeleteDialog.tsx src/components/dialogs/SettingsDialog.tsx src/components/dialogs/ConfirmDialog.tsx src/components/dialogs/MigrationDialog.test.tsx src/components/dialogs/WorkspaceDialog.test.tsx src/components/dialogs/ProjectDeleteDialog.test.tsx src/components/dialogs/SettingsDialog.test.tsx src/components/dialogs/ConfirmDialog.test.tsx src/styles/dialogs.css src-tauri/src/tray.rs src-tauri/src/application/mod.rs src-tauri/src/application/bootstrap.rs src-tauri/src/application/mutation_gate.rs src-tauri/src/application/provider_service.rs src-tauri/src/application/quit_gate.rs src-tauri/src/state.rs src-tauri/src/commands/app_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/commands/config_cmds.rs src-tauri/src/commands/project_cmds.rs src-tauri/src/commands/provider_cmds.rs src-tauri/src/commands/preferences_cmds.rs src-tauri/src/commands/migration_cmds.rs src-tauri/src/commands/session_cmds.rs src-tauri/src/commands/history_cmds.rs src-tauri/src/commands/pty_cmds.rs src-tauri/src/compat/facade.rs src-tauri/src/compat/write_transaction.rs src-tauri/src/compat/project_facade.rs src-tauri/src/compat/session_facade.rs src-tauri/src/compat/layout_facade.rs src-tauri/src/history/importer.rs src-tauri/src/pty/lifecycle.rs src-tauri/src/pty/manager.rs src-tauri/src/error.rs src-tauri/src/lib.rs src-tauri/tests/bootstrap_order.rs src-tauri/tests/provider_service.rs src-tauri/tests/compatibility_facade.rs src-tauri/tests/legacy_history_importer.rs src-tauri/tests/legacy_launch.rs src-tauri/tests/quit_gate.rs src-tauri/tests/tray_quit.rs
git commit -m "feat: 增加安全迁移与项目供应商选择"
```

### Task 18: 通过 Phase A 自动化与 legacy 手工门禁

**Files:**
- Create: `docs/verification/phase-a-foundation.md`
- Verify: all Phase A files

- [ ] **Step 1: 运行完整自动化门禁**

Run: `npm run test && npm run typecheck && npx tsc -p tsconfig.node.json --noEmit && npm run build && npm run build:pty-host -- --release && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: 全部成功；release helper PE subsystem=CUI 且实际 ConPTY stdin/stdout/exit 测试通过；无 SKIP（仅明确 `#[cfg(not(windows))]` 测试在非目标平台可跳过，本仓库 Windows 执行应运行 DPAPI）。

Run: `npm run tauri -- build; if ($LASTEXITCODE -ne 0) { throw 'tauri NSIS build failed' }; $nsis = @(Get-ChildItem -LiteralPath 'src-tauri\target\release\bundle\nsis' -Filter '*.exe' -File); if ($nsis.Count -lt 1) { throw 'NSIS installer missing' }`

Expected: release NSIS build 成功且 bundler 未报告 externalBin 缺失，安装包产物存在；Task 14 的静态 basename/实际 release helper 测试与本次 bundler 成功共同证明 `tht-panel-pty-host.exe` 已进入打包输入。不得静默安装该 EXE；最终安装包哈希/大小和解包级 sentinel 审计留给 Phase E。

- [ ] **Step 2: 运行密钥与备份静态扫描**

Run: `rg -n '\bapiKey\b|secretValue|fixture-(claude|codex|workspace)-key|\.bak\b' src src-tauri/src src-tauri/tests`

Expected: 精确字段 `apiKey`/secretValue 只命中 write-only legacy 输入或负向测试，合法 `apiKeyConfigured` 不被误报；fixture key 只在 fixtures/负向断言；生产 `.bak` 只允许命中 `migration/legacy_reader.rs` 的精确 legacy artifact allow-list，测试命中只允许 fixture 文件名或负向断言。

Run: `$artifactHits = @(rg --path-separator / --only-matching -n '(settings|workspaces|sessions|layout)\.json\.(bak|tmp)' src-tauri/src); if ($artifactHits.Count -ne 8 -or @($artifactHits | Where-Object { $_ -notmatch '^src-tauri/src/migration/legacy_reader\.rs:' }).Count -ne 0) { $artifactHits; throw 'legacy artifact allow-list drift' }; $bakHits = @(rg --path-separator / --only-matching -n '\.bak\b' src-tauri/src); if ($bakHits.Count -ne 4 -or @($bakHits | Where-Object { $_ -notmatch '^src-tauri/src/migration/legacy_reader\.rs:' }).Count -ne 0) { $bakHits; throw 'unexpected production .bak literal' }`

Expected: 8 个 canonical artifact 字面量集中在唯一 allow-list（4 个 `.bak`、4 个 `.tmp`）；Coordinator/其他生产模块没有额外 `.bak` 字面量。

Run: `rg -n "EncodedCommand" src-tauri/src`

Expected: 只命中明确的 legacy PTY launch 模块，并有 `nativeAiEnabled=false` 路由测试；其他模块不得新增。

Run: `rg -n "commands::app_cmds::(app_prepare_quit|app_cancel_quit|layout_flush_for_quit|app_quit)" src-tauri/src/lib.rs`

Expected: 四个退出命令在唯一 `generate_handler!` 清单中各命中一次；缺少或重复任一项均失败。

- [ ] **Step 3: 运行显式 opt-in CLI probe**

Run: `npm run test:cli-smoke -- --probe-only`

Expected: 每个 driver 为 PASS(version) 或 SKIP(not installed)，无模型请求、无费用、无环境值；SKIP 不阻塞 Phase A，但会记录为 Phase C 默认切换前必须解决的联调前置。

- [ ] **Step 4: 运行新安装与同目录重启烟测**

Run: `$env:THT_PANEL_SMOKE = '1'; $freshSmoke = Join-Path (Resolve-Path 'src-tauri\target') ('phase-a-smoke-fresh-' + [guid]::NewGuid()); $env:THT_PANEL_CONFIG_DIR = $freshSmoke; npm run tauri -- dev`

Expected: 第一次启动的空配置目录生成 8 个 v2 文件和 schema marker；可新增两个同名模型的不同供应商、创建项目，并强制完成 Shell PTY 创建/输入/关闭。legacy AI PTY 仅对 Step 3 probe 为 PASS 的 driver 执行且不发送 prompt；probe 为 SKIP 的 driver 在本步骤同样记录 SKIP，不能把“未安装”改判 FAIL，也不得借用用户全局认证。无论 AI driver 是否安装，provider/model/project 持久化与 Shell 都必须 PASS。通过正常退出流程关闭实例，确认退出完成后在同一 PowerShell、同一 `$freshSmoke` 再运行：

Run: `npm run tauri -- dev`

Expected: 第二次启动自动进入 Ready；两个供应商、同名模型、项目和 schema marker 均保持。仅对第一次实际 PASS 且成功启动 legacy AI 的 driver，验证其冻结 revision/namespace 仍隔离；若两个 AI driver 均 SKIP，不得伪造该运行时证据，但 provider/model/project 持久化与 Shell 必须继续 PASS。未重新生成或覆盖 schema marker；再次正常退出后才能进入下一步。

- [ ] **Step 5: 运行旧数据取消、确认与重启烟测**

Run: `$smoke = Join-Path (Resolve-Path 'src-tauri\target') ('phase-a-smoke-migration-' + [guid]::NewGuid()); Copy-Item -Recurse -LiteralPath 'src-tauri\tests\fixtures\migration\v1' -Destination $smoke; $before = Get-ChildItem -LiteralPath $smoke -File | Sort-Object Name | ForEach-Object { "{0}:{1}" -f $_.Name,(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash }; $env:THT_PANEL_SMOKE = '1'; $env:THT_PANEL_CONFIG_DIR = $smoke; npm run tauri -- dev`

Expected: 第一次启动先看到迁移计数；选择取消后进入 LegacyReadOnly，正常退出。随后在同一 shell 运行：

Run: `$afterCancel = Get-ChildItem -LiteralPath $smoke -File | Sort-Object Name | ForEach-Object { "{0}:{1}" -f $_.Name,(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash }; if (Compare-Object $before $afterCancel) { throw 'cancelled migration changed canonical files' }; npm run tauri -- dev`

Expected: 第二次启动仍显示相同迁移计数；本次确认迁移。完成后 v2 文件/DPAPI backup 完整，旧明文文件被删除或脱敏替换；访问已迁移会话会惰性导入可靠历史，重复访问不产生重复 eventId，旧 Codex 自管 HOME 的 config hash 保持不变。正常退出后第三次运行：

Run: `npm run tauri -- dev`

Expected: 第三次启动无需再次确认并自动进入 Ready，迁移后实体/事件仍可读且没有重复导入。目标目录始终是本次新建且位于 workspace 的 `src-tauri/target/` 内，不覆盖真实应用配置；第三次正常退出后才能进入 legacy PTY 回归。

- [ ] **Step 6: 运行 legacy PTY 回归**

前置：仅使用测试供应商/无生产密钥；不发送模型 prompt，除非用户另行明确同意可能产生费用；CLI 缺失的 driver 标 SKIP 并记录。逐项验证 Shell 创建→输入→resize→关闭；Claude/Codex legacy PTY 进程启动与安全退出；运行受控 process-tree fixture，确认 pty_kill 与托盘退出都在 5 秒总 deadline 内让 parent/child PID 消失，Job assign 或 tree-empty ack 失败必须 FAIL、不得 SKIP。使用 fixture/fake 验证 Codex stable session 恢复仍选旧 frozen revision，以及 spawn 后首次输入前编辑供应商不改变实际 binding；两个 Project 共用 revision HOME 时历史按 cwd 隔离；迁移 legacy HOME 保持只读；Claude 多供应商 native history 探测明确拒绝；分屏、托盘隐藏、无活跃会话托盘退出也先 flush、退出确认依次 PASS。检查两个 revision 的 runtime 目录不同，日志、Zustand snapshot、命令行均无密钥。自动化必须通过；真实 CLI SKIP 不阻断 Phase A，但记录为 Phase C 前置。

- [ ] **Step 7: 恢复 smoke 环境变量**

Run: `Remove-Item Env:THT_PANEL_CONFIG_DIR -ErrorAction SilentlyContinue; Remove-Item Env:THT_PANEL_SMOKE -ErrorAction SilentlyContinue`

Expected: 当前 shell 不再设置调试配置目录或 smoke 标志；不得删除 smoke 文件夹，保留作证据直到用户明确批准清理。

- [ ] **Step 8: 写入可复核证据**

`docs/verification/phase-a-foundation.md` 记录日期、Phase A base/HEAD 提交、committed file 清单摘要、自动化命令输出、新安装/迁移/legacy PTY 的 PASS/FAIL 和已知边界；不得粘贴密钥、用户真实路径或真实会话内容。

- [ ] **Step 9: 使用完成前验证与代码简化规则收尾**

使用 `@superpowers:verification-before-completion` 核对证据；本任务只新增验证文档，无需再次运行 code-simplifier。若任何门禁失败，Phase A 保持未完成，不进入 Phase B。

```bash
git add docs/verification/phase-a-foundation.md
git commit -m "test: 记录 Phase A 验收证据"
```

- [ ] **Step 10: 核对 Phase A 提交范围和干净状态**

Run: `git status --short`

Expected: 空输出；不得遗留 code-simplifier、smoke 或验证文档改动。

Run: `$first = git log --grep='^test: 建立前端后端注入边界$' -n 1 --format='%H'; if (-not $first) { throw 'Phase A first commit not found' }; $phaseABase = git rev-parse "$first^"; git diff --check "$phaseABase..HEAD"; git diff --name-only "$phaseABase..HEAD"`

Expected: `git diff --check` 成功；文件清单逐项属于 Tasks 1-18，且不含主工作区已有 `AGENTS.md`、`tsconfig.node.tsbuildinfo`、`src-tauri/target/` 或未授权文件。验证文档在 Step 8/9 提交前已记录 base/HEAD 与清单摘要；任何漏提交或越界文件使 Phase A 保持未完成。
