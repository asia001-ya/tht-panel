import type { AgentKind, ProviderProfile } from "../api/types";

interface ProjectProviderSelection {
  defaultProviderId?: string;
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

export function resolveProjectProvider(
  project: ProjectProviderSelection,
  providers: ProviderProfile[],
): ProviderProfile | null {
  if (!project.defaultProviderId) return null;
  return providers.find((provider) => provider.id === project.defaultProviderId) ?? null;
}

export function resolveConversationProvider(
  conversation: ConversationProviderSelection,
  project: ProjectProviderSelection,
  providers: ProviderProfile[],
): ProviderProfile | null {
  const override = conversation.providerId
    ? providers.find((provider) => provider.id === conversation.providerId)
    : undefined;
  return override ?? resolveProjectProvider(project, providers);
}

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
