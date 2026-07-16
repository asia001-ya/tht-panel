# 工作区自动保存与会话恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作区创建即激活、变动自动同步，点击工作区同时恢复布局与会话；项目行改文件夹图标并加风琴展开动画。

**Architecture:** 恢复编排放入新模块 `src/lib/workspaceRestore.ts`（直接读写 zustand store 与 api/commands，测试用 vi.mock）；`layoutStore.persist()` 通过注册的 refs provider 把激活工作区写回；Sidebar 移除手动保存，改为「工作区」分组内新建即激活；PaneLeaf 消费 `restoreErrors`。

**Tech Stack:** React 19、TypeScript、zustand 5、Vitest（jsdom + @testing-library/react）、lucide-react

## Global Constraints

- 所有交流、注释、测试描述使用简体中文；所有函数必须有中文注释（用途、参数、返回值）。
- 恢复引擎 `src/lib/workspaceSnapshots.ts` 不修改。
- 每个 Task 的 `git add` 只加本 Task 涉及的文件（仓库存在其他未提交改动，严禁 `git add -A`）。
- 测试命令统一用 `npm test -- <文件路径>`（vitest run）。

---

### Task 1: pendingSessions 独立模块

**Files:**
- Create: `src/lib/pendingSessions.ts`
- Modify: `src/App.tsx`（删除导出，改 import）
- Modify: `src/terminal/TerminalPane.tsx:20`
- Modify: `src/App.test.tsx:19`

**Interfaces:**
- Produces: `pendingSessions: Map<string, { workspaceId: string; kind: string; providerId?: string }>`（`src/lib/pendingSessions.ts` 导出，后续 Task 2 消费）

**背景:** `pendingSessions` 目前在 `src/App.tsx:62` 导出，Task 2 的 lib 模块若 import App 会形成循环依赖，先挪到独立模块。纯移动重构，不写新测试，靠既有测试回归。

- [ ] **Step 1: 创建新模块**

```ts
/**
 * pendingSessions.ts —— "待命名"会话注册表。
 * spawn 后登记 ptySessionId→{workspaceId, kind, providerId}，
 * 等 TerminalPane 检测到用户首次按 Enter 时，以输入行作为名称创建 ManagedSession。
 */
export const pendingSessions = new Map<
  string,
  { workspaceId: string; kind: string; providerId?: string }
>();
```

- [ ] **Step 2: 改三处引用**

`src/App.tsx`：删除第 58-65 行的注释与 `export const pendingSessions = ...` 定义，在 import 区加 `import { pendingSessions } from "./lib/pendingSessions";`。

`src/terminal/TerminalPane.tsx:20`：`import { pendingSessions } from "../App";` → `import { pendingSessions } from "../lib/pendingSessions";`

`src/App.test.tsx:19`：`import App, { pendingSessions } from "./App";` → 拆为 `import App from "./App";` 与 `import { pendingSessions } from "./lib/pendingSessions";`

- [ ] **Step 3: 回归验证**

Run: `npm test -- src/App.test.tsx` → PASS
Run: `npm run typecheck` → 无错误

- [ ] **Step 4: Commit**

```bash
git add src/lib/pendingSessions.ts src/App.tsx src/terminal/TerminalPane.tsx src/App.test.tsx
git commit -m "refactor: pendingSessions 挪至独立模块，消除 lib 循环依赖"
```

### Task 2: 恢复编排模块 workspaceRestore

**Files:**
- Create: `src/lib/workspaceRestore.ts`
- Create: `src/lib/workspaceRestore.test.ts`

**Interfaces:**
- Consumes: `planWorkspaceRestore` / `buildSessionRefs`（`src/lib/workspaceSnapshots.ts`）、`resolveTerminalResumeSelection`（`src/lib/providers.ts`）、`pendingSessions`（Task 1）、`ptySpawn` / `managedSessionList` / `managedSessionUpdate`（`src/api/commands.ts`）、四个 zustand store 的 `getState()`
- Produces:
  - `collectCurrentSessionRefs(): Record<string, SavedSessionRef>`（Task 3/4 消费）
  - `restoreWorkspaceById(savedWorkspaceId: string, onResumeRebound?: (managed: ManagedSession, spawnedAt: string) => void): Promise<{ restored: boolean; errorCount: number }>`（Task 4 消费）

- [ ] **Step 1: 写失败测试**

`src/lib/workspaceRestore.test.ts`（与 `App.test.tsx` 同模式：vi.mock api/commands + setState stores）：

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalConfig,
  ManagedSession,
  PaneNode,
  PtySessionInfo,
  SavedWorkspaceLayout,
  Workspace,
} from "../api/types";
import { useLayoutStore } from "../store/layoutStore";
import { useSessionStore } from "../store/sessionStore";
import { useSettingsStore } from "../store/settingsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { pendingSessions } from "./pendingSessions";
import { collectCurrentSessionRefs, restoreWorkspaceById } from "./workspaceRestore";

const commandMocks = vi.hoisted(() => ({
  managedSessionList: vi.fn(async (_workspaceId: string): Promise<ManagedSession[]> => []),
  managedSessionUpdate: vi.fn(async (_session: ManagedSession): Promise<void> => undefined),
  ptySpawn: vi.fn(),
}));

vi.mock("../api/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/commands")>()),
  ...commandMocks,
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "项目一",
  path: "D:\\AI\\project-1",
  agent: "claude",
  useGlobalConfig: true,
  sortOrder: 0,
  createdAt: "2026-07-16T08:00:00.000Z",
};

