import { sha256Base64Url as hashSha256Base64Url } from "@stll/sha256/bun";

import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

export const encodeActorCursor = (search: string, actorId: string) =>
  encodePaginationCursor([hashSha256Base64Url(search), actorId]);

export const decodeActorCursor = (
  cursor: string,
  search: string,
): string | null => {
  const parts = decodePaginationCursor(cursor);
  const cursorSearchKey = parts?.at(0);
  const actorId = parts?.at(1);
  return parts?.length === 2 &&
    cursorSearchKey === hashSha256Base64Url(search) &&
    typeof actorId === "string"
    ? actorId
    : null;
};
