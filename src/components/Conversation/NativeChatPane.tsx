import { useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  ManagedSession,
  NativePromptRequest,
  ProviderProfile,
  Workspace,
} from "../../api/types";
import { aiPrompt, managedSessionUpdate } from "../../api/commands";
import { buildConversationPrompt } from "../../lib/nativeConversation";
import {
  resolveConversationProvider,
  resolveProjectProvider,
} from "../../lib/providers";
import { selectProviders, useSettingsStore } from "../../store/settingsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { ProviderSelect } from "../settings/ProviderSelect";
import { Send } from "../ui/icons";
import {
  copyClipboardText,
  resolveClipboardPayload,
} from "../../lib/clipboard";

interface NativeChatPaneProps {
  conversation: ManagedSession;
  project: Workspace;
  providers: ProviderProfile[];
  onUpdate: (conversation: ManagedSession) => Promise<void>;
  runPrompt: (request: NativePromptRequest) => Promise<string>;
}

export function NativeChatPane({
  conversation,
  project,
  providers,
  onUpdate,
  runPrompt,
}: NativeChatPaneProps): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(conversation.messages ?? []);
  const [providerId, setProviderId] = useState(conversation.providerId ?? "");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationTokenRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    conversationTokenRef.current += 1;
    setMessages(conversation.messages ?? []);
    setProviderId(conversation.providerId ?? "");
    setDraft("");
    setSending(false);
    setError(null);
  }, [conversation.id]);

  useEffect(() => {
    setMessages(conversation.messages ?? []);
    setProviderId(conversation.providerId ?? "");
  }, [conversation.messages, conversation.providerId]);

  const selectedProvider = resolveConversationProvider(
    { providerId: providerId || undefined },
    project,
    providers,
  );

  const changeProvider = (nextProviderId: string): void => {
    setProviderId(nextProviderId);
    const provider = providers.find((item) => item.id === nextProviderId);
    const projectProvider = resolveProjectProvider(project, providers);
    void onUpdate({
      ...conversation,
      messages,
      providerId: nextProviderId || undefined,
      kind: provider?.driver ?? projectProvider?.driver ?? project.agent,
      updatedAt: new Date().toISOString(),
    });
  };

  const sendMessage = async (): Promise<void> => {
    const content = draft.trim();
    if (!content || sending || !selectedProvider) return;
    const conversationToken = conversationTokenRef.current;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const pendingMessages = [...messages, userMessage];
    const baseConversation: ManagedSession = {
      ...conversation,
      name:
        messages.length === 0 && conversation.name === "新会话"
          ? content.slice(0, 36)
          : conversation.name,
      providerId: providerId || undefined,
      kind: selectedProvider.driver,
      mode: "native",
      messages: pendingMessages,
      updatedAt: userMessage.createdAt,
    };

    setMessages(pendingMessages);
    setDraft("");
    setSending(true);
    setError(null);

    try {
      await onUpdate(baseConversation);

      const response = await runPrompt({
        workspaceId: project.id,
        providerId: selectedProvider.id,
        prompt: buildConversationPrompt(pendingMessages),
      });

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: response,
        createdAt: new Date().toISOString(),
      };
      const completedMessages = [...pendingMessages, assistantMessage];
      if (conversationTokenRef.current === conversationToken) {
        setMessages(completedMessages);
      }
      await onUpdate({
        ...baseConversation,
        messages: completedMessages,
        updatedAt: assistantMessage.createdAt,
      });
    } catch (cause) {
      if (conversationTokenRef.current === conversationToken) {
        setError(
          cause instanceof Error ? cause.message : "AI 请求失败，请检查供应商配置",
        );
      }
    } finally {
      if (conversationTokenRef.current === conversationToken) {
        setSending(false);
      }
    }
  };

  const insertDraftText = (value: string): void => {
    if (!value) return;
    const textarea = textareaRef.current;
    setDraft((current) => {
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
  };

  const handleDraftPaste = async (data?: DataTransfer | null): Promise<void> => {
    const payload = await resolveClipboardPayload(data);
    if (payload.kind !== "none") insertDraftText(payload.text);
  };

  const handleDraftCopy = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (start === end) return;
    event.preventDefault();
    void copyClipboardText(textarea.value.slice(start, end));
  };

  return (
    <div className="native-chat">
      <div className="native-chat-toolbar">
        <span className="native-chat-provider-label">供应商</span>
        <ProviderSelect
          providers={providers}
          value={providerId}
          inheritLabel="跟随项目默认"
          disabled={sending}
          onChange={changeProvider}
        />
      </div>

      <div className="native-chat-messages">
        {messages.length === 0 && (
          <div className="native-chat-empty">新会话</div>
        )}
        {messages.map((message) => (
          <article
            className={`native-message native-message-${message.role}`}
            key={message.id}
          >
            <div className="native-message-role">
              {message.role === "user" ? "你" : selectedProvider?.name ?? "AI"}
            </div>
            <div className="native-message-content">{message.content}</div>
          </article>
        ))}
        {sending && <div className="native-chat-pending">正在生成...</div>}
        {error && <div className="native-chat-error">{error}</div>}
      </div>

      <div className="native-composer">
        <textarea
          ref={textareaRef}
          aria-label="消息"
          value={draft}
          rows={3}
          placeholder={selectedProvider ? "输入消息" : "请先为项目选择供应商"}
          disabled={!selectedProvider || sending}
          onChange={(event) => setDraft(event.target.value)}
          onCopy={handleDraftCopy}
          onPaste={(event) => {
            event.preventDefault();
            void handleDraftPaste(event.clipboardData);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleDraftPaste(event.dataTransfer);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button
          type="button"
          className="native-send-btn"
          aria-label="发送消息"
          title="发送消息"
          disabled={!draft.trim() || !selectedProvider || sending}
          onClick={() => void sendMessage()}
        >
          <Send size={16} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

export function NativeChatPaneHost({
  conversationId,
}: {
  conversationId: string;
}): React.JSX.Element {
  const conversation = useWorkspaceStore((state) => {
    for (const list of Object.values(state.historyCache)) {
      const found = list.find((item) => item.id === conversationId);
      if (found) return found;
    }
    return undefined;
  });
  const project = useWorkspaceStore((state) =>
    conversation
      ? state.workspaces.find((item) => item.id === conversation.workspaceId)
      : undefined,
  );
  const loadHistory = useWorkspaceStore((state) => state.loadHistory);
  const providers = useSettingsStore(selectProviders);

  if (!conversation || !project) {
    return <div className="pane-empty">会话不存在</div>;
  }

  return (
    <NativeChatPane
      conversation={conversation}
      project={project}
      providers={providers}
      runPrompt={aiPrompt}
      onUpdate={async (updated) => {
        await managedSessionUpdate(updated);
        await loadHistory(project.id);
      }}
    />
  );
}