const config: GlobalConfig = {
  theme: "dark",
  shellPath: "powershell.exe",
  fontSize: 14,
  scrollbackBytes: 5 * 1024 * 1024,
  scrollbackLines: 10000,
  notifyOnWaiting: true,
  claudeDefaults: {},
  codexDefaults: {},
  providers: [],
};

const managedAlive: ManagedSession = {
  id: "managed-1",
  workspaceId: workspace.id,
  name: "存活会话",
  kind: "claude",
  mode: "terminal",
  ptySessionId: "pty-alive",
  aiSessionId: "ai-1",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:01:00.000Z",
};

const managedDead: ManagedSession = {
  id: "managed-2",
  workspaceId: workspace.id,
  name: "已死会话",
  kind: "claude",
  mode: "terminal",
  ptySessionId: "pty-dead",
  aiSessionId: "ai-2",
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:02:00.000Z",
};

/**
 * 创建运行中的 PTY 会话镜像。
 * @param sessionId PTY 会话 ID。
 * @returns 状态为 running 的会话信息。
 */
function alivePty(sessionId: string): PtySessionInfo {
  return {
    sessionId,
    workspaceId: workspace.id,
    kind: "claude",
    cwd: workspace.path,
    title: sessionId,
    state: "running",
    createdAt: "2026-07-16T08:00:00.000Z",
  };
}

/**
 * 创建包含两个终端 Tab 的单叶快照。
 * @returns 引用存活与已死会话各一个的保存工作区。
 */
