import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { caseLawResearchColumns } from "@/api/db/schema";
import { readOrganizationResearchColumns } from "@/api/handlers/case-law/research/column-access";
import {
  reorderResearchColumnsBodySchema,
  toResearchColumnResponse,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Set the order of the organization's question columns. The list must " +
    "name every column the organization keeps, exactly once.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  body: reorderResearchColumnsBodySchema,
} satisfies HandlerConfig;

const reorderResearchColumns = createSafeRootHandler(
  config,
  async function* ({ body: { columnIds }, recordAuditEvent, safeDb, session }) {
    if (new Set(columnIds).size !== columnIds.length) {
      return Result.err(
        new HandlerError({ status: 400, message: "Columns repeat" }),
      );
    }

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await readOrganizationResearchColumns({
          tx,
          organizationId: session.activeOrganizationId,
          lock: true,
        });
        const existingIds = new Set(existing.map((column) => column.id));
        if (columnIds.some((columnId) => !existingIds.has(columnId))) {
          return { status: "not-found" as const };
        }
        // An order that leaves a column out would settle its position by
        // omission; the client sends the whole set or nothing.
        if (existingIds.size !== columnIds.length) {
          return { status: "mismatch" as const };
        }
        for (const [index, columnId] of columnIds.entries()) {
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded by the per-organization column cap (the body schema's maxItems), inside one transaction
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
        await recordAuditEvent(
          tx,
          columnIds.map((columnId, index) => ({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_COLUMN,
            resourceId: columnId,
            metadata: { position: index + 1 },
          })),
        );
        const columns = await readOrganizationResearchColumns({
          tx,
          organizationId: session.activeOrganizationId,
        });
        return { status: "ok" as const, columns };
      }),
    );

    switch (outcome.status) {
      case "not-found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Question column not found",
          }),
        );
      case "mismatch":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "The order must name every question column once",
          }),
        );
      case "ok":
        return Result.ok({
          columns: outcome.columns.map(toResearchColumnResponse),
        });
      default: {
        outcome satisfies never;
        return panic(`Unhandled outcome: ${String(outcome)}`);
      }
    }
  },
);

export default reorderResearchColumns;
