import { useState } from "react";
import type { ProviderProfile, WorkspaceAgent } from "../../api/types";
import { Pencil, Plus, Trash2 } from "../ui/icons";

interface ProviderManagerProps {
  providers: ProviderProfile[];
  onChange: (providers: ProviderProfile[]) => void;
}

/**
 * 创建一条可编辑的新供应商草稿。
 * @returns 带唯一 ID 和默认 Claude 驱动的空供应商。
 */
function emptyProvider(): ProviderProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    driver: "claude",
  };
}

/**
 * 渲染供应商列表及新增、编辑表单。
 * @param props 当前供应商列表和变更回调。
 * @returns 供应商管理界面。
 */
export function ProviderManager({
  providers,
  onChange,
}: ProviderManagerProps): React.JSX.Element {
  const [draft, setDraft] = useState<ProviderProfile | null>(null);

  /**
   * 合并供应商草稿的局部字段。
   * @param patch 要覆盖到当前草稿的字段。
   * @returns 无返回值。
   */
  const patchDraft = (patch: Partial<ProviderProfile>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  /**
   * 校验、规范化并保存当前供应商草稿。
   * @returns 无返回值。
   */
  const saveDraft = (): void => {
    if (!draft?.name.trim()) return;
    const { extraArgs: rawExtraArgs, ...draftWithoutArgs } = draft;
    const extraArgs = (rawExtraArgs ?? [])
      .map((argument) => argument.trim())
      .filter(Boolean);
    const normalized: ProviderProfile = {
      ...draftWithoutArgs,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl?.trim() || undefined,
      apiKey: draft.apiKey?.trim() || undefined,
      model: draft.model?.trim() || undefined,
    };
    if (extraArgs.length > 0) normalized.extraArgs = extraArgs;
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
          <div className="provider-empty">
            未添加供应商，将使用系统 Claude/Codex 配置
          </div>
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
            <label className="dialog-label provider-editor-wide">
              附加参数（每行一个）
              <textarea
                className="dialog-textarea"
                value={(draft.extraArgs ?? []).join("\n")}
                placeholder="例如：--verbose"
                onChange={(event) =>
                  patchDraft({ extraArgs: event.target.value.split("\n") })
                }
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
