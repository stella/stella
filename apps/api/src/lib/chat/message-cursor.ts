import { chatMessages } from "@/api/db/schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

/**
 * Keyset cursor over `chat_messages` in thread order.
 *
 * Compaction stores one of these on each checkpoint (`delta_cursor`) to mark
 * the last message it summarized. Every later read of the thread — the
 * compactor's delta batch and the send path's history window alike — seeks
 * from that cursor rather than from the start of the thread, which is what
 * keeps both bounded regardless of how long a conversation runs.
 *
 * Timestamps round-trip at full PostgreSQL microsecond precision, so two
 * messages recorded in the same millisecond are ordered by id rather than
 * collapsed onto the same boundary.
 */
export const chatMessageCursorCodec = createTimestampIdCursorCodec({
  column: chatMessages.createdAt,
  brandId: brandPersistedChatMessageId,
});
