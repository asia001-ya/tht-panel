/**
 * 全部 Tauri command 的类型安全封装。
 * 约定：JS 侧传 camelCase 键，Rust 侧 snake_case 参数，Tauri 默认自动映射
 *（如 { sessionId } → fn(session_id)），故命令函数无需在 Rust 加 rename_all。
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  GlobalConfig,
  ManagedSession,
  Workspace,
  PtySessionInfo,
  SpawnRequest,
  SessionHistoryEntry,
  PersistedLayout,
  PtyOutputMsg,
  NativePromptRequest,
  PaneTask,
  CreatePaneTaskRequest,
  TaskOutcome,
  UsageQueryResult,
} from "./types";

// ---- PTY 会话 ----
export const ptySpawn = (req: SpawnRequest) => invoke<PtySessionInfo>("pty_spawn", { req });
export const ptyWrite = (sessionId: string, data: string) =>
  invoke<void>("pty_write", { sessionId, data });
export const ptyResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { sessionId, cols, rows });
export const ptyKill = (sessionId: string) => invoke<void>("pty_kill", { sessionId });
export const ptyList = () => invoke<PtySessionInfo[]>("pty_list");
export const ptyDetach = (sessionId: string) => invoke<void>("pty_detach", { sessionId });

// ---- 剪贴板 ----
export const clipboardSaveImage = (dataUrl: string, fileName?: string) =>
  invoke<string>("clipboard_save_image", { dataUrl, fileName });

/**
 * 附着到会话并接收输出。后端在 session 锁内先发 snapshot（环形缓冲回放）再发 data，
 * 同一 Channel 消息有序，故前端无需处理时序。返回 Channel 以便需要时手动释放。
 */
export function ptyAttach(
  sessionId: string,
  onMsg: (m: PtyOutputMsg) => void,
  onError?: (error: unknown) => void,
): Channel<PtyOutputMsg> {
  const channel = new Channel<PtyOutputMsg>();
  channel.onmessage = onMsg;
  void invoke<void>("pty_attach", { sessionId, channel }).catch((error: unknown) => {
    onError?.(error);
  });
  return channel;
}

// ---- 全局配置 / 工作空间 / 布局 ----
export const configGet = () => invoke<GlobalConfig>("config_get");
export const configSet = (cfg: GlobalConfig) => invoke<void>("config_set", { cfg });
export const workspaceList = () => invoke<Workspace[]>("workspace_list");
export const workspaceSave = (ws: Workspace) => invoke<void>("workspace_save", { ws });
export const workspaceDelete = (id: string) => invoke<void>("workspace_delete", { id });
export const layoutGet = () => invoke<PersistedLayout>("layout_get");
export const layoutSave = (layout: PersistedLayout) => invoke<void>("layout_save", { layout });

// ---- 历史会话 ----
export const historyList = (workspaceId: string) =>
  invoke<SessionHistoryEntry[]>("history_list", { workspaceId });

// ---- 退出 ----
export const appQuit = (force: boolean) => invoke<void>("app_quit", { force });

// ---- 自管会话（侧边栏列表数据源）----
export const managedSessionList = (workspaceId: string) =>
  invoke<ManagedSession[]>("managed_session_list", { workspaceId });
export const managedSessionCreate = (session: ManagedSession) =>
  invoke<void>("managed_session_create", { session });
export const managedSessionUpdate = (session: ManagedSession) =>
  invoke<void>("managed_session_update", { session });
export const managedSessionDelete = (id: string) =>
  invoke<void>("managed_session_delete", { id });
export const aiSessionDetect = (args: {
  workspaceId: string; kind: string; spawnedAt: string; exclude: string[];
}) => invoke<string | null>("ai_session_detect", args);

// ---- 原生 AI 会话（不经过 PowerShell）----
export const aiPrompt = (req: NativePromptRequest) =>
  invoke<string>("ai_prompt", { req });

// ---- Token 用量统计 ----

/**
 * 查询用量统计（只读后端缓存，不触发磁盘扫描）。
 * @param workspaceId 限定工作空间；省略表示统计全部项目。
 * @param rangeDays 统计最近天数；省略用后端默认 30 天。
 * @returns 按日期升序的序列与各维度汇总。
 */
export const usageQuery = (workspaceId?: string, rangeDays?: number) =>
  invoke<UsageQueryResult>("usage_query", { workspaceId, rangeDays });

/**
 * 重新扫描会话文件后返回最新统计。耗时随会话文件总量增长。
 * @param workspaceId 限定工作空间；省略表示统计全部项目。
 * @param rangeDays 统计最近天数；省略用后端默认 30 天。
 * @returns 扫描后的最新统计。
 */
export const usageRefresh = (workspaceId?: string, rangeDays?: number) =>
  invoke<UsageQueryResult>("usage_refresh", { workspaceId, rangeDays });

// ---- 窗格协作任务 ----

/**
 * 列出指定保存工作区或当前未保存布局的任务。
 * @param savedWorkspaceId 保存工作区标识；省略表示当前未保存布局。
 * @returns 后端任务列表。
 */
export function taskList(savedWorkspaceId?: string): Promise<PaneTask[]> {
  return invoke<PaneTask[]>("task_list", { savedWorkspaceId });
}

/**
 * 创建 queued 协作任务。
 * @param req 受控任务创建输入。
 * @returns 后端创建的任务。
 */
export function taskCreate(req: CreatePaneTaskRequest): Promise<PaneTask> {
  return invoke<PaneTask>("task_create", { req });
}

/**
 * 把任务注入目标活动会话。
 * @param taskId 任务标识。
 * @param targetPaneId 目标窗格标识。
 * @param sessionId 目标 PTY 会话标识。
 * @returns dispatched 任务。
 */
export function taskDispatch(
  taskId: string,
  targetPaneId: string,
  sessionId: string,
): Promise<PaneTask> {
  return invoke<PaneTask>("task_dispatch", { taskId, targetPaneId, sessionId });
}

/**
 * 上报已派发任务的结果。
 * @param taskId 任务标识。
 * @param outcome 完成或受阻结果。
 * @param report 上报正文。
 * @returns reported 任务。
 */
export function taskReport(
  taskId: string,
  outcome: TaskOutcome,
  report: string,
): Promise<PaneTask> {
  return invoke<PaneTask>("task_report", { taskId, outcome, report });
}

/**
 * 把上报结果注入来源活动会话。
 * @param taskId 任务标识。
 * @param sourcePaneId 来源窗格标识。
 * @param sessionId 来源 PTY 会话标识。
 * @returns forwarded 任务。
 */
export function taskForward(
  taskId: string,
  sourcePaneId: string,
  sessionId: string,
): Promise<PaneTask> {
  return invoke<PaneTask>("task_forward", { taskId, sourcePaneId, sessionId });
}

/**
 * 关闭已转交任务。
 * @param taskId 任务标识。
 * @returns closed 任务。
 */
export function taskClose(taskId: string): Promise<PaneTask> {
  return invoke<PaneTask>("task_close", { taskId });
}

/**
 * 取消尚未派发的任务。
 * @param taskId 任务标识。
 * @returns cancelled 任务。
 */
export function taskCancel(taskId: string): Promise<PaneTask> {
  return invoke<PaneTask>("task_cancel", { taskId });
}
