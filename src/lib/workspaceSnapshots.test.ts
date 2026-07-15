import { describe, expect, it } from "vitest";
import type {
  ManagedSession,
  PaneNode,
  ProviderProfile,
  PtySessionInfo,
  SavedSessionRef,
  SavedWorkspaceLayout,
  Workspace,
} from "../api/types";
import {
  buildSessionRefs,
  planWorkspaceRestore,
} from "./workspaceSnapshots";

const WORKSPACE_ID = "workspace-1";

const workspace: Workspace = {
  id: WORKSPACE_ID,
  name: "面板项目",
  path: "D:\\AI\\tht-panel",
  agent: "claude",
  useGlobalConfig: true,
  sortOrder: 0,
  createdAt: "2026-07-15T08:00:00.000Z",
  defaultProviderId: "claude-default",
};

const providers: ProviderProfile[] = [
  {
    id: "claude-default",
    name: "Claude 默认",
    driver: "claude",
  },
  {
    id: "claude-saved",
    name: "Claude 保存配置",
    driver: "claude",
  },
  {
    id: "codex-saved",
    name: "Codex 保存配置",
    driver: "codex",
  },
];

/**
 * 创建测试用运行时 PTY 会话。
 * @param sessionId PTY 会话 ID。
 * @param overrides 需要覆盖的会话字段。
 * @returns 完整的运行时会话。
 */
