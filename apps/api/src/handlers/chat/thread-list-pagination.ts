import { chatThreads } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { brandPersistedChatThreadId } from "@/api/lib/safe-id-boundaries";

type ChatThreadListCursor = {
  id: SafeId<"chatThread">;
  updatedAt: string;
};

export const chatThreadListCursorCodec = createTimestampIdCursorCodec({
  column: chatThreads.updatedAt,
  brandId: brandPersistedChatThreadId,
});

export const encodeChatThreadListCursor = ({
  id,
  updatedAt,
}: ChatThreadListCursor): string =>
  chatThreadListCursorCodec.encode(updatedAt, id);

export const decodeChatThreadListCursor = (
  cursor: string,
): ChatThreadListCursor | null => {
  const decoded = chatThreadListCursorCodec.decode(cursor);
  return decoded === null
    ? null
    : { id: decoded.id, updatedAt: decoded.timestamp.value };
};
