import { t } from "elysia";

import { readReportExportHistory } from "@/api/handlers/reports/export-history";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { workspaceParams } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "reporting_export" },
  access: "read",
  params: workspaceParams({}),
  query: t.Object({
    cursor: t.Optional(t.String({ maxLength: 512 })),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.reportExportsPageSizeMax,
      }),
    ),
  }),
} satisfies HandlerConfig;

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
