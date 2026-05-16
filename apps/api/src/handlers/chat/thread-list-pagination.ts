import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedChatThreadId } from "@/api/lib/safe-id-boundaries";

const CURSOR_SEPARATOR = "|";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ChatThreadListCursor = {
  id: SafeId<"chatThread">;
  updatedAt: Date;
};

export const encodeChatThreadListCursor = ({
  id,
  updatedAt,
}: ChatThreadListCursor): string =>
  `${updatedAt.toISOString()}${CURSOR_SEPARATOR}${id}`;

export const decodeChatThreadListCursor = (
  cursor: string,
): ChatThreadListCursor | null => {
  const separatorIndex = cursor.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const updatedAt = new Date(cursor.slice(0, separatorIndex));
  const id = cursor.slice(separatorIndex + 1);
  if (Number.isNaN(updatedAt.getTime()) || !UUID_RE.test(id)) {
    return null;
  }

  return { id: brandPersistedChatThreadId(id), updatedAt };
};
