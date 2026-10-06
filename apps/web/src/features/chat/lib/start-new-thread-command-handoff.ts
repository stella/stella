import type { QueryClient } from "@tanstack/react-query";

import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import { persistChatModelSelection } from "@/components/chat/use-chat-model-selection";
import type { ChatThreadOptionsContext } from "@/features/chat/chat-query-contract";
import { buildChatRequestMessage } from "@/features/chat/lib/build-chat-request-message";
import { acquireChatRuntime, chatThreadOptions } from "@/features/chat/queries";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

type StartNewThreadCommandHandoffArgs = {
  activeOrganizationId: string;
  context: ChatThreadOptionsContext;
  files: ChatDraftAttachment[];
  html: string;
  queryClient: QueryClient;
  threadRef: ChatThreadRef;
  isCurrent: () => boolean;
};

/**
 * Starts `/new <message>` on a fresh thread before its destination mounts.
 *
 * The caller changes surface only after this returns, so a setup failure
 * bubbles to the editor and restores the original text and attachments.
 */
export const startNewThreadCommandHandoff = async ({
  activeOrganizationId,
  context,
  files,
  html,
  queryClient,
  threadRef,
  isCurrent,
}: StartNewThreadCommandHandoffArgs): Promise<void> => {
  const [message, data] = await Promise.all([
    buildChatRequestMessage({ files, html }),
    queryClient.query({
      ...chatThreadOptions({
        activeOrganizationId,
        context,
        key: threadRef,
      }),
      staleTime: "static",
    }),
  ]);
  if (!isCurrent()) {
    return;
  }
  if (
    (!data.threadExists || data.modelSelectionSource === "carried") &&
    (data.model !== null || data.reasoningEffort !== null)
  ) {
    const selection = await persistChatModelSelection({
      threadRef,
      selection: { model: data.model, reasoningEffort: data.reasoningEffort },
    });
    selection.unwrap();
  }
  if (!isCurrent()) {
    return;
  }
  const chat = acquireChatRuntime({
    activeOrganizationId,
    context,
    data,
    key: threadRef,
    queryClient,
  });

  chat.startRouteHandoffMessage(message);
};
