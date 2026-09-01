import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  caseLawResearchAnswers,
  caseLawResearchColumns,
} from "@/api/db/schema";
import {
  researchColumnParamsSchema,
  toResearchColumnResponse,
  updateResearchColumnBodySchema,
} from "@/api/handlers/case-law/research/schema";
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
    "Reword or retype a research-table question. A changed question or " +
    "answer type invalidates every answer the column holds; the cells " +
    "empty until the next run.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchColumnParamsSchema,
  body: updateResearchColumnBodySchema,
} satisfies HandlerConfig;

const updateResearchColumn = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { columnId, tableId },
    recordAuditEvent,
    safeDb,
    session,
  }) {
    const question = body.question?.trim();
    if (question?.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "A question is required" }),
      );
    }
    if (question === undefined && body.answerType === undefined) {
      return Result.err(
        new HandlerError({ status: 400, message: "Nothing to update" }),
      );
    }

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const table = await findResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        if (table === null) {
          return null;
        }
        const [current] = await tx
          .select()
          .from(caseLawResearchColumns)
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
          .limit(1);
        if (current === undefined) {
          return null;
        }
        const nextQuestion = question ?? current.question;
        const nextAnswerType = body.answerType ?? current.answerType;
        const changed =
          nextQuestion !== current.question ||
          nextAnswerType !== current.answerType;
        if (!changed) {
          return current;
        }
        const [row] = await tx
          .update(caseLawResearchColumns)
          .set({ question: nextQuestion, answerType: nextAnswerType })
          .where(
            and(
              eq(caseLawResearchColumns.id, columnId),
              eq(
                caseLawResearchColumns.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .returning();
        if (row === undefined) {
          return null;
        }
        // The answers were to the old question: they are not answers any more.
        await tx
          .delete(caseLawResearchAnswers)
          .where(
            and(
              eq(caseLawResearchAnswers.columnId, columnId),
              eq(
                caseLawResearchAnswers.organizationId,
                session.activeOrganizationId,
              ),
            ),
          );
        await touchResearchTable({
          tx,
          tableId,
          organizationId: session.activeOrganizationId,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_TABLE,
          resourceId: tableId,
          metadata: { columnId, columnChanged: true, answersInvalidated: true },
        });
        return row;
      }),
    );
    if (updated === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Research column not found" }),
      );
    }

    return Result.ok(toResearchColumnResponse(updated));
  },
);

export default updateResearchColumn;
