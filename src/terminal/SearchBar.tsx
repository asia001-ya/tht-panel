/**
 * 终端搜索浮条（SearchBar）。
 * 内嵌于每个 TerminalPane，浮在终端右上角。监听 window "app:open-search"（由 useHotkeys
 * 的 Ctrl+Shift+F 派发）打开，使用 @xterm/addon-search 的 SearchAddon 做正向/反向查找，
 * Enter 下一个、Shift+Enter 上一个、Esc 关闭。终端内容不进 store，搜索完全由 addon 处理。
 */
import { useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";

/** SearchBar 属性：search 为所属 TerminalPane 的 SearchAddon 句柄（挂载完成前为 null） */
interface SearchBarProps {
  search: SearchAddon | null;
}

/**
 * 终端搜索浮条组件。
 * @param props.search 所属终端的 SearchAddon；为 null 时按键静默无操作
 * @returns 打开时渲染浮条，关闭时渲染 null
 */
export function SearchBar({ search }: SearchBarProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false); // 浮条是否可见
  const [query, setQuery] = useState(""); // 当前搜索关键词
  const inputRef = useRef<HTMLInputElement>(null); // 输入框引用，用于聚焦/全选

  // 监听全局「打开搜索」事件（Ctrl+Shift+F）
  useEffect(() => {
    /** 打开搜索浮条：置可见并在下一帧聚焦全选，便于直接输入新关键词 */
    function onOpen(): void {
      setOpen(true);
      // 若此前已打开，下面的 [open] effect 不会重跑，这里补一次聚焦全选（未打开时 inputRef 为空，无副作用）
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("app:open-search", onOpen);
    return () => window.removeEventListener("app:open-search", onOpen);
  }, []);

  // 由关闭变为打开时，聚焦输入框并全选已有关键词
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  if (!open) return null;

  /** 查找下一个匹配（正向） */
  function findNext(): void {
    if (query) search?.findNext(query);
  }

  /** 查找上一个匹配（反向） */
  function findPrevious(): void {
    if (query) search?.findPrevious(query);
  }

  /**
   * 输入框键盘处理：Esc 关闭；Enter 下一个 / Shift+Enter 上一个。
   * @param e 键盘事件
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) findPrevious();
      else findNext();
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 6px",
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="搜索…"
        style={{
          width: 160,
          padding: "3px 6px",
          background: "var(--panel-2)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          outline: "none",
          fontSize: 13,
        }}
      />
      <button type="button" onClick={findPrevious} title="上一个 (Shift+Enter)" style={btnStyle}>
        ↑
      </button>
      <button type="button" onClick={findNext} title="下一个 (Enter)" style={btnStyle}>
        ↓
      </button>
      <button type="button" onClick={() => setOpen(false)} title="关闭 (Esc)" style={btnStyle}>
        ✕
      </button>
    </div>
  );
}

/** 浮条按钮统一样式 */
const btnStyle: React.CSSProperties = {
  padding: "2px 7px",
  background: "transparent",
  color: "var(--fg-dim)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1.2,
};
