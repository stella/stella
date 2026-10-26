import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { readReportExportHistory } from "@/api/handlers/reports/export-history";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const config = {
  contract: "patch",
  description:
    "List report exports requested by the current user in a matter, newest first with cursor pagination.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "reporting_export",
    consumesServices: false,
  },
  access: "read",
  params: workspaceParams({}),
  query: v.object({
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.reportExportsPageSizeMax),
        ),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const listReportExports = createSafeHandler(
  config,
  async function* ({ query, safeDb, user, workspaceId }) {
    return yield* readReportExportHistory({
      cursor: query.cursor,
      limit: query.limit ?? LIMITS.reportExportsPageSizeDefault,
      requestedBy: user.id,
      safeDb,
      workspaceId,
    });
  },
);

export default listReportExports;
