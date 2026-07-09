/**
 * ComposerBar — 底部常驻输入卡片（Codex 风格大圆角），回车发送到活动终端 stdin。
 * 可折叠为一条细悬浮条，折叠状态存 localStorage。
 */
import { useCallback, useRef, useState, useEffect } from "react";
import { useLayoutStore } from "../../store/layoutStore";
import { useSessionStore } from "../../store/sessionStore";
import { ptyWrite } from "../../api/commands";
import { IconButton } from "../ui/IconButton";
import { ChevronDown, ChevronUp, ArrowUp, ICON_DEFAULTS } from "../ui/icons";
import type { PaneNode, LeafNode } from "../../api/types";

const LS_KEY = "tht-composer-collapsed";

function findLeafById(node: PaneNode, id: string): LeafNode | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id);
}

export function ComposerBar(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(LS_KEY) === "1");
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const tree = useLayoutStore((s) => s.tree);
  const activePaneId = useLayoutStore((s) => s.activePaneId);

  const leaf = tree && activePaneId ? findLeafById(tree, activePaneId) : null;
  const sessionId = leaf?.activeSessionId ?? null;
  const session = useSessionStore((s) => sessionId ? s.sessions[sessionId] : undefined);
  const disabled = !sessionId || session?.state === "dead";

  useEffect(() => {
    localStorage.setItem(LS_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const send = useCallback(() => {
    if (!sessionId || !text.trim()) return;
    const payload = `\x1b[200~${text}\x1b[201~\r`;
    void ptyWrite(sessionId, payload);
    setText("");
  }, [sessionId, text]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // 自适应 textarea 高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  if (collapsed) {
    return (
      <div className="composer-collapsed" onClick={() => setCollapsed(false)}>
        <span className="composer-collapsed-hint">输入内容发送到终端…</span>
        <IconButton title="展开输入框" onClick={() => setCollapsed(false)}>
          <ChevronUp {...ICON_DEFAULTS} />
        </IconButton>
      </div>
    );
  }

  return (
    <div className={`composer${disabled ? " composer-disabled" : ""}`}>
      <div className="composer-card">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入内容发送到当前终端…"
          disabled={disabled}
          rows={1}
        />
        <div className="composer-footer">
          <div className="composer-meta">
            {session && (
              <span className="composer-kind">{session.kind}</span>
            )}
            {session && <span className="pane-status-dot" data-state={session.state} />}
          </div>
          <div className="composer-actions">
            <IconButton title="折叠" onClick={() => setCollapsed(true)}>
              <ChevronDown {...ICON_DEFAULTS} />
            </IconButton>
            <button
              type="button"
              className="composer-send"
              onClick={send}
              disabled={disabled || !text.trim()}
              title="发送 (Enter)"
            >
              <ArrowUp size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
