import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  caseLawResearchTableDecisions,
  caseLawResearchTables,
} from "@/api/db/schema";
import { researchTableDecisionParamsSchema } from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Drop a decision's pin or exclusion from a research table, so the " +
    "saved query alone decides whether it is a row again.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableDecisionParamsSchema,
} satisfies HandlerConfig;

const deleteResearchTableDecision = createSafeRootHandler(
  config,
  async function* ({
    params: { decisionId, tableId },
    recordAuditEvent,
    safeDb,
    session,
  }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(caseLawResearchTableDecisions)
          .where(
            and(
              eq(caseLawResearchTableDecisions.tableId, tableId),
              eq(caseLawResearchTableDecisions.decisionId, decisionId),
              eq(
                caseLawResearchTableDecisions.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .returning({ decisionId: caseLawResearchTableDecisions.decisionId });
        if (rows.length > 0) {
          await tx
            .update(caseLawResearchTables)
            .set({ updatedAt: new Date() })
            .where(
              and(
                eq(caseLawResearchTables.id, tableId),
                eq(
                  caseLawResearchTables.organizationId,
                  session.activeOrganizationId,
                ),
              ),
            );
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
            resourceId: tableId,
            metadata: { decisionId, disposition: null },
          });
        }
        return rows;
      }),
    );
    if (deleted.length === 0) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Decision is not pinned or excluded in this table",
        }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default deleteResearchTableDecision;
