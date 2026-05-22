import { and, gt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

export const ENTITY_LIST_TIMESTAMP_CURSOR_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US';

const entityListTimestampCursorPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/u;

export const entityListTimestampCursorExpr = (expr: SQL): SQL<string> =>
  sql<string>`to_char(${expr}, ${ENTITY_LIST_TIMESTAMP_CURSOR_FORMAT})`;

type EntityListCursor = {
  createdAt: string;
  id: SafeId<"entity">;
};

export const encodeEntityListCursor = ({
  createdAt,
  id,
}: {
  createdAt: string;
  id: SafeId<"entity"> | string;
}): string => encodePaginationCursor([createdAt, id]);

export const decodeEntityListCursor = (
  cursor: string | undefined,
): EntityListCursor | null => {
  if (cursor === undefined) {
    return null;
  }

  const parts = decodePaginationCursor(cursor);
  const createdAt = parts?.at(0);
  const id = parts?.at(1);

  if (
    typeof createdAt !== "string" ||
    !entityListTimestampCursorPattern.test(createdAt) ||
    typeof id !== "string"
  ) {
    throw new HandlerError({ status: 400, message: "Invalid cursor" });
  }

  return { createdAt, id: brandPersistedEntityId(id) };
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
