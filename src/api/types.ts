/**
 * 前端 ↔ Rust 后端的数据契约（DTO）。
 * 与 src-tauri/src/config/model.rs、pty 相关结构的 serde 定义严格一一对应，
 * Rust 侧统一 #[serde(rename_all = "camelCase")]，这里全部 camelCase。
 * 修改任一侧字段时，务必同步另一侧。
 */

/** AI 类型：工作空间级为 claude|codex；会话级额外允许 shell（纯 PowerShell） */
export type AgentKind = "claude" | "codex" | "shell";

/** 工作空间级 AI 类型（不含 shell） */
export type WorkspaceAgent = "claude" | "codex";

/** 可复用的命名供应商配置；同一 driver 可以保存多套配置。 */
export interface ProviderProfile extends AgentConfig {
  id: string;
  name: string;
  driver: WorkspaceAgent;
}

/**
 * 一套 AI 连接配置。
 * claude: baseUrl→ANTHROPIC_BASE_URL, apiKey→ANTHROPIC_AUTH_TOKEN, model→--model
 * codex:  baseUrl→config.toml 的 model_providers.base_url, apiKey→OPENAI_API_KEY, model→--model
 */
export interface AgentConfig {
  baseUrl?: string; // API 端点，空=官方默认
  apiKey?: string; // 密钥（v1 明文存储，已确认可接受）
  model?: string; // 模型名
  extraArgs?: string[]; // 附加命令行参数，逐项追加
}

/** Keep-alive 配置 */
export interface KeepAliveConfig {
  enabled: boolean;
  command: string;
  intervalMin: number;
}

/** 工作空间：名称 + 项目目录 + AI 类型 + 配置模式 */
export interface Workspace {
  id: string; // uuid
  name: string; // 显示名（默认=目录名）
  path: string; // 项目绝对路径，如 D:\AI\register
  agent: WorkspaceAgent;
  useGlobalConfig: boolean; // true=统一配置（用 GlobalConfig 对应默认）；false=用下面的 config
  config?: AgentConfig; // 独立配置（useGlobalConfig=false 时生效）
  sortOrder: number; // 侧边栏顺序，Ctrl+1..9 依此序
  createdAt: string;
  keepAlive?: KeepAliveConfig;
  defaultProviderId?: string;
}

/** 全局配置 */
export interface GlobalConfig {
  theme: "light" | "dark";
  shellPath: string; // 默认 "powershell.exe"，可改 pwsh.exe
  fontSize: number; // 终端字号，默认 14
  scrollbackBytes: number; // 每会话环形缓冲上限（后端），默认 5*1024*1024
  scrollbackLines: number; // xterm 前端 scrollback 行数，默认 10000
  notifyOnWaiting: boolean; // 等待输入时系统通知，默认 true
  claudeDefaults: AgentConfig; // 「统一配置」时 claude 用这套
  codexDefaults: AgentConfig; // 「统一配置」时 codex 用这套
  providers: ProviderProfile[];
}

/** 分屏布局二叉树节点 */
export type PaneNode = SplitNode | LeafNode;

/** 保存工作区中的稳定会话引用，用于重建易失的运行时 Tab。 */
export interface SavedSessionRef {
  managedSessionId?: string;
  workspaceId: string;
  kind: AgentKind;
  providerId?: string;
  mode: "terminal" | "native";
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical"; // horizontal=左右并排，vertical=上下
  ratio: number; // 第一个子节点占比 0~1
  children: [PaneNode, PaneNode];
}

export interface LeafNode {
  type: "leaf";
  id: string;
  name?: string;                    // 属于布局槽位的显式名称
  sessionIds: string[];            // Tab 顺序（先开在前）
  activeSessionId: string | null;  // 当前激活 Tab；null=空占位
  locked: boolean;                 // 锁定：不接受新 Tab
}

