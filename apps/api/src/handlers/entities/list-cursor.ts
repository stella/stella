import { and, gt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { entities, fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityId,
  brandPersistedFieldId,
} from "@/api/lib/safe-id-boundaries";

export const ENTITY_LIST_TIMESTAMP_CURSOR_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US';

const entityListTimestampCursorPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/u;

export const entityListTimestampCursorExpr = (expr: SQL): SQL<string> =>
  sql<string>`to_char(${expr}, ${ENTITY_LIST_TIMESTAMP_CURSOR_FORMAT})`;

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
}): string => encodePaginationCursor([createdAt, id]);

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

  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }

  const createdAt = parts.at(0);
  const id = parts.at(1);

  if (
    typeof createdAt !== "string" ||
    !entityListTimestampCursorPattern.test(createdAt) ||
    typeof id !== "string"
  ) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }

  return { createdAt, id: brandPersistedEntityId(id) };
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
    !entityListTimestampCursorPattern.test(createdAt) ||
    typeof id !== "string" ||
    typeof fieldId !== "string"
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

  return (
    or(
      sql`${entities.createdAt} > ${cursor.createdAt}::timestamp`,
      and(
        sql`${entities.createdAt} = ${cursor.createdAt}::timestamp`,
        gt(entities.id, cursor.id),
      ),
    ) ?? undefined
  );
};

export const entityFileListCursorCondition = (
  cursor: EntityFileListCursor | null,
): SQL | undefined => {
  if (cursor === null) {
    return undefined;
  }

  return (
    or(
      sql`${entities.createdAt} > ${cursor.createdAt}::timestamp`,
      and(
        sql`${entities.createdAt} = ${cursor.createdAt}::timestamp`,
        gt(entities.id, cursor.id),
      ),
      and(
        sql`${entities.createdAt} = ${cursor.createdAt}::timestamp`,
        sql`${entities.id} = ${cursor.id}`,
        gt(fields.id, cursor.fieldId),
      ),
    ) ?? undefined
  );
};
