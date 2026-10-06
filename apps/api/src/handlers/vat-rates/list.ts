import { panic, Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { vatRates } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { vatRateOnDate } from "@/api/lib/billing/vat-rates";
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
import { brandPersistedVatRateId } from "@/api/lib/safe-id-boundaries";

type VatRateRow = typeof vatRates.$inferSelect;

const UNPROJECTED_VAT_RATE_COLUMNS = [
  // Tenant scope is fixed by the active organization and archived rows are excluded.
  "organizationId",
  "archivedAt",
] as const satisfies readonly (keyof VatRateRow)[];

const VAT_RATE_LIST_COLUMNS = {
  id: vatRates.id,
  code: vatRates.code,
  name: vatRates.name,
  rateBps: vatRates.rateBps,
  validFrom: vatRates.validFrom,
  validTo: vatRates.validTo,
  createdAt: vatRates.createdAt,
  updatedAt: vatRates.updatedAt,
};

type MissingVatRateListColumn = UnprojectedColumns<
  VatRateRow,
  typeof VAT_RATE_LIST_COLUMNS,
  (typeof UNPROJECTED_VAT_RATE_COLUMNS)[number]
>;
type UnexpectedVatRateListColumn = UnbackedProjectionKeys<
  VatRateRow,
  typeof VAT_RATE_LIST_COLUMNS,
  (typeof UNPROJECTED_VAT_RATE_COLUMNS)[number]
>;

true satisfies MissingVatRateListColumn extends never ? true : never;
true satisfies UnexpectedVatRateListColumn extends never ? true : never;

const config = {
  description: "List active VAT rates in the active organization.",
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
    on: t.Optional(t.String({ format: "date" })),
    limit: t.Optional(
      t.Integer({ minimum: 1, maximum: LIMITS.vatRatesPageSizeMax }),
    ),
    cursor: t.Optional(tPaginationCursor()),
  }),
} satisfies HandlerConfig;

const cursorCodec = createTimestampIdCursorCodec({
  column: vatRates.createdAt,
  brandId: brandPersistedVatRateId,
});

export default createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.vatRatesPageSizeDefault,
    );
    const conditions = [
      eq(vatRates.organizationId, session.activeOrganizationId),
      isNull(vatRates.archivedAt),
    ];
    if (query.on) {
      conditions.push(
        vatRateOnDate(query.on) ?? panic("VAT date condition missing"),
      );
    }
    if (query.cursor) {
      const cursor = cursorCodec.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const after = cursorCodec.keysetAfter({
        cursor,
        idColumn: vatRates.id,
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
            ...VAT_RATE_LIST_COLUMNS,
            createdAtCursor: cursorCodec.cursorValue.as("created_at_cursor"),
          })
          .from(vatRates)
          .where(and(...conditions))
          .orderBy(desc(vatRates.createdAt), desc(vatRates.id))
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
