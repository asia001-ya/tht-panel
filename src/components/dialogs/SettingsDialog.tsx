/**
 * 全局设置对话框。
 * 受 uiStore.settingsOpen 控制：false 不渲染；true 渲染模态。
 * 编辑 GlobalConfig：claude/codex 两套 defaults(各 baseUrl/apiKey/model/extraArgs)、
 * shellPath、fontSize、scrollbackBytes、scrollbackLines、notifyOnWaiting。
 * 每次改动即调 settingsStore.update(partial)，由 store 负责浅合并 + 防抖持久化。
 * 主题不在此编辑（由主题切换入口单独负责）。
 */
import { useState } from "react";
import type { AgentConfig, GlobalConfig } from "../../api/types";
import { useUiStore } from "../../store/uiStore";
import { useSettingsStore } from "../../store/settingsStore";

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

/** 内层表单：挂载时以当前 config 播种 extraArgs 本地文本，其余字段实时读 store */
function SettingsForm({ config }: { config: GlobalConfig }) {
  const closeSettings = useUiStore((s) => s.closeSettings);
  const update = useSettingsStore((s) => s.update);

  // extraArgs 用本地文本态承载，避免每次 split/join 丢失正在输入的换行
  const [claudeArgs, setClaudeArgs] = useState((config.claudeDefaults.extraArgs ?? []).join("\n"));
  const [codexArgs, setCodexArgs] = useState((config.codexDefaults.extraArgs ?? []).join("\n"));

  /**
   * 合并更新 claudeDefaults 子字段。
   * @param patch 要覆盖的 AgentConfig 局部字段
   */
  const patchClaude = (patch: Partial<AgentConfig>) =>
    update({ claudeDefaults: { ...config.claudeDefaults, ...patch } });

  /**
   * 合并更新 codexDefaults 子字段。
   * @param patch 要覆盖的 AgentConfig 局部字段
   */
  const patchCodex = (patch: Partial<AgentConfig>) =>
    update({ codexDefaults: { ...config.codexDefaults, ...patch } });

  /**
   * 数字输入统一处理：解析失败（空/非数）则忽略，不写坏值。
   * @param raw input 原始字符串
   * @param apply 解析成功后的落库回调
   */
  const onNum = (raw: string, apply: (n: number) => void) => {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n)) apply(n);
  };

  return (
    <div className="dialog-overlay" onClick={closeSettings}>
      <div
        className="dialog dialog-settings"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">全局设置</h2>
        </div>

        <div className="dialog-body">
          {/* claude 默认配置 */}
          <fieldset className="dialog-group">
            <legend className="dialog-group-title">claude 统一配置</legend>
            <div className="dialog-field">
              <label className="dialog-label">API 端点 (baseUrl)</label>
              <input
                className="dialog-input"
                type="text"
                value={config.claudeDefaults.baseUrl ?? ""}
                placeholder="空=官方默认"
                onChange={(e) => patchClaude({ baseUrl: e.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">密钥 (apiKey)</label>
              <input
                className="dialog-input"
                type="password"
                value={config.claudeDefaults.apiKey ?? ""}
                onChange={(e) => patchClaude({ apiKey: e.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">模型 (model)</label>
              <input
                className="dialog-input"
                type="text"
                value={config.claudeDefaults.model ?? ""}
                onChange={(e) => patchClaude({ model: e.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">附加参数 (每行一个)</label>
              <textarea
                className="dialog-textarea"
                rows={3}
                value={claudeArgs}
                onChange={(e) => {
                  setClaudeArgs(e.target.value);
                  patchClaude({ extraArgs: parseExtraArgs(e.target.value) });
                }}
              />
            </div>
          </fieldset>

          {/* codex 默认配置 */}
          <fieldset className="dialog-group">
            <legend className="dialog-group-title">codex 统一配置</legend>
            <div className="dialog-field">
              <label className="dialog-label">API 端点 (baseUrl)</label>
              <input
                className="dialog-input"
                type="text"
                value={config.codexDefaults.baseUrl ?? ""}
                placeholder="空=官方默认"
                onChange={(e) => patchCodex({ baseUrl: e.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">密钥 (apiKey)</label>
              <input
                className="dialog-input"
                type="password"
                value={config.codexDefaults.apiKey ?? ""}
                onChange={(e) => patchCodex({ apiKey: e.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">模型 (model)</label>
              <input
                className="dialog-input"
                type="text"
                value={config.codexDefaults.model ?? ""}
                onChange={(e) => patchCodex({ model: e.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">附加参数 (每行一个)</label>
              <textarea
                className="dialog-textarea"
                rows={3}
                value={codexArgs}
                onChange={(e) => {
                  setCodexArgs(e.target.value);
                  patchCodex({ extraArgs: parseExtraArgs(e.target.value) });
                }}
              />
            </div>
          </fieldset>

          {/* 终端/通用设置 */}
          <fieldset className="dialog-group">
            <legend className="dialog-group-title">终端与通用</legend>
            <div className="dialog-field">
              <label className="dialog-label">Shell 路径 (shellPath)</label>
              <input
                className="dialog-input"
                type="text"
                value={config.shellPath}
                placeholder="powershell.exe"
                onChange={(e) => update({ shellPath: e.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">字号 (fontSize)</label>
              <input
                className="dialog-input"
                type="number"
                value={config.fontSize}
                onChange={(e) => onNum(e.target.value, (n) => update({ fontSize: n }))}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">缓冲字节上限 (scrollbackBytes)</label>
              <input
                className="dialog-input"
                type="number"
                value={config.scrollbackBytes}
                onChange={(e) => onNum(e.target.value, (n) => update({ scrollbackBytes: n }))}
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label">回滚行数 (scrollbackLines)</label>
              <input
                className="dialog-input"
                type="number"
                value={config.scrollbackLines}
                onChange={(e) => onNum(e.target.value, (n) => update({ scrollbackLines: n }))}
              />
            </div>
            <div className="dialog-field dialog-field-inline">
              <label className="dialog-label">
                <input
                  type="checkbox"
                  checked={config.notifyOnWaiting}
                  onChange={(e) => update({ notifyOnWaiting: e.target.checked })}
                />
                等待输入时系统通知 (notifyOnWaiting)
              </label>
            </div>
          </fieldset>
        </div>

        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-primary" onClick={closeSettings}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 设置对话框外壳：据 settingsOpen 与 config 是否就绪决定挂载内层表单 */
export default function SettingsDialog() {
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const config = useSettingsStore((s) => s.config);
  if (!settingsOpen || !config) return null;
  return <SettingsForm config={config} />;
}
