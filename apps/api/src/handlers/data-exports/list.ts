import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { organizationDataExports } from "@/api/db/schema";
import {
  DATA_EXPORT_PAGE_SIZE_DEFAULT,
  DATA_EXPORT_PAGE_SIZE_MAX,
  dataExportCreatedAtCursor,
  dataExportSummaryColumns,
  toDataExportSummary,
} from "@/api/handlers/data-exports/summary";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const config = {
  contract: "patch",
  description:
    "List the organization's data exports, newest first, with status, " +
    "progress, parts and expiry. Paginate with limit and cursor. " +
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
  query: t.Object({
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(
      t.Integer({ minimum: 1, maximum: DATA_EXPORT_PAGE_SIZE_MAX }),
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
            ...dataExportSummaryColumns,
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
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        dataExportCreatedAtCursor.encode(item.createdAtCursor, item.id),
    });
    return Result.ok({
      ...page,
      items: page.items.map(({ createdAtCursor: _cursor, ...row }) =>
        toDataExportSummary(row),
      ),
    });
  },
);

export default listDataExports;
