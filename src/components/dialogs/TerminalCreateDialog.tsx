import { useEffect, useMemo, useState } from "react";
import type {
  ProviderProfile,
  TerminalExecutionMode,
  Workspace,
  WorkspaceAgent,
} from "../../api/types";

export interface TerminalCreateOptions {
  workspaceId: string;
  kind: WorkspaceAgent;
  providerId?: string;
  executionMode: TerminalExecutionMode;
}

export interface TerminalCreateDialogProps {
  open: boolean;
  workspaces: Workspace[];
  providers: ProviderProfile[];
  initialWorkspaceId?: string;
  error?: string | null;
  creating?: boolean;
  onClose: () => void;
  onCreate: (options: TerminalCreateOptions) => void | Promise<void>;
}

/**
 * 新建 AI 终端配置框。
 * 该组件只负责收集启动选项，PTY 生命周期由 App 的 spawn 编排负责。
 */
export function TerminalCreateDialog({
  open,
  workspaces,
  providers,
  initialWorkspaceId,
  error,
  creating = false,
  onClose,
  onCreate,
}: TerminalCreateDialogProps): React.JSX.Element | null {
  const firstWorkspaceId = initialWorkspaceId && workspaces.some((item) => item.id === initialWorkspaceId)
    ? initialWorkspaceId
    : workspaces[0]?.id ?? "";
  const [workspaceId, setWorkspaceId] = useState(firstWorkspaceId);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const [kind, setKind] = useState<WorkspaceAgent>(workspace?.agent ?? "claude");
  const providerOptions = useMemo(
    () => providers.filter((provider) => provider.driver === kind),
    [providers, kind],
  );
  const [providerId, setProviderId] = useState("");
  const [executionMode, setExecutionMode] = useState<TerminalExecutionMode>("default");

  useEffect(() => {
    if (!open) return;
    const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
    const defaultProvider = selectedWorkspace?.defaultProviderId
      ? providers.find((provider) => provider.id === selectedWorkspace.defaultProviderId
        && provider.driver === kind)
      : undefined;
    const firstProvider = providers.find((provider) => provider.driver === kind);
    setProviderId(defaultProvider?.id ?? firstProvider?.id ?? "");
  }, [open, workspaceId, kind, providers, workspaces]);

  useEffect(() => {
    if (!open) return;
    const nextWorkspaceId = initialWorkspaceId && workspaces.some((item) => item.id === initialWorkspaceId)
      ? initialWorkspaceId
      : workspaces[0]?.id ?? "";
    setWorkspaceId(nextWorkspaceId);
    const nextWorkspace = workspaces.find((item) => item.id === nextWorkspaceId);
    setKind(nextWorkspace?.agent ?? "claude");
    setExecutionMode("default");
  }, [open, initialWorkspaceId, workspaces]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (!workspaceId) return;
    await onCreate({
      workspaceId,
      kind,
      providerId: providerId || undefined,
      executionMode,
    });
  };

  const selectWorkspace = (nextWorkspaceId: string): void => {
    setWorkspaceId(nextWorkspaceId);
    const nextWorkspace = workspaces.find((item) => item.id === nextWorkspaceId);
    if (nextWorkspace) setKind(nextWorkspace.agent);
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog dialog-terminal-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-create-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="terminal-create-title">创建终端</h2>
        </div>
        <div className="dialog-body">
          <div className="dialog-field">
            <label className="dialog-label" htmlFor="terminal-create-workspace">工作区</label>
            <select
              id="terminal-create-workspace"
              className="dialog-input"
              value={workspaceId}
              disabled={workspaces.length === 0}
              onChange={(event) => selectWorkspace(event.target.value)}
            >
              {workspaces.length === 0 && <option value="">暂无工作区</option>}
              {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>

          <div className="dialog-field">
            <span className="dialog-label">AI 类型</span>
            <div className="dialog-radio-group terminal-create-options">
              {(["claude", "codex"] as const).map((value) => (
                <label className="dialog-radio" key={value}>
                  <input
                    type="radio"
                    name="terminal-create-kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                  />
                  {value === "claude" ? "Claude" : "Codex"}
                </label>
              ))}
            </div>
          </div>

          <div className="dialog-field">
            <label className="dialog-label" htmlFor="terminal-create-provider">渠道商</label>
            <select
              id="terminal-create-provider"
              className="dialog-input"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
            >
              <option value="">系统默认</option>
              {providerOptions.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
            {providerOptions.length === 0 && (
              <div className="dialog-hint">未配置该 AI 的渠道商，将使用本机默认配置。</div>
            )}
          </div>

          <div className="dialog-field">
            <span className="dialog-label">运行模式</span>
            <div className="dialog-radio-group terminal-create-options">
              <label className="dialog-radio">
                <input
                  type="radio"
                  name="terminal-create-mode"
                  checked={executionMode === "default"}
                  onChange={() => setExecutionMode("default")}
                />
                默认模式
              </label>
              <label className="dialog-radio">
                <input
                  type="radio"
                  name="terminal-create-mode"
                  checked={executionMode === "yolo"}
                  onChange={() => setExecutionMode("yolo")}
                />
                YOLO 模式
              </label>
            </div>
            {executionMode === "yolo" && (
              <div className="dialog-hint dialog-hint-warning">YOLO 模式会跳过 AI 的权限确认与沙箱限制。</div>
            )}
          </div>
          {error && <div className="dialog-error" role="alert">{error}</div>}
        </div>
        <div className="dialog-footer">
          <button type="button" className="dialog-btn dialog-btn-ghost" disabled={creating} onClick={onClose}>取消</button>
          <button
            type="button"
            className="dialog-btn dialog-btn-primary"
            disabled={!workspaceId || creating}
            onClick={() => void submit()}
          >
            {creating ? "创建中..." : "创建会话"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TerminalCreateDialog;
