import { useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";
import {
  resolveSuggestedPromptsAvailability,
  resolveSuggestedPromptsTurnOwner,
} from "@/features/chat/lib/suggested-prompts-availability";
import { chatThreadSuggestedPromptsOptions } from "@/features/chat/queries";
import { useIsChatDraftEmpty } from "@/lib/chat-draft-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

type UseSuggestedFollowupPromptsOptions = {
  activeOrganizationId: string;
  approvalPendingMessageId: string | null;
  error: Error | undefined;
  isGenerating: boolean;
  messages: readonly ChatMessage[];
  threadRef: ChatThreadRef;
  turnAbandoned: boolean;
};

/**
 * Follow-up prompts for a thread's last assistant turn. They are fetched only
 * while the draft is empty and nothing else owns the turn (generation, a
 * pending approval, or an ask-user card reopened for editing), so typing does
 * not trigger the query.
 */
export const useSuggestedFollowupPrompts = ({
  activeOrganizationId,
  approvalPendingMessageId,
  error,
  isGenerating,
  messages,
  threadRef,
  turnAbandoned,
}: UseSuggestedFollowupPromptsOptions) => {
  const lastMessage = messages.at(-1);
  const [editingAskUserToolCallIds, setEditingAskUserToolCallIds] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const handleAskUserEditingChange = useCallback(
    (toolCallId: string, isEditing: boolean) => {
      setEditingAskUserToolCallIds((current) => {
        if (current.has(toolCallId) === isEditing) {
          return current;
        }
        const next = new Set(current);
        if (isEditing) {
          next.add(toolCallId);
        } else {
          next.delete(toolCallId);
        }
        return next;
      });
    },
    [],
  );
  const editorIsInitiallyEmpty = useIsChatDraftEmpty(threadRef);
  const suggestedPromptsAvailability = resolveSuggestedPromptsAvailability({
    editorIsEmpty: editorIsInitiallyEmpty,
    error,
    isGenerating,
    lastMessage: lastMessage ?? null,
    turnAbandoned,
    turnOwner: resolveSuggestedPromptsTurnOwner({
      approvalPendingMessageId,
      hasReopenedAskUser: editingAskUserToolCallIds.size > 0,
      lastMessage: lastMessage ?? null,
    }),
  });
  const lastMessageId =
    suggestedPromptsAvailability.status === "eligible"
      ? suggestedPromptsAvailability.lastMessageId
      : "";
  const { data: suggestedPromptsData } = useQuery(
    chatThreadSuggestedPromptsOptions({
      activeOrganizationId,
      enabled: suggestedPromptsAvailability.status === "eligible",
      lastMessageId,
      threadRef,
    }),
  );
  const suggestedPrompts =
    suggestedPromptsAvailability.status === "eligible" && suggestedPromptsData
      ? suggestedPromptsData.prompts
      : [];

  return {
    handleAskUserEditingChange,
    lastMessageId,
    suggestedFollowupPrompt: suggestedPrompts.at(0) ?? undefined,
    suggestedPrompts,
  };
};
