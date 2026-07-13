import type { ChatMessage } from "../api/types";

const NATIVE_TAB_PREFIX = "native:";

export function nativeConversationTabId(conversationId: string): string {
  return `${NATIVE_TAB_PREFIX}${conversationId}`;
}

export function parseNativeConversationTabId(tabId: string): string | null {
  return tabId.startsWith(NATIVE_TAB_PREFIX)
    ? tabId.slice(NATIVE_TAB_PREFIX.length)
    : null;
}

export function buildConversationPrompt(messages: ChatMessage[]): string {
  const transcript = messages
    .map((message) =>
      `${message.role === "user" ? "用户" : "助手"}：${message.content}`,
    )
    .join("\n\n");
  return `请继续下面的对话，直接回答最后一条用户消息。\n\n${transcript}`;
}
