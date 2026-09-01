import { panic, Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import { caseLawResearchColumns } from "@/api/db/schema";
import {
  createResearchColumnBodySchema,
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
import { createSafeId } from "@/api/lib/branded-types";
import { defaultResearchColumnTool } from "@/api/lib/case-law/research-answers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "Add a question column to a research table. Answers are produced later, " +
    "by an explicit run; the column starts empty. Refused once the table " +
    "holds its maximum number of columns.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchTableParamsSchema,
  body: createResearchColumnBodySchema,
} satisfies HandlerConfig;

const createResearchColumn = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { tableId },
    recordAuditEvent,
    safeDb,
    session,
  }) {
    const question = body.question.trim();
    if (question.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "A question is required" }),
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
        // Serialize count-and-insert per table so concurrent adds cannot
        // exceed the cap or share a position.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${tableId}), hashtext('columns'))`,
        );
        const [aggregate] = await tx
          .select({
            count: sql<number>`count(*)::int`,
            maxPosition: sql<number>`coalesce(max(${caseLawResearchColumns.position}), 0)::int`,
          })
          .from(caseLawResearchColumns)
          .where(eq(caseLawResearchColumns.tableId, tableId));
        if ((aggregate?.count ?? 0) >= LIMITS.caseLawResearchColumnsPerTable) {
          return { status: "limit" as const };
        }
        const [row] = await tx
          .insert(caseLawResearchColumns)
          .values({
            id: createSafeId<"caseLawResearchColumn">(),
            tableId,
            organizationId: session.activeOrganizationId,
            position: (aggregate?.maxPosition ?? 0) + 1,
            question,
            answerType: body.answerType,
            tool: defaultResearchColumnTool(),
          })
          .returning();
        const column = row ?? panic("Research column insert returned no row");
        await touchResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
          resourceId: tableId,
          metadata: { columnId: column.id, columnAdded: true },
        });
        return { status: "ok" as const, column };
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
      case "limit":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Research table column limit reached",
          }),
        );
      case "ok":
        return Result.ok(toResearchColumnResponse(outcome.column));
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  },
);

export default createResearchColumn;
