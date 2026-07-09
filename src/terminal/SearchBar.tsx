/**
 * 终端搜索浮条（SearchBar）。
 * 内嵌于每个 TerminalPane，浮在终端右上角。监听 window "app:open-search"（由 useHotkeys
 * 的 Ctrl+Shift+F 派发）打开，使用 @xterm/addon-search 做正向/反向查找。
 */
import { useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import { IconButton } from "../components/ui/IconButton";
import { ArrowUp, ArrowDown, X, ICON_DEFAULTS } from "../components/ui/icons";

interface SearchBarProps {
  search: SearchAddon | null;
}

export function SearchBar({ search }: SearchBarProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onOpen(): void {
      setOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("app:open-search", onOpen);
    return () => window.removeEventListener("app:open-search", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  if (!open) return null;

  function findNext(): void {
    if (query) search?.findNext(query);
  }
  function findPrevious(): void {
    if (query) search?.findPrevious(query);
  }
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
    <div className="term-search">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="搜索…"
        className="term-search-input"
      />
      <IconButton title="上一个 (Shift+Enter)" onClick={findPrevious}>
        <ArrowUp {...ICON_DEFAULTS} />
      </IconButton>
      <IconButton title="下一个 (Enter)" onClick={findNext}>
        <ArrowDown {...ICON_DEFAULTS} />
      </IconButton>
      <IconButton title="关闭 (Esc)" onClick={() => setOpen(false)}>
        <X {...ICON_DEFAULTS} />
      </IconButton>
    </div>
  );
}
