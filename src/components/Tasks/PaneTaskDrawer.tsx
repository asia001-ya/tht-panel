/**
 * 当前布局的窗格协作任务抽屉。
 */
import { useEffect, useState } from "react";
import type {
  LeafNode,
  PaneTask,
  PtySessionInfo,
  TaskOutcome,
  Workspace,
} from "../../api/types";
import { parseNativeConversationTabId } from "../../lib/nativeConversation";
import { preorderLeaves, useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { useTaskStore } from "../../store/taskStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { X, ICON_DEFAULTS } from "../ui/icons";
import { IconButton } from "../ui/IconButton";

interface InjectionConfirmation {
  kind: "dispatch" | "forward";
  taskId: string;
  paneId: string;
  sessionId: string;
}

const STATUS_LABEL: Record<PaneTask["status"], string> = {
  queued: "待接收",
  dispatched: "执行中",
  reported: "已上报",
  forwarded: "已转交",
  closed: "已关闭",
  cancelled: "已取消",
};

const OUTCOME_LABEL: Record<TaskOutcome, string> = {
  completed: "完成",
  blocked: "受阻",
};

/**
 * 判断活动 Tab 是否可以接收协作任务注入。
 * @param activeSessionId 当前活动 Tab 标识。
 * @param sessions PTY 会话镜像。
 * @returns 可注入时返回 null，否则返回禁用原因。
 */
export function injectionBlockReason(
  activeSessionId: string | null,
  sessions: Record<string, PtySessionInfo>,
): string | null {
  if (!activeSessionId) return "当前窗格没有活动会话";
  if (parseNativeConversationTabId(activeSessionId) !== null) {
    return "Native 会话暂不支持任务注入";
  }
  const session = sessions[activeSessionId];
  if (!session) return "活动会话尚未连接";
  if (session.kind !== "claude" && session.kind !== "codex") {
    return "仅 Claude/Codex 会话可接收任务";
  }
  if (session.state === "waiting") return "等待输入的会话暂不能注入";
  if (session.state === "dead") return "已结束的会话不能注入";
  return null;
}

/**
 * 解析窗格展示名称；显式名称优先，其次使用活动终端所属项目名。
 * @param leaf 窗格叶子。
 * @param sessions PTY 会话镜像。
 * @param workspaces 项目列表。
 * @returns 可用于任务路由的名称；未命名时返回 null。
 */
function paneDisplayName(
  leaf: LeafNode,
  sessions: Record<string, PtySessionInfo>,
  workspaces: Workspace[],
): string | null {
  const explicitName = leaf.name?.trim();
  if (explicitName) return explicitName;
  const workspaceId = leaf.activeSessionId
    ? sessions[leaf.activeSessionId]?.workspaceId
    : null;
  if (!workspaceId) return null;
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? null;
}

/**
 * 生成人工确认页的任务内容预览。
 * @param kind 派发或转交动作。
 * @param task 任务快照。
 * @returns 包含任务标识、标题、请求与可选报告的预览文本。
 */
function taskPromptPreview(
  kind: InjectionConfirmation["kind"],
  task: PaneTask,
): string {
  const lines = [
    `任务 ID：${task.id}`,
    `标题：${task.title}`,
    `请求：${task.request}`,
  ];
  if (kind === "forward") {
    const outcomeLabel = task.outcome ? OUTCOME_LABEL[task.outcome] : "未知";
    lines.push(`结果：${outcomeLabel}`);
    lines.push(`报告：${task.report ?? ""}`);
  }
  return lines.join("\n");
}

/**
 * 渲染单个任务及当前 Pane 可执行的状态动作。
 * @param props 任务、当前 Pane、布局、会话与动作回调。
 * @returns 单个任务条目。
 */
function TaskItem({
  task,
  drawerPaneId,
  leaves,
  sessions,
  reportDraft,
  onReportDraftChange,
  onBeginConfirmation,
  onReport,
  onClose,
  onCancel,
}: {
  task: PaneTask;
  drawerPaneId: string;
  leaves: LeafNode[];
  sessions: Record<string, PtySessionInfo>;
  reportDraft: string;
  onReportDraftChange: (value: string) => void;
  onBeginConfirmation: (confirmation: InjectionConfirmation) => void;
  onReport: (taskId: string, outcome: TaskOutcome, report: string) => void;
  onClose: (taskId: string) => void;
  onCancel: (taskId: string) => void;
}): React.ReactElement {
  const isSource = task.sourcePaneId === drawerPaneId;
  const isTarget = task.targetPaneId === drawerPaneId;
  const targetLeaf = leaves.find((leaf) => leaf.id === task.targetPaneId);
  const sourceLeaf = leaves.find((leaf) => leaf.id === task.sourcePaneId);
  const receiveReason = injectionBlockReason(
    targetLeaf?.activeSessionId ?? null,
    sessions,
  );
  const forwardReason = injectionBlockReason(
    sourceLeaf?.activeSessionId ?? null,
    sessions,
  );

  return (
    <article className="task-item">
      <header className="task-item-header">
        <strong>{task.title}</strong>
        <span className={`task-status task-status-${task.status}`}>
          {STATUS_LABEL[task.status]}
        </span>
      </header>
      <div className="task-route">
        {task.sourcePaneName} → {task.targetPaneName}
      </div>
      <p className="task-request">{task.request}</p>
      {task.report && <p className="task-report">{task.report}</p>}

      <div className="task-item-actions">
        {task.status === "queued" && isTarget && (
          <button
            className="dialog-btn dialog-btn-primary"
            disabled={receiveReason !== null}
            title={receiveReason ?? "接收并注入目标活动会话"}
            type="button"
            onClick={() => {
              if (!targetLeaf?.activeSessionId || receiveReason) return;
              onBeginConfirmation({
                kind: "dispatch",
                taskId: task.id,
                paneId: task.targetPaneId,
                sessionId: targetLeaf.activeSessionId,
              });
            }}
          >
            接收并注入
          </button>
        )}
        {task.status === "queued" && isSource && (
          <button
            className="dialog-btn dialog-btn-ghost"
            type="button"
            onClick={() => onCancel(task.id)}
          >
            取消任务
          </button>
        )}
        {task.status === "dispatched" && isTarget && (
          <div className="task-report-form">
            <textarea
              aria-label="上报内容"
              className="dialog-textarea"
              value={reportDraft}
              onChange={(event) => onReportDraftChange(event.target.value)}
            />
            <button
              className="dialog-btn dialog-btn-primary"
              disabled={!reportDraft.trim()}
              type="button"
              onClick={() => onReport(task.id, "completed", reportDraft)}
            >
              完成并上报
            </button>
            <button
              className="dialog-btn dialog-btn-ghost"
              disabled={!reportDraft.trim()}
              type="button"
              onClick={() => onReport(task.id, "blocked", reportDraft)}
            >
              受阻并上报
            </button>
          </div>
        )}
        {task.status === "reported" && isSource && (
          <button
            className="dialog-btn dialog-btn-primary"
            disabled={forwardReason !== null}
            title={forwardReason ?? "转交来源活动会话"}
            type="button"
            onClick={() => {
              if (!sourceLeaf?.activeSessionId || forwardReason) return;
              onBeginConfirmation({
                kind: "forward",
                taskId: task.id,
                paneId: task.sourcePaneId,
                sessionId: sourceLeaf.activeSessionId,
              });
            }}
          >
            转交来源
          </button>
        )}
        {task.status === "forwarded" && isSource && (
          <button
            className="dialog-btn dialog-btn-primary"
            type="button"
            onClick={() => onClose(task.id)}
          >
            关闭任务
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * 渲染当前 Pane 的全局任务抽屉。
 * @returns 抽屉关闭时返回 null，否则返回任务界面。
 */
export function PaneTaskDrawer(): React.ReactElement | null {
  const drawerPaneId = useTaskStore((state) => state.drawerPaneId);
  const tasks = useTaskStore((state) => state.tasks);
  const loading = useTaskStore((state) => state.loading);
  const error = useTaskStore((state) => state.error);
  const closeDrawer = useTaskStore((state) => state.closeDrawer);
  const createTask = useTaskStore((state) => state.create);
  const dispatchTask = useTaskStore((state) => state.dispatch);
  const reportTask = useTaskStore((state) => state.report);
  const forwardTask = useTaskStore((state) => state.forward);
  const closeTask = useTaskStore((state) => state.close);
  const cancelTask = useTaskStore((state) => state.cancel);
  const tree = useLayoutStore((state) => state.tree);
  const sessions = useSessionStore((state) => state.sessions);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const [targetPaneId, setTargetPaneId] = useState("");
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [reportDrafts, setReportDrafts] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<InjectionConfirmation | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [injectionSubmitting, setInjectionSubmitting] = useState(false);

  const leaves = preorderLeaves(tree);
  const drawerLeaf = leaves.find((leaf) => leaf.id === drawerPaneId);
  const paneNames = new Map(
    leaves.map((leaf) => [leaf.id, paneDisplayName(leaf, sessions, workspaces)]),
  );
  const targetLeaves = leaves.filter(
    (leaf) => leaf.id !== drawerPaneId && paneNames.get(leaf.id),
  );
  const selectedTargetPaneId = targetLeaves.some((leaf) => leaf.id === targetPaneId)
    ? targetPaneId
    : (targetLeaves[0]?.id ?? "");

  useEffect(() => {
    setConfirmation(null);
    setInjectionSubmitting(false);
  }, [drawerPaneId]);

  if (!drawerPaneId || !drawerLeaf) return null;

  const currentPaneId = drawerLeaf.id;
  const drawerName = paneNames.get(drawerPaneId) ?? "未命名";
  const visibleTasks = tasks.filter(
    (task) => task.sourcePaneId === drawerPaneId || task.targetPaneId === drawerPaneId,
  );
  const confirmationTask = confirmation
    ? tasks.find((task) => task.id === confirmation.taskId)
    : undefined;
  const confirmationLeaf = confirmation
    ? leaves.find((leaf) => leaf.id === confirmation.paneId)
    : undefined;
  const currentSessionId = confirmationLeaf?.activeSessionId ?? null;
  const confirmationChanged = confirmation !== null
    && currentSessionId !== confirmation.sessionId;
  const currentBlockReason = injectionBlockReason(currentSessionId, sessions);

  /**
   * 创建新任务并在成功后清空表单。
   * @returns 创建流程完成时解决。
   */
  async function handleCreate(): Promise<void> {
    if (createSubmitting) return;
    const targetLeaf = targetLeaves.find((leaf) => leaf.id === selectedTargetPaneId);
    const targetName = targetLeaf ? paneNames.get(targetLeaf.id) : null;
    if (!targetLeaf || !targetName || !title.trim() || !request.trim()) return;
    setCreateSubmitting(true);
    try {
      const created = await createTask({
        savedWorkspaceId: useLayoutStore.getState().activeSavedWorkspaceId ?? undefined,
        sourcePaneId: currentPaneId,
        targetPaneId: targetLeaf.id,
        sourcePaneName: drawerName,
        targetPaneName: targetName,
        title: title.trim(),
        request: request.trim(),
      });
      if (!created) return;
      setTitle("");
      setRequest("");
    } finally {
      setCreateSubmitting(false);
    }
  }

  /**
   * 执行冻结确认中的派发或转交。
   * @returns 注入流程完成时解决。
   */
  async function handleConfirmInjection(): Promise<void> {
    if (
      !confirmation
      || confirmationChanged
      || currentBlockReason
      || injectionSubmitting
    ) return;
    setInjectionSubmitting(true);
    try {
      const result = confirmation.kind === "dispatch"
        ? await dispatchTask(
          confirmation.taskId,
          confirmation.paneId,
          confirmation.sessionId,
        )
        : await forwardTask(
          confirmation.taskId,
          confirmation.paneId,
          confirmation.sessionId,
        );
      if (result) setConfirmation(null);
    } finally {
      setInjectionSubmitting(false);
    }
  }

  return (
    <aside className="task-drawer" aria-label="窗格任务">
      <header className="task-drawer-header">
        <div>
          <h2>窗格任务</h2>
          <span>{drawerName}</span>
        </div>
        <IconButton title="关闭任务抽屉" onClick={closeDrawer}>
          <X {...ICON_DEFAULTS} />
        </IconButton>
      </header>

      <section className="task-create-section">
        <h3>新任务</h3>
        <label className="dialog-label" htmlFor="task-target-pane">目标窗格</label>
        <select
          className="dialog-input"
          id="task-target-pane"
          value={selectedTargetPaneId}
          onChange={(event) => setTargetPaneId(event.target.value)}
        >
          {targetLeaves.length === 0 && <option value="">无可用窗格</option>}
          {targetLeaves.map((leaf) => (
            <option key={leaf.id} value={leaf.id}>
              {paneNames.get(leaf.id)}
            </option>
          ))}
        </select>
        <label className="dialog-label" htmlFor="task-title">任务标题</label>
        <input
          className="dialog-input"
          id="task-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="dialog-label" htmlFor="task-request">任务内容</label>
        <textarea
          className="dialog-textarea"
          id="task-request"
          value={request}
          onChange={(event) => setRequest(event.target.value)}
        />
        <button
          className="dialog-btn dialog-btn-primary"
          disabled={
            createSubmitting
            || !selectedTargetPaneId
            || !title.trim()
            || !request.trim()
          }
          type="button"
          onClick={() => void handleCreate()}
        >
          创建任务
        </button>
      </section>

      <section className="task-list-section">
        <h3>任务</h3>
        {loading && <div className="task-empty">正在加载</div>}
        {!loading && visibleTasks.length === 0 && (
          <div className="task-empty">暂无任务</div>
        )}
        {visibleTasks.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            drawerPaneId={drawerPaneId}
            leaves={leaves}
            sessions={sessions}
            reportDraft={reportDrafts[task.id] ?? ""}
            onReportDraftChange={(value) => setReportDrafts((current) => ({
              ...current,
              [task.id]: value,
            }))}
            onBeginConfirmation={setConfirmation}
            onReport={(taskId, outcome, report) => {
              void reportTask(taskId, outcome, report);
            }}
            onClose={(taskId) => {
              void closeTask(taskId);
            }}
            onCancel={(taskId) => {
              void cancelTask(taskId);
            }}
          />
        ))}
      </section>

      {confirmation && confirmationTask && (
        <section className="task-confirmation" aria-label="任务注入确认">
          <h3>{confirmation.kind === "dispatch" ? "确认接收任务" : "确认转交结果"}</h3>
          <dl>
            <dt>会话</dt>
            <dd>{confirmation.sessionId}</dd>
            <dt>类型</dt>
            <dd>{sessions[confirmation.sessionId]?.kind ?? "未知"}</dd>
            <dt>状态</dt>
            <dd>{sessions[confirmation.sessionId]?.state ?? "未知"}</dd>
          </dl>
          <pre>{taskPromptPreview(confirmation.kind, confirmationTask)}</pre>
          {confirmationChanged && (
            <p className="task-confirmation-warning">活动会话已变化，请重新确认</p>
          )}
          {!confirmationChanged && currentBlockReason && (
            <p className="task-confirmation-warning">{currentBlockReason}</p>
          )}
          <div className="task-confirmation-actions">
            {confirmationChanged && (
              <button
                className="dialog-btn dialog-btn-ghost"
                disabled={currentBlockReason !== null}
                type="button"
                onClick={() => {
                  if (!currentSessionId || currentBlockReason) return;
                  setConfirmation({ ...confirmation, sessionId: currentSessionId });
                }}
              >
                重新确认
              </button>
            )}
            <button
              className="dialog-btn dialog-btn-primary"
              disabled={
                confirmationChanged
                || currentBlockReason !== null
                || injectionSubmitting
              }
              type="button"
              onClick={() => void handleConfirmInjection()}
            >
              {confirmation.kind === "dispatch" ? "确认接收并注入" : "确认转交"}
            </button>
            <button
              className="dialog-btn dialog-btn-ghost"
              type="button"
              onClick={() => setConfirmation(null)}
            >
              返回
            </button>
          </div>
        </section>
      )}

      {error && <div className="task-error" role="alert">{error}</div>}
    </aside>
  );
}
