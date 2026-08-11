import { useQuery } from "@tanstack/react-query";

import { chatDraftMetaOptions } from "@/features/chat/queries";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

type UseChatDraftMetaArgs = {
  activeOrganizationId: string;
  threadRef: ChatThreadRef;
};

/**
 * Draft thread metadata for the chat home, plus the key it is cached under
 * (the model-change writer updates that entry in place).
 *
 * The key hangs off `chatKeys.threadPrefix`, so the web-search PATCH's
 * `invalidateChatThread` refetches it; without that match the toggle would
 * flip server-side while the hero kept showing the previous state.
 */
export const useChatDraftMeta = ({
  activeOrganizationId,
  threadRef,
}: UseChatDraftMetaArgs) => {
  const options = chatDraftMetaOptions({ activeOrganizationId, threadRef });
  const { data } = useQuery(options);

  return { draftMeta: data, draftMetaQueryKey: options.queryKey };
};
