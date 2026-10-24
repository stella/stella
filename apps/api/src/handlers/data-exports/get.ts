import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { organizationDataExports } from "@/api/db/schema";
import {
  dataExportSummaryColumns,
  toDataExportSummary,
} from "@/api/handlers/data-exports/summary";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  description:
    "Read one data export: status (queued, running, ready, failed or " +
    "expired), progress in matters and bytes, the finished parts with size " +
    "and SHA-256, how many files could not be included, and when the files " +
    "expire. Organization owners and admins only.",
  permissions: { dataExport: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "reporting_export",
    consumesServices: false,
  },
  access: "read",
  params: t.Object({ exportId: tSafeId("dataExport") }),
} satisfies HandlerConfig;

const readDataExport = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select(dataExportSummaryColumns)
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
      ),
    );
    const row = rows.at(0);
    if (row === undefined) {
      return Result.err(
        new HandlerError({ status: 404, message: "Export not found" }),
      );
    }
    return Result.ok(toDataExportSummary(row));
  },
);

export default readDataExport;
