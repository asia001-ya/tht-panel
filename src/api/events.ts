/**
 * 全局事件订阅封装（低频广播）。高频终端输出不走这里，走 ptyAttach 的 Channel。
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EVT_SESSION_STATE,
  EVT_SESSION_EXIT,
  EVT_QUIT_REQUEST,
  type SessionStatePayload,
  type SessionExitPayload,
} from "./types";

/** 会话状态变化（running/waiting/idle/dead），用于侧边栏/分屏徽标 */
export const onSessionState = (cb: (p: SessionStatePayload) => void): Promise<UnlistenFn> =>
  listen<SessionStatePayload>(EVT_SESSION_STATE, (e) => cb(e.payload));

/** 会话进程退出 */
export const onSessionExit = (cb: (p: SessionExitPayload) => void): Promise<UnlistenFn> =>
  listen<SessionExitPayload>(EVT_SESSION_EXIT, (e) => cb(e.payload));

/** 托盘「退出」被点击，前端据此弹确认框 */
export const onQuitRequest = (cb: () => void): Promise<UnlistenFn> =>
  listen(EVT_QUIT_REQUEST, () => cb());