function runtimeSession(
  sessionId: string,
  overrides: Partial<PtySessionInfo> = {},
): PtySessionInfo {
  return {
    sessionId,
    workspaceId: WORKSPACE_ID,
    kind: "claude",
    cwd: workspace.path,
    title: "Claude",
    state: "idle",
    createdAt: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

/**
 * 创建测试用自管会话。
 * @param id 自管会话 ID。
 * @param overrides 需要覆盖的会话字段。
 * @returns 完整的自管会话。
 */
function managedSession(
  id: string,
  overrides: Partial<ManagedSession> = {},
): ManagedSession {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name: `会话 ${id}`,
    kind: "claude",
    createdAt: "2026-07-15T08:00:00.000Z",
    updatedAt: "2026-07-15T08:00:00.000Z",
    mode: "terminal",
    ...overrides,
  };
}

/**
 * 创建包含指定 Tab 的单窗格布局树。
 * @param sessionIds 按显示顺序排列的 Tab ID。
 * @param leafId 叶子窗格 ID。
 * @returns 单窗格布局树。
 */
function leafTree(sessionIds: string[], leafId = "leaf-1"): PaneNode {
  return {
    type: "leaf",
    id: leafId,
    sessionIds,
    activeSessionId: sessionIds[0] ?? null,
    locked: false,
  };
}

/**
 * 创建测试用保存工作区快照。
 * @param tree 快照中的布局树。
 * @param sessionRefs 可选的稳定会话引用。
 * @returns 完整的保存工作区快照。
 */
function snapshot(
  tree: PaneNode,
  sessionRefs?: Record<string, SavedSessionRef>,
): SavedWorkspaceLayout {
  return {
    id: "snapshot-1",
    name: "保存布局",
    tree,
    activePaneId: tree.type === "leaf" ? tree.id : null,
    createdAt: "2026-07-15T09:00:00.000Z",
    ...(sessionRefs ? { sessionRefs } : {}),
  };
}

describe("保存工作区会话引用", () => {
  it("按自管会话、原生会话和待命名元数据构建独立引用", () => {
    const named = managedSession("managed-terminal", {
      ptySessionId: "pty-named",
      providerId: "claude-saved",
    });
    const native = managedSession("managed-native", {
      mode: "native",
      providerId: "codex-saved",
      kind: "codex",
    });
    const runtimeSessions = {
      "pty-named": runtimeSession("pty-named"),
      "pty-pending": runtimeSession("pty-pending", { kind: "claude" }),
      "pty-runtime": runtimeSession("pty-runtime", { kind: "shell" }),
      "pty-unbound": runtimeSession("pty-unbound", { workspaceId: null }),
    };
    const pendingMeta = {
      workspaceId: WORKSPACE_ID,
      kind: "codex",
      providerId: "codex-saved",
    };
    const refs = buildSessionRefs(
      leafTree([
        "pty-named",
        "native:managed-native",
        "pty-pending",
        "pty-runtime",
        "pty-unbound",
      ]),
      runtimeSessions,
      { [WORKSPACE_ID]: [named, native] },
      new Map([["pty-pending", pendingMeta]]),
    );

    expect(refs).toEqual({
      "pty-named": {
        managedSessionId: "managed-terminal",
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        providerId: "claude-saved",
        mode: "terminal",
      },
      "native:managed-native": {
        managedSessionId: "managed-native",
        workspaceId: WORKSPACE_ID,
        kind: "codex",
        providerId: "codex-saved",
        mode: "native",
      },
      "pty-pending": {
        workspaceId: WORKSPACE_ID,
        kind: "codex",
        providerId: "codex-saved",
        mode: "terminal",
      },
      "pty-runtime": {
        workspaceId: WORKSPACE_ID,
        kind: "shell",
        mode: "terminal",
      },
    });
    expect(refs["pty-pending"]).not.toBe(pendingMeta);
    pendingMeta.providerId = "changed-after-save";
    expect(refs["pty-pending"]?.providerId).toBe("codex-saved");
  });
});

describe("保存工作区恢复规划", () => {
  it("旧 PTY 仍存活时原位复用并保留自管会话关联", () => {
    const ref: SavedSessionRef = {
      managedSessionId: "managed-1",
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      providerId: "claude-saved",
      mode: "terminal",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-old"]), { "pty-old": ref }),
      runtimeSessions: { "pty-old": runtimeSession("pty-old") },
      managedSessions: [managedSession("managed-1", { ptySessionId: "pty-old" })],
      workspaces: [workspace],
      providers,
    })).toEqual([
      {
        kind: "keep",
        leafId: "leaf-1",
        oldTabId: "pty-old",
        sessionId: "pty-old",
        managedSessionId: "managed-1",
      },
    ]);
  });

  it("旧 PTY 存活但工作空间与保存引用不一致时拒绝复用", () => {
    const ref: SavedSessionRef = {
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      mode: "terminal",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-cross-workspace"]), {
        "pty-cross-workspace": ref,
      }),
      runtimeSessions: {
        "pty-cross-workspace": runtimeSession("pty-cross-workspace", {
          workspaceId: "workspace-2",
          state: "running",
        }),
      },
      managedSessions: [],
      workspaces: [workspace, { ...workspace, id: "workspace-2" }],
      providers,
    })[0]).toMatchObject({
      kind: "error",
      oldTabId: "pty-cross-workspace",
    });
  });

  it("旧 PTY 存活但类型与保存引用不一致时拒绝复用", () => {
    const ref: SavedSessionRef = {
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      mode: "terminal",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-cross-kind"]), {
        "pty-cross-kind": ref,
      }),
      runtimeSessions: {
        "pty-cross-kind": runtimeSession("pty-cross-kind", {
          kind: "codex",
          state: "running",
        }),
      },
      managedSessions: [],
      workspaces: [workspace],
      providers,
    })[0]).toMatchObject({
      kind: "error",
      oldTabId: "pty-cross-kind",
    });
  });

  it("旧 PTY 被其他自管会话占用时拒绝串接显式 managed 身份", () => {
    const ref: SavedSessionRef = {
      managedSessionId: "managed-target",
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      mode: "terminal",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-old"]), { "pty-old": ref }),
      runtimeSessions: { "pty-old": runtimeSession("pty-old") },
      managedSessions: [
        managedSession("managed-target", { ptySessionId: "pty-other" }),
        managedSession("managed-unrelated", { ptySessionId: "pty-old" }),
      ],
      workspaces: [workspace],
      providers,
    })[0]).toMatchObject({
      kind: "error",
      oldTabId: "pty-old",
    });
  });

  it("同一自管会话已有新 PTY 时复用新 ID 而不重复启动", () => {
    const ref: SavedSessionRef = {
      managedSessionId: "managed-1",
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      mode: "terminal",
    };
    const managed = managedSession("managed-1", { ptySessionId: "pty-new" });

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-old"]), { "pty-old": ref }),
      runtimeSessions: {
        "pty-old": runtimeSession("pty-old", { state: "running" }),
        "pty-new": runtimeSession("pty-new", { state: "running" }),
      },
      managedSessions: [managed],
      workspaces: [workspace],
      providers,
    })).toEqual([
      {
        kind: "keep",
        leafId: "leaf-1",
        oldTabId: "pty-old",
        sessionId: "pty-new",
        managedSessionId: "managed-1",
      },
    ]);
  });

  it("AI 历史会话需要重启时把匹配类型的自管会话附到 spawn", () => {
    const ref: SavedSessionRef = {
      managedSessionId: "managed-1",
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      providerId: "claude-saved",
      mode: "terminal",
    };
    const managed = managedSession("managed-1", {
      ptySessionId: "pty-dead",
      aiSessionId: "ai-session-1",
      providerId: "claude-saved",
    });
    const actions = planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-dead"]), { "pty-dead": ref }),
      runtimeSessions: {
        "pty-dead": runtimeSession("pty-dead", { state: "dead" }),
      },
      managedSessions: [managed],
      workspaces: [workspace],
      providers,
    });

    expect(actions).toEqual([
      {
        kind: "spawn",
        leafId: "leaf-1",
        oldTabId: "pty-dead",
        ref,
        managed,
      },
    ]);
    expect(actions[0]?.kind === "spawn" && actions[0].ref).not.toBe(ref);
  });

  it("保存引用没有 managed ID 时不把占用旧 PTY 的其他会话附到 spawn", () => {
    const ref: SavedSessionRef = {
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      mode: "terminal",
    };
    const unrelated = managedSession("managed-unrelated", {
      ptySessionId: "pty-old",
      aiSessionId: "ai-unrelated",
    });

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-old"]), { "pty-old": ref }),
      runtimeSessions: {
        "pty-old": runtimeSession("pty-old", { state: "dead" }),
      },
      managedSessions: [unrelated],
      workspaces: [workspace],
      providers,
    })).toEqual([
      {
        kind: "spawn",
        leafId: "leaf-1",
        oldTabId: "pty-old",
        ref,
      },
    ]);
  });

  it("旧快照按原生 ID 或旧 PTY 绑定回退，无法识别时返回固定错误", () => {
    const native = managedSession("managed-native", {
      mode: "native",
      kind: "codex",
      providerId: "codex-saved",
    });
    const terminal = managedSession("managed-terminal", {
      ptySessionId: "pty-legacy",
      aiSessionId: "ai-legacy",
      providerId: "claude-saved",
    });

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree([
        "native:managed-native",
        "pty-legacy",
        "pty-unknown",
      ])),
      runtimeSessions: {},
      managedSessions: [native, terminal],
      workspaces: [workspace],
      providers,
    })).toEqual([
      {
        kind: "native",
        leafId: "leaf-1",
        oldTabId: "native:managed-native",
        sessionId: "native:managed-native",
        managedSessionId: "managed-native",
      },
      {
        kind: "spawn",
        leafId: "leaf-1",
        oldTabId: "pty-legacy",
        ref: {
          managedSessionId: "managed-terminal",
          workspaceId: WORKSPACE_ID,
          kind: "claude",
          providerId: "claude-saved",
          mode: "terminal",
        },
        managed: terminal,
      },
      {
        kind: "error",
        leafId: "leaf-1",
        oldTabId: "pty-unknown",
        message: "旧会话无法恢复",
      },
    ]);
  });

  it("原生引用找不到自管会话时返回错误", () => {
    const ref: SavedSessionRef = {
      managedSessionId: "missing-native",
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      providerId: "claude-saved",
      mode: "native",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["native:old-id"]), { "native:old-id": ref }),
      runtimeSessions: {},
      managedSessions: [managedSession("unrelated", {
        ptySessionId: "native:old-id",
      })],
      workspaces: [workspace],
      providers,
    })[0]).toMatchObject({
      kind: "error",
      leafId: "leaf-1",
      oldTabId: "native:old-id",
    });
  });

  it("命名供应商缺失、重复或驱动不一致时分别拒绝恢复", () => {
    const tree = leafTree(["pty-missing", "pty-duplicate", "pty-mismatch"]);
    const refs: Record<string, SavedSessionRef> = {
      "pty-missing": {
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        providerId: "missing-provider",
        mode: "terminal",
      },
      "pty-duplicate": {
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        providerId: "duplicate-provider",
        mode: "terminal",
      },
      "pty-mismatch": {
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        providerId: "codex-saved",
        mode: "terminal",
      },
    };
    const duplicateProvider: ProviderProfile = {
      id: "duplicate-provider",
      name: "重复 A",
      driver: "claude",
    };
    const actions = planWorkspaceRestore({
      snapshot: snapshot(tree, refs),
      runtimeSessions: {},
      managedSessions: [],
      workspaces: [workspace],
      providers: [
        ...providers,
        duplicateProvider,
        { ...duplicateProvider, name: "重复 B" },
      ],
    });

    expect(actions).toHaveLength(3);
    expect(actions.every((action) => action.kind === "error")).toBe(true);
    expect(actions.map((action) => action.oldTabId)).toEqual([
      "pty-missing",
      "pty-duplicate",
      "pty-mismatch",
    ]);
  });

  it("未保存 providerId 时明确使用系统配置且不继承项目默认供应商", () => {
    const ref: SavedSessionRef = {
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      mode: "terminal",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-system"]), { "pty-system": ref }),
      runtimeSessions: {},
      managedSessions: [],
      workspaces: [workspace],
      providers,
    })).toEqual([
      {
        kind: "spawn",
        leafId: "leaf-1",
        oldTabId: "pty-system",
        ref,
      },
    ]);
  });

  it("引用的工作空间不存在时返回错误", () => {
    const ref: SavedSessionRef = {
      workspaceId: "missing-workspace",
      kind: "claude",
      mode: "terminal",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-missing-workspace"]), {
        "pty-missing-workspace": ref,
      }),
      runtimeSessions: {},
      managedSessions: [],
      workspaces: [workspace],
      providers,
    })[0]).toMatchObject({
      kind: "error",
      oldTabId: "pty-missing-workspace",
    });
  });

  it("shell 会话忽略供应商校验并按保存引用启动", () => {
    const ref: SavedSessionRef = {
      workspaceId: WORKSPACE_ID,
      kind: "shell",
      providerId: "missing-shell-provider",
      mode: "terminal",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["shell-dead"]), { "shell-dead": ref }),
      runtimeSessions: {},
      managedSessions: [],
      workspaces: [workspace],
      providers,
    })[0]).toMatchObject({
      kind: "spawn",
      oldTabId: "shell-dead",
      ref,
    });
  });

  it("严格按 Leaf 先序和 Leaf 内 Tab 顺序输出动作", () => {
    const tree: PaneNode = {
      type: "split",
      id: "root",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        leafTree(["left-1", "left-2"], "left"),
        {
          type: "split",
          id: "right-split",
          direction: "vertical",
          ratio: 0.4,
          children: [
            leafTree(["top-1"], "top"),
            leafTree(["bottom-1", "bottom-2"], "bottom"),
          ],
        },
      ],
    };
    const runtimeSessions = Object.fromEntries(
      ["left-1", "left-2", "top-1", "bottom-1", "bottom-2"].map(
        (sessionId) => [sessionId, runtimeSession(sessionId)],
      ),
    );

    const actions = planWorkspaceRestore({
      snapshot: snapshot(tree),
      runtimeSessions,
      managedSessions: [],
      workspaces: [workspace],
      providers,
    });

    expect(actions.map((action) => [action.leafId, action.oldTabId])).toEqual([
      ["left", "left-1"],
      ["left", "left-2"],
      ["top", "top-1"],
      ["bottom", "bottom-1"],
      ["bottom", "bottom-2"],
    ]);
  });

  it("重复引用同一 managed ID 时只保留首个正常动作并按顺序报错", () => {
    const sessionIds = [
      "spawn-first",
      "spawn-duplicate",
      "keep-first",
      "keep-duplicate",
      "native-first",
      "native-duplicate",
    ];
    const refs: Record<string, SavedSessionRef> = {
      "spawn-first": {
        managedSessionId: "managed-spawn",
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        mode: "terminal",
      },
      "spawn-duplicate": {
        managedSessionId: "managed-spawn",
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        mode: "terminal",
      },
      "keep-first": {
        managedSessionId: "managed-keep",
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        mode: "terminal",
      },
      "keep-duplicate": {
        managedSessionId: "managed-keep",
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        mode: "terminal",
      },
      "native-first": {
        managedSessionId: "managed-native",
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        mode: "native",
      },
      "native-duplicate": {
        managedSessionId: "managed-native",
        workspaceId: WORKSPACE_ID,
        kind: "claude",
        mode: "native",
      },
    };
    const actions = planWorkspaceRestore({
      snapshot: snapshot(leafTree(sessionIds), refs),
      runtimeSessions: {
        "pty-current": runtimeSession("pty-current", { state: "running" }),
      },
      managedSessions: [
        managedSession("managed-spawn", { aiSessionId: "ai-spawn" }),
        managedSession("managed-keep", { ptySessionId: "pty-current" }),
        managedSession("managed-native", { mode: "native" }),
      ],
      workspaces: [workspace],
      providers,
    });

    expect(actions.map((action) => [action.oldTabId, action.kind])).toEqual([
      ["spawn-first", "spawn"],
      ["spawn-duplicate", "error"],
      ["keep-first", "keep"],
      ["keep-duplicate", "error"],
      ["native-first", "native"],
      ["native-duplicate", "error"],
    ]);
    expect(
      actions.filter((action) => action.kind === "error")
        .map((action) => action.message),
    ).toEqual([
      "快照重复引用同一自管会话",
      "快照重复引用同一自管会话",
      "快照重复引用同一自管会话",
    ]);
  });

  it("历史加载失败且引用依赖自管会话时返回错误", () => {
    const ref: SavedSessionRef = {
      managedSessionId: "managed-1",
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      mode: "terminal",
    };

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-dead"]), { "pty-dead": ref }),
      runtimeSessions: {
        "pty-dead": runtimeSession("pty-dead", { state: "dead" }),
      },
      managedSessions: [managedSession("managed-1", { aiSessionId: "ai-1" })],
      workspaces: [workspace],
      providers,
      failedWorkspaceIds: new Set([WORKSPACE_ID]),
    })[0]).toMatchObject({
      kind: "error",
      leafId: "leaf-1",
      oldTabId: "pty-dead",
    });
  });

  it("AI 自管会话类型不一致时不复用错误的 aiSessionId", () => {
    const ref: SavedSessionRef = {
      managedSessionId: "managed-codex",
      workspaceId: WORKSPACE_ID,
      kind: "claude",
      mode: "terminal",
    };
    const mismatched = managedSession("managed-codex", {
      kind: "codex",
      aiSessionId: "codex-ai-session",
      ptySessionId: "pty-codex-live",
    });

    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["pty-ai"]), { "pty-ai": ref }),
      runtimeSessions: {
        "pty-codex-live": runtimeSession("pty-codex-live", {
          kind: "codex",
          state: "running",
        }),
      },
      managedSessions: [mismatched],
      workspaces: [workspace],
      providers,
    })[0]).toMatchObject({
      kind: "error",
      oldTabId: "pty-ai",
    });
  });

  it("无工作空间的死亡 PTY 不会被静默新建", () => {
    expect(planWorkspaceRestore({
      snapshot: snapshot(leafTree(["orphan-dead"])),
      runtimeSessions: {
        "orphan-dead": runtimeSession("orphan-dead", {
          workspaceId: null,
          state: "dead",
        }),
      },
      managedSessions: [],
      workspaces: [workspace],
      providers,
    })).toEqual([
      {
        kind: "error",
        leafId: "leaf-1",
        oldTabId: "orphan-dead",
        message: "旧会话无法恢复",
      },
    ]);
  });
});
