/**
 * pendingSessions.ts —— "待命名"会话注册表。
 * spawn 后登记 ptySessionId→{workspaceId, kind, providerId}，
 * 等 TerminalPane 检测到用户首次按 Enter 时，以输入行作为名称创建 ManagedSession。
 */
export const pendingSessions = new Map<
  string,
  { workspaceId: string; kind: string; providerId?: string }
>();