function snapshotWithTwoTabs(): SavedWorkspaceLayout {
  const tree: PaneNode = {
    type: "leaf",
    id: "leaf-1",
    sessionIds: ["pty-alive", "pty-dead"],
    activeSessionId: "pty-alive",
    locked: false,
  };
  return {
    id: "saved-1",
    name: "双 Tab 工作区",
    tree,
    activePaneId: "leaf-1",
    createdAt: "2026-07-16T08:03:00.000Z",
    sessionRefs: {
      "pty-alive": {
        managedSessionId: managedAlive.id,
        workspaceId: workspace.id,
        kind: "claude",
        mode: "terminal",
      },
      "pty-dead": {
        managedSessionId: managedDead.id,
        workspaceId: workspace.id,
        kind: "claude",
        mode: "terminal",
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingSessions.clear();
  useSettingsStore.setState({ config, loaded: true });
  useWorkspaceStore.setState({
    workspaces: [workspace],
    expandedIds: new Set<string>(),
    historyCache: { [workspace.id]: [managedAlive, managedDead] },
    historyLoading: {},
    loadHistory: vi.fn(async () => undefined),
  });
  useSessionStore.setState({ sessions: { "pty-alive": alivePty("pty-alive") } });
  useLayoutStore.setState({
    tree: { type: "leaf", id: "leaf-0", sessionIds: [], activeSessionId: null, locked: false },
    activePaneId: "leaf-0",
    savedWorkspaces: [snapshotWithTwoTabs()],
    restoreErrors: {},
    activeSavedWorkspaceId: null,
    persist: vi.fn(),
  });
  commandMocks.managedSessionList.mockResolvedValue([managedAlive, managedDead]);
});

describe("collectCurrentSessionRefs", () => {
  it("从当前布局与历史缓存构建稳定引用", () => {
    useLayoutStore.setState({
      tree: {
        type: "leaf",
        id: "leaf-0",
        sessionIds: ["pty-alive"],
        activeSessionId: "pty-alive",
        locked: false,
      },
    });

    const refs = collectCurrentSessionRefs();

    expect(refs["pty-alive"]).toEqual({
      managedSessionId: managedAlive.id,
      workspaceId: workspace.id,
      kind: "claude",
      mode: "terminal",
    });
  });
});

describe("restoreWorkspaceById", () => {
  it("快照不存在时不改动布局", async () => {
    const result = await restoreWorkspaceById("missing");

    expect(result).toEqual({ restored: false, errorCount: 0 });
    expect(useLayoutStore.getState().tree.id).toBe("leaf-0");
  });

  it("存活 PTY 原位保留，已死会话以 resume 重建并回绑", async () => {
    commandMocks.ptySpawn.mockResolvedValue(alivePty("pty-new"));
    const onResumeRebound = vi.fn();

    const result = await restoreWorkspaceById("saved-1", onResumeRebound);

    expect(result).toEqual({ restored: true, errorCount: 0 });
    expect(commandMocks.managedSessionList).toHaveBeenCalledWith(workspace.id);
    expect(commandMocks.ptySpawn).toHaveBeenCalledTimes(1);
    expect(commandMocks.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: workspace.id,
      kind: "claude",
      resumeSessionId: "ai-2",
    }));
    expect(commandMocks.managedSessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: managedDead.id,
      ptySessionId: "pty-new",
    }));
    const tree = useLayoutStore.getState().tree;
    if (tree.type !== "leaf") throw new Error("恢复后应为单叶布局");
    expect(tree.sessionIds).toEqual(["pty-alive", "pty-new"]);
    expect(onResumeRebound).toHaveBeenCalledTimes(1);
    expect(useLayoutStore.getState().activeSavedWorkspaceId).toBe("saved-1");
  });

  it("历史刷新失败时对应 Tab 记录恢复错误", async () => {
    commandMocks.managedSessionList.mockRejectedValue(new Error("离线"));
    useSessionStore.setState({ sessions: {} });
    useWorkspaceStore.setState({ historyCache: {} });

    const result = await restoreWorkspaceById("saved-1");

    expect(result.restored).toBe(true);
    expect(result.errorCount).toBe(2);
    expect(useLayoutStore.getState().restoreErrors["leaf-1"]).toBeTruthy();
    expect(commandMocks.ptySpawn).not.toHaveBeenCalled();
  });

  it("spawn 失败时记录窗格错误并继续执行其余动作", async () => {
    commandMocks.ptySpawn.mockRejectedValue(new Error("PTY 启动失败"));

    const result = await restoreWorkspaceById("saved-1");

    expect(result.errorCount).toBe(1);
    expect(useLayoutStore.getState().restoreErrors["leaf-1"]).toContain("PTY 启动失败");
  });

  it("无 managed 引用的 spawn 动作登记 pendingSessions", async () => {
    commandMocks.ptySpawn.mockResolvedValue(alivePty("pty-fresh"));
    const saved = snapshotWithTwoTabs();
    saved.sessionRefs = {
      "pty-dead": { workspaceId: workspace.id, kind: "claude", mode: "terminal" },
    };
    if (saved.tree.type !== "leaf") throw new Error("测试快照应为单叶");
    saved.tree.sessionIds = ["pty-dead"];
    saved.tree.activeSessionId = "pty-dead";
    useLayoutStore.setState({ savedWorkspaces: [saved] });
    useSessionStore.setState({ sessions: {} });
    useWorkspaceStore.setState({ historyCache: { [workspace.id]: [] } });
    commandMocks.managedSessionList.mockResolvedValue([]);

    const result = await restoreWorkspaceById("saved-1");

    expect(result.errorCount).toBe(0);
    expect(pendingSessions.get("pty-fresh")).toEqual({
      workspaceId: workspace.id,
      kind: "claude",
      providerId: undefined,
    });
    expect(commandMocks.managedSessionUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认 RED**

Run: `npm test -- src/lib/workspaceRestore.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`src/lib/workspaceRestore.ts`：

```ts
/**
 * workspaceRestore.ts —— 保存工作区的会话恢复编排。
 * 职责：刷新涉及项目的历史 → 换布局树 → 用 planWorkspaceRestore 规划 →
 * 串行执行 keep/native/spawn/error 动作。规划语义在 workspaceSnapshots.ts，不在此处。
 */
import type { ManagedSession, SavedSessionRef } from "../api/types";
import {
  managedSessionList,
  managedSessionUpdate,
  ptySpawn,
} from "../api/commands";
import { useLayoutStore } from "../store/layoutStore";
import { useSessionStore } from "../store/sessionStore";
import { useSettingsStore } from "../store/settingsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { pendingSessions } from "./pendingSessions";
import { resolveTerminalResumeSelection } from "./providers";
import {
  buildSessionRefs,
  planWorkspaceRestore,
  type RestoreAction,
} from "./workspaceSnapshots";

const RESTORE_COLS = 80;
const RESTORE_ROWS = 24;

/** 恢复结果：快照是否存在，以及记录到窗格的错误数量。 */
export interface RestoreWorkspaceResult {
  restored: boolean;
  errorCount: number;
}

/**
 * 从当前布局、运行时会话、历史缓存和待命名注册表构建稳定会话引用。
 * @returns 以当前 Tab ID 为键的稳定引用表。
 */
export function collectCurrentSessionRefs(): Record<string, SavedSessionRef> {
  return buildSessionRefs(
    useLayoutStore.getState().tree,
    useSessionStore.getState().sessions,
    useWorkspaceStore.getState().historyCache,
    pendingSessions,
  );
}

/**
 * 把未知异常转换为简短错误文案。
 * @param error 捕获到的未知异常。
 * @returns 非空错误信息。
 */
function restoreErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const message = String(error);
  return message || "未知错误";
}

/**
 * 现场刷新快照引用的全部工作空间历史。
 * @param sessionRefs 快照中的稳定会话引用表。
 * @returns 刷新失败的工作空间 ID 集合。
 */
async function refreshReferencedHistories(
  sessionRefs: Record<string, SavedSessionRef> | undefined,
): Promise<Set<string>> {
  const workspaceIds = [...new Set(
    Object.values(sessionRefs ?? {}).map((ref) => ref.workspaceId),
  )];
  const failedWorkspaceIds = new Set<string>();
  await Promise.all(workspaceIds.map(async (workspaceId) => {
    try {
      const sessions = await managedSessionList(workspaceId);
      useWorkspaceStore.setState((state) => ({
        historyCache: { ...state.historyCache, [workspaceId]: sessions },
      }));
    } catch {
      failedWorkspaceIds.add(workspaceId);
    }
  }));
  return failedWorkspaceIds;
}

/**
 * 为 spawn 动作重建终端：启动 PTY、原位替换 Tab，并回绑或登记会话。
 * @param action 待执行的 spawn 恢复动作。
 * @param onResumeRebound resume 回绑成功后的回调（用于 AI 会话探测）。
 * @returns 重建完成后解析。
 */
async function spawnRestoredTerminal(
  action: Extract<RestoreAction, { kind: "spawn" }>,
  onResumeRebound?: (managed: ManagedSession, spawnedAt: string) => void,
): Promise<void> {
  const { ref, managed, leafId, oldTabId } = action;
  const workspace = useWorkspaceStore.getState().workspaces
    .find((item) => item.id === ref.workspaceId);
  if (!workspace) throw new Error(`工作空间不存在：${ref.workspaceId}`);
  const providers = useSettingsStore.getState().config?.providers ?? [];
  const selection = managed
    ? resolveTerminalResumeSelection(managed, workspace, providers)
    : { kind: ref.kind, providerId: ref.providerId, resumeSessionId: undefined };

  const info = await ptySpawn({
    workspaceId: ref.workspaceId,
    kind: selection.kind,
    providerId: selection.providerId,
    resumeSessionId: selection.resumeSessionId,
    cols: RESTORE_COLS,
    rows: RESTORE_ROWS,
  });
  useSessionStore.getState().upsert(info);
  useLayoutStore.getState().replaceSession(leafId, oldTabId, info.sessionId);

  if (managed) {
    const now = new Date().toISOString();
    await managedSessionUpdate({
      ...managed,
      kind: selection.kind,
      aiSessionId: selection.resumeSessionId,
      ptySessionId: info.sessionId,
      updatedAt: now,
    });
    void useWorkspaceStore.getState().loadHistory(managed.workspaceId);
    if (selection.resumeSessionId) {
      onResumeRebound?.({ ...managed, ptySessionId: info.sessionId }, now);
    }
  } else {
    pendingSessions.set(info.sessionId, {
      workspaceId: ref.workspaceId,
      kind: selection.kind,
      providerId: selection.providerId,
    });
  }
}

/**
 * 恢复保存工作区：换布局树并按恢复计划重建会话。
 * @param savedWorkspaceId 保存工作区 ID。
 * @param onResumeRebound resume 回绑成功后的回调（用于 AI 会话探测）。
 * @returns 恢复结果；快照不存在时 restored 为 false。
 */
export async function restoreWorkspaceById(
  savedWorkspaceId: string,
  onResumeRebound?: (managed: ManagedSession, spawnedAt: string) => void,
): Promise<RestoreWorkspaceResult> {
  const saved = useLayoutStore.getState().savedWorkspaces
    .find((item) => item.id === savedWorkspaceId);
  if (!saved) return { restored: false, errorCount: 0 };

  const failedWorkspaceIds = await refreshReferencedHistories(saved.sessionRefs);

  const snapshot = useLayoutStore.getState().restoreSavedWorkspace(savedWorkspaceId);
  if (!snapshot) return { restored: false, errorCount: 0 };

  const actions = planWorkspaceRestore({
    snapshot,
    runtimeSessions: useSessionStore.getState().sessions,
    managedSessions: Object.values(useWorkspaceStore.getState().historyCache).flat(),
    workspaces: useWorkspaceStore.getState().workspaces,
    providers: useSettingsStore.getState().config?.providers ?? [],
    failedWorkspaceIds,
  });

  let errorCount = 0;
  for (const action of actions) {
    if (action.kind === "error") {
      useLayoutStore.getState().setRestoreError(action.leafId, action.message);
      errorCount += 1;
      continue;
    }
    if (action.kind === "keep" || action.kind === "native") {
      if (action.sessionId !== action.oldTabId) {
        useLayoutStore.getState()
          .replaceSession(action.leafId, action.oldTabId, action.sessionId);
      }
      continue;
    }
    try {
      await spawnRestoredTerminal(action, onResumeRebound);
    } catch (error) {
      useLayoutStore.getState()
        .setRestoreError(action.leafId, restoreErrorMessage(error));
      errorCount += 1;
    }
  }
  return { restored: true, errorCount };
}
```

注意：“历史刷新失败”测试里两个 Tab 都会因 `failedWorkspaceIds` 或 runtime/managed 缺失得到 error 动作——若实测中 `planWorkspaceRestore` 对无 `managedSessionId` 的 ref 不检查 failedWorkspaceIds，请回读 `src/lib/workspaceSnapshots.ts:362`（仅 `ref.managedSessionId` 存在时才检查），本测试的 refs 均带 `managedSessionId`，成立。

- [ ] **Step 4: 运行确认 GREEN**

Run: `npm test -- src/lib/workspaceRestore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspaceRestore.ts src/lib/workspaceRestore.test.ts
git commit -m "feat: 保存工作区的会话恢复编排（keep/native/spawn/error）"
```

### Task 3: layoutStore 自动同步激活工作区

**Files:**
- Modify: `src/store/layoutStore.ts`
- Modify: `src/store/layoutStore.test.ts`

**Interfaces:**
- Produces:
  - `registerActiveWorkspaceRefsProvider(provider: (() => Record<string, SavedSessionRef>) | null): void`（layoutStore 导出；App 在 Task 4 注册 `collectCurrentSessionRefs`）
  - `persist()` 行为扩展：debounce 到期时若 `activeSavedWorkspaceId` 非空且 provider 已注册，先把 `{tree, activePaneId, sessionRefs}` 写回激活工作区再落盘
  - `openSessionInLeaf` / `activateTab` / `closeTab` / `replaceSession` 在 `activeSavedWorkspaceId` 非空时触发 `persist()`

- [ ] **Step 1: 写失败测试**

在 `src/store/layoutStore.test.ts` 追加（沿用该文件既有的 layoutSave mock 与 store 重置模式；`vi.useFakeTimers()` 推进 300ms debounce；若文件尚未用 fake timers，则在新测试内局部 `vi.useFakeTimers()` / `vi.useRealTimers()`）：

```ts
describe("激活工作区自动同步", () => {
  it("persist 到期时把当前布局与会话引用写回激活工作区", () => {
    vi.useFakeTimers();
    try {
      const sessionRefs = {
        "pty-1": {
          workspaceId: "workspace-1",
          kind: "claude" as const,
          mode: "terminal" as const,
        },
      };
      registerActiveWorkspaceRefsProvider(() => sessionRefs);
      const saved = useLayoutStore.getState().saveCurrentWorkspace("自动同步");
      if (!saved) throw new Error("应创建保存工作区");
      useLayoutStore.getState().openSessionInLeaf(
        useLayoutStore.getState().activePaneId ?? "",
        "pty-1",
      );
      vi.advanceTimersByTime(300);

      const updated = useLayoutStore.getState().savedWorkspaces
        .find((item) => item.id === saved.id);
      if (!updated || updated.tree.type !== "leaf") throw new Error("快照应为单叶");
      expect(updated.tree.sessionIds).toEqual(["pty-1"]);
      expect(updated.sessionRefs).toEqual(sessionRefs);
    } finally {
      registerActiveWorkspaceRefsProvider(null);
      vi.useRealTimers();
    }
  });

  it("无激活工作区时 Tab 操作不写回任何快照", () => {
    vi.useFakeTimers();
    try {
      registerActiveWorkspaceRefsProvider(() => ({}));
      const saved = useLayoutStore.getState().saveCurrentWorkspace("非激活");
      if (!saved) throw new Error("应创建保存工作区");
      useLayoutStore.setState({ activeSavedWorkspaceId: null });
      useLayoutStore.getState().openSessionInLeaf(
        useLayoutStore.getState().activePaneId ?? "",
        "pty-1",
      );
      vi.advanceTimersByTime(300);

      const kept = useLayoutStore.getState().savedWorkspaces
        .find((item) => item.id === saved.id);
      if (!kept || kept.tree.type !== "leaf") throw new Error("快照应为单叶");
      expect(kept.tree.sessionIds).toEqual([]);
    } finally {
      registerActiveWorkspaceRefsProvider(null);
      vi.useRealTimers();
    }
  });
});
```

import 区补 `registerActiveWorkspaceRefsProvider`。

- [ ] **Step 2: 运行确认 RED**

Run: `npm test -- src/store/layoutStore.test.ts`
Expected: FAIL（`registerActiveWorkspaceRefsProvider` 不存在）

- [ ] **Step 3: 最小实现**

`src/store/layoutStore.ts`：

模块级（`persistTimer` 声明旁）：

```ts
let activeWorkspaceRefsProvider: (() => Record<string, SavedSessionRef>) | null = null;

/**
 * 注册激活工作区写回时的会话引用提供者。
 * @param provider 构建当前稳定会话引用的函数；null 表示注销。
 * @returns 无返回值。
 */
export function registerActiveWorkspaceRefsProvider(
  provider: (() => Record<string, SavedSessionRef>) | null,
): void {
  activeWorkspaceRefsProvider = provider;
}
```

`persist()` 的 debounce 回调改为：

```ts
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const { tree, activePaneId, activeSavedWorkspaceId, savedWorkspaces } = get();
      let nextSavedWorkspaces = savedWorkspaces;
      if (activeSavedWorkspaceId && activeWorkspaceRefsProvider) {
        nextSavedWorkspaces = savedWorkspaces.map((item) =>
          item.id === activeSavedWorkspaceId
            ? createSavedWorkspaceSnapshot({
                ...item,
                tree,
                activePaneId,
                sessionRefs: activeWorkspaceRefsProvider(),
              })
            : item,
        );
        set({ savedWorkspaces: nextSavedWorkspaces });
      }
      void layoutSave({
        version: LAYOUT_VERSION,
        tree: toPersisted(tree),
        activePaneId,
        activeSavedWorkspaceId: activeSavedWorkspaceId ?? undefined,
        savedWorkspaces: nextSavedWorkspaces,
      });
    }, 300);
