import type {
  AgentKind,
  ProviderProfile,
  WorkspaceAgent,
} from "../api/types";

interface ProjectProviderSelection {
  defaultProviderId?: string;
}

interface NewTerminalProjectSelection extends ProjectProviderSelection {
  agent: WorkspaceAgent;
}

interface ConversationProviderSelection {
  providerId?: string;
}

interface TerminalConversationSelection extends ConversationProviderSelection {
  kind: AgentKind;
  aiSessionId?: string;
}

export interface TerminalResumeSelection {
  kind: AgentKind;
  providerId?: string;
  resumeSessionId?: string;
}

export interface NewTerminalSelection {
  kind: WorkspaceAgent;
  providerId?: string;
}

/**
 * 按 ID 查找唯一且驱动合法的供应商。
 * @param id 供应商 ID，未提供时不匹配任何供应商。
 * @param providers 可选供应商列表。
 * @returns ID 唯一且驱动为 Claude 或 Codex 时返回供应商，否则返回 null。
 */
function uniqueProviderById(
  id: string | undefined,
  providers: ProviderProfile[],
): ProviderProfile | null {
  if (!id) return null;
  const matches = providers.filter((provider) => provider.id === id);
  if (matches.length !== 1) return null;
  const provider = matches[0];
  return provider.driver === "claude" || provider.driver === "codex"
    ? provider
    : null;
}

/**
 * 解析项目配置的默认供应商。
 * @param project 含默认供应商 ID 的项目选择配置。
 * @param providers 可选供应商列表。
 * @returns 唯一且有效的默认供应商，否则返回 null。
 */
export function resolveProjectProvider(
  project: ProjectProviderSelection,
  providers: ProviderProfile[],
): ProviderProfile | null {
  return uniqueProviderById(project.defaultProviderId, providers);
}

/**
 * 解析会话供应商，无效覆盖会回退到项目默认供应商。
 * @param conversation 含可选供应商覆盖 ID 的会话配置。
 * @param project 含默认供应商 ID 的项目选择配置。
 * @param providers 可选供应商列表。
 * @returns 唯一且有效的会话供应商或项目默认供应商，否则返回 null。
 */
export function resolveConversationProvider(
  conversation: ConversationProviderSelection,
  project: ProjectProviderSelection,
  providers: ProviderProfile[],
): ProviderProfile | null {
  const override = uniqueProviderById(conversation.providerId, providers);
  return override ?? resolveProjectProvider(project, providers);
}

/**
 * 解析新终端的 AI 类型与供应商 ID。
 * @param project 含项目 AI 类型和默认供应商 ID 的项目选择配置。
 * @param providers 可选供应商列表。
 * @returns 有效供应商对应的启动选择；无有效供应商时使用项目 AI 类型。
 */
export function resolveNewTerminalSelection(
  project: NewTerminalProjectSelection,
  providers: ProviderProfile[],
): NewTerminalSelection {
  const provider = resolveProjectProvider(project, providers);
  return {
    kind: provider?.driver ?? project.agent,
    providerId: provider?.id,
  };
}

/**
 * 解析历史会话恢复时的 AI 类型、供应商和可复用会话 ID。
 * @param conversation 含原 AI 类型、供应商覆盖和会话 ID 的历史会话配置。
 * @param project 含默认供应商 ID 的项目选择配置。
 * @param providers 可选供应商列表。
 * @returns 终端恢复选择；跨驱动切换时不返回原会话 ID。
 */
export function resolveTerminalResumeSelection(
  conversation: TerminalConversationSelection,
  project: ProjectProviderSelection,
  providers: ProviderProfile[],
): TerminalResumeSelection {
  const provider = resolveConversationProvider(conversation, project, providers);
  const kind = provider?.driver ?? conversation.kind;
  return {
    kind,
    providerId: provider?.id,
    resumeSessionId:
      kind === conversation.kind ? conversation.aiSessionId : undefined,
  };
}
