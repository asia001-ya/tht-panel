/**
 * 工作空间新建/编辑对话框。
 * 受 uiStore.workspaceDialog 控制：open=false 不渲染；open=true 渲染模态。
 * 表单字段：目录选择（plugin-dialog open 选目录）、name、agent(claude/codex)、
 * useGlobalConfig(统一/独立)，独立时展开 AgentConfig 子表单(baseUrl/apiKey/model/extraArgs)。
 * 保存：新建生成 uuid/sortOrder/createdAt；编辑保留 id/sortOrder/createdAt。
 * 内层表单以独立组件承载，借 open 时挂载/关闭时卸载让 useState 初始值每次打开重新播种。
 */
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AgentConfig, Workspace, WorkspaceAgent } from "../../api/types";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

/**
 * 从目录绝对路径取最后一段作为默认工作空间名。
 * @param path 绝对路径（兼容 \ 与 / 分隔符）
 * @returns 末段目录名，取不到则返回原路径
 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * 把 extraArgs 多行文本按行拆成字符串数组（去空白、丢空行）。
 * @param text textarea 原始文本
 * @returns 逐项参数数组
 */
function parseExtraArgs(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 由子表单字段构造 AgentConfig，仅收录非空字段（空=官方默认，不落键）。
 * @param baseUrl API 端点
 * @param apiKey 密钥
 * @param model 模型名
 * @param extraArgsText extraArgs 多行文本
 * @returns 精简后的 AgentConfig
 */
function buildConfig(
  baseUrl: string,
  apiKey: string,
  model: string,
  extraArgsText: string
): AgentConfig {
  const cfg: AgentConfig = {};
  if (baseUrl.trim()) cfg.baseUrl = baseUrl.trim();
  if (apiKey.trim()) cfg.apiKey = apiKey.trim();
  if (model.trim()) cfg.model = model.trim();
  const args = parseExtraArgs(extraArgsText);
  if (args.length > 0) cfg.extraArgs = args;
  return cfg;
}

/** 内层表单：每次对话框打开时全新挂载，useState 初始值据 editing 播种一次 */
function WorkspaceForm({ editing }: { editing?: Workspace }) {
  const closeWorkspaceDialog = useUiStore((s) => s.closeWorkspaceDialog);
  const save = useWorkspaceStore((s) => s.save);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  // 基础字段（编辑时以现有值播种，新建为空/默认）
  const [path, setPath] = useState(editing?.path ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [agent, setAgent] = useState<WorkspaceAgent>(editing?.agent ?? "claude");
  const [useGlobalConfig, setUseGlobalConfig] = useState(editing?.useGlobalConfig ?? true);
  // 用户是否手动改过名字：改过则选目录时不再覆盖
  const [nameEdited, setNameEdited] = useState(false);

  // 独立配置子表单字段（编辑时从 editing.config 播种）
  const initCfg = editing?.config;
  const [baseUrl, setBaseUrl] = useState(initCfg?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initCfg?.apiKey ?? "");
  const [model, setModel] = useState(initCfg?.model ?? "");
  const [extraArgsText, setExtraArgsText] = useState((initCfg?.extraArgs ?? []).join("\n"));

  const isEdit = editing !== undefined;

  /** 打开系统目录选择器，选定后填入 path，未手改名时同步默认名 */
  const handlePickDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setPath(picked);
      if (!nameEdited) setName(lastSegment(picked));
    }
  };

  /** 保存：组装 Workspace，新建生成 id/sortOrder/createdAt，编辑保留三者 */
  const handleSave = async () => {
    if (!path.trim()) return; // 目录必填
    const ws: Workspace = {
      id: isEdit ? editing.id : crypto.randomUUID(),
      name: name.trim() || lastSegment(path),
      path: path.trim(),
      agent,
      useGlobalConfig,
      // 统一配置不落 config；独立配置收录子表单
      config: useGlobalConfig ? undefined : buildConfig(baseUrl, apiKey, model, extraArgsText),
      sortOrder: isEdit ? editing.sortOrder : workspaces.length,
      createdAt: isEdit ? editing.createdAt : new Date().toISOString(),
    };
    await save(ws);
    closeWorkspaceDialog();
  };

  return (
    <div className="dialog-overlay" onClick={closeWorkspaceDialog}>
      <div
        className="dialog dialog-workspace"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{isEdit ? "编辑工作空间" : "新建工作空间"}</h2>
        </div>

        <div className="dialog-body">
          {/* 目录选择 */}
          <div className="dialog-field">
            <label className="dialog-label">项目目录</label>
            <div className="dialog-path-row">
              <input
                className="dialog-input"
                type="text"
                value={path}
                placeholder="点击右侧按钮选择目录"
                onChange={(e) => setPath(e.target.value)}
              />
              <button className="dialog-btn dialog-btn-ghost" onClick={handlePickDir}>
                选择…
              </button>
            </div>
          </div>

          {/* 名称 */}
          <div className="dialog-field">
            <label className="dialog-label">名称</label>
            <input
              className="dialog-input"
              type="text"
              value={name}
              placeholder="默认取目录名"
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
            />
          </div>

          {/* AI 类型单选 */}
          <div className="dialog-field">
            <label className="dialog-label">AI 类型</label>
            <div className="dialog-radio-group">
              <label className="dialog-radio">
                <input
                  type="radio"
                  name="agent"
                  checked={agent === "claude"}
                  onChange={() => setAgent("claude")}
                />
                claude
              </label>
              <label className="dialog-radio">
                <input
                  type="radio"
                  name="agent"
                  checked={agent === "codex"}
                  onChange={() => setAgent("codex")}
                />
                codex
              </label>
            </div>
          </div>

          {/* 配置模式单选 */}
          <div className="dialog-field">
            <label className="dialog-label">配置模式</label>
            <div className="dialog-radio-group">
              <label className="dialog-radio">
                <input
                  type="radio"
                  name="cfgmode"
                  checked={useGlobalConfig}
                  onChange={() => setUseGlobalConfig(true)}
                />
                统一配置
              </label>
              <label className="dialog-radio">
                <input
                  type="radio"
                  name="cfgmode"
                  checked={!useGlobalConfig}
                  onChange={() => setUseGlobalConfig(false)}
                />
                独立配置
              </label>
            </div>
          </div>

          {/* 独立配置子表单：仅 useGlobalConfig=false 时展开 */}
          {!useGlobalConfig && (
            <div className="dialog-subform">
              <div className="dialog-field">
                <label className="dialog-label">API 端点 (baseUrl)</label>
                <input
                  className="dialog-input"
                  type="text"
                  value={baseUrl}
                  placeholder="空=官方默认"
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
              <div className="dialog-field">
                <label className="dialog-label">密钥 (apiKey)</label>
                <input
                  className="dialog-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
              <div className="dialog-field">
                <label className="dialog-label">模型 (model)</label>
                <input
                  className="dialog-input"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
              <div className="dialog-field">
                <label className="dialog-label">附加参数 (每行一个)</label>
                <textarea
                  className="dialog-textarea"
                  rows={3}
                  value={extraArgsText}
                  onChange={(e) => setExtraArgsText(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-ghost" onClick={closeWorkspaceDialog}>
            取消
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            disabled={!path.trim()}
            onClick={handleSave}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/** 工作空间对话框外壳：据 uiStore.workspaceDialog.open 决定是否挂载内层表单 */
export default function WorkspaceDialog() {
  const workspaceDialog = useUiStore((s) => s.workspaceDialog);
  if (!workspaceDialog.open) return null;
  return <WorkspaceForm editing={workspaceDialog.editing} />;
}
