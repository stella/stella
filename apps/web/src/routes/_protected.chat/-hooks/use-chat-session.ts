import { useCallback, useMemo, useState } from "react";

import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import { isToolUIPart } from "ai";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";
import { EntityLink } from "@/components/chat/entity-link";
import type { ChatActor } from "@/lib/api";
import { eventHandlerV2 } from "@/lib/rivet";
import { useSuspenseChatActor } from "@/routes/_protected.chat/-hooks/chat-actor-provider";

// Type-level helper; no reactive state, safe at module scope.
const chatEvent = eventHandlerV2<ChatActor>();

type UseChatSessionOptions = {
  chat: Chat<ChatMessage>;
  threadId: string;
};

export const useChatSession = ({ chat, threadId }: UseChatSessionOptions) => {
  const actor = useSuspenseChatActor();

  const [autoApprovedTools, setAutoApprovedTools] = useState(
    () => new Set<string>(),
  );

  const {
    messages,
    sendMessage,
    setMessages,
    stop,
    status,
    addToolApprovalResponse,
  } = useChat({
    chat,
    resume: true,
  });

  const handleApprove = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: true }),
    [addToolApprovalResponse],
  );
  const handleDeny = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: false }),
    [addToolApprovalResponse],
  );
  const handleAlwaysAllow = useCallback(
    (toolName: string) =>
      setAutoApprovedTools((prev) => new Set(prev).add(toolName)),
    [],
  );

  // Stable Streamdown overrides for mention links.
  const streamdownComponents = useMemo(() => ({ a: EntityLink }), []);

  // Dim non-approval messages when an approval is pending.
  const approvalPendingMessageId = useMemo(() => {
    for (const msg of messages) {
      if (msg.role !== "assistant") {
        continue;
      }
      for (const part of msg.parts) {
        if (isToolUIPart(part) && part.state === "approval-requested") {
          return msg.id;
        }
      }
    }
    return null;
  }, [messages]);

  // When another connection starts streaming for this
  // thread, stop any local stream, sync messages, and
  // resume so this tab picks up the in-progress generation.
  actor.useEvent(
    ...chatEvent("stream-started", async (data) => {
      if (data.threadId !== threadId || data.chatId === chat.id) {
        return;
      }
      await stop();
      const latest = await actor.connection.getMessages({
        threadId,
      });
      // SAFETY: messages from the actor are structurally
      // ChatMessage — narrowing adds typed tool parts.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      setMessages(latest as ChatMessage[]);
      await chat.resumeStream();
    }),
  );

  const isGenerating = status === "submitted" || status === "streaming";

  return {
    messages,
    sendMessage,
    stop,
    isGenerating,
    autoApprovedTools,
    handleApprove,
    handleDeny,
    handleAlwaysAllow,
    streamdownComponents,
    approvalPendingMessageId,
  };
};
