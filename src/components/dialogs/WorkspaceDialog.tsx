import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Workspace } from "../../api/types";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { ProviderSelect } from "../settings/ProviderSelect";
import { buildProjectRecord } from "../../lib/projects";

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function WorkspaceForm({ editing }: { editing?: Workspace }): React.JSX.Element {
  const closeWorkspaceDialog = useUiStore((state) => state.closeWorkspaceDialog);
  const openSettings = useUiStore((state) => state.openSettings);
  const providers = useSettingsStore((state) => state.config?.providers ?? []);
  const save = useWorkspaceStore((state) => state.save);
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  const [path, setPath] = useState(editing?.path ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [providerId, setProviderId] = useState(
    editing?.defaultProviderId ?? providers[0]?.id ?? "",
  );
  const [nameEdited, setNameEdited] = useState(false);
  const [keepAliveEnabled, setKeepAliveEnabled] = useState(
    editing?.keepAlive?.enabled ?? false,
  );
  const [keepAliveCommand, setKeepAliveCommand] = useState(
    editing?.keepAlive?.command ?? "",
  );
  const [keepAliveInterval, setKeepAliveInterval] = useState(
    editing?.keepAlive?.intervalMin ?? 5,
  );

  const pickDirectory = async (): Promise<void> => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setPath(picked);
    if (!nameEdited) setName(lastSegment(picked));
  };

  const saveProject = async (): Promise<void> => {
    if (!path.trim()) return;
    const project = buildProjectRecord({
      existing: editing,
      name: name.trim() || lastSegment(path),
      path: path.trim(),
      providerId: providerId || undefined,
      providers,
      sortOrder: workspaces.length,
      now: new Date().toISOString(),
      keepAlive: keepAliveEnabled
        ? {
            enabled: true,
            command: keepAliveCommand.trim(),
            intervalMin: keepAliveInterval,
          }
        : undefined,
    });
    await save(project);
    closeWorkspaceDialog();
  };

  const configureProviders = (): void => {
    closeWorkspaceDialog();
    openSettings();
  };

  return (
    <div className="dialog-overlay" onClick={closeWorkspaceDialog}>
      <div
        className="dialog dialog-workspace"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{editing ? "编辑项目" : "新建项目"}</h2>
        </div>

        <div className="dialog-body">
          <div className="dialog-field">
            <label className="dialog-label">项目目录</label>
            <div className="dialog-path-row">
              <input
                className="dialog-input"
                value={path}
                placeholder="选择代码所在目录"
                onChange={(event) => setPath(event.target.value)}
              />
              <button
                type="button"
                className="dialog-btn dialog-btn-ghost"
                onClick={() => void pickDirectory()}
              >
                选择
              </button>
            </div>
          </div>

          <div className="dialog-field">
            <label className="dialog-label">项目名称</label>
            <input
              className="dialog-input"
              value={name}
              placeholder="默认使用目录名"
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
          </div>

          <div className="dialog-field">
            <label className="dialog-label">默认供应商</label>
            <ProviderSelect
              providers={providers}
              value={providerId}
              inheritLabel="暂不指定"
              onChange={setProviderId}
            />
            {providers.length === 0 && (
              <button
                type="button"
                className="dialog-link-btn"
                onClick={configureProviders}
              >
                前往设置添加供应商
              </button>
            )}
          </div>

          <div className="dialog-field dialog-field-inline">
            <label className="dialog-label">
              <input
                type="checkbox"
                checked={keepAliveEnabled}
                onChange={(event) => setKeepAliveEnabled(event.target.checked)}
              />
              启用 Keep-Alive
            </label>
          </div>
          {keepAliveEnabled && (
            <div className="dialog-subform">
              <div className="dialog-field">
                <label className="dialog-label">发送指令</label>
                <input
                  className="dialog-input"
                  value={keepAliveCommand}
                  onChange={(event) => setKeepAliveCommand(event.target.value)}
                />
              </div>
              <div className="dialog-field">
                <label className="dialog-label">发送间隔</label>
                <select
                  className="dialog-input"
                  value={keepAliveInterval}
                  onChange={(event) =>
                    setKeepAliveInterval(Number(event.target.value))
                  }
                >
                  {[1, 2, 3, 5, 10, 15, 20, 30].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes} 分钟
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            className="dialog-btn dialog-btn-ghost"
            onClick={closeWorkspaceDialog}
          >
            取消
          </button>
          <button
            type="button"
            className="dialog-btn dialog-btn-primary"
            disabled={!path.trim()}
            onClick={() => void saveProject()}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WorkspaceDialog(): React.JSX.Element | null {
  const dialog = useUiStore((state) => state.workspaceDialog);
  if (!dialog.open) return null;
  return <WorkspaceForm editing={dialog.editing} />;
}