```

`openSessionInLeaf`、`activateTab`、`closeTab`、`replaceSession` 四个方法中每处 `set({ tree })`（或 `if (tree !== currentTree) set({ tree })`）之后追加：

```ts
    if (get().activeSavedWorkspaceId) get().persist();
```

（`openSessionInLeaf` 有两处 `set`，都要加。）

- [ ] **Step 4: 运行确认 GREEN**

Run: `npm test -- src/store/layoutStore.test.ts src/App.test.tsx`
Expected: PASS（App 测试回归确认 Tab 操作触发 persist 不破坏既有编排）

- [ ] **Step 5: Commit**

```bash
git add src/store/layoutStore.ts src/store/layoutStore.test.ts
git commit -m "feat: 激活工作区随布局与 Tab 变动自动写回"
```

### Task 4: Sidebar 新建入口 + App 恢复接线

**Files:**
- Modify: `src/components/Sidebar/Sidebar.tsx`
- Create: `src/components/Sidebar/Sidebar.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles/sidebar.css`

**Interfaces:**
- Consumes: `collectCurrentSessionRefs` / `restoreWorkspaceById`（Task 2）、`registerActiveWorkspaceRefsProvider`（Task 3）
- Produces: `SidebarProps` 新增 `onRestoreWorkspace: (savedWorkspaceId: string) => void`；移除顶部「保存当前工作区」导航按钮

- [ ] **Step 1: 写失败测试**

`src/components/Sidebar/Sidebar.test.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutStore } from "../../store/layoutStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { Sidebar } from "./Sidebar";

