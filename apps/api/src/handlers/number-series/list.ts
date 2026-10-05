import { Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { numberSeries } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedNumberSeriesId } from "@/api/lib/safe-id-boundaries";

type NumberSeriesRow = typeof numberSeries.$inferSelect;

const UNPROJECTED_NUMBER_SERIES_COLUMNS = [
  // Tenant scope is fixed by the active organization and archived rows are excluded.
  "organizationId",
  "archivedAt",
] as const satisfies readonly (keyof NumberSeriesRow)[];

const NUMBER_SERIES_LIST_COLUMNS = {
  id: numberSeries.id,
  documentType: numberSeries.documentType,
  name: numberSeries.name,
  pattern: numberSeries.pattern,
  padding: numberSeries.padding,
  sellerProfileId: numberSeries.sellerProfileId,
  isDefault: numberSeries.isDefault,
  createdAt: numberSeries.createdAt,
  updatedAt: numberSeries.updatedAt,
};

type MissingNumberSeriesListColumn = UnprojectedColumns<
  NumberSeriesRow,
  typeof NUMBER_SERIES_LIST_COLUMNS,
  (typeof UNPROJECTED_NUMBER_SERIES_COLUMNS)[number]
>;
type UnexpectedNumberSeriesListColumn = UnbackedProjectionKeys<
  NumberSeriesRow,
  typeof NUMBER_SERIES_LIST_COLUMNS,
  (typeof UNPROJECTED_NUMBER_SERIES_COLUMNS)[number]
>;

true satisfies MissingNumberSeriesListColumn extends never ? true : never;
true satisfies UnexpectedNumberSeriesListColumn extends never ? true : never;

const config = {
  description: "List active document number series in the active organization.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
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
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.numberSeriesPageSizeDefault,
    );
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
            ...NUMBER_SERIES_LIST_COLUMNS,
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
