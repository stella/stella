import type { QueryClient } from "@tanstack/react-query";

import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import type { ChatThreadOptionsContext } from "@/features/chat/chat-query-contract";
import { buildChatRequestMessage } from "@/features/chat/lib/build-chat-request-message";
import { chatThreadOptions } from "@/features/chat/queries";
import { setThreadActiveSkill } from "@/features/chat/thread-active-skill-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

type StartNewThreadCommandHandoffArgs = {
  activeOrganizationId: string;
  context: ChatThreadOptionsContext;
  files: ChatDraftAttachment[];
  html: string;
  queryClient: QueryClient;
  threadRef: ChatThreadRef;
};

/**
 * Starts `/new <message>` on a fresh thread before its destination mounts.
 *
 * The caller changes surface only after this returns, so a setup failure
 * bubbles to the editor and restores the original text and attachments.
 *
 * A skill in `context` is stored for the new thread first: until the
 * server has saved the thread, the destination page has no other record
 * of it.
 */
export const startNewThreadCommandHandoff = async ({
  activeOrganizationId,
  context,
  files,
  html,
  queryClient,
  threadRef,
}: StartNewThreadCommandHandoffArgs): Promise<void> => {
  const activeSkill = context.getActiveSkill?.();
  if (activeSkill !== undefined) {
    setThreadActiveSkill(threadRef, activeSkill);
  }
  const [message, data, { acquireChatRuntime }] = await Promise.all([
    buildChatRequestMessage({ files, html }),
    queryClient.query({
      ...chatThreadOptions({
        activeOrganizationId,
        context,
        key: threadRef,
      }),
      staleTime: "static",
    }),
    import("@/features/chat/chat-runtime-registry"),
  ]);
  const chat = acquireChatRuntime({
    activeOrganizationId,
    context,
    data,
    key: threadRef,
    queryClient,
  });

  await chat.startRouteHandoffMessage(message, {
    timingSurface: "chat-thread",
  });
};
