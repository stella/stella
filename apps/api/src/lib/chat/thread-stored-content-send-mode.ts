import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatThreads } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * How a request built from a thread's stored content outside the chat turn
 * (a title, a recap, suggested prompts, a compaction summary, memory
 * extraction) may send it. These requests have no anonymization step, so a
 * thread that ever used anonymized mode is not sent at all.
 */
export const THREAD_STORED_CONTENT_SEND_MODE = {
  anonymized: "anonymized",
  raw: "raw",
} as const;

export type ThreadStoredContentSendMode =
  (typeof THREAD_STORED_CONTENT_SEND_MODE)[keyof typeof THREAD_STORED_CONTENT_SEND_MODE];

export const threadStoredContentSendModeOf = (
  row: { usedAnonymization: boolean } | undefined,
): ThreadStoredContentSendMode =>
  // A missing thread reads as anonymized, so nothing is sent.
  row === undefined || row.usedAnonymization
    ? THREAD_STORED_CONTENT_SEND_MODE.anonymized
    : THREAD_STORED_CONTENT_SEND_MODE.raw;

/**
 * Read the send mode a thread's stored content leaves under, right before it
 * leaves. A turn sent in anonymized mode sets `used_anonymization` in the
 * transaction that stores it, so a read after the payload was loaded sees
 * every such turn that payload holds; a read taken earlier (at claim or queue
 * time) does not.
 */
export const readThreadStoredContentSendModeOnTx = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Pick<Transaction, "select">;
}): Promise<ThreadStoredContentSendMode> => {
  const rows = await tx
    .select({ usedAnonymization: chatThreads.usedAnonymization })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return threadStoredContentSendModeOf(rows.at(0));
};
