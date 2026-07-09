/**
 * UI 开关 store（zustand v5）。
 * 集中管理对话框 / 确认框的开合状态，避免这些一次性 UI 状态在组件树里逐层 prop 透传。
 * 对话框宿主（App）订阅此 store 渲染 WorkspaceDialog / SettingsDialog / ConfirmDialog，
 * 任意组件（侧边栏按钮、菜单等）通过 actions 触发开合。
 */
import { create } from "zustand";
import type { Workspace } from "../api/types";

/** 工作空间对话框状态：open 控制显隐，editing 有值=编辑该工作空间，无值=新建 */
interface WorkspaceDialogState {
  open: boolean;
  editing?: Workspace;
}

/** 确认框状态：点击“确认”执行 onConfirm 回调 */
interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

/** openConfirm 入参（open 由 store 内部置 true，无需调用方传） */
interface ConfirmOptions {
  title: string;
  message: string;
  onConfirm: () => void;
}

interface UiState {
  /** 工作空间新建/编辑对话框 */
  workspaceDialog: WorkspaceDialogState;
  /** 全局设置对话框是否打开 */
  settingsOpen: boolean;
  /** 通用确认框；null=未激活 */
  confirm: ConfirmState | null;

  /** 打开工作空间对话框；传 editing 进入编辑模式，不传为新建 */
  openWorkspaceDialog: (editing?: Workspace) => void;
  /** 关闭工作空间对话框并清除 editing */
  closeWorkspaceDialog: () => void;
  /** 打开全局设置对话框 */
  openSettings: () => void;
  /** 关闭全局设置对话框 */
  closeSettings: () => void;
  /** 打开确认框，传入标题/内容/确认回调 */
  openConfirm: (o: ConfirmOptions) => void;
  /** 关闭确认框 */
  closeConfirm: () => void;
}

/** UI 开关全局 store */
export const useUiStore = create<UiState>((set) => ({
  workspaceDialog: { open: false, editing: undefined },
  settingsOpen: false,
  confirm: null,

  openWorkspaceDialog: (editing) => set({ workspaceDialog: { open: true, editing } }),
  closeWorkspaceDialog: () => set({ workspaceDialog: { open: false, editing: undefined } }),

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  openConfirm: (o) => set({ confirm: { open: true, ...o } }),
  closeConfirm: () => set({ confirm: null }),
}));
