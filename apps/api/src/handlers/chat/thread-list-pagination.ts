import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedChatThreadId } from "@/api/lib/safe-id-boundaries";

const CURSOR_SEPARATOR = "|";
const CURSOR_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ChatThreadListCursor = {
  id: SafeId<"chatThread">;
  updatedAt: string;
};

export const encodeChatThreadListCursor = ({
  id,
  updatedAt,
}: ChatThreadListCursor): string => `${updatedAt}${CURSOR_SEPARATOR}${id}`;

export const decodeChatThreadListCursor = (
  cursor: string,
): ChatThreadListCursor | null => {
  const separatorIndex = cursor.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const updatedAt = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + 1);
  if (!isValidCursorTimestamp(updatedAt) || !UUID_RE.test(id)) {
    return null;
  }

  return { id: brandPersistedChatThreadId(id), updatedAt };
};

const isValidCursorTimestamp = (timestamp: string): boolean => {
  const match = CURSOR_TIMESTAMP_RE.exec(timestamp);
  if (!match) {
    return false;
  }

  const [, year, month, day, hour, minute, second, microsecond] = match;
  const parts = [year, month, day, hour, minute, second, microsecond].map(
    Number,
  );
  const [
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
    microsecondValue,
  ] = parts;
  if (
    yearValue === undefined ||
    monthValue === undefined ||
    dayValue === undefined ||
    hourValue === undefined ||
    minuteValue === undefined ||
    secondValue === undefined ||
    microsecondValue === undefined ||
    yearValue < 1 ||
    monthValue < 1 ||
    monthValue > 12 ||
    dayValue < 1 ||
    hourValue > 23 ||
    minuteValue > 59 ||
    secondValue > 59 ||
    microsecondValue > 999_999
  ) {
    return false;
  }

  const date = new Date(
    Date.UTC(
      yearValue,
      monthValue - 1,
      dayValue,
      hourValue,
      minuteValue,
      secondValue,
      Math.floor(microsecondValue / 1000),
    ),
  );

  return (
    date.getUTCFullYear() === yearValue &&
    date.getUTCMonth() === monthValue - 1 &&
    date.getUTCDate() === dayValue &&
    date.getUTCHours() === hourValue &&
    date.getUTCMinutes() === minuteValue &&
    date.getUTCSeconds() === secondValue
  );
};
