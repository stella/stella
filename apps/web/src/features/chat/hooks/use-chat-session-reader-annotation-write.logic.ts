import type { QueryClient } from "@tanstack/react-query";

import {
  consumeReaderAnnotationWriteToolCalls,
  type ReaderAnnotationWriteMessage,
} from "@/components/chat/chat-ui-tools";
import { readerAnnotationKeys } from "@/components/legal-reader/annotations/reader-annotations-query";

type ReconcileReaderAnnotationWriteToolCallsOptions = {
  handledToolCallIds: Set<string>;
  messages: readonly ReaderAnnotationWriteMessage[];
  queryClient: QueryClient;
};

/**
 * A chat annotation write runs outside the reader's own mutations, and its
 * inputs name the document by opaque chat ref, so every reader's marks are
 * refetched: the open reader's margin then shows what the chat changed.
 */
export const reconcileReaderAnnotationWriteToolCalls = async ({
  handledToolCallIds,
  messages,
  queryClient,
}: ReconcileReaderAnnotationWriteToolCallsOptions): Promise<void> => {
  if (
    !consumeReaderAnnotationWriteToolCalls({ handledToolCallIds, messages })
  ) {
    return;
  }
  await queryClient.invalidateQueries({
    queryKey: readerAnnotationKeys.all,
  });
};