const restoreMocks = vi.hoisted(() => ({
  collectCurrentSessionRefs: vi.fn(() => ({
    "pty-1": {
      workspaceId: "workspace-1",
      kind: "claude" as const,
      mode: "terminal" as const,
    },
  })),
}));

vi.mock("../../lib/workspaceRestore", () => restoreMocks);
vi.mock("./WorkspaceItem", () => ({
  WorkspaceItem: () => <div data-testid="workspace-item" />,
}));
vi.mock("./RecentSessionList", () => ({
  RecentSessionList: () => <div data-testid="recent-list" />,
}));
vi.mock("./SidebarFooter", () => ({
  SidebarFooter: () => <footer />,
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({
    workspaces: [],
    expandedIds: new Set<string>(),
    historyCache: {},
    historyLoading: {},
    load: vi.fn(async () => undefined),
    loadAllHistories: vi.fn(async () => undefined),
  });
  useLayoutStore.setState({
    tree: { type: "leaf", id: "leaf-1", sessionIds: [], activeSessionId: null, locked: false },
    activePaneId: "leaf-1",
    savedWorkspaces: [{
      id: "saved-1",
      name: "已有工作区",
      tree: { type: "leaf", id: "leaf-s", sessionIds: [], activeSessionId: null, locked: false },
      activePaneId: "leaf-s",
      createdAt: "2026-07-16T08:00:00.000Z",
    }],
    activeSavedWorkspaceId: null,
    persist: vi.fn(),
  });
});

/**
 * 渲染带默认回调的侧边栏。
 * @param onRestoreWorkspace 工作区恢复回调。
 * @returns 无返回值。
 */
function renderSidebar(onRestoreWorkspace = vi.fn()): { onRestoreWorkspace: ReturnType<typeof vi.fn> } {
  render(
    <Sidebar
      locateWorkspaceId={null}
      onLocateWorkspaceHandled={vi.fn()}
      onResume={vi.fn()}
      onNewShell={vi.fn()}
      onNewSession={vi.fn()}
      onQuickShell={vi.fn()}
      onRestoreWorkspace={onRestoreWorkspace}
    />,
  );
  return { onRestoreWorkspace };
}

describe("Sidebar 工作区", () => {
  it("顶部导航不再提供保存当前工作区", () => {
    renderSidebar();
    expect(screen.queryByText("保存当前工作区")).toBeNull();
  });

  it("加号新建工作区即以当前引用创建并激活", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "新建工作区" }));
    fireEvent.change(screen.getByPlaceholderText("工作区名称"), {
      target: { value: "新布局" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("工作区名称"), { key: "Enter" });

    const { savedWorkspaces, activeSavedWorkspaceId } = useLayoutStore.getState();
    const created = savedWorkspaces.find((item) => item.name === "新布局");
    expect(created).toBeTruthy();
    expect(created?.sessionRefs).toEqual(restoreMocks.collectCurrentSessionRefs());
    expect(activeSavedWorkspaceId).toBe(created?.id);
  });

  it("点击工作区行触发恢复回调而非直接换树", () => {
    const { onRestoreWorkspace } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "已有工作区" }));

    expect(onRestoreWorkspace).toHaveBeenCalledWith("saved-1");
    expect(useLayoutStore.getState().tree.id).toBe("leaf-1");
  });

  it("激活中的工作区行带激活样式", () => {
    useLayoutStore.setState({ activeSavedWorkspaceId: "saved-1" });
    renderSidebar();
    expect(
      screen.getByRole("button", { name: "已有工作区" }).className,
    ).toContain("saved-workspace-open-active");
  });
});
```

- [ ] **Step 2: 运行确认 RED**

Run: `npm test -- src/components/Sidebar/Sidebar.test.tsx`
Expected: FAIL（无 `onRestoreWorkspace` prop、无「新建工作区」按钮）

- [ ] **Step 3: 实现 Sidebar**

`src/components/Sidebar/Sidebar.tsx`：

1. `SidebarProps` 加 `onRestoreWorkspace: (savedWorkspaceId: string) => void;`，函数签名解构加入。
2. import 增 `Plus`，删 `Save`；增 `import { collectCurrentSessionRefs } from "../../lib/workspaceRestore";`。
3. 删除顶部「保存当前工作区」`SidebarNavItem` 与 `savingWorkspace` 状态块；状态改名 `creatingWorkspace`。
4. 「工作区」分组标题替换为：

```tsx
        <div className="sidebar-group-title sidebar-group-title-row">
          <span>工作区</span>
          <button
            type="button"
            className="sidebar-group-add"
            aria-label="新建工作区"
            title="以当前布局新建工作区"
            onClick={() => setCreatingWorkspace(true)}
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        </div>
        {creatingWorkspace && (
          <div className="sidebar-save-workspace">
            <input
              className="sidebar-search-input"
              value={workspaceName}
              placeholder="工作区名称"
              autoFocus
              onChange={(event) => setWorkspaceName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setCreatingWorkspace(false);
                  setWorkspaceName("");
                }
                if (event.key === "Enter" && workspaceName.trim()) {
                  saveCurrentWorkspace(workspaceName, collectCurrentSessionRefs());
                  setCreatingWorkspace(false);
                  setWorkspaceName("");
                }
              }}
            />
          </div>
        )}
