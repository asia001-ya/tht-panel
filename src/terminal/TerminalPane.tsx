/**
 * 终端分屏面板（TerminalPane）——xterm 生命周期与 PTY attach/detach 的核心组件。
 *
 * 关键约束（见实施计划 9.2）：
 * - xterm 实例与 leaf 绑定、常驻复用；切换会话 = detach 旧 + term.reset() + attach 新（快照回放），
 *   绝不为每个会话重建 xterm 实例（WebGL context 上限约 8~16，10+ 会话必崩）。
 * - 终端输出永不进 store：全部经 ptyAttach 的 Channel 直写 xterm。
 * - fit 防抖 100ms；cols/rows 下限钳制 ≥2；attach 后主动对齐一次尺寸避免 TUI 错位。
 *
 * props：{ sessionId }。sessionId 为 null 时显示占位、不 attach。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { createTerm, tryLoadWebgl, unregisterTerm } from "./xtermManager";
import { SearchBar } from "./SearchBar";
import { ptyAttach, ptyWrite, ptyResize, ptyDetach } from "../api/commands";
import { useSettingsStore } from "../store/settingsStore";
import { pendingSessions } from "../App";

/** TerminalPane 属性 */
interface TerminalPaneProps {
  sessionId: string | null;
}

/**
 * 单个终端分屏面板。
 */
export function TerminalPane({ sessionId }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const attachedRef = useRef<string | null>(null); // 上一次 attach 的 sessionId，防重复

  const doFit = useCallback((): void => {
    const fit = fitRef.current;
    if (!fit) return;
    try {
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      fit.fit();
    } catch {
      // 渲染器尚未就绪等偶发异常，静默忽略
    }
  }, []);

  // effect A：挂载一次，创建并常驻 xterm 实例
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cfg = useSettingsStore.getState().config;
    const { term, fit, search: searchAddon } = createTerm({
      fontSize: cfg?.fontSize ?? 14,
      scrollbackLines: cfg?.scrollbackLines ?? 10000,
      theme: cfg?.theme ?? "light",
    });
    termRef.current = term;
    fitRef.current = fit;
    setSearch(searchAddon);

    term.open(container);
    tryLoadWebgl(term);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (!e.ctrlKey) return true;
      if (!e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") return false;
      if (e.shiftKey && (e.key === "F" || e.key === "f")) return false;
      if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") return false;
      if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return false;
      return true;
    });

    doFit();

    let fitTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        fitTimer = null;
        doFit();
      }, 100);
    });
    ro.observe(container);

    const onRefit = (): void => doFit();
    window.addEventListener("app:refit", onRefit);

    return () => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      ro.disconnect();
      window.removeEventListener("app:refit", onRefit);
      unregisterTerm(term);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // effect B：sessionId 变化时切换 attach 目标
  useEffect(() => {
    const term = termRef.current;
    if (sessionId === null || !term) return;
    // 已 attach 同一 session，跳过避免 snapshot 重复回放
    if (attachedRef.current === sessionId) return;
    attachedRef.current = sessionId;

    let dead = false;
    term.reset();

    const channel = ptyAttach(sessionId, (msg) => {
      if (dead) return;
      if (msg.kind === "snapshot" || msg.kind === "data") {
        term.write(msg.data);
      } else if (msg.kind === "exit") {
        term.write(`\r\n\x1b[90m[进程已退出 code=${msg.code}]\x1b[0m\r\n`);
      }
    });
    void channel;

    let inputBuf = "";
    let named = false;
    // 过滤 ANSI 转义序列，避免 escape 混入会话名称
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b\[[?]?[0-9;]*[hl]/g, "");
    const dataDisp = term.onData((d) => {
      void ptyWrite(sessionId, d);
      if (!named && pendingSessions.has(sessionId)) {
        if (d.includes("\r") || d.includes("\n")) {
          const trimmed = stripAnsi(inputBuf).trim().slice(0, 80);
          if (trimmed) {
            named = true;
            window.dispatchEvent(
              new CustomEvent("app:session-named", { detail: { sessionId, name: trimmed } }),
            );
          }
          inputBuf = "";
        } else if (d === "\x7f" || d === "\b") {
          inputBuf = inputBuf.slice(0, -1);
        } else if (d.charCodeAt(0) >= 0x20 && !d.startsWith("\x1b")) {
          inputBuf += d;
        }
      }
    });
    const resizeDisp = term.onResize(({ cols, rows }) => {
      void ptyResize(sessionId, Math.max(2, cols), Math.max(2, rows));
    });

    void ptyResize(sessionId, Math.max(2, term.cols), Math.max(2, term.rows));
    term.focus();

    return () => {
      dead = true;
      attachedRef.current = null;
      dataDisp.dispose();
      resizeDisp.dispose();
      void ptyDetach(sessionId);
    };
  }, [sessionId]);

  return (
    <div className="term-host">
      <div ref={containerRef} className="term-host-inner" />
      <SearchBar search={search} />
      {sessionId === null && (
        <div className="term-placeholder">
          从菜单打开项目或历史会话
        </div>
      )}
    </div>
  );
}
