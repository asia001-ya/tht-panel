import { useState } from "react";
import type { ProviderProfile, WorkspaceAgent } from "../../api/types";
import { Pencil, Plus, Trash2 } from "../ui/icons";

interface ProviderManagerProps {
  providers: ProviderProfile[];
  onChange: (providers: ProviderProfile[]) => void;
}

function emptyProvider(): ProviderProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    driver: "claude",
  };
}

export function ProviderManager({
  providers,
  onChange,
}: ProviderManagerProps): React.JSX.Element {
  const [draft, setDraft] = useState<ProviderProfile | null>(null);

  const patchDraft = (patch: Partial<ProviderProfile>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const saveDraft = (): void => {
    if (!draft?.name.trim()) return;
    const normalized = {
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl?.trim() || undefined,
      apiKey: draft.apiKey?.trim() || undefined,
      model: draft.model?.trim() || undefined,
    };
    const exists = providers.some((provider) => provider.id === normalized.id);
    onChange(
      exists
        ? providers.map((provider) =>
            provider.id === normalized.id ? normalized : provider,
          )
        : [...providers, normalized],
    );
    setDraft(null);
  };

  return (
    <div className="provider-manager">
      <div className="provider-list">
        {providers.length === 0 && (
          <div className="provider-empty">尚未配置供应商</div>
        )}
        {providers.map((provider) => (
          <div className="provider-row" key={provider.id}>
            <span className="provider-driver">
              {provider.driver === "claude" ? "Claude" : "Codex"}
            </span>
            <span className="provider-name">{provider.name}</span>
            <span className="provider-model">
              {provider.model || provider.baseUrl || "默认模型"}
            </span>
            <button
              type="button"
              className="provider-icon-btn"
              aria-label={`编辑 ${provider.name}`}
              onClick={() => setDraft({ ...provider })}
            >
              <Pencil size={14} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className="provider-icon-btn provider-delete-btn"
              aria-label={`删除 ${provider.name}`}
              onClick={() =>
                onChange(providers.filter((item) => item.id !== provider.id))
              }
            >
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          </div>
        ))}
      </div>

      {!draft && (
        <button
          type="button"
          className="dialog-btn dialog-btn-ghost provider-add-btn"
          aria-label="添加供应商"
          onClick={() => setDraft(emptyProvider())}
        >
          <Plus size={14} strokeWidth={1.5} />
          添加供应商
        </button>
      )}

      {draft && (
        <div className="provider-editor">
          <div className="provider-editor-grid">
            <label className="dialog-label">
              供应商名称
              <input
                className="dialog-input"
                value={draft.name}
                autoFocus
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </label>
            <label className="dialog-label">
              驱动
              <select
                className="dialog-input"
                value={draft.driver}
                onChange={(event) =>
                  patchDraft({ driver: event.target.value as WorkspaceAgent })
                }
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="dialog-label provider-editor-wide">
              API 地址
              <input
                className="dialog-input"
                value={draft.baseUrl ?? ""}
                placeholder="空值使用官方地址"
                onChange={(event) => patchDraft({ baseUrl: event.target.value })}
              />
            </label>
            <label className="dialog-label provider-editor-wide">
              API Key
              <input
                className="dialog-input"
                type="password"
                value={draft.apiKey ?? ""}
                onChange={(event) => patchDraft({ apiKey: event.target.value })}
              />
            </label>
            <label className="dialog-label provider-editor-wide">
              模型
              <input
                className="dialog-input"
                value={draft.model ?? ""}
                placeholder="空值使用供应商默认模型"
                onChange={(event) => patchDraft({ model: event.target.value })}
              />
            </label>
          </div>
          <div className="provider-editor-actions">
            <button
              type="button"
              className="dialog-btn dialog-btn-ghost"
              onClick={() => setDraft(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="dialog-btn dialog-btn-primary"
              aria-label="保存供应商"
              disabled={!draft.name.trim()}
              onClick={saveDraft}
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
