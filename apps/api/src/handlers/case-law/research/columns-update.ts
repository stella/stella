import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  caseLawResearchAnswers,
  caseLawResearchColumns,
} from "@/api/db/schema";
import {
  readNamedResearchColumns,
  toResearchColumnResponse,
} from "@/api/handlers/case-law/research/column-access";
import {
  researchColumnParamsSchema,
  updateResearchColumnBodySchema,
} from "@/api/handlers/case-law/research/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Reword or retype one of the organization's questions. A changed " +
    "question or answer type invalidates every answer the column holds; the " +
    "cells empty until the next run.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "search_ui" },
  params: researchColumnParamsSchema,
  body: updateResearchColumnBodySchema,
} satisfies HandlerConfig;

const updateResearchColumn = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { columnId },
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
        const columns = await readNamedResearchColumns({
          tx,
          columnIds: [columnId],
          organizationId: session.activeOrganizationId,
          lock: true,
        });
        const current = columns?.at(0);
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
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_COLUMN,
          resourceId: columnId,
          metadata: { answersInvalidated: true },
        });
        return row;
      }),
    );
    if (updated === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Question column not found" }),
      );
    }

    return Result.ok(toResearchColumnResponse(updated));
  },
);

export default updateResearchColumn;
