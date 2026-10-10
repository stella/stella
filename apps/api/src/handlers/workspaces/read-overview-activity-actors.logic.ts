import { sha256Base64Url as hashSha256Base64Url } from "@stll/sha256/bun";

import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

const actorSearchKey = (search: string) => hashSha256Base64Url(search);

export const encodeActorCursor = (search: string, actorId: string) =>
  encodePaginationCursor([actorSearchKey(search), actorId]);

export const decodeActorCursor = (
  cursor: string,
  search: string,
): string | null => {
  const parts = decodePaginationCursor(cursor);
  const cursorSearchKey = parts?.at(0);
  const actorId = parts?.at(1);
  return parts?.length === 2 &&
    cursorSearchKey === actorSearchKey(search) &&
    typeof actorId === "string"
    ? actorId
    : null;
};
