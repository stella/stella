import { and, eq, gt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  parseDateTimePaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

type EntityListCursor = {
  createdAt: Date;
  id: SafeId<"entity">;
};

export const encodeEntityListCursor = ({
  createdAt,
  id,
}: {
  createdAt: Date;
  id: SafeId<"entity"> | string;
}): string => encodePaginationCursor([createdAt.toISOString(), id]);

export const decodeEntityListCursor = (
  cursor: string | undefined,
): EntityListCursor | null => {
  if (cursor === undefined) {
    return null;
  }

  const parts = decodePaginationCursor(cursor);
  const createdAt = parseDateTimePaginationCursorPart(parts?.at(0));
  const id = parts?.at(1);

  if (createdAt === null || typeof id !== "string") {
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
      gt(entities.createdAt, cursor.createdAt),
      and(eq(entities.createdAt, cursor.createdAt), gt(entities.id, cursor.id)),
    ) ?? undefined
  );
};
