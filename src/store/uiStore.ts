/**
 * UI 开关 store（zustand v5）。
 * 集中管理主区域视图切换与对话框 / 确认框的开合状态，
 * 避免这些一次性 UI 状态在组件树里逐层 prop 透传。
 * 对话框宿主（App）订阅此 store 渲染 WorkspaceDialog / ConfirmDialog，
 * 并按 mainView 决定主区域渲染终端网格还是各功能页。
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

/**
 * 主区域视图。
 * 本应用无路由库，视图切换即由此状态驱动（参见 App.tsx 的分支渲染）。
 * panes=终端网格（默认），其余为各功能页。
 */
export type MainView = "panes" | "usage" | "providers" | "settings";

interface UiState {
  /** 工作空间新建/编辑对话框 */
  workspaceDialog: WorkspaceDialogState;
  /** 当前主区域视图 */
  mainView: MainView;
  /** 左侧资源面板是否可见；ActivityBar 再次点击当前模块时切换。 */
  sidebarVisible: boolean;
  /** 通用确认框；null=未激活 */
  confirm: ConfirmState | null;

  /** 打开工作空间对话框；传 editing 进入编辑模式，不传为新建 */
  openWorkspaceDialog: (editing?: Workspace) => void;
  /** 关闭工作空间对话框并清除 editing */
  closeWorkspaceDialog: () => void;
  /** 切换主区域视图 */
  setMainView: (view: MainView) => void;
  /** 按 cc-pane 语义切换模块：同一模块切侧栏，切换模块时自动展开。 */
  toggleMainView: (view: MainView) => void;
  /** 直接设置侧栏可见性。 */
  setSidebarVisible: (visible: boolean) => void;
  /** 切换侧栏可见性。 */
  toggleSidebar: () => void;
  /** 打开确认框，传入标题/内容/确认回调 */
  openConfirm: (o: ConfirmOptions) => void;
  /** 关闭确认框 */
  closeConfirm: () => void;
}

/** UI 开关全局 store */
export const useUiStore = create<UiState>((set) => ({
  workspaceDialog: { open: false, editing: undefined },
  mainView: "panes",
  sidebarVisible: true,
  confirm: null,

  openWorkspaceDialog: (editing) => set({ workspaceDialog: { open: true, editing } }),
  closeWorkspaceDialog: () => set({ workspaceDialog: { open: false, editing: undefined } }),

  setMainView: (mainView) => set({ mainView }),
  toggleMainView: (mainView) => set((state) => (
    state.mainView === mainView
      ? { sidebarVisible: !state.sidebarVisible }
      : { mainView, sidebarVisible: true }
  )),
  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),

  openConfirm: (o) => set({ confirm: { open: true, ...o } }),
  closeConfirm: () => set({ confirm: null }),
}));
