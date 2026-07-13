import type {
  KeepAliveConfig,
  ProviderProfile,
  Workspace,
} from "../api/types";

interface ProjectRecordInput {
  existing?: Workspace;
  name: string;
  path: string;
  providerId?: string;
  providers: ProviderProfile[];
  keepAlive?: KeepAliveConfig;
  sortOrder: number;
  now: string;
}

export function buildProjectRecord({
  existing,
  name,
  path,
  providerId,
  providers,
  keepAlive,
  sortOrder,
  now,
}: ProjectRecordInput): Workspace {
  const provider = providers.find((item) => item.id === providerId);
  return {
    ...existing,
    id: existing?.id ?? crypto.randomUUID(),
    name,
    path,
    agent: provider?.driver ?? existing?.agent ?? "claude",
    useGlobalConfig: existing?.useGlobalConfig ?? true,
    config: existing?.config,
    sortOrder: existing?.sortOrder ?? sortOrder,
    createdAt: existing?.createdAt ?? now,
    defaultProviderId: providerId || undefined,
    keepAlive,
  };
}
