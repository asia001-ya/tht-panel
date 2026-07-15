/**
 * 当前布局的窗格协作任务抽屉。
 */
import { useEffect, useRef, useState } from "react";
import type {
  LeafNode,
  ManagedSession,
  PaneTask,
  PtySessionInfo,
  TaskOutcome,
  Workspace,
} from "../../api/types";
import { parseNativeConversationTabId } from "../../lib/nativeConversation";
import { workspaceIdForTab } from "../../lib/workItems";
import { preorderLeaves, useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { tasksForSavedWorkspace, useTaskStore } from "../../store/taskStore";
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
 * 解析窗格展示名称；显式名称优先，其次使用活动 Tab 所属项目名。
 * @param leaf 窗格叶子。
 * @param sessions PTY 会话镜像。
 * @param workspaces 项目列表。
 * @param historyCache Native 会话历史缓存。
 * @returns 可用于任务路由的名称；未命名时返回 null。
 */
function paneDisplayName(
  leaf: LeafNode,
  sessions: Record<string, PtySessionInfo>,
  workspaces: Workspace[],
  historyCache: Record<string, ManagedSession[]>,
): string | null {
  const explicitName = leaf.name?.trim();
  if (explicitName) return explicitName;
  const workspaceId = leaf.activeSessionId
    ? workspaceIdForTab(leaf.activeSessionId, sessions, historyCache)
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
 * 判断当前确认是否仍是某次注入请求发起时的确认。
 * @param current 当前确认；抽屉关闭时为 null。
 * @param submitted 注入请求发起时冻结的确认。
 * @returns kind、任务、Pane 与会话均一致时返回 true。
 */
function isSameInjectionConfirmation(
  current: InjectionConfirmation | null,
  submitted: InjectionConfirmation,
): boolean {
  return current?.kind === submitted.kind
    && current.taskId === submitted.taskId
    && current.paneId === submitted.paneId
    && current.sessionId === submitted.sessionId;
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
  submitting,
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
  submitting: boolean;
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
            disabled={submitting || receiveReason !== null}
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
            disabled={submitting}
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
              disabled={submitting}
              value={reportDraft}
              onChange={(event) => onReportDraftChange(event.target.value)}
            />
            <button
              className="dialog-btn dialog-btn-primary"
              disabled={submitting || !reportDraft.trim()}
              type="button"
              onClick={() => onReport(task.id, "completed", reportDraft)}
            >
              完成并上报
            </button>
            <button
              className="dialog-btn dialog-btn-ghost"
              disabled={submitting || !reportDraft.trim()}
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
            disabled={submitting || forwardReason !== null}
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
            disabled={submitting}
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
  const activeSavedWorkspaceId = useLayoutStore(
    (state) => state.activeSavedWorkspaceId,
  );
  const sessions = useSessionStore((state) => state.sessions);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const historyCache = useWorkspaceStore((state) => state.historyCache);
  const [targetPaneId, setTargetPaneId] = useState("");
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [reportDrafts, setReportDrafts] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<InjectionConfirmation | null>(null);
  const [confirmationInvalidated, setConfirmationInvalidated] = useState(false);
  const createSubmittingRef = useRef(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const pendingTaskIdsRef = useRef(new Set<string>());
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const leaves = preorderLeaves(tree);
  const drawerLeaf = leaves.find((leaf) => leaf.id === drawerPaneId);
  const paneNames = new Map(
    leaves.map((leaf) => [
      leaf.id,
      paneDisplayName(leaf, sessions, workspaces, historyCache),
    ]),
  );
  const targetLeaves = leaves.filter(
    (leaf) => leaf.id !== drawerPaneId && paneNames.get(leaf.id),
  );
  const selectedTargetPaneId = targetLeaves.some((leaf) => leaf.id === targetPaneId)
    ? targetPaneId
    : (targetLeaves[0]?.id ?? "");
  const scopedTasks = tasksForSavedWorkspace(tasks, activeSavedWorkspaceId);

  useEffect(() => {
    setConfirmation(null);
    setConfirmationInvalidated(false);
  }, [drawerPaneId]);

  useEffect(() => {
    if (!confirmation) return;
    const leaf = leaves.find((item) => item.id === confirmation.paneId);
    if ((leaf?.activeSessionId ?? null) !== confirmation.sessionId) {
      setConfirmationInvalidated(true);
    }
  }, [confirmation, tree]);

  if (!drawerPaneId || !drawerLeaf) return null;

  const currentPaneId = drawerLeaf.id;
  const drawerName = paneNames.get(drawerPaneId) ?? "未命名";
  const visibleTasks = scopedTasks.filter(
    (task) => task.sourcePaneId === drawerPaneId || task.targetPaneId === drawerPaneId,
  );
  const confirmationTask = confirmation
    ? scopedTasks.find((task) => task.id === confirmation.taskId)
    : undefined;
  const confirmationLeaf = confirmation
    ? leaves.find((leaf) => leaf.id === confirmation.paneId)
    : undefined;
  const currentSessionId = confirmationLeaf?.activeSessionId ?? null;
  const confirmationChanged = confirmation !== null
    && (
      confirmationInvalidated
      || currentSessionId !== confirmation.sessionId
    );
  const currentBlockReason = injectionBlockReason(currentSessionId, sessions);

  /**
   * 更新指定任务的提交锁，并同步即时互斥 ref 与渲染状态。
   * @param taskId 任务标识。
   * @param submitting 是否正在提交。
   * @returns 无返回值。
   */
  function setTaskSubmitting(taskId: string, submitting: boolean): void {
    const next = new Set(pendingTaskIdsRef.current);
    if (submitting) next.add(taskId);
    else next.delete(taskId);
    pendingTaskIdsRef.current = next;
    setPendingTaskIds(next);
  }

  /**
   * 在任务级互斥锁内执行一次后端状态动作。
   * @param taskId 任务标识。
   * @param command 返回后端任务的异步动作。
   * @returns 后端任务；重复触发或失败时返回 null。
   */
  async function runTaskAction(
    taskId: string,
    command: () => Promise<PaneTask | null>,
  ): Promise<PaneTask | null> {
    if (pendingTaskIdsRef.current.has(taskId)) return null;
    setTaskSubmitting(taskId, true);
    try {
      return await command();
    } finally {
      setTaskSubmitting(taskId, false);
    }
  }

  /**
   * 创建新任务并在成功后清空表单。
   * @returns 创建流程完成时解决。
   */
  async function handleCreate(): Promise<void> {
    if (createSubmittingRef.current || loading) return;
    const targetLeaf = targetLeaves.find((leaf) => leaf.id === selectedTargetPaneId);
    const targetName = targetLeaf ? paneNames.get(targetLeaf.id) : null;
    if (!targetLeaf || !targetName || !title.trim() || !request.trim()) return;
    createSubmittingRef.current = true;
    setCreateSubmitting(true);
    try {
      const created = await createTask({
        savedWorkspaceId: activeSavedWorkspaceId ?? undefined,
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
      createSubmittingRef.current = false;
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
      || pendingTaskIdsRef.current.has(confirmation.taskId)
    ) return;
    const submittedConfirmation = confirmation;
    const result = await runTaskAction(
      submittedConfirmation.taskId,
      () => submittedConfirmation.kind === "dispatch"
        ? dispatchTask(
          submittedConfirmation.taskId,
          submittedConfirmation.paneId,
          submittedConfirmation.sessionId,
        )
        : forwardTask(
          submittedConfirmation.taskId,
          submittedConfirmation.paneId,
          submittedConfirmation.sessionId,
        ),
    );
    if (result) {
      setConfirmation((current) => (
        isSameInjectionConfirmation(current, submittedConfirmation)
          ? null
          : current
      ));
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
          disabled={loading}
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
          disabled={loading}
          id="task-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="dialog-label" htmlFor="task-request">任务内容</label>
        <textarea
          className="dialog-textarea"
          disabled={loading}
          id="task-request"
          value={request}
          onChange={(event) => setRequest(event.target.value)}
        />
        <button
          className="dialog-btn dialog-btn-primary"
          disabled={
            createSubmitting
            || loading
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
        {!loading && visibleTasks.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            drawerPaneId={drawerPaneId}
            leaves={leaves}
            sessions={sessions}
            submitting={pendingTaskIds.has(task.id)}
            reportDraft={reportDrafts[task.id] ?? ""}
            onReportDraftChange={(value) => setReportDrafts((current) => ({
              ...current,
              [task.id]: value,
            }))}
            onBeginConfirmation={(nextConfirmation) => {
              setConfirmationInvalidated(false);
              setConfirmation(nextConfirmation);
            }}
            onReport={(taskId, outcome, report) => {
              void runTaskAction(
                taskId,
                () => reportTask(taskId, outcome, report),
              );
            }}
            onClose={(taskId) => {
              void runTaskAction(taskId, () => closeTask(taskId));
            }}
            onCancel={(taskId) => {
              void runTaskAction(taskId, () => cancelTask(taskId));
            }}
          />
        ))}
      </section>

      {!loading && confirmation && confirmationTask && (
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
                  setConfirmationInvalidated(false);
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
                || pendingTaskIds.has(confirmation.taskId)
              }
              type="button"
              onClick={() => void handleConfirmInjection()}
            >
              {confirmation.kind === "dispatch" ? "确认接收并注入" : "确认转交"}
            </button>
            <button
              className="dialog-btn dialog-btn-ghost"
              type="button"
              onClick={() => {
                setConfirmationInvalidated(false);
                setConfirmation(null);
              }}
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