```

5. 工作区行按钮：`onClick={() => onRestoreWorkspace(saved.id)}`，className 改为：

```tsx
                  className={`saved-workspace-open${
                    saved.id === activeSavedWorkspaceId ? " saved-workspace-open-active" : ""
                  }`}
```

`activeSavedWorkspaceId` 通过 `useLayoutStore((s) => s.activeSavedWorkspaceId)` 订阅。`restoreSavedWorkspace` 的订阅删除。

`src/styles/sidebar.css` 追加：

```css
.sidebar-group-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sidebar-group-add {
  display: flex;
  align-items: center;
  padding: 2px;
  background: transparent;
  border: none;
  color: var(--fg-faint);
  cursor: pointer;
  border-radius: 4px;
}
.sidebar-group-add:hover {
  background: var(--sidebar-hover);
  color: var(--fg);
}
.saved-workspace-open-active {
  color: var(--fg);
  font-weight: 600;
}
```

- [ ] **Step 4: 实现 App 接线**

`src/App.tsx`：

1. import 增：

```ts
import { registerActiveWorkspaceRefsProvider } from "./store/layoutStore";
import { collectCurrentSessionRefs, restoreWorkspaceById } from "./lib/workspaceRestore";
```

（layoutStore 已有 import 行，合并即可。）

2. 启动 useEffect 注册 provider：

```ts
  // 注册激活工作区写回的会话引用提供者
  useEffect(() => {
    registerActiveWorkspaceRefsProvider(collectCurrentSessionRefs);
    return () => registerActiveWorkspaceRefsProvider(null);
  }, []);
