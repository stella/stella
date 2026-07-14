import { Result } from "better-result";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
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
  updatedAt: Date;
  id: SafeId<"styleSet">;
};

const decodeStyleSetCursor = (cursor: string): StyleSetCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const timestamp = parts?.at(0);
  const id = parts?.at(1);
  if (typeof timestamp !== "string" || !isUuidPaginationCursorPart(id)) {
    return null;
  }

  const updatedAt = new Date(timestamp);
  if (Number.isNaN(updatedAt.valueOf())) {
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
    ];

    if (query.cursor) {
      const cursor = decodeStyleSetCursor(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = or(
        lt(styleSets.updatedAt, cursor.updatedAt),
        and(
          eq(styleSets.updatedAt, cursor.updatedAt),
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
          .select(styleSetColumns)
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
        encodePaginationCursor([item.updatedAt.toISOString(), item.id]),
    });

    return Result.ok({
      ...page,
      styleSetsCountLimit: LIMITS.styleSetsCount,
    });
  },
);
