import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { organizationDataExports } from "@/api/db/schema";
import {
  dataExportSummaryColumns,
  toDataExportSummary,
} from "@/api/handlers/data-exports/summary";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  dataExportMatterIdsSql,
  readableStoredDataExports,
} from "@/api/lib/data-export/stored-export-access";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  description:
    "Read one data export: status (queued, running, ready, failed or " +
    "expired), progress in matters and bytes, the finished parts with size " +
    "and SHA-256, how many files could not be included, and when the files " +
    "expire. Organization owners and admins only, and only while they can " +
    "see every matter in the export.",
  permissions: { dataExport: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "reporting_export",
    consumesServices: false,
  },
  access: "read",
  params: v.strictObject({ exportId: resourceIdSchema("dataExport") }),
} satisfies HandlerConfig;

const readDataExport = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, user }) {
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await readableStoredDataExports({
            tx,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            exports: await tx
              .select({
                ...dataExportSummaryColumns,
                matterIds: dataExportMatterIdsSql,
              })
              .from(organizationDataExports)
              .where(
                and(
                  eq(organizationDataExports.id, params.exportId),
                  eq(
                    organizationDataExports.organizationId,
                    session.activeOrganizationId,
                  ),
                ),
              )
              .limit(1),
          }),
      ),
    );
    const row = rows.at(0);
    // An export the caller may no longer read answers as one that is absent.
    if (row === undefined) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "data_export_not_found",
          message: "Export not found",
        }),
      );
    }
    return Result.ok(toDataExportSummary(row));
  },
);

export default readDataExport;
