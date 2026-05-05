import { createElement, useCallback, useMemo, useState } from "react";
import type { ComponentProps } from "react";

import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { isToolUIPart } from "ai";

import type {
  ApprovalToolName,
  AskUserOutput,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import {
  invalidateChatThread,
  invalidateGroupedChatThreads,
} from "@/routes/_protected.chat/-queries";

type UseChatSessionOptions = {
  chat: Chat<PersistedChatMessage>;
  threadRef: ChatThreadRef;
  workspaceId?: string | undefined;
};

export const useChatSession = ({
  chat,
  threadRef,
  workspaceId,
}: UseChatSessionOptions) => {
  const queryClient = useQueryClient();
  const [autoApprovedTools, setAutoApprovedTools] = useState(
    () => new Set<ApprovalToolName>(),
  );

  const {
    error,
    messages,
    regenerate,
    sendMessage: sendChatMessage,
    stop,
    status,
    addToolApprovalResponse,
    addToolOutput,
  } = useChat({ chat });

  const sendMessage = useCallback(
    async (message: Parameters<typeof sendChatMessage>[0]) => {
      await sendChatMessage(message);
      if (chat.status === "error" || chat.error) {
        return;
      }
      await invalidateChatThread({ queryClient, threadRef });
      await invalidateGroupedChatThreads(queryClient);
    },
    [chat, queryClient, sendChatMessage, threadRef],
  );

  const resendLatestMessage = useCallback(async () => {
    await regenerate();
    if (chat.status === "error" || chat.error) {
      return;
    }
    await invalidateChatThread({ queryClient, threadRef });
    await invalidateGroupedChatThreads(queryClient);
  }, [chat, queryClient, regenerate, threadRef]);

  const handleApprove = useCallback(
    (id: string, _toolName?: ApprovalToolName) =>
      addToolApprovalResponse({ id, approved: true }),
    [addToolApprovalResponse],
  );
  const handleDeny = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: false }),
    [addToolApprovalResponse],
  );
  const handleAskUserSubmit = useCallback(
    (toolCallId: string, output: AskUserOutput) =>
      addToolOutput({
        tool: "ask-user",
        toolCallId,
        output,
      }),
    [addToolOutput],
  );
  const handleAlwaysAllow = useCallback(
    (toolName: ApprovalToolName) =>
      setAutoApprovedTools((prev) => new Set(prev).add(toolName)),
    [],
  );

  const streamdownComponents = useMemo(
    () => ({
      a: (props: ComponentProps<"a">) =>
        createElement(StreamdownMentionLink, {
          ...props,
          interactive: true,
          workspaceId,
        }),
    }),
    [workspaceId],
  );

  const approvalPendingMessageId = useMemo(
    () => getCurrentApprovalPendingMessageId(messages),
    [messages],
  );

  const isGenerating = status === "submitted" || status === "streaming";

  return {
    error,
    messages,
    resendLatestMessage,
    sendMessage,
    stop,
    isGenerating,
    autoApprovedTools,
    handleApprove,
    handleDeny,
    handleAskUserSubmit,
    handleAlwaysAllow,
    addToolOutput,
    streamdownComponents,
    approvalPendingMessageId,
  };
};

const getCurrentApprovalPendingMessageId = (
  messages: PersistedChatMessage[],
) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages.at(index);
    if (!msg || msg.role !== "assistant") {
      continue;
    }

    for (const part of msg.parts) {
      if (isToolUIPart(part) && part.state === "approval-requested") {
        return msg.id;
      }
    }

    return null;
  }

  return null;
};
