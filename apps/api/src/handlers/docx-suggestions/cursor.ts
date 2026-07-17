import type { SafeId } from "@/api/lib/branded-types";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedDocxSuggestionId } from "@/api/lib/safe-id-boundaries";

/**
 * Keyset cursor for the entity's suggestion list: oldest-first by
 * `(created_at, id)`, matching the `docx_suggestions_ws_entity_created_idx`
 * composite index. Kept in its own module (not exported from the endpoint)
 * per the domain-cursor-helper convention.
 */
export type DocxSuggestionCursor = {
  createdAt: Date;
  id: SafeId<"docxSuggestion">;
};

export const encodeDocxSuggestionCursor = ({
  createdAt,
  id,
}: DocxSuggestionCursor): string =>
  encodePaginationCursor([createdAt.toISOString(), id]);

export const decodeDocxSuggestionCursor = (
  cursor: string,
): DocxSuggestionCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    return null;
  }

  const createdAt = parseDateTimePaginationCursorPart(parts.at(0));
  const rawId = parts.at(1);
  if (createdAt === null || !isUuidPaginationCursorPart(rawId)) {
    return null;
  }

  return { createdAt, id: brandPersistedDocxSuggestionId(rawId) };
};
