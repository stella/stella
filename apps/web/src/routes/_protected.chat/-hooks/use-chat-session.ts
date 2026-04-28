import { createElement, useCallback, useMemo, useState } from "react";
import type { ComponentProps } from "react";

import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { isToolUIPart } from "ai";

import type {
  ApprovalToolName,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { invalidateGroupedChatThreads } from "@/routes/_protected.chat/-queries";

type UseChatSessionOptions = {
  chat: Chat<PersistedChatMessage>;
  workspaceId?: string | undefined;
};

export const useChatSession = ({
  chat,
  workspaceId,
}: UseChatSessionOptions) => {
  const queryClient = useQueryClient();
  const [autoApprovedTools, setAutoApprovedTools] = useState(
    () => new Set<ApprovalToolName>(),
  );

  const {
    messages,
    sendMessage: sendChatMessage,
    stop,
    status,
    addToolApprovalResponse,
  } = useChat({ chat });

  const sendMessage = useCallback(
    async (message: Parameters<typeof sendChatMessage>[0]) => {
      await sendChatMessage(message);
      await invalidateGroupedChatThreads(queryClient);
    },
    [queryClient, sendChatMessage],
  );

  const handleApprove = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: true }),
    [addToolApprovalResponse],
  );
  const handleDeny = useCallback(
    (id: string) => addToolApprovalResponse({ id, approved: false }),
    [addToolApprovalResponse],
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
