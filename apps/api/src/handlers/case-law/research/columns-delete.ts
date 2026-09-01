import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { caseLawResearchColumns } from "@/api/db/schema";
import { researchColumnParamsSchema } from "@/api/handlers/case-law/research/schema";
import {
  findResearchTable,
  touchResearchTable,
} from "@/api/handlers/case-law/research/table-access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Remove a question column from a research table, with every answer it holds.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchColumnParamsSchema,
} satisfies HandlerConfig;

const deleteResearchColumn = createSafeRootHandler(
  config,
  async function* ({
    params: { columnId, tableId },
    recordAuditEvent,
    safeDb,
    session,
  }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const table = await findResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        if (table === null) {
          return [];
        }
        const rows = await tx
          .delete(caseLawResearchColumns)
          .where(
            and(
              eq(caseLawResearchColumns.id, columnId),
              eq(caseLawResearchColumns.tableId, tableId),
              eq(
                caseLawResearchColumns.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .returning({ id: caseLawResearchColumns.id });
        if (rows.length > 0) {
          await touchResearchTable({
            tx,
            tableId,
            organizationId: session.activeOrganizationId,
          });
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
            resourceId: tableId,
            metadata: { columnId, columnRemoved: true },
          });
        }
        return rows;
      }),
    );
    if (deleted.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Research column not found" }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default deleteResearchColumn;
