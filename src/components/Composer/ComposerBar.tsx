/**
 * ComposerBar — 单个终端窗格的输入卡片，回车发送到该窗格的活动终端 stdin。
 * 每个窗格各自挂载组件，因此草稿、选区和发送目标互不共享。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../store/sessionStore";
import { ptyWrite } from "../../api/commands";
import {
  copyClipboardText,
  resolveClipboardPayload,
} from "../../lib/clipboard";
import { IconButton } from "../ui/IconButton";
import { ChevronDown, ChevronUp, ArrowUp, ICON_DEFAULTS } from "../ui/icons";

const LS_KEY_PREFIX = "tht-composer-collapsed:";

interface ComposerBarProps {
  leafId: string;
  sessionId: string | null;
}

export function ComposerBar({ leafId, sessionId }: ComposerBarProps): React.JSX.Element {
  const collapsedStorageKey = `${LS_KEY_PREFIX}${leafId}`;
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(collapsedStorageKey) === "1",
  );
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const session = useSessionStore((s) => sessionId ? s.sessions[sessionId] : undefined);
  const disabled = !sessionId || !session || session.state === "dead" || sending;

  useEffect(() => {
    localStorage.setItem(collapsedStorageKey, collapsed ? "1" : "0");
  }, [collapsed, collapsedStorageKey]);

  const send = useCallback(async (): Promise<void> => {
    if (!sessionId || !session || !text.trim() || sending) return;
    const payload = `\x1b[200~${text}\x1b[201~\r`;
    setSending(true);
    setSendError(null);
    try {
      await ptyWrite(sessionId, payload);
      setText("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "发送失败，请检查终端状态");
    } finally {
      setSending(false);
    }
  }, [session, sessionId, sending, text]);

  const insertClipboardText = useCallback((value: string): void => {
    if (!value) return;
    const textarea = textareaRef.current;
    setText((current) => {
      const start = textarea?.selectionStart ?? current.length;
      const end = textarea?.selectionEnd ?? start;
      const next = `${current.slice(0, start)}${value}${current.slice(end)}`;
      queueMicrotask(() => {
        const target = textareaRef.current;
        if (!target) return;
        const caret = start + value.length;
        target.focus();
        target.setSelectionRange(caret, caret);
      });
      return next;
    });
  }, []);

  const handlePaste = useCallback(async (data?: DataTransfer | null): Promise<void> => {
    const payload = await resolveClipboardPayload(data);
    if (payload.kind !== "none") insertClipboardText(payload.text);
  }, [insertClipboardText]);

  const handleCopy = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (start === end) return;
    event.preventDefault();
    void copyClipboardText(textarea.value.slice(start, end));
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
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
      <div
        className="composer-collapsed"
        onClick={(event) => {
          event.stopPropagation();
          setCollapsed(false);
        }}
      >
        <span className="composer-collapsed-hint">输入内容发送到终端…</span>
        <IconButton
          title="展开输入框"
          onClick={(event) => {
            event.stopPropagation();
            setCollapsed(false);
          }}
        >
          <ChevronUp {...ICON_DEFAULTS} />
        </IconButton>
      </div>
    );
  }

  return (
    <div
      className={`composer${disabled ? " composer-disabled" : ""}`}
      data-pane-drag-ignore
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="composer-card">
        {sendError && <div className="composer-error" role="alert">{sendError}</div>}
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onCopy={handleCopy}
          onPaste={(event) => {
            event.preventDefault();
            void handlePaste(event.clipboardData);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void handlePaste(event.dataTransfer);
          }}
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
            <IconButton
              title="折叠"
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed(true);
              }}
            >
              <ChevronDown {...ICON_DEFAULTS} />
            </IconButton>
            <button
              type="button"
              className="composer-send"
              onClick={() => void send()}
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
