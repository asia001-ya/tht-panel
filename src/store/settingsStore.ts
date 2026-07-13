/**
 * 全局配置 store：持有 GlobalConfig，负责主题 / 字号 / 各项设置的读取与防抖持久化。
 * 终端输出永不进 store，此处仅低频 UI/配置状态。
 */
import { create } from "zustand";
import type { GlobalConfig, ProviderProfile } from "../api/types";
import { configGet, configSet } from "../api/commands";

/** 持久化防抖句柄（模块级，跨调用复用同一个定时器） */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 把主题写到 <html data-theme>，供 CSS 变量切换两套配色。
 * @param theme 主题名 light/dark
 */
function applyThemeAttr(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * 防抖 500ms 调用 configSet 把整份配置持久化到后端。
 * @param cfg 最新的完整 GlobalConfig
 */
function scheduleSave(cfg: GlobalConfig): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void configSet(cfg);
  }, 500);
}

/** settingsStore 状态与动作定义 */
interface SettingsState {
  config: GlobalConfig | null; // 全局配置，load 前为 null
  loaded: boolean; // 是否已完成首次加载
  /** 从后端拉取配置填充 store，并把主题应用到 data-theme */
  load: () => Promise<void>;
  /** 浅合并部分字段并防抖持久化 */
  update: (partial: Partial<GlobalConfig>) => void;
  /** 切换主题：更新配置 + data-theme + 持久化 */
  setTheme: (theme: "light" | "dark") => void;
  /** 设置终端字号并持久化 */
  setFontSize: (fontSize: number) => void;
}

const EMPTY_PROVIDERS: ProviderProfile[] = [];

export function selectProviders(state: SettingsState): ProviderProfile[] {
  return state.config?.providers ?? EMPTY_PROVIDERS;
}

/** 全局配置 store */
export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: null,
  loaded: false,

  /** 从后端拉取配置填充 store，并把主题应用到 data-theme */
  load: async () => {
    const config = await configGet();
    applyThemeAttr(config.theme);
    set({ config, loaded: true });
  },

  /** 浅合并部分字段到 config，并防抖持久化；未加载完成时忽略 */
  update: (partial) => {
    const current = get().config;
    if (!current) return;
    const next: GlobalConfig = { ...current, ...partial };
    set({ config: next });
    scheduleSave(next);
  },

  /** 切换主题：立即改 data-theme，再走 update 合并 + 持久化 */
  setTheme: (theme) => {
    applyThemeAttr(theme);
    get().update({ theme });
  },

  /** 设置终端字号（走 update 合并 + 持久化） */
  setFontSize: (fontSize) => {
    get().update({ fontSize });
  },
}));
