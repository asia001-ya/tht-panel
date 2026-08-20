/**
 * 全局配置 store：持有 GlobalConfig，负责主题 / 字号 / 各项设置的读取与防抖持久化。
 * 终端输出永不进 store，此处仅低频 UI/配置状态。
 */
import { create } from "zustand";
import type { GlobalConfig, ProviderProfile, WallpaperSettings } from "../api/types";
import { configGet, configSet } from "../api/commands";

/** 持久化防抖句柄（模块级，跨调用复用同一个定时器） */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 壁纸默认值：关闭壁纸时主区仍沿用原有不透明主题。 */
export const DEFAULT_WALLPAPER: WallpaperSettings = {
  enabled: false,
  kind: "none",
  file: null,
  dataUrl: null,
  fit: "cover",
  opacity: 1,
  blur: 0,
  dim: 0.28,
  terminalOpacity: 0.86,
  glassBlur: 8,
};

/** Web 预览 / 首次启动时的完整配置，避免 IPC 暂不可用时设置页永久停在加载态。 */
export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  theme: "light",
  shellPath: "powershell.exe",
  fontSize: 14,
  scrollbackBytes: 5 * 1024 * 1024,
  scrollbackLines: 10000,
  notifyOnWaiting: true,
  claudeDefaults: {},
  codexDefaults: {},
  providers: [],
  wallpaper: DEFAULT_WALLPAPER,
};

function normalizeWallpaper(value: WallpaperSettings | undefined): WallpaperSettings {
  const source = value ?? DEFAULT_WALLPAPER;
  return {
    ...DEFAULT_WALLPAPER,
    ...source,
    file: source.file ?? null,
    dataUrl: source.dataUrl ?? null,
    enabled: Boolean(source.enabled && (source.dataUrl || source.file)),
  };
}

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
    void configSet(cfg).catch(() => {
      // 浏览器预览没有 Tauri IPC；本地状态仍保留，桌面端会正常持久化。
    });
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
  /** 更新壁纸字段并立即作用到主区，落盘沿用全局配置防抖。 */
  setWallpaper: (partial: Partial<WallpaperSettings>) => void;
  clearWallpaper: () => void;
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
    let raw: GlobalConfig;
    try {
      raw = await configGet();
    } catch {
      // 浏览器预览和 Tauri 尚未初始化时仍展示完整可操作的默认设置。
      raw = DEFAULT_GLOBAL_CONFIG;
    }
    const config: GlobalConfig = {
      ...raw,
      wallpaper: normalizeWallpaper(raw.wallpaper),
    };
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

  setWallpaper: (partial) => {
    const current = get().config;
    if (!current) return;
    const wallpaper = normalizeWallpaper({
      ...normalizeWallpaper(current.wallpaper),
      ...partial,
    });
    get().update({ wallpaper });
  },

  clearWallpaper: () => {
    get().setWallpaper({
      enabled: false,
      kind: "none",
      file: null,
      dataUrl: null,
    });
  },
}));
