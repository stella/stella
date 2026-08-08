import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { entities, fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createTimestampIdCursorCodec,
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityId,
  brandPersistedFieldId,
} from "@/api/lib/safe-id-boundaries";

const isStringPart = (value: unknown): value is string =>
  typeof value === "string";

const entityListCursorCodec = createTimestampIdCursorCodec({
  column: entities.createdAt,
  brandId: brandPersistedEntityId,
  // Older internal tests and development data used non-UUID branded ids;
  // retain the prior string validation while centralizing the timestamp codec.
  isIdPart: isStringPart,
});

export const entityListTimestampCursorExpr = (expr: SQL): SQL<string> =>
  pgTimestampCursorValue(expr);

type EntityListCursor = {
  createdAt: string;
  id: SafeId<"entity">;
};

type EntityFileListCursor = EntityListCursor & {
  fieldId: SafeId<"field">;
};

export const encodeEntityListCursor = ({
  createdAt,
  id,
}: {
  createdAt: string;
  id: SafeId<"entity"> | string;
}): string => entityListCursorCodec.encode(createdAt, id);

export const encodeEntityFileListCursor = ({
  createdAt,
  fieldId,
  id,
}: {
  createdAt: string;
  fieldId: SafeId<"field"> | string;
  id: SafeId<"entity"> | string;
}): string => encodePaginationCursor([createdAt, id, fieldId]);

export const decodeEntityListCursor = (
  cursor: string | undefined,
): EntityListCursor | null => {
  if (cursor === undefined) {
    return null;
  }
  const decoded = entityListCursorCodec.decode(cursor);
  if (decoded === null) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }
  return { createdAt: decoded.timestamp.value, id: decoded.id };
};

export const decodeEntityFileListCursor = (
  cursor: string | undefined,
): EntityFileListCursor | null => {
  if (cursor === undefined) {
    return null;
  }

  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 3) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }
  const createdAt = parts.at(0);
  const id = parts.at(1);
  const fieldId = parts.at(2);
  if (
    typeof createdAt !== "string" ||
    parsePgTimestampCursorValue(createdAt) === null ||
    !isStringPart(id) ||
    !isStringPart(fieldId)
  ) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }

  return {
    createdAt,
    fieldId: brandPersistedFieldId(fieldId),
    id: brandPersistedEntityId(id),
  };
};

export const entityListCursorCondition = (
  cursor: EntityListCursor | null,
): SQL | undefined => {
  if (cursor === null) {
    return undefined;
  }
  const timestamp = parsePgTimestampCursorValue(cursor.createdAt);
  if (timestamp === null) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }
  return entityListCursorCodec.keysetAfter({
    cursor: { timestamp, id: cursor.id },
    direction: "ascending",
    idColumn: entities.id,
  });
};

export const entityFileListCursorCondition = (
  cursor: EntityFileListCursor | null,
): SQL | undefined => {
  if (cursor === null) {
    return undefined;
  }
  const timestamp = parsePgTimestampCursorValue(cursor.createdAt);
  if (timestamp === null) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }
  if (timestamp.precision === "milliseconds") {
    return sql`${entities.createdAt} >= ${pgTimestampCursorBoundary(timestamp)} + interval '1 millisecond'`;
  }
  return sql`(${entities.createdAt}, ${entities.id}, ${fields.id}) > (${pgTimestampCursorBoundary(timestamp)}, ${cursor.id}, ${cursor.fieldId})`;
};
