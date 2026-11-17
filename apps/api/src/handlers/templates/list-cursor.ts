import { sql } from "drizzle-orm";

import { templates } from "@/api/db/schema";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  parsePreciseDateTimePaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedTemplateId } from "@/api/lib/safe-id-boundaries";

export const templateCursorCreatedAt = sql<string>`to_char(${templates.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const decodeTemplateListCursor = (cursor: string) => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 2) {
    return null;
  }
  const createdAt = parsePreciseDateTimePaginationCursorPart(parts.at(0));
  const id = parts.at(1);
  return createdAt !== null && isUuidPaginationCursorPart(id)
    ? { cursorCreatedAt: createdAt, id: brandPersistedTemplateId(id) }
    : null;
};

type TemplateCursorBoundary = NonNullable<
  ReturnType<typeof decodeTemplateListCursor>
>;

export const encodeTemplateListCursor = ({
  cursorCreatedAt,
  id,
}: TemplateCursorBoundary): string =>
  encodePaginationCursor([cursorCreatedAt, id]);

export const templateListCursorCondition = ({
  cursorCreatedAt,
  id,
}: TemplateCursorBoundary) =>
  sql`(${templates.createdAt}, ${templates.id}) < (${cursorCreatedAt}::timestamptz, ${id}::uuid)`;
