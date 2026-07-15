import { Result } from "better-result";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import type { ParsedPgTimestampCursor } from "@/api/lib/db-pagination";
import {
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedStyleSetId } from "@/api/lib/safe-id-boundaries";
import { styleSetColumns } from "@/api/lib/style-sets";

const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.styleSetsPageSizeMax }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const config = {
  permissions: { styleSet: ["use"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  query: querySchema,
} satisfies HandlerConfig;

type StyleSetCursor = {
  updatedAt: ParsedPgTimestampCursor;
  id: SafeId<"styleSet">;
};

const decodeStyleSetCursor = (cursor: string): StyleSetCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const updatedAt = parsePgTimestampCursorValue(parts?.at(0));
  const id = parts?.at(1);
  if (!updatedAt || !isUuidPaginationCursorPart(id)) {
    return null;
  }

  return { updatedAt, id: brandPersistedStyleSetId(id) };
};

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    const limit = query.limit ?? LIMITS.styleSetsPageSizeDefault;
    const conditions = [
      eq(styleSets.organizationId, session.activeOrganizationId),
      isNull(styleSets.deletedAt),
    ];

    if (query.cursor) {
      const cursor = decodeStyleSetCursor(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = or(
        lt(styleSets.updatedAt, pgTimestampCursorBoundary(cursor.updatedAt)),
        and(
          eq(styleSets.updatedAt, pgTimestampCursorBoundary(cursor.updatedAt)),
          lt(styleSets.id, cursor.id),
        ),
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            ...styleSetColumns,
            updatedAtCursor: pgTimestampCursorValue(styleSets.updatedAt).as(
              "updated_at_cursor",
            ),
          })
          .from(styleSets)
          .where(and(...conditions))
          .orderBy(desc(styleSets.updatedAt), desc(styleSets.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.updatedAtCursor, item.id]),
    });

    return Result.ok({
      ...page,
      items: page.items.map((item) => ({
        id: item.id,
        name: item.name,
        fileName: item.fileName,
        sizeBytes: item.sizeBytes,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      styleSetsCountLimit: LIMITS.styleSetsCount,
    });
  },
);
