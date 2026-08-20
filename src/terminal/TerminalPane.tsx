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
import {
  createTerm,
  setTerminalTransparency,
  tryLoadWebgl,
  unregisterTerm,
} from "./xtermManager";
import { SearchBar } from "./SearchBar";
import { ptyAttach, ptyWrite, ptyResize, ptyDetach } from "../api/commands";
import { DEFAULT_WALLPAPER, useSettingsStore } from "../store/settingsStore";
import { pendingSessions } from "../App";
import {
  copyClipboardText,
  resolveClipboardPayload,
} from "../lib/clipboard";
import { isInternalPaneDrag } from "../lib/paneDrag";

/** TerminalPane 属性 */
interface TerminalPaneProps {
  sessionId: string | null;
}

interface TerminalContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

/**
 * 单个终端分屏面板。
 */
export function TerminalPane({ sessionId }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pasteRequestRef = useRef<(() => void) | null>(null);
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
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
    const wallpaper = cfg?.wallpaper ?? DEFAULT_WALLPAPER;
    const { term, fit, search: searchAddon } = createTerm({
      fontSize: cfg?.fontSize ?? 14,
      scrollbackLines: cfg?.scrollbackLines ?? 10000,
      theme: cfg?.theme ?? "light",
      terminalOpacity: wallpaper.enabled ? wallpaper.terminalOpacity : 1,
    });
    termRef.current = term;
    fitRef.current = fit;
    setSearch(searchAddon);

    term.open(container);
    const transparent = wallpaper.enabled && wallpaper.terminalOpacity < 0.999;
    if (transparent) setTerminalTransparency(term, true);
    else tryLoadWebgl(term);

    let lastShortcutPasteAt = 0;
    const pasteIntoTerminal = (data?: DataTransfer | null): void => {
      void resolveClipboardPayload(data).then((payload) => {
        if (payload.kind === "none") return;
        term.focus();
        term.paste(payload.text);
      })
        .catch(() => term.focus());
    };
    const requestSystemPaste = (): void => {
      lastShortcutPasteAt = Date.now();
      pasteIntoTerminal();
    };
    pasteRequestRef.current = requestSystemPaste;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const modifier = e.ctrlKey || e.metaKey;
      if (!modifier) return true;
      if (!e.altKey && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        requestSystemPaste();
        return false;
      }
      if (!e.altKey && (e.key === "c" || e.key === "C")) {
        const selection = term.getSelection();
        if (selection) {
          e.preventDefault();
          void copyClipboardText(selection)
            .then(() => {
              term.clearSelection();
              term.focus();
            })
            .catch(() => term.focus());
          return false;
        }
        // 无选区时保留 Ctrl+C 的 SIGINT 语义。
        if (!e.shiftKey) return true;
      }
      if (!e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") return false;
      if (e.shiftKey && (e.key === "F" || e.key === "f")) return false;
      if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") return false;
      if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return false;
      return true;
    });

    const textarea = term.textarea;
    const onPaste = (event: ClipboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() - lastShortcutPasteAt < 250) return;
      pasteIntoTerminal(event.clipboardData);
    };
    textarea?.addEventListener("paste", onPaste, true);

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      term.focus();
      setContextMenu({
        x: Math.min(event.clientX, Math.max(8, window.innerWidth - 160)),
        y: Math.min(event.clientY, Math.max(8, window.innerHeight - 116)),
        hasSelection: Boolean(term.getSelection()),
      });
    };
    container.addEventListener("contextmenu", onContextMenu);

    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer) return;
      if (isInternalPaneDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent): void => {
      if (isInternalPaneDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      pasteIntoTerminal(event.dataTransfer);
    };
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);

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
      textarea?.removeEventListener("paste", onPaste, true);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      pasteRequestRef.current = null;
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
    setAttachError(null);

    const channel = ptyAttach(sessionId, (msg) => {
      if (dead) return;
      if (msg.kind === "snapshot" || msg.kind === "data") {
        term.write(msg.data);
      } else if (msg.kind === "exit") {
        term.write(`\r\n\x1b[90m[进程已退出 code=${msg.code}]\x1b[0m\r\n`);
      }
    }, (error) => {
      if (dead) return;
      setAttachError(error instanceof Error ? error.message : "终端连接失败，请重试");
    });
    void channel;

    let inputBuf = "";
    let named = false;
    // 过滤 ANSI 转义序列，避免 escape 混入会话名称
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b\[[?]?[0-9;]*[hl]/g, "");
    const dataDisp = term.onData((d) => {
      void ptyWrite(sessionId, d).catch((error: unknown) => {
        if (!dead) {
          setAttachError(error instanceof Error ? error.message : "终端写入失败");
        }
      });
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
      void ptyResize(sessionId, Math.max(2, cols), Math.max(2, rows)).catch(() => undefined);
    });

    void ptyResize(sessionId, Math.max(2, term.cols), Math.max(2, term.rows)).catch(() => undefined);
    term.focus();

    return () => {
      dead = true;
      attachedRef.current = null;
      dataDisp.dispose();
      resizeDisp.dispose();
      void ptyDetach(sessionId);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = (): void => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const copySelection = (): void => {
    const term = termRef.current;
    const selection = term?.getSelection() ?? "";
    setContextMenu(null);
    if (!term || !selection) return;
    void copyClipboardText(selection)
      .then(() => {
        term.clearSelection();
        term.focus();
      })
      .catch(() => term.focus());
  };

  const pasteFromMenu = (): void => {
    setContextMenu(null);
    pasteRequestRef.current?.();
  };

  const selectAll = (): void => {
    setContextMenu(null);
    const term = termRef.current;
    term?.selectAll();
    term?.focus();
  };

  return (
    <div className="term-host">
      <div ref={containerRef} className="term-host-inner" />
      <SearchBar search={search} />
      {attachError && <div className="term-error" role="alert">{attachError}</div>}
      {contextMenu && (
        <div
          className="term-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.hasSelection}
            onClick={copySelection}
          >
            复制
          </button>
          <button type="button" role="menuitem" onClick={pasteFromMenu}>
            粘贴
          </button>
          <button type="button" role="menuitem" onClick={selectAll}>
            全选
          </button>
        </div>
      )}
      {sessionId === null && (
        <div className="term-placeholder">
          从菜单打开项目或历史会话
        </div>
      )}
    </div>
  );
}