/** 持久化到 layout.json 的 leaf（sessionId 易失，只存骨架） */
export interface PersistedLeaf {
  type: "leaf";
  id: string;
  name?: string;
  locked: boolean;
  workspaceId?: string; // 上次绑定的工作空间，重启后点击占位页按此启动
}
export interface PersistedSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  children: [PersistedNode, PersistedNode];
}
export type PersistedNode = PersistedSplit | PersistedLeaf;

export interface SavedWorkspaceLayout {
  id: string;
  name: string;
  tree: PaneNode;
  activePaneId: string | null;
  createdAt: string;
  sessionRefs?: Record<string, SavedSessionRef>;
}

export interface PersistedLayout {
  version: number;
  tree: PersistedNode | null;
  activePaneId: string | null;
  activeSavedWorkspaceId?: string;
  savedWorkspaces?: SavedWorkspaceLayout[];
  window?: { width: number; height: number; maximized: boolean };
}

/** 会话运行状态 */
export type SessionState = "running" | "waiting" | "idle" | "dead";

/** 运行时 PTY 会话信息（Rust 为真相，前端镜像） */
export interface PtySessionInfo {
  sessionId: string; // 本应用生成的 PTY 会话 uuid（≠ claude/codex 的会话 uuid）
  workspaceId: string | null; // 所属工作空间；纯 shell 也可挂在工作空间下
  kind: AgentKind;
  cwd: string;
  title: string; // 显示名："claude"/"codex"/"PowerShell"/"续: <历史标题>"
  resumedFrom?: string; // 若恢复历史会话，记录原 AI sessionId
  state: SessionState;
  createdAt: string;
}

/** 历史会话条目（claude 与 codex 统一） */
export interface SessionHistoryEntry {
  sessionId: string; // AI 侧会话 uuid（resume 用）
  source: "claude" | "codex";
  title: string; // claude: firstPrompt；codex: 首条用户输入或时间戳
  summary?: string; // claude sessions-index 的 summary
  messageCount?: number;
  modifiedAt: string; // 排序键，倒序
  gitBranch?: string;
}

/** 启动请求 */
export interface SpawnRequest {
  workspaceId?: string; // 有则从工作空间取 cwd 和配置
  kind: AgentKind; // claude/codex/shell
  providerId?: string;
  resumeSessionId?: string; // 恢复历史会话时传 AI sessionId
  cols: number;
  rows: number; // 目标 leaf 当前尺寸，避免启动后立刻 resize 重绘
}

/** Channel 推送的输出消息（tagged enum，Rust 侧 #[serde(tag="kind")]） */
export type PtyOutputMsg =
  | { kind: "snapshot"; data: string } // attach 后第一条：环形缓冲回放
  | { kind: "data"; data: string } // 实时输出（~16ms 聚合）
  | { kind: "exit"; code: number | null };

/** 全局事件载荷 */
export interface SessionStatePayload {
  sessionId: string;
  workspaceId: string | null;
  state: SessionState;
}
export interface SessionExitPayload {
  sessionId: string;
  exitCode: number | null;
}

/** 事件名常量 */
export const EVT_SESSION_STATE = "session://state";
export const EVT_SESSION_EXIT = "session://exit";
export const EVT_QUIT_REQUEST = "app://quit-request";

/** tht-panel 自管的会话记录（侧边栏列表数据源）。不依赖 claude/codex 写文件，由应用自身管理。 */
export interface ManagedSession {
  id: string; // 自管会话 uuid
  workspaceId: string; // 所属工作空间
  name: string; // 显示名称（可编辑）
  kind: AgentKind; // 会话类型
  ptySessionId?: string; // 关联的运行时 PTY session_id（活跃时有值）
  aiSessionId?: string; // 关联的 AI 侧 session_id（可用于 resume）
  createdAt: string;
  updatedAt: string;
  providerId?: string;
  mode?: "native" | "terminal";
  messages?: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface NativePromptRequest {
  workspaceId: string;
  providerId: string;
  prompt: string;
}
