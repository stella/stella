import type { SafeDb } from "@/api/db/safe-db";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import {
  THREAD_STORED_CONTENT_SEND_MODE,
  threadStoredContentSendModeOf,
} from "@/api/lib/chat/thread-stored-content-send-mode";

type ReadThreadTitleInputOptions = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  messages: readonly Pick<ChatMessage, "role" | "parts">[];
};

/** Detached follow-ups take a new snapshot rather than inheriting the completed turn's verdict. */
export const readThreadTitleInput = async ({
  safeDb,
  threadId,
  userId,
  messages,
}: ReadThreadTitleInputOptions) =>
  await safeDb(async (tx) => {
    const thread = await tx.query.chatThreads.findFirst({
      where: { id: { eq: threadId }, userId: { eq: userId } },
      columns: { usedAnonymization: true, subjectDecisionId: true },
    });
    if (
      threadStoredContentSendModeOf(thread) ===
      THREAD_STORED_CONTENT_SEND_MODE.anonymized
    ) {
      return { type: "anonymized" } as const;
    }
    const projection = await readWithdrawnCopyProjection({
      values: [thread, messages],
      snapshot: "fresh",
    });
    const marker = projection.marker(messages, thread?.subjectDecisionId);
    if (marker !== null) {
      return { type: "withdrawn", marker } as const;
    }
    return { type: "available", messages } as const;
  });
