import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { caseLawResearchTables } from "@/api/db/schema";
import { researchTableParamsSchema } from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Delete a research table with its pins and exclusions. The decisions " +
    "themselves stay in the corpus.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
} satisfies HandlerConfig;

const deleteResearchTable = createSafeRootHandler(
  config,
  async function* ({ params: { tableId }, recordAuditEvent, safeDb, session }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(caseLawResearchTables)
          .where(
            and(
              eq(caseLawResearchTables.id, tableId),
              eq(
                caseLawResearchTables.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .returning({ id: caseLawResearchTables.id });
        if (rows.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
            resourceId: tableId,
          });
        }
        return rows;
      }),
    );
    if (deleted.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Research table not found" }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default deleteResearchTable;
