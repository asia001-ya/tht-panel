/**
 * Keep-alive 管理器：按工作空间配置的间隔定时向活跃会话发送指令。
 * 纯前端 setInterval 实现，不涉及 Rust 端。
 */
import { ptyWrite } from "./api/commands";
import { useSessionStore } from "./store/sessionStore";

const timers = new Map<string, ReturnType<typeof setInterval>>();

/** 获取当前正在 keep-alive 的工作空间 id 集合 */
export function activeKeepAliveIds(): Set<string> {
  return new Set(timers.keys());
}

/** 启动某工作空间的 keep-alive */
export function startKeepAlive(wsId: string, command: string, intervalMin: number): void {
  stopKeepAlive(wsId);
  if (!command || intervalMin <= 0) return;

  const send = (): void => {
    const sessions = Object.values(useSessionStore.getState().sessions);
    const alive = sessions.filter(
      (s) => s.workspaceId === wsId && s.state !== "dead" && s.kind !== "shell",
    );
    for (const s of alive) {
      void ptyWrite(s.sessionId, command + "\r");
    }
  };

  send();
  const id = setInterval(send, intervalMin * 60 * 1000);
  timers.set(wsId, id);
}

/** 停止某工作空间的 keep-alive */
export function stopKeepAlive(wsId: string): void {
  const id = timers.get(wsId);
  if (id != null) {
    clearInterval(id);
    timers.delete(wsId);
  }
}

/** 停止全部 keep-alive */
export function stopAllKeepAlive(): void {
  for (const id of timers.values()) clearInterval(id);
  timers.clear();
}

/** 检查某工作空间是否正在 keep-alive */
export function isKeepAliveActive(wsId: string): boolean {
  return timers.has(wsId);
}
