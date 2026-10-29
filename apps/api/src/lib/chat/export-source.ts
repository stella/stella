import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";

import { readChatCopyProjection } from "./withdrawn-copies";

type ReadChatExportSourceOptions = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  messageId: SafeId<"chatMessage">;
  userId: SafeId<"user">;
};

/** Exporters receive the same projected content as the transcript and model context. */
export const readChatExportSource = async ({
  safeDb,
  threadId,
  messageId,
  userId,
}: ReadChatExportSourceOptions) =>
  await safeDb(async (tx) => {
    const thread = await tx.query.chatThreads.findFirst({
      where: { id: { eq: threadId }, userId: { eq: userId } },
      columns: {
        title: true,
        titleSource: true,
        subjectDecisionId: true,
        workspaceId: true,
      },
      with: {
        messages: {
          where: { id: { eq: messageId } },
          columns: { content: true, role: true },
        },
      },
    });
    if (thread === undefined) {
      return undefined;
    }
    const { projection } = await readChatCopyProjection({
      tx,
      threadIds: [threadId],
      values: thread,
    });
    return {
      ...thread,
      title: projection.thread(thread).title,
      messages: thread.messages.map((row) =>
        projection.chat(row, thread.subjectDecisionId),
      ),
    };
  });
