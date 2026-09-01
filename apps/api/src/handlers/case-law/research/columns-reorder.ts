import { Result } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

import { caseLawResearchColumns } from "@/api/db/schema";
import {
  reorderResearchColumnsBodySchema,
  researchTableParamsSchema,
  toResearchColumnResponse,
} from "@/api/handlers/case-law/research/schema";
import {
  findResearchTable,
  touchResearchTable,
} from "@/api/handlers/case-law/research/table-access";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "Set the order of a research table's question columns. The list must " +
    "name every column of the table exactly once.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
  body: reorderResearchColumnsBodySchema,
} satisfies HandlerConfig;

const reorderResearchColumns = createSafeRootHandler(
  config,
  async function* ({
    body: { columnIds },
    params: { tableId },
    recordAuditEvent,
    safeDb,
    session,
  }) {
    if (new Set(columnIds).size !== columnIds.length) {
      return Result.err(
        new HandlerError({ status: 400, message: "Columns repeat" }),
      );
    }

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const table = await findResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        if (table === null) {
          return { status: "not-found" as const };
        }
        const existing = await tx
          .select({ id: caseLawResearchColumns.id })
          .from(caseLawResearchColumns)
          .where(
            and(
              eq(caseLawResearchColumns.tableId, tableId),
              eq(
                caseLawResearchColumns.organizationId,
                session.activeOrganizationId,
              ),
            ),
          );
        const existingIds = new Set(existing.map((column) => column.id));
        if (
          existingIds.size !== columnIds.length ||
          columnIds.some((columnId) => !existingIds.has(columnId))
        ) {
          return { status: "mismatch" as const };
        }
        for (const [index, columnId] of columnIds.entries()) {
          // SAFETY: bounded by LIMITS.caseLawResearchColumnsPerTable (the body
          // schema's maxItems), inside one transaction.
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- bounded by the column cap
          await tx
            .update(caseLawResearchColumns)
            .set({ position: index + 1 })
            .where(
              and(
                eq(caseLawResearchColumns.id, columnId),
                eq(
                  caseLawResearchColumns.organizationId,
                  session.activeOrganizationId,
                ),
              ),
            );
        }
        await touchResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
          resourceId: tableId,
          metadata: { columnsReordered: columnIds.length },
        });
        const columns = await tx
          .select()
          .from(caseLawResearchColumns)
          .where(
            and(
              inArray(caseLawResearchColumns.id, columnIds),
              eq(
                caseLawResearchColumns.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .orderBy(asc(caseLawResearchColumns.position))
          .limit(LIMITS.caseLawResearchColumnsPerTable);
        return { status: "ok" as const, columns };
      }),
    );

    switch (outcome.status) {
      case "not-found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Research table not found",
          }),
        );
      case "mismatch":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "The order must name every column of the table once",
          }),
        );
      case "ok":
        return Result.ok({
          columns: outcome.columns.map(toResearchColumnResponse),
        });
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  },
);

export default reorderResearchColumns;