```

3. 新增回调：

```ts
  /**
   * 恢复保存工作区：布局与会话一并恢复，错误汇总为 toast。
   * @param savedWorkspaceId 保存工作区 ID。
   * @returns 恢复流程完成后解析。
   */
  const restoreWorkspace = useCallback(async (savedWorkspaceId: string): Promise<void> => {
    if (useLayoutStore.getState().activeSavedWorkspaceId === savedWorkspaceId) return;
    const result = await restoreWorkspaceById(
      savedWorkspaceId,
      (managed, spawnedAt) => scheduleAiDetect(managed, spawnedAt, [5000, 15000]),
    );
    if (result.errorCount > 0) {
      showToast(`${result.errorCount} 个会话恢复失败，详见窗格提示`);
    }
  }, [showToast]);
```

4. `<Sidebar ... onRestoreWorkspace={(id) => void restoreWorkspace(id)} />`。

`src/App.test.tsx`：Sidebar mock 的 props 类型与按钮改为：

```tsx
    onRestoreWorkspace,
```

（props 解构与类型声明加 `onRestoreWorkspace: (savedWorkspaceId: string) => void;`），「恢复保存工作区」按钮 onClick 改为 `() => onRestoreWorkspace("saved-layout")`。

既有两个用例行为核对：
- 「释放期间切换保存工作区……」：走新编排。快照无 sessionRefs 且 `native:restored-tab` 在 historyCache 中无对应 managed 会话 → error 动作（`setRestoreError` + 恢复失败 toast）。error 动作不修改树，原断言（树为 `restored-split`、sessionIds 保留、`窗格内容已变化` toast 最终覆盖恢复失败 toast）仍全部成立，无需改动。
- 「恢复保存工作区时不终止当前 PTY」：改为 `await waitFor(() => expect(useLayoutStore.getState().tree.id).toBe(leaf.id));`（编排异步），`ptyKill` 不被调用断言保留；测试改成 `async`。

- [ ] **Step 5: 运行确认 GREEN**

Run: `npm test -- src/components/Sidebar/Sidebar.test.tsx src/App.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar/Sidebar.tsx src/components/Sidebar/Sidebar.test.tsx src/App.tsx src/App.test.tsx src/styles/sidebar.css
git commit -m "feat: 工作区新建即激活，点击恢复布局与会话"
```

### Task 5: PaneLeaf 渲染恢复错误占位

**Files:**
- Modify: `src/components/PaneGrid/PaneLeaf.tsx`
- Modify: `src/components/PaneGrid/PaneGrid.test.tsx`
- Modify: `src/styles/main.css`

**Interfaces:**
- Consumes: `useLayoutStore` 的 `restoreErrors` / `setRestoreError`（已存在）

- [ ] **Step 1: 写失败测试**

`src/components/PaneGrid/PaneGrid.test.tsx` 追加（沿用文件内既有 store 重置模式）：

```tsx
  it("窗格存在恢复错误时显示占位并可手动清除", () => {
    useLayoutStore.setState({
      restoreErrors: { "leaf-1": "供应商不存在：p-1" },
    });
    renderGrid();

    expect(screen.getByRole("alert").textContent).toContain("供应商不存在：p-1");

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));

    expect(useLayoutStore.getState().restoreErrors["leaf-1"]).toBeUndefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
```

（`renderGrid` 为该文件既有渲染帮助函数；若名称不同以实际为准，布局需含 id 为 `leaf-1` 的叶子。）

- [ ] **Step 2: 运行确认 RED**

Run: `npm test -- src/components/PaneGrid/PaneGrid.test.tsx`
Expected: FAIL（无 alert 渲染）

- [ ] **Step 3: 最小实现**

`src/components/PaneGrid/PaneLeaf.tsx`：

订阅（`activeSavedWorkspaceId` 订阅旁）：

```ts
  const restoreError = useLayoutStore((s) => s.restoreErrors[leaf.id]);
  const setRestoreError = useLayoutStore((s) => s.setRestoreError);
