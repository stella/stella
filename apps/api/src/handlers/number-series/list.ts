import { Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { numberSeries } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedNumberSeriesId } from "@/api/lib/safe-id-boundaries";

const config = {
  description: "List active document number series in the active organization.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "billing_admin" },
  access: "read",
  query: t.Object({
    limit: t.Optional(
      t.Integer({ minimum: 1, maximum: LIMITS.numberSeriesPageSizeMax }),
    ),
    cursor: t.Optional(tPaginationCursor()),
  }),
} satisfies HandlerConfig;

const cursorCodec = createTimestampIdCursorCodec({
  column: numberSeries.createdAt,
  brandId: brandPersistedNumberSeriesId,
});

export default createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const limit = query.limit ?? LIMITS.numberSeriesPageSizeDefault;
    const conditions = [
      eq(numberSeries.organizationId, session.activeOrganizationId),
      isNull(numberSeries.archivedAt),
    ];
    if (query.cursor) {
      const cursor = cursorCodec.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const after = cursorCodec.keysetAfter({
        cursor,
        idColumn: numberSeries.id,
        direction: "descending",
      });
      if (after) {
        conditions.push(after);
      }
    }
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: numberSeries.id,
            documentType: numberSeries.documentType,
            name: numberSeries.name,
            pattern: numberSeries.pattern,
            padding: numberSeries.padding,
            sellerProfileId: numberSeries.sellerProfileId,
            isDefault: numberSeries.isDefault,
            createdAt: numberSeries.createdAt,
            updatedAt: numberSeries.updatedAt,
            createdAtCursor: cursorCodec.cursorValue.as("created_at_cursor"),
          })
          .from(numberSeries)
          .where(and(...conditions))
          .orderBy(desc(numberSeries.createdAt), desc(numberSeries.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (row) => cursorCodec.encode(row.createdAtCursor, row.id),
    });
    return Result.ok({
      ...page,
      items: page.items.map(({ createdAtCursor: _cursor, ...row }) => row),
    });
  },
);
