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
  sessionId: string | null; // 绑定的 PTY 会话；null=空占位（不 attach）
}

/**
 * 单个终端分屏面板。
 * @param props.sessionId 绑定的 PTY 会话 uuid，null 时显示占位
 * @returns 终端容器 + 内嵌搜索浮条 + （sessionId 为 null 时）占位层
 */
export function TerminalPane({ sessionId }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null); // xterm 挂载容器
  const termRef = useRef<Terminal | null>(null); // 常驻 xterm 实例
  const fitRef = useRef<FitAddon | null>(null); // FitAddon 句柄（自适应尺寸）
  const [search, setSearch] = useState<SearchAddon | null>(null); // 传给 SearchBar 的搜索 addon

  /**
   * 自适应尺寸：调用 FitAddon.fit() 让终端行列匹配容器。
   * 容器不可见（尺寸 0）或渲染器未就绪时 proposeDimensions 返回非法值，直接跳过避免报错。
   * fit() 触发 term.onResize → 由 effect B 注册的回调把新尺寸下发到 PTY。
   */
  const doFit = useCallback((): void => {
    const fit = fitRef.current;
    if (!fit) return;
    try {
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      fit.fit();
    } catch {
      // 渲染器尚未就绪等偶发异常，静默忽略，等下次 ResizeObserver 触发
    }
  }, []);

  // ---- effect A：挂载一次，创建并常驻 xterm 实例 ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 用 settingsStore 当前配置创建终端（缺省兜底：字号 14 / 回滚 10000 行 / 深色）
    const cfg = useSettingsStore.getState().config;
    const { term, fit, search: searchAddon } = createTerm({
      fontSize: cfg?.fontSize ?? 14,
      scrollbackLines: cfg?.scrollbackLines ?? 10000,
      theme: cfg?.theme ?? "dark",
    });
    termRef.current = term;
    fitRef.current = fit;
    setSearch(searchAddon);

    term.open(container);
    tryLoadWebgl(term); // WebGL 提速，失败自动降级 DOM 渲染

    // 放行应用级快捷键：命中的组合返回 false（阻止 xterm 处理，交给 window capture 的 useHotkeys），其余 true 正常输入
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (!e.ctrlKey) return true;
      // Ctrl+1..9 切工作空间
      if (!e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") return false;
      // Ctrl+Shift+F 搜索
      if (e.shiftKey && (e.key === "F" || e.key === "f")) return false;
      // Ctrl+= / Ctrl++ 放大字号
      if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") return false;
      // Ctrl+- / Ctrl+_ 缩小字号
      if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return false;
      return true;
    });

    doFit(); // 挂载后先适配一次

    // ResizeObserver 防抖 100ms 触发 fit，避免 resize 风暴
    let fitTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        fitTimer = null;
        doFit();
      }, 100);
    });
    ro.observe(container);

    // 字号变化后容器尺寸不变、ResizeObserver 不触发，需响应全局 app:refit 主动重排
    const onRefit = (): void => doFit();
    window.addEventListener("app:refit", onRefit);

    return () => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      ro.disconnect();
      window.removeEventListener("app:refit", onRefit);
      unregisterTerm(term); // 先移出全局注册表再销毁，防止全局主题/字号遍历到已销毁终端
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 仅挂载一次：xterm 实例常驻复用，切会话不重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- effect B：sessionId 变化时切换 attach 目标（reset + 重新 attach）----
  useEffect(() => {
    const term = termRef.current;
    // sessionId 为 null（空占位）或终端尚未创建：不 attach
    if (sessionId === null || !term) return;

    let dead = false; // 本次 attach 是否已失效，防止 detach 后残留的 Channel 消息写入已切换的终端
    term.reset(); // 清屏，准备回放新会话快照

    // attach 后端会话：先收 snapshot（环形缓冲回放）再收 data，同一 Channel 有序，直写 xterm
    const channel = ptyAttach(sessionId, (msg) => {
      if (dead) return;
      if (msg.kind === "snapshot" || msg.kind === "data") {
        term.write(msg.data);
      } else if (msg.kind === "exit") {
        // 进程退出：灰色提示行（\x1b[90m 亮黑=灰，\x1b[0m 复位）
        term.write(`\r\n\x1b[90m[进程已退出 code=${msg.code}]\x1b[0m\r\n`);
      }
    });
    void channel; // Channel 生命周期随 detach 释放，无需显式引用

    // 用户输入回写到 PTY + 首次 Enter 检测（自动命名会话）
    let inputBuf = "";
    let named = false; // 本次 attach 是否已完成命名
    const dataDisp = term.onData((d) => {
      void ptyWrite(sessionId, d);
      // 仅对 pendingSessions 中登记的（未命名的）会话追踪首次输入
      if (!named && pendingSessions.has(sessionId)) {
        if (d.includes("\r") || d.includes("\n")) {
          // 用户按了 Enter：用之前攒的内容作为会话名称
          named = true;
          const name = inputBuf.trim().slice(0, 80) || "新会话";
          window.dispatchEvent(
            new CustomEvent("app:session-named", { detail: { sessionId, name } }),
          );
        } else if (d === "\x7f" || d === "\b") {
          // 退格：删除最后一个字符
          inputBuf = inputBuf.slice(0, -1);
        } else if (d.length === 1 && d >= " ") {
          // 可见字符追加到缓冲
          inputBuf += d;
        }
        // 粘贴（d.length>1 且含回车）也视为首次发送
        if (!named && d.length > 1 && (d.includes("\r") || d.includes("\n"))) {
          named = true;
          const firstLine = (inputBuf + d).split(/[\r\n]/)[0].trim().slice(0, 80) || "新会话";
          window.dispatchEvent(
            new CustomEvent("app:session-named", { detail: { sessionId, name: firstLine } }),
          );
        }
      }
    });
    // 终端行列变化（fit 或手动）下发到 PTY，下限钳制 ≥2
    const resizeDisp = term.onResize(({ cols, rows }) => {
      void ptyResize(sessionId, Math.max(2, cols), Math.max(2, rows));
    });

    // attach 后主动对齐一次尺寸：不同 leaf 尺寸不同，否则 TUI 排版错位
    void ptyResize(sessionId, Math.max(2, term.cols), Math.max(2, term.rows));

    return () => {
      dead = true; // 置失效标志，拦截后续晚到的 Channel 消息
      dataDisp.dispose();
      resizeDisp.dispose();
      void ptyDetach(sessionId); // 通知后端停止向本 Channel 推送（继续写环形缓冲）
    };
  }, [sessionId]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "var(--term-bg)" }}>
      {/* xterm 挂载容器：常驻，不随 sessionId 卸载 */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {/* 搜索浮条：监听 app:open-search 自行显隐 */}
      <SearchBar search={search} />
      {/* 空占位层：sessionId 为 null 时盖在终端上方提示 */}
      {sessionId === null && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-faint)",
            fontSize: 13,
            userSelect: "none",
            pointerEvents: "none",
          }}
        >
          点击左侧工作空间或历史会话以在此打开终端
        </div>
      )}
    </div>
  );
}
