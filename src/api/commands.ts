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

/**
 * 附着到会话并接收输出。后端在 session 锁内先发 snapshot（环形缓冲回放）再发 data，
 * 同一 Channel 消息有序，故前端无需处理时序。返回 Channel 以便需要时手动释放。
 */
export function ptyAttach(sessionId: string, onMsg: (m: PtyOutputMsg) => void): Channel<PtyOutputMsg> {
  const channel = new Channel<PtyOutputMsg>();
  channel.onmessage = onMsg;
  void invoke<void>("pty_attach", { sessionId, channel });
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