```

`pane-body` 内容顶部插入：

```tsx
      <div className="pane-body">
        {restoreError && (
          <div className="pane-restore-error" role="alert">
            <span>会话恢复失败：{restoreError}</span>
            <button
              type="button"
              className="pane-restore-error-dismiss"
              onClick={() => setRestoreError(leaf.id, null)}
            >
              知道了
            </button>
          </div>
        )}
        {nativeConversationId ? (
```

`src/styles/main.css` 追加：

```css
.pane-restore-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-bottom: 1px solid var(--border);
}
.pane-restore-error-dismiss {
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  color: var(--fg);
  cursor: pointer;
}
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `npm test -- src/components/PaneGrid/PaneGrid.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/PaneGrid/PaneLeaf.tsx src/components/PaneGrid/PaneGrid.test.tsx src/styles/main.css
git commit -m "feat: 窗格内显示会话恢复错误占位"
```

### Task 6: 文件夹图标、间距与风琴动画

**Files:**
- Modify: `src/components/ui/icons.ts`
- Modify: `src/components/Sidebar/WorkspaceItem.tsx`
- Modify: `src/components/Sidebar/WorkspaceItem.test.tsx`
- Modify: `src/styles/sidebar.css`

**Interfaces:**
- Consumes: lucide-react `Folder` / `FolderOpen`

- [ ] **Step 1: 写失败测试**

`src/components/Sidebar/WorkspaceItem.test.tsx` 追加（文件已有 render 帮助模式，SessionHistoryList 需 mock 以聚焦容器行为）：

```tsx
vi.mock("./SessionHistoryList", () => ({
  SessionHistoryList: () => <div data-testid="history-list" />,
}));
```

```tsx
  it("折叠显示文件夹图标，展开切换为打开的文件夹", () => {
    const { container } = render(
      <WorkspaceItem
        ws={workspace}
        index={0}
        onResume={vi.fn()}
        onNewShell={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );

    expect(container.querySelector(".lucide-folder")).toBeTruthy();
    expect(container.querySelector(".lucide-folder-open")).toBeNull();

    useWorkspaceStore.setState({ expandedIds: new Set([workspace.id]) });

    expect(container.querySelector(".lucide-folder-open")).toBeTruthy();
  });

  it("会话历史容器常驻并以风琴类名控制展开", () => {
    const { container } = render(
      <WorkspaceItem
        ws={workspace}
        index={0}
        onResume={vi.fn()}
        onNewShell={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("history-list")).toBeNull();

    useWorkspaceStore.setState({ expandedIds: new Set([workspace.id]) });
    expect(screen.getByTestId("history-list")).toBeTruthy();
    expect(container.querySelector(".ws-item-history-open")).toBeTruthy();

    useWorkspaceStore.setState({ expandedIds: new Set() });
    expect(screen.getByTestId("history-list")).toBeTruthy();
    expect(container.querySelector(".ws-item-history-open")).toBeNull();
  });
```

注：`useWorkspaceStore.setState` 需包在 `act(...)` 中（`@testing-library/react` 的 `act` 已可 import）。

- [ ] **Step 2: 运行确认 RED**

Run: `npm test -- src/components/Sidebar/WorkspaceItem.test.tsx`
Expected: FAIL（当前是 ChevronRight，且历史列表条件卸载）

- [ ] **Step 3: 最小实现**

`src/components/ui/icons.ts` 导出列表加 `Folder, FolderOpen,`。

`src/components/Sidebar/WorkspaceItem.tsx`：

1. import 改：`import { Folder, FolderOpen, Plus } from "../ui/icons";`（删 ChevronRight）。
2. 顶部 `import { useEffect, useState } from "react";`。
3. 加状态与效果（组件内）：

```ts
  const [historyMounted, setHistoryMounted] = useState(false);

  // 首次展开后保持挂载，收起时仅折叠容器以保留风琴动画
  useEffect(() => {
    if (expanded) setHistoryMounted(true);
  }, [expanded]);
```

4. 展开图标块替换：

```tsx
        <span className="ws-item-folder" onClick={onToggleClick}>
          {expanded
            ? <FolderOpen size={14} strokeWidth={1.5} />
            : <Folder size={14} strokeWidth={1.5} />}
        </span>
```

5. `{expanded && <SessionHistoryList ... />}` 替换为：

```tsx
      <div className={`ws-item-history${expanded ? " ws-item-history-open" : ""}`}>
        <div className="ws-item-history-inner">
          {historyMounted && (
            <SessionHistoryList
              ws={ws}
              onResume={onResume}
            />
          )}
        </div>
      </div>
```

`src/styles/sidebar.css`：

1. `.ws-item-row` 的 `gap: 8px` → `gap: 5px`。
2. `.ws-item-arrow` / `.ws-item-arrow-open` 两条规则替换为：

```css
.ws-item-folder {
  color: var(--fg-faint);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}
```

3. 追加风琴容器：

```css
.ws-item-history {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.18s ease;
}
.ws-item-history-open {
  grid-template-rows: 1fr;
}
.ws-item-history-inner {
  min-height: 0;
  overflow: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .ws-item-history {
    transition: none;
  }
}
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `npm test -- src/components/Sidebar/WorkspaceItem.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/icons.ts src/components/Sidebar/WorkspaceItem.tsx src/components/Sidebar/WorkspaceItem.test.tsx src/styles/sidebar.css
git commit -m "feat: 项目行文件夹图标与会话历史风琴动画"
```

### Task 7: 全量验证

- [ ] **Step 1: 全量测试与构建**

Run: `npm test` → 全部 PASS
Run: `npm run typecheck` → 无错误
Run: `npm run build` → 成功
Run: `git diff --check` → 干净

- [ ] **Step 2: 手工验收（提示用户）**

提示用户按设计文档验收：开两个 AI 会话 → 「工作区」组「+」新建 → 关闭其中一个 PTY → 点击该工作区：存活会话原位、关闭的以 resume 重建；拖分屏/开关 Tab 后重启应用确认自动同步已落盘；检查文件夹图标、间距与风琴动画。
