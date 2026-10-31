import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { organizationDataExports } from "@/api/db/schema";
import type { UNPROJECTED_DATA_EXPORT_COLUMNS } from "@/api/handlers/data-exports/summary";
import {
  DATA_EXPORT_PAGE_SIZE_DEFAULT,
  DATA_EXPORT_PAGE_SIZE_MAX,
  dataExportCreatedAtCursor,
  dataExportListColumns,
  toDataExportListItem,
} from "@/api/handlers/data-exports/summary";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const config = {
  contract: "patch",
  description:
    "List the organization's data exports, newest first, with status, " +
    "progress, part count and expiry; data-exports.get lists the parts. " +
    "Paginate with limit and cursor. " +
    "Organization owners and admins only.",
  permissions: { dataExport: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "reporting_export",
    consumesServices: false,
  },
  access: "read",
  query: v.strictObject({
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(DATA_EXPORT_PAGE_SIZE_MAX),
        ),
      ),
    ),
  }),
} satisfies HandlerConfig;

const listDataExports = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? DATA_EXPORT_PAGE_SIZE_DEFAULT,
    );
    const cursor =
      query.cursor === undefined
        ? null
        : dataExportCreatedAtCursor.decode(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            ...dataExportListColumns,
            createdAtCursor:
              dataExportCreatedAtCursor.cursorValue.as("created_at_cursor"),
          })
          .from(organizationDataExports)
          .where(
            and(
              eq(
                organizationDataExports.organizationId,
                session.activeOrganizationId,
              ),
              cursor === null
                ? undefined
                : dataExportCreatedAtCursor.keysetAfter({
                    cursor,
                    direction: "descending",
                    idColumn: organizationDataExports.id,
                  }),
            ),
          )
          .orderBy(
            desc(organizationDataExports.createdAt),
            desc(organizationDataExports.id),
          )
          .limit(limit + 1),
      ),
    );
    // Finished part metadata is available on the detail endpoint, keeping
    // list pages bounded independently of the number of export parts.
    type UnselectedDataExportColumn =
      (typeof UNPROJECTED_DATA_EXPORT_COLUMNS)[number] | "parts";
    type SelectedDataExportRow = Omit<(typeof rows)[number], "createdAtCursor">;
    true satisfies UnprojectedColumns<
      typeof organizationDataExports.$inferSelect,
      SelectedDataExportRow,
      UnselectedDataExportColumn
    > extends never
      ? true
      : never;
    true satisfies UnbackedProjectionKeys<
      typeof organizationDataExports.$inferSelect,
      SelectedDataExportRow,
      UnselectedDataExportColumn
    > extends never
      ? true
      : never;

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        dataExportCreatedAtCursor.encode(item.createdAtCursor, item.id),
    });
    return Result.ok({
      ...page,
      items: page.items.map(({ createdAtCursor: _cursor, ...row }) =>
        toDataExportListItem(row),
      ),
    });
  },
);

export default listDataExports;
